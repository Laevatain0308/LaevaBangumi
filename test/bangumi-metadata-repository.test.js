import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createBangumiRepository } from "../src/bangumi/repository.js";

const NOW = "2026-07-10T00:00:00.000Z";
const LATER = "2026-07-11T00:00:00.000Z";
const NEXT = "2026-07-18T00:00:00.000Z";

function createRepository(t) {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  return { sqlite, repository: createBangumiRepository(sqlite) };
}

function summary(bangumiId = 1) {
  return {
    subject: {
      bangumiId,
      name: "Initial",
      nameCn: "初始标题",
      summary: "preserved summary",
      airDate: "2026-07-01",
      airWeekday: 3,
      platform: "TV",
      eps: 12,
    },
    images: { largeUrl: "old-large", commonUrl: "preserved-common" },
    rating: { score: 7.5, rank: 100, total: 50, counts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    collection: { wish: 1, collect: 2, doing: 3, onHold: 4, dropped: 5 },
    tags: [{ position: 0, name: "old-tag", count: 10, totalCount: 20 }],
    metaTags: [{ position: 0, name: "old-meta" }],
    infobox: [{
      entryPosition: 0,
      key: "中文名",
      valueKind: "scalar",
      values: [{ valuePosition: 0, label: null, value: "初始标题" }],
    }],
  };
}

function detail(bangumiId = 1) {
  return {
    subject: {
      bangumiId,
      name: "Detail",
      nameCn: "详情标题",
      summary: "detail summary",
      airDate: "2026-07-02",
      platform: "WEB",
      eps: 13,
      totalEpisodes: 13,
      volumes: 0,
      series: false,
      locked: false,
      nsfw: false,
    },
    images: { largeUrl: "detail-large", commonUrl: null, mediumUrl: null, smallUrl: null, gridUrl: null },
    rating: { score: 8.2, rank: 20, total: 100, counts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    collection: { wish: 10, collect: 20, doing: 30, onHold: 40, dropped: 50 },
    tags: [{ position: 0, name: "new-tag", count: 30, totalCount: 40 }],
    metaTags: [{ position: 0, name: "new-meta" }],
    infobox: [
      {
        entryPosition: 0,
        key: "中文名",
        valueKind: "scalar",
        values: [{ valuePosition: 0, label: null, value: "详情标题" }],
      },
      {
        entryPosition: 1,
        key: "别名",
        valueKind: "list",
        values: [
          { valuePosition: 0, label: null, value: "Alias A" },
          { valuePosition: 1, label: "英文名", value: "Alias B" },
        ],
      },
      { entryPosition: 2, key: "空列表", valueKind: "list", values: [] },
    ],
  };
}

test("summary merge preserves missing fields and applies explicit null", (t) => {
  const { repository } = createRepository(t);
  repository.mergeSummary(summary(), { now: NOW });
  repository.mergeSummary({
    subject: { bangumiId: 1, name: "Updated", nameCn: null },
    images: { largeUrl: "new-large" },
    rating: { score: 8.0, counts: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0] },
  }, { now: LATER });

  const result = repository.findById(1);
  assert.equal(result.subject.name, "Updated");
  assert.equal(result.subject.nameCn, null);
  assert.equal(result.subject.summary, "preserved summary");
  assert.equal(result.images.largeUrl, "new-large");
  assert.equal(result.images.commonUrl, "preserved-common");
  assert.equal(result.rating.score, 8.0);
  assert.equal(result.rating.rank, 100);
  assert.equal(result.subject.discoveredAt, NOW);
  assert.equal(result.subject.updatedAt, LATER);
  assert.equal(result.refreshState, null);
});

test("summary merge deletes explicit null objects and replaces present arrays", (t) => {
  const { repository } = createRepository(t);
  repository.mergeSummary(summary(), { now: NOW });
  repository.mergeSummary({
    subject: { bangumiId: 1, name: "Updated" },
    images: null,
    collection: null,
    tags: [],
    metaTags: null,
  }, { now: LATER });

  const result = repository.findById(1);
  assert.equal(result.images, null);
  assert.equal(result.collection, null);
  assert.deepEqual(result.tags, []);
  assert.deepEqual(result.metaTags, []);
  assert.equal(result.infobox.length, 1);
});

test("detail snapshot replaces owned relations and preserves a missing weekday", (t) => {
  const { repository } = createRepository(t);
  repository.mergeSummary(summary(), { now: NOW });
  repository.replaceDetail(detail(), { now: LATER, nextRefreshAt: NEXT });

  const result = repository.findById(1);
  assert.equal(result.subject.name, "Detail");
  assert.equal(result.subject.airWeekday, 3);
  assert.deepEqual(result.tags.map((tag) => tag.name), ["new-tag"]);
  assert.deepEqual(result.metaTags.map((tag) => tag.name), ["new-meta"]);
  assert.deepEqual(result.rating.counts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(result.refreshState, {
    bangumiId: 1,
    lastSucceededAt: LATER,
    nextRefreshAt: NEXT,
    lastAttemptedAt: LATER,
    consecutiveFailures: 0,
    lastError: null,
  });
});

test("detail snapshot clears missing detail-owned fields and child relations", (t) => {
  const { repository } = createRepository(t);
  repository.mergeSummary(summary(), { now: NOW });
  repository.replaceDetail({ subject: { bangumiId: 1, name: "Sparse Detail" } }, { now: LATER, nextRefreshAt: NEXT });

  const result = repository.findById(1);
  assert.equal(result.subject.nameCn, null);
  assert.equal(result.subject.summary, null);
  assert.equal(result.subject.airDate, null);
  assert.equal(result.subject.airWeekday, 3);
  assert.equal(result.images, null);
  assert.equal(result.rating, null);
  assert.deepEqual(result.tags, []);
  assert.deepEqual(result.infobox, []);
});

test("round-trips scalar, labeled list, and empty Infobox values losslessly", (t) => {
  const { repository } = createRepository(t);
  const input = detail();
  repository.replaceDetail(input, { now: NOW, nextRefreshAt: NEXT });
  assert.deepEqual(repository.findById(1).infobox, input.infobox);
});

test("rolls back an entire detail snapshot when a child write fails", (t) => {
  const { sqlite, repository } = createRepository(t);
  sqlite.exec(`
    CREATE TRIGGER fail_image_insert
    BEFORE INSERT ON bangumi_subject_images
    BEGIN
      SELECT RAISE(ABORT, 'injected image failure');
    END;
  `);

  assert.throws(
    () => repository.replaceDetail(detail(), { now: NOW, nextRefreshAt: NEXT }),
    /injected image failure/,
  );
  assert.equal(repository.findById(1), null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM bangumi_subject_refresh_state").get().count, 0);
});

test("lists due completed details in due-time order with a limit", (t) => {
  const { sqlite, repository } = createRepository(t);
  for (const [id, nextRefreshAt] of [[1, "2026-07-09T00:00:00.000Z"], [2, "2026-07-08T00:00:00.000Z"], [3, NEXT]]) {
    repository.replaceDetail(detail(id), { now: NOW, nextRefreshAt });
  }
  assert.deepEqual(repository.listDueRefreshIds({ now: NOW, limit: 1 }), [{ bangumiId: 2, consecutiveFailures: 0 }]);

  repository.recordDetailRefreshFailure({
    bangumiId: 2,
    now: LATER,
    nextRefreshAt: "2026-07-11T06:00:00.000Z",
    error: "unavailable",
  });
  assert.deepEqual(sqlite.prepare(`
    SELECT consecutive_failures, last_error FROM bangumi_subject_refresh_state WHERE bangumi_id = 2
  `).get(), { consecutive_failures: 1, last_error: "unavailable" });
  assert.equal(repository.findById(2).subject.name, "Detail");
});

test("atomically replaces calendar membership without creating detail state", (t) => {
  const { repository } = createRepository(t);
  repository.replaceCalendarSnapshot([
    { metadata: summary(1), weekday: 1 },
    { metadata: summary(2), weekday: 3 },
  ], { now: NOW });

  assert.deepEqual(repository.listCalendarSubjects().map((row) => [row.subject.bangumiId, row.weekday]), [[1, 1], [2, 3]]);
  assert.equal(repository.hasCompletedDetail(1), false);

  repository.replaceCalendarSnapshot([{ metadata: summary(2), weekday: 5 }], { now: LATER });
  assert.deepEqual(repository.listCalendarSubjects().map((row) => [row.subject.bangumiId, row.weekday]), [[2, 5]]);
  assert.ok(repository.findById(1));
  assert.deepEqual(repository.findCalendarSyncState(), {
    lastSucceededAt: LATER,
    lastAttemptedAt: LATER,
    consecutiveFailures: 0,
    lastError: null,
  });
});

test("calendar failure updates only sync state and preserves the snapshot", (t) => {
  const { repository } = createRepository(t);
  repository.replaceCalendarSnapshot([{ metadata: summary(1), weekday: 1 }], { now: NOW });
  const before = repository.listCalendarSubjects();

  repository.recordCalendarSyncFailure({ now: LATER, error: "calendar unavailable" });
  assert.deepEqual(repository.listCalendarSubjects(), before);
  assert.deepEqual(repository.findCalendarSyncState(), {
    lastSucceededAt: NOW,
    lastAttemptedAt: LATER,
    consecutiveFailures: 1,
    lastError: "calendar unavailable",
  });
});
