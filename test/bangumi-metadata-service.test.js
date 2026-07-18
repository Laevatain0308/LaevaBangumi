import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createBangumiRepository } from "../src/bangumi/repository.js";
import { createBangumiMetadataClient } from "../src/bangumi/client.js";
import {
  DetailRefreshError,
  createBangumiMetadataService,
} from "../src/bangumi/metadataService.js";
import { createMetadataEnsureService } from "../src/bangumi/metadataEnsureService.js";
import { fetchJson, BANGUMI_TRANSPORT_RETRY_DELAYS_MS } from "../src/clients/bangumiClient.js";
import { HOUR_MS } from "../src/bangumi/config.js";

const NOW = "2026-07-10T00:00:00.000Z";
const NEXT = "2026-07-17T00:00:00.000Z";

function anime(id, extra = {}) {
  return {
    id,
    type: 2,
    name: `Anime ${id}`,
    name_cn: `动画 ${id}`,
    images: { large: `https://example.invalid/${id}.jpg` },
    ...extra,
  };
}

function setup(t, overrides = {}) {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const calls = [];
  let detailCalls = 0;
  const httpClient = {
    async searchSubjects(keyword, options) {
      calls.push({ keyword, ...options });
      return { data: [anime(1), { id: 2, type: 6, name: "Person" }, { id: 3, type: "2", name: "String Type" }] };
    },
    async getSubject(id) {
      detailCalls += 1;
      return anime(id, {
        summary: "full detail",
        rating: { score: 8.1, rank: 10, total: 100, count: { 8: 20 } },
        tags: [{ name: "detail", count: 5, total_count: 10 }],
        infobox: [{ key: "别名", value: [{ v: "Alias" }] }],
      });
    },
    async getCalendar() {
      return [];
    },
    ...overrides,
  };
  const repository = createBangumiRepository(sqlite);
  const client = createBangumiMetadataClient(httpClient);
  const logs = [];
  let wakeCount = 0;
  const metadataEnsureService = createMetadataEnsureService({
    repository,
    clock: () => new Date(NOW),
    wake() { wakeCount += 1; },
  });
  const service = createBangumiMetadataService({
    client,
    repository,
    ensureMetadata: metadataEnsureService.ensure,
    clock: () => new Date(NOW),
    logger: {
      log(scope, message, meta) { logs.push({ scope, message, meta }); },
      error(scope, message, meta) { logs.push({ scope, message, meta }); },
    },
  });
  return {
    calls,
    client,
    httpClient,
    logs,
    repository,
    service,
    get detailCalls() { return detailCalls; },
    get wakeCount() { return wakeCount; },
  };
}

test("anime-only client forces the search media type", async () => {
  const calls = [];
  const client = createBangumiMetadataClient({
    async searchSubjects(keyword, options) {
      calls.push({ keyword, options });
      return { data: [] };
    },
  });
  await client.search("frieren", { mediaType: "tv", limit: 10 });
  assert.deepEqual(calls, [{ keyword: "frieren", options: { mediaType: "anime", limit: 10 } }]);
});

test("search persists valid anime summaries and rejects all other types", async (t) => {
  const context = setup(t);
  const result = await context.service.searchAndPersist("frieren");

  assert.deepEqual(context.calls, [{ keyword: "frieren", mediaType: "anime" }]);
  assert.deepEqual(result, { received: 3, persisted: 1, rejected: 2 });
  assert.equal(context.repository.findById(1).subject.nameCn, "动画 1");
  assert.equal(context.repository.findById(2), null);
  assert.equal(context.repository.findById(3), null);
  assert.equal(context.repository.hasCompletedDetail(1), false);
  assert.deepEqual(context.repository.listDueRefreshIds({ now: NOW, limit: 100 }), [
    { bangumiId: 1, consecutiveFailures: 0 },
  ]);
  assert.equal(context.wakeCount, 1);
  assert.deepEqual(context.logs.map((entry) => entry.meta.id), [2, 3]);
  assert.ok(context.logs.every((entry) => entry.meta.path === "$.type"));
});

test("first detail read fetches full metadata and later reads the cache", async (t) => {
  const context = setup(t);
  context.repository.mergeSummary({ subject: { bangumiId: 1, name: "Summary" } }, { now: NOW });

  const first = await context.service.getDetail(1);
  assert.equal(context.detailCalls, 1);
  assert.equal(first.subject.summary, "full detail");
  assert.equal(first.refreshState.nextRefreshAt, NEXT);
  assert.equal(first.refreshState.consecutiveFailures, 0);
  assert.deepEqual(context.logs.map((entry) => entry.message), ["detail fetch started", "detail fetch completed"]);
  assert.equal(context.wakeCount, 1);

  const second = await context.service.getDetail(1);
  assert.equal(context.detailCalls, 1);
  assert.deepEqual(second, first);
});

test("detail fetch validates the requested ID before writing", async (t) => {
  const context = setup(t, {
    async getSubject() {
      return anime(99);
    },
  });
  context.repository.mergeSummary({ subject: { bangumiId: 1, name: "Summary" } }, { now: NOW });

  await assert.rejects(() => context.service.getDetail(1), (error) => error.code === "id_mismatch");
  assert.equal(context.repository.hasCompletedDetail(1), false);
  assert.equal(context.repository.findById(1).subject.name, "Summary");
});

test("failed first detail fetch records six-hour backoff", async (t) => {
  const context = setup(t, {
    async getSubject() {
      throw new Error("Bangumi unavailable");
    },
  });
  context.repository.mergeSummary({ subject: { bangumiId: 1, name: "Summary" } }, { now: NOW });

  await assert.rejects(() => context.service.getDetail(1), (error) => (
    error instanceof DetailRefreshError && error.refreshStateRecorded === true
  ));
  assert.equal(context.repository.hasCompletedDetail(1), false);
  assert.equal(context.repository.findById(1).subject.name, "Summary");
  assert.deepEqual(context.repository.findRefreshState(1), {
    bangumiId: 1,
    lastSucceededAt: null,
    nextRefreshAt: new Date(Date.parse(NOW) + 6 * HOUR_MS).toISOString(),
    lastAttemptedAt: NOW,
    consecutiveFailures: 1,
    lastError: "Bangumi unavailable",
    updatedAt: NOW,
  });
  assert.deepEqual(context.logs.map((entry) => entry.message), ["detail fetch started", "detail fetch failed"]);
});

test("transport retries temporary blockage before recording one persistent failure", async (t) => {
  assert.deepEqual(BANGUMI_TRANSPORT_RETRY_DELAYS_MS, [500, 1500]);
  let attempts = 0;
  const context = setup(t, {
    async getSubject(id) {
      return fetchJson(`https://example.invalid/${id}`, {
        retryDelaysMs: [0, 0],
        fetchImpl: async () => {
          attempts += 1;
          throw Object.assign(new TypeError("blocked"), { code: "ECONNRESET" });
        },
      });
    },
  });

  await assert.rejects(() => context.service.getDetail(1), DetailRefreshError);
  assert.equal(attempts, 3);
  assert.equal(context.repository.findRefreshState(1).consecutiveFailures, 1);
});

for (const [previousFailures, delay] of [[0, 6], [1, 24], [2, 72], [9, 72]]) {
  test(`persistent failure ${previousFailures + 1} uses ${delay}-hour backoff`, async (t) => {
    const context = setup(t, {
      async getSubject() { throw new Error("Bangumi unavailable"); },
    });
    context.repository.ensureRefreshIds([1], { now: NOW });
    for (let index = 0; index < previousFailures; index += 1) {
      context.repository.recordDetailRefreshFailure({
        bangumiId: 1,
        now: NOW,
        nextRefreshAt: NOW,
        error: "previous failure",
      });
    }

    await assert.rejects(() => context.service.refreshDetail(1), DetailRefreshError);
    const state = context.repository.findRefreshState(1);
    assert.equal(state.consecutiveFailures, previousFailures + 1);
    assert.equal(state.nextRefreshAt, new Date(Date.parse(NOW) + delay * HOUR_MS).toISOString());
  });
}

test("a stale completed detail returns locally and wakes background refresh", async (t) => {
  const context = setup(t);
  context.repository.replaceDetail(
    { subject: { bangumiId: 1, name: "Stale detail", summary: "local" } },
    { now: "2026-07-01T00:00:00.000Z", nextRefreshAt: NOW },
  );

  const result = await context.service.getDetail(1);
  assert.equal(result.subject.summary, "local");
  assert.equal(context.detailCalls, 0);
  assert.equal(context.wakeCount, 1);
});

test("failure backoff returns available local summary without a network call", async (t) => {
  const context = setup(t);
  context.repository.mergeSummary({ subject: { bangumiId: 1, name: "Summary" } }, { now: NOW });
  context.repository.ensureRefreshIds([1], { now: NOW });
  context.repository.recordDetailRefreshFailure({
    bangumiId: 1,
    now: NOW,
    nextRefreshAt: NEXT,
    error: "temporary outage",
  });

  const result = await context.service.getDetail(1);
  assert.equal(result.subject.name, "Summary");
  assert.equal(context.detailCalls, 0);
});

test("foreground and worker detail refreshes share one per-ID request", async (t) => {
  let release;
  let detailCalls = 0;
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const repository = createBangumiRepository(sqlite);
  let workerPromise;
  let service;
  service = createBangumiMetadataService({
    client: {
      async getSubject(id) {
        detailCalls += 1;
        await new Promise((resolve) => { release = resolve; });
        return anime(id, { summary: "shared result" });
      },
    },
    repository,
    clock: () => new Date(NOW),
    ensureMetadata(ids) {
      repository.ensureRefreshIds(ids, { now: NOW });
      workerPromise = Promise.resolve().then(() => service.refreshDetail(ids[0]));
      return { ensuredIds: ids, newlyDueIds: ids, dueIds: ids };
    },
  });

  const foreground = service.getDetail(1);
  while (!release) await Promise.resolve();
  release();
  const [foregroundResult, workerResult] = await Promise.all([foreground, workerPromise]);
  assert.equal(detailCalls, 1);
  assert.equal(foregroundResult.subject.summary, "shared result");
  assert.deepEqual(workerResult, foregroundResult);
});

test("forced refresh replaces an existing detail snapshot", async (t) => {
  const context = setup(t);
  await context.service.getDetail(1);
  context.httpClient.getSubject = async (id) => anime(id, { summary: "new authority" });

  const refreshed = await context.service.refreshDetail(1);
  assert.equal(refreshed.subject.summary, "new authority");
  assert.equal(refreshed.rating, null);
  assert.deepEqual(refreshed.tags, []);
});
