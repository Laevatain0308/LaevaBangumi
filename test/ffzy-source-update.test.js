import test from "node:test";
import assert from "node:assert/strict";
import { FFZYRequestError } from "../src/resourceSources/ffzy/ffzyClient.js";
import FFZYSource from "../src/resourceSources/ffzy/FFZYSource.js";

function catalogXml({ categoryId, page = 1, pageCount = 1, items = [] }) {
  return `<?xml version="1.0"?><rss><list page="${page}" pagecount="${pageCount}" recordcount="${items.length}">${items.map((item) => `
    <video><last>${item.last}</last><id>${item.id}</id><tid>${categoryId}</tid><name>${item.title ?? `Item ${item.id}`}</name></video>
  `).join("")}</list></rss>`;
}

function detailXml(ids, categoryId = "30") {
  return `<?xml version="1.0"?><rss><list page="1" pagecount="1" recordcount="${ids.length}">${ids.map((id) => `
    <video><last>2026-07-15 08:00:00</last><id>${id}</id><tid>${categoryId}</tid><name>Item ${id}</name><dl><dd flag="ffm3u8">Episode$https://example.invalid/${id}.m3u8</dd></dl></video>
  `).join("")}</list></rss>`;
}

function createRepository(overrides = {}) {
  const calls = {
    skipped: [], running: [], catalog: [], details: [], failures: [], success: [], failed: [],
  };
  return {
    calls,
    getSyncState() {
      return { initialized: true, watermarkAt: "2026-07-15T00:00:00.000Z" };
    },
    markSkipped(operation, reason) { calls.skipped.push({ operation, reason }); },
    markRunning(operation) { calls.running.push(operation); },
    listDueDetailFailures() { return []; },
    listDetailFailureIds() { return []; },
    listChangedItemIds(items) { return items.map((item) => item.sourceItemId); },
    listChangedMatchFactItemIds(items) { return items.map((item) => item.sourceItemId); },
    listMatchableItemIds(ids) { return [...new Set(ids)].sort(); },
    saveCatalogItems(items) { calls.catalog.push(items); return items.length; },
    saveDetail(detail) { calls.details.push(detail); return detail.episodes.length; },
    saveDetailWithChanges(detail) {
      calls.details.push(detail);
      return { savedEpisodes: detail.episodes.length, matchingFactsChanged: true };
    },
    recordDetailFailure(id, error) { calls.failures.push({ id, error }); },
    markSuccess(operation, state) { calls.success.push({ operation, state }); },
    markFailed(operation, error) { calls.failed.push({ operation, error }); },
    searchItems(keyword) { return [{ keyword }]; },
    getItem(id) { return { id }; },
    getEpisodes(id) { return [{ id }]; },
    getEpisode(id, index) { return { id, index }; },
    ...overrides,
  };
}

function createSource({ client, repository } = {}) {
  return new FFZYSource({
    db: {},
    logger: { log() {}, warn() {}, error() {} },
    client,
    repository,
    clock: () => new Date("2026-07-15T12:00:00.000Z"),
    sleep: async () => {},
    random: () => 0,
  });
}

test("uninitialized update skips without touching FFZY", async () => {
  const client = {
    async fetchCatalogXml() { throw new Error("network must not be called"); },
    async fetchDetailXml() { throw new Error("network must not be called"); },
  };
  const repository = createRepository({
    getSyncState() { return { initialized: false, watermarkAt: null }; },
  });
  const summary = await createSource({ client, repository }).update();

  assert.equal(summary.fetchedItems, 0);
  assert.equal(summary.savedItems, 0);
  assert.deepEqual(summary.changedItemIds, []);
  assert.equal(repository.calls.running.length, 0);
  assert.equal(repository.calls.skipped.length, 1);
});

test("incremental update retries due details before reading catalog", async () => {
  const order = [];
  const client = {
    async fetchDetailXml(ids) { order.push(`detail:${ids.join(",")}`); return detailXml(ids); },
    async fetchCatalogXml({ categoryId }) {
      order.push(`catalog:${categoryId}`);
      return catalogXml({ categoryId, items: [] });
    },
  };
  const repository = createRepository({
    listDueDetailFailures() { return [{ sourceItemId: "due-1" }]; },
  });

  await createSource({ client, repository }).update();
  assert.deepEqual(order.slice(0, 2), ["detail:due-1", "catalog:30"]);
  assert.deepEqual(repository.calls.details.map((detail) => detail.sourceItemId), ["due-1"]);
});

test("incremental pages stop after crossing the five-minute overlap", async () => {
  const catalogCalls = [];
  const client = {
    async fetchCatalogXml({ categoryId, page }) {
      catalogCalls.push({ categoryId, page });
      if (categoryId !== "30") return catalogXml({ categoryId, items: [] });
      if (page === 1) return catalogXml({
        categoryId,
        page,
        pageCount: 3,
        items: [
          { id: "new", last: "2026-07-15 08:05:00" },
          { id: "overlap", last: "2026-07-15 07:56:00" },
          { id: "old", last: "2026-07-15 07:54:59" },
        ],
      });
      throw new Error("page after cutoff must not be requested");
    },
    async fetchDetailXml(ids) { return detailXml(ids); },
  };
  const repository = createRepository();

  await createSource({ client, repository }).update();
  assert.deepEqual(catalogCalls, [
    { categoryId: "30", page: 1 },
  ]);
  assert.deepEqual(repository.calls.catalog[0].map((item) => item.sourceItemId), ["new", "overlap"]);
});

test("incremental update hydrates changed items and catalog failures that are still backing off", async () => {
  const detailCalls = [];
  const client = {
    async fetchCatalogXml({ categoryId }) {
      return catalogXml({
        categoryId,
        items: categoryId === "30" ? [
          { id: "unchanged", last: "2026-07-15 08:10:00" },
          { id: "changed", last: "2026-07-15 08:09:00" },
          { id: "backoff", last: "2026-07-15 08:08:00" },
        ] : [],
      });
    },
    async fetchDetailXml(ids) { detailCalls.push(ids); return detailXml(ids); },
  };
  const repository = createRepository({
    listChangedItemIds() { return ["changed"]; },
    listChangedMatchFactItemIds() { return ["changed"]; },
    listDetailFailureIds() { return ["backoff", "not-in-catalog"]; },
  });

  const result = await createSource({ client, repository }).update();
  assert.deepEqual(detailCalls.flat().sort(), ["backoff", "changed"]);
  assert.deepEqual(result.changedItemIds, ["backoff", "changed"]);
});

test("remote detail failure is queued while a complete catalog advances the watermark", async () => {
  const client = {
    async fetchCatalogXml({ categoryId }) {
      return catalogXml({
        categoryId,
        items: categoryId === "30" ? [{ id: "changed", last: "2026-07-15 08:30:00" }] : [],
      });
    },
    async fetchDetailXml() {
      throw new FFZYRequestError("temporary exhausted", { status: 503, retryable: false });
    },
  };
  const repository = createRepository();
  const summary = await createSource({ client, repository }).update();
  assert.equal(summary.failedItems, 1);
  assert.equal(repository.calls.failures.length, 1);
  assert.deepEqual(repository.calls.success, [{
    operation: "update",
    state: { watermarkAt: "2026-07-15T00:30:00.000Z" },
  }]);
});

test("catalog failure and database failure both preserve the old watermark", async () => {
  const catalogRepository = createRepository();
  const catalogClient = {
    async fetchCatalogXml({ categoryId }) {
      if (categoryId === "30") throw new Error("catalog unavailable");
      return catalogXml({ categoryId, items: [] });
    },
    async fetchDetailXml(ids) { return detailXml(ids); },
  };
  await assert.rejects(() => createSource({
    client: catalogClient,
    repository: catalogRepository,
  }).update(), /catalog unavailable/);
  assert.equal(catalogRepository.calls.success.length, 0);
  assert.equal(catalogRepository.calls.failed.length, 1);

  const databaseRepository = createRepository({
    saveCatalogItems() { throw new Error("database unavailable"); },
  });
  const databaseClient = {
    async fetchCatalogXml({ categoryId }) {
      return catalogXml({
        categoryId,
        items: categoryId === "30" ? [{ id: "new", last: "2026-07-15 08:30:00" }] : [],
      });
    },
    async fetchDetailXml(ids) { return detailXml(ids); },
  };
  await assert.rejects(() => createSource({
    client: databaseClient,
    repository: databaseRepository,
  }).update(), /database unavailable/);
  assert.equal(databaseRepository.calls.success.length, 0);
  assert.equal(databaseRepository.calls.failed.length, 1);
});

test("incremental pagination drift fails without advancing the watermark", async () => {
  const repository = createRepository();
  const client = {
    async fetchCatalogXml({ categoryId, page }) {
      if (categoryId === "30" && page === 1) {
        return catalogXml({
          categoryId,
          page,
          pageCount: 3,
          items: [{ id: "1", last: "2026-07-15 08:30:00" }],
        });
      }
      if (categoryId === "30" && page === 2) {
        return catalogXml({
          categoryId,
          page,
          pageCount: 1,
          items: [{ id: "2", last: "2026-07-15 08:20:00" }],
        });
      }
      return catalogXml({ categoryId, page, items: [] });
    },
    async fetchDetailXml(ids) { return detailXml(ids); },
  };

  await assert.rejects(
    () => createSource({ client, repository }).update(),
    /pagecount.*changed|pagination/i,
  );
  assert.equal(repository.calls.success.length, 0);
});

test("local hooks and explicit fetch delegate without implicit persistence", async () => {
  const client = {
    async fetchCatalogXml() { return catalogXml({ categoryId: "30", items: [] }); },
    async fetchDetailXml(ids) { return detailXml(ids); },
  };
  const repository = createRepository({
    searchItems(keyword) { return keyword; },
    getItem(id) { return id; },
    getEpisodes(id) { return [id]; },
    getEpisode(id, index) { return [id, index]; },
  });
  const source = createSource({ client, repository });

  assert.equal(await source._searchItems("needle"), "needle");
  assert.equal(await source._getItem("item"), "item");
  assert.deepEqual(await source._getEpisodes("item"), ["item"]);
  assert.deepEqual(await source._getEpisode("item", 2), ["item", 2]);
  assert.equal((await source.fetchDetail("remote")).sourceItemId, "remote");
  assert.equal(repository.calls.details.length, 0);
});
