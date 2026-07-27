import test from "node:test";
import assert from "node:assert/strict";
import { FFZYRequestError } from "../src/resourceSources/ffzy/ffzyClient.js";
import FFZYSource from "../src/resourceSources/ffzy/FFZYSource.js";

function catalogXml({ categoryId, page = 1, pageCount = 1, ids = [] }) {
  return `<?xml version="1.0"?><rss><list page="${page}" pagecount="${pageCount}" recordcount="${ids.length}">${ids.map((id) => `
    <video><last>2026-07-12 01:00:00</last><id>${id}</id><tid>${categoryId}</tid><name>Item ${id}</name></video>
  `).join("")}</list></rss>`;
}

function detailXml(ids, { categoryId = "30" } = {}) {
  return `<?xml version="1.0"?><rss><list page="1" pagecount="1" recordcount="${ids.length}">${ids.map((id) => `
    <video><last>2026-07-12 01:00:00</last><id>${id}</id><tid>${categoryId}</tid><name>Item ${id}</name><year>2026</year><dl><dd flag="ffm3u8">展示 ${id}$https://example.invalid/${id}.m3u8</dd></dl></video>
  `).join("")}</list></rss>`;
}

function createRepository(overrides = {}) {
  const calls = {
    running: [], catalog: [], details: [], failures: [], success: [], failed: [],
  };
  return {
    calls,
    markRunning(operation) { calls.running.push(operation); },
    saveCatalogItems(items) { calls.catalog.push(items); return items.length; },
    saveDetail(detail) { calls.details.push(detail); return detail.episodes.length; },
    saveDetailWithChanges(detail) {
      calls.details.push(detail);
      return { savedEpisodes: detail.episodes.length, matchingFactsChanged: true };
    },
    recordDetailFailure(id, error) { calls.failures.push({ id, error }); },
    markSuccess(operation, state) { calls.success.push({ operation, state }); },
    markFailed(operation, error) { calls.failed.push({ operation, error }); },
    getSyncState() { return { initialized: false, watermarkAt: null }; },
    listChangedItemIds(items) { return items.map((item) => item.sourceItemId); },
    listChangedMatchFactItemIds(items) { return items.map((item) => item.sourceItemId); },
    listMatchableItemIds(ids) { return [...new Set(ids)].sort(); },
    listDueDetailFailures() { return []; },
    listDetailFailureIds() { return []; },
    markSkipped() {},
    searchItems() { return []; },
    getItem() { return null; },
    getEpisodes() { return []; },
    getEpisode() { return null; },
    ...overrides,
  };
}

function createSource({ client, repository, sleep = async () => {}, random = () => 0 } = {}) {
  return new FFZYSource({
    db: {},
    logger: { log() {}, warn() {}, error() {} },
    client,
    repository,
    clock: () => new Date("2026-07-15T00:00:00.000Z"),
    sleep,
    random,
  });
}

test("initialize reads every tid=30 page without requesting tid=29 or tid=31", async () => {
  const catalogCalls = [];
  const detailCalls = [];
  const client = {
    async fetchCatalogXml({ categoryId, page }) {
      catalogCalls.push({ categoryId, page });
      if (categoryId === "30") {
        return catalogXml({ categoryId, page, pageCount: 2, ids: page === 1 ? ["shared", "30-a"] : ["30-b"] });
      }
      return catalogXml({ categoryId, page, ids: [] });
    },
    async fetchDetailXml(ids) {
      detailCalls.push(ids);
      return detailXml(ids);
    },
  };
  const repository = createRepository();
  const summary = await createSource({ client, repository }).initialize();

  assert.deepEqual(catalogCalls, [
    { categoryId: "30", page: 1 },
    { categoryId: "30", page: 2 },
  ]);
  assert.deepEqual(repository.calls.catalog[0].map((row) => row.sourceItemId).sort(), [
    "30-a", "30-b", "shared",
  ]);
  assert.equal(detailCalls.flat().length, 3);
  assert.equal(repository.calls.details.length, 3);
  assert.deepEqual(repository.calls.success, [{
    operation: "initialize",
    state: { initialized: true, watermarkAt: "2026-07-11T17:00:00.000Z" },
  }]);
  assert.deepEqual(summary, {
    sourceKey: "ffzy",
    operation: "initialize",
    startedAt: "2026-07-15T00:00:00.000Z",
    finishedAt: "2026-07-15T00:00:00.000Z",
    fetchedItems: 3,
    savedItems: 3,
    fetchedEpisodes: 3,
    savedEpisodes: 3,
    failedItems: 0,
    changedItemIds: [],
  });
});

test("initialize fails when any required catalog page is unavailable", async () => {
  const repository = createRepository();
  const client = {
    async fetchCatalogXml({ categoryId, page }) {
      if (categoryId === "30" && page === 2) throw new Error("catalog page unavailable");
      return catalogXml({ categoryId, page, pageCount: categoryId === "30" ? 2 : 1, ids: [categoryId] });
    },
    async fetchDetailXml(ids) { return detailXml(ids); },
  };

  await assert.rejects(() => createSource({ client, repository }).initialize(), /catalog page unavailable/);
  assert.equal(repository.calls.catalog.length, 0);
  assert.equal(repository.calls.success.length, 0);
  assert.equal(repository.calls.failed.length, 1);
});

test("initialize rejects pagination metadata that changes before the final page", async () => {
  const repository = createRepository();
  const client = {
    async fetchCatalogXml({ categoryId, page }) {
      if (categoryId === "30" && page === 1) {
        return catalogXml({ categoryId, page, pageCount: 3, ids: ["1"] });
      }
      if (categoryId === "30" && page === 2) {
        return catalogXml({ categoryId, page, pageCount: 1, ids: ["2"] });
      }
      return catalogXml({ categoryId, page, ids: [] });
    },
    async fetchDetailXml(ids) { return detailXml(ids); },
  };

  await assert.rejects(
    () => createSource({ client, repository }).initialize(),
    /pagecount.*changed|pagination/i,
  );
  assert.equal(repository.calls.success.length, 0);
});

test("detail batches use 20 IDs, two concurrent requests, and 500ms start spacing", async () => {
  const sleeps = [];
  let active = 0;
  let maxActive = 0;
  const detailCalls = [];
  const ids = Array.from({ length: 41 }, (_, index) => String(index + 1));
  const client = {
    async fetchCatalogXml({ categoryId }) {
      return catalogXml({ categoryId, ids: categoryId === "30" ? ids : [] });
    },
    async fetchDetailXml(batch) {
      detailCalls.push(batch);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return detailXml(batch);
    },
  };

  await createSource({
    client,
    repository: createRepository(),
    sleep: async (ms) => { sleeps.push(ms); await Promise.resolve(); },
  }).initialize();

  assert.deepEqual(detailCalls.map((batch) => batch.length), [20, 20, 1]);
  assert.equal(maxActive <= 2, true);
  assert.equal(sleeps.filter((ms) => ms === 500).length, 2);
});

test("retryable detail failures wait 5s and 30s before succeeding", async () => {
  const sleeps = [];
  let attempts = 0;
  const client = {
    async fetchCatalogXml({ categoryId }) {
      return catalogXml({ categoryId, ids: categoryId === "30" ? ["1"] : [] });
    },
    async fetchDetailXml(ids) {
      attempts += 1;
      if (attempts < 3) {
        throw new FFZYRequestError("temporary", { status: 503, retryable: true });
      }
      return detailXml(ids);
    },
  };
  const repository = createRepository();

  await createSource({
    client,
    repository,
    sleep: async (ms) => { sleeps.push(ms); },
  }).initialize();

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [5_000, 30_000]);
  assert.equal(repository.calls.failures.length, 0);
});

test("a missing batch item waits briefly and falls back to a single-ID request", async () => {
  const sleeps = [];
  const detailCalls = [];
  const client = {
    async fetchCatalogXml({ categoryId }) {
      return catalogXml({ categoryId, ids: categoryId === "30" ? ["1", "2"] : [] });
    },
    async fetchDetailXml(ids) {
      detailCalls.push(ids);
      return ids.length > 1 ? detailXml(["1"]) : detailXml(ids);
    },
  };
  const repository = createRepository();
  await createSource({
    client,
    repository,
    sleep: async (ms) => { sleeps.push(ms); },
  }).initialize();

  assert.deepEqual(detailCalls, [["1", "2"], ["2"]]);
  assert.equal(sleeps.includes(5_000), true);
  assert.deepEqual(repository.calls.details.map((row) => row.sourceItemId).sort(), ["1", "2"]);
});

test("permanent remote detail failure is queued without failing initialization", async () => {
  const client = {
    async fetchCatalogXml({ categoryId }) {
      return catalogXml({ categoryId, ids: categoryId === "30" ? ["1"] : [] });
    },
    async fetchDetailXml() {
      throw new FFZYRequestError("not found", { status: 404, retryable: false });
    },
  };
  const repository = createRepository();
  const summary = await createSource({ client, repository }).initialize();
  assert.equal(summary.failedItems, 1);
  assert.deepEqual(repository.calls.failures.map((row) => row.id), ["1"]);
  assert.equal(repository.calls.success.length, 1);
});

test("one invalid detail is queued without discarding valid details from the same batch", async () => {
  const detailCalls = [];
  const client = {
    async fetchCatalogXml({ categoryId }) {
      return catalogXml({ categoryId, ids: categoryId === "30" ? ["good", "bad"] : [] });
    },
    async fetchDetailXml(ids) {
      detailCalls.push(ids);
      return detailXml(ids).replace(
        "<last>2026-07-12 01:00:00</last><id>bad</id>",
        "<last>invalid-time</last><id>bad</id>",
      );
    },
  };
  const repository = createRepository();
  const summary = await createSource({ client, repository }).initialize();

  assert.deepEqual(detailCalls, [["good", "bad"]]);
  assert.deepEqual(repository.calls.details.map((row) => row.sourceItemId), ["good"]);
  assert.deepEqual(repository.calls.failures.map((row) => row.id), ["bad"]);
  assert.equal(summary.failedItems, 1);
  assert.equal(repository.calls.success.length, 1);
});

test("database failure stops new detail batches and fails the complete initialize run", async () => {
  const ids = Array.from({ length: 41 }, (_, index) => String(index + 1));
  const detailCalls = [];
  const client = {
    async fetchCatalogXml({ categoryId }) {
      return catalogXml({ categoryId, ids: categoryId === "30" ? ids : [] });
    },
    async fetchDetailXml(batch) {
      detailCalls.push(batch);
      return detailXml(batch);
    },
  };
  const repository = createRepository({
    saveDetailWithChanges() { throw new Error("disk full"); },
  });

  await assert.rejects(() => createSource({ client, repository }).initialize(), /disk full/);
  assert.equal(detailCalls.length < 3, true, "third batch must not start after the DB failure");
  assert.equal(repository.calls.success.length, 0);
  assert.equal(repository.calls.failed.length, 1);
});
