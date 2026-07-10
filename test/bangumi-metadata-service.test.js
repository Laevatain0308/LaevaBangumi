import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createBangumiRepository } from "../src/bangumi/repository.js";
import { createBangumiMetadataClient } from "../src/bangumi/client.js";
import { createBangumiMetadataService } from "../src/bangumi/metadataService.js";

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
  const service = createBangumiMetadataService({
    client,
    repository,
    clock: () => new Date(NOW),
    logger: {
      log(scope, message, meta) { logs.push({ scope, message, meta }); },
      error(scope, message, meta) { logs.push({ scope, message, meta }); },
    },
  });
  return { calls, client, httpClient, logs, repository, service, get detailCalls() { return detailCalls; } };
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

test("failed first detail fetch leaves no refresh state", async (t) => {
  const context = setup(t, {
    async getSubject() {
      throw new Error("Bangumi unavailable");
    },
  });
  context.repository.mergeSummary({ subject: { bangumiId: 1, name: "Summary" } }, { now: NOW });

  await assert.rejects(() => context.service.getDetail(1), /Bangumi unavailable/);
  assert.equal(context.repository.hasCompletedDetail(1), false);
  assert.equal(context.repository.findById(1).subject.name, "Summary");
  assert.deepEqual(context.logs.map((entry) => entry.message), ["detail fetch started", "detail fetch failed"]);
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
