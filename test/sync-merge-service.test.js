import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createSyncRepository } from "../src/sync/syncRepository.js";
import { createSyncMergeService } from "../src/sync/syncMergeService.js";
import { syncVersion } from "../src/sync/syncEventValidator.js";

const NOW = "2026-07-16T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function createContext(t, { ensureMetadata = () => {}, logger = {} } = {}) {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  sqlite.prepare(`
    INSERT INTO accounts (username, password_hash, created_at, password_changed_at)
    VALUES ('alice', 'hash', ?, ?)
  `).run(NOW, NOW);
  const accountId = Number(sqlite.prepare("SELECT account_id FROM accounts").get().account_id);
  sqlite.prepare(`
    INSERT INTO account_devices (
      account_id, device_id, device_name, platform, app_version, first_seen_at, last_seen_at
    ) VALUES (?, 'device-a', NULL, NULL, NULL, ?, ?)
  `).run(accountId, NOW, NOW);
  const clock = () => new Date(NOW);
  const repository = createSyncRepository({ sqlite, clock });
  const service = createSyncMergeService({ repository, ensureMetadata, clock, logger });
  return { sqlite, accountId, repository, service };
}

function watchUpsert({
  eventId,
  updatedAt = NOW_MS,
  bangumiId = 123,
  episode = 1,
  lastWatchEpisode = episode,
  road = 0,
  progressMs = 1_000,
  lastWatchTime = updatedAt,
  lastWatchEpisodeName = `Episode ${lastWatchEpisode}`,
} = {}) {
  return {
    eventId,
    deviceId: "device-a",
    seq: 1,
    domain: "watch",
    op: "watch.upsertProgress",
    updatedAt,
    bangumiId,
    payload: {
      episode,
      lastWatchEpisode,
      road,
      progressMs,
      lastWatchTime,
      lastWatchEpisodeName,
    },
  };
}

function itemEvent({ eventId, updatedAt, domain, op, bangumiId = 123, payload = {} }) {
  return {
    eventId,
    deviceId: "device-a",
    seq: 1,
    domain,
    op,
    updatedAt,
    bangumiId,
    payload,
  };
}

function clearEvent({ eventId, updatedAt, domain }) {
  return {
    eventId,
    deviceId: "device-a",
    seq: 1,
    domain,
    op: `${domain}.clear`,
    updatedAt,
    payload: {},
  };
}

function collectionUpsert({ eventId, updatedAt, bangumiId = 123, type = 2, collectedAt = updatedAt }) {
  return itemEvent({
    eventId,
    updatedAt,
    domain: "collection",
    op: "collection.upsert",
    bangumiId,
    payload: { type, collectedAt },
  });
}

function merge(context, events) {
  return context.service.merge({
    accountId: context.accountId,
    deviceId: "device-a",
    events,
  });
}

test("merge stores the minimal ledger and normalized watch state", (t) => {
  const context = createContext(t);
  const event = watchUpsert({
    eventId: "device-a:1",
    episode: 3,
    road: 2,
    progressMs: 120_000,
    lastWatchEpisodeName: "第 3 集",
  });

  assert.deepEqual(merge(context, [event]), {
    acceptedEventIds: ["device-a:1"],
    duplicateEventIds: [],
  });
  const ledger = context.sqlite.prepare("SELECT * FROM sync_events").get();
  assert.equal(ledger.operation, "watch.upsertProgress");
  assert.equal(ledger.received_at, NOW);
  assert.deepEqual(JSON.parse(ledger.payload_json), event.payload);
  assert.equal(/entityKey|adapterName|bangumiItem|lastSrc/.test(ledger.payload_json), false);
  assert.deepEqual(context.sqlite.prepare("SELECT * FROM watch_records").get(), {
    account_id: context.accountId,
    bangumi_id: 123,
    last_watch_episode: 3,
    last_watch_time_ms: NOW_MS,
    last_watch_episode_name: "第 3 集",
    record_version: syncVersion(NOW_MS, "device-a:1"),
  });
  assert.deepEqual(context.sqlite.prepare("SELECT * FROM watch_progress").get(), {
    account_id: context.accountId,
    bangumi_id: 123,
    episode: 3,
    road: 2,
    progress_ms: 120_000,
    progress_version: syncVersion(NOW_MS, "device-a:1"),
  });
});

test("stored and same-request duplicate IDs never revalidate or reapply business payload", (t) => {
  const context = createContext(t);
  const first = watchUpsert({ eventId: "device-a:duplicate", progressMs: 10 });
  merge(context, [first]);
  const lateMalformedRetry = {
    eventId: first.eventId,
    deviceId: "device-a",
    seq: -1,
    domain: "removed",
    op: "removed",
    updatedAt: NOW_MS - 25 * 60 * 60 * 1_000,
    payload: null,
  };

  assert.deepEqual(merge(context, [lateMalformedRetry]), {
    acceptedEventIds: [],
    duplicateEventIds: [first.eventId],
  });
  assert.equal(context.sqlite.prepare("SELECT progress_ms FROM watch_progress").get().progress_ms, 10);

  const newEvent = watchUpsert({ eventId: "device-a:same-request", progressMs: 20 });
  const malformedSecond = { ...lateMalformedRetry, eventId: newEvent.eventId };
  assert.deepEqual(merge(context, [newEvent, malformedSecond]), {
    acceptedEventIds: [newEvent.eventId],
    duplicateEventIds: [newEvent.eventId],
  });
  assert.equal(context.sqlite.prepare("SELECT progress_ms FROM watch_progress").get().progress_ms, 20);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM sync_events").get().n, 2);
});

test("binary event-id order resolves equal timestamps and episode progress stays independent", (t) => {
  const context = createContext(t);
  merge(context, [
    watchUpsert({ eventId: "device-a:z", episode: 1, progressMs: 900, lastWatchEpisodeName: "winner" }),
    watchUpsert({ eventId: "device-a:a", episode: 2, progressMs: 200, lastWatchEpisodeName: "older" }),
  ]);

  const record = context.sqlite.prepare("SELECT * FROM watch_records").get();
  assert.equal(record.last_watch_episode_name, "winner");
  assert.equal(record.record_version, syncVersion(NOW_MS, "device-a:z"));
  assert.deepEqual(context.sqlite.prepare(`
    SELECT episode, progress_ms, progress_version FROM watch_progress ORDER BY episode
  `).all(), [
    { episode: 1, progress_ms: 900, progress_version: syncVersion(NOW_MS, "device-a:z") },
    { episode: 2, progress_ms: 200, progress_version: syncVersion(NOW_MS, "device-a:a") },
  ]);
});

test("watch delete tombstones block old upserts and a newer upsert revives", (t) => {
  const context = createContext(t);
  const t10 = NOW_MS - 10_000;
  const t20 = NOW_MS - 5_000;
  merge(context, [watchUpsert({ eventId: "watch:10", updatedAt: t10, episode: 1 })]);
  merge(context, [itemEvent({
    eventId: "watch:20",
    updatedAt: t20,
    domain: "watch",
    op: "watch.delete",
  })]);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM watch_records").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM watch_progress").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT deleted_version FROM watch_tombstones").get().deleted_version,
    syncVersion(t20, "watch:20"));

  merge(context, [watchUpsert({ eventId: "watch:15-late", updatedAt: t10 + 1_000 })]);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM watch_records").get().n, 0);
  merge(context, [watchUpsert({ eventId: "watch:30", updatedAt: NOW_MS, progressMs: 30 })]);
  assert.equal(context.sqlite.prepare("SELECT progress_ms FROM watch_progress").get().progress_ms, 30);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM watch_tombstones").get().n, 0);
});

test("late watch clear preserves newer state and blocks events at or below its watermark", (t) => {
  const context = createContext(t);
  const older = NOW_MS - 20_000;
  const clearAt = NOW_MS - 10_000;
  const newer = NOW_MS;
  merge(context, [watchUpsert({ eventId: "watch:old", updatedAt: older, bangumiId: 1 })]);
  merge(context, [watchUpsert({ eventId: "watch:new", updatedAt: newer, bangumiId: 2, progressMs: 2 })]);
  merge(context, [clearEvent({ eventId: "watch:clear", updatedAt: clearAt, domain: "watch" })]);

  assert.deepEqual(context.repository.listWatchRecords(context.accountId).map(({ bangumiId }) => bangumiId), [2]);
  assert.equal(context.repository.findWatchClearVersion(context.accountId), syncVersion(clearAt, "watch:clear"));
  merge(context, [watchUpsert({ eventId: "watch:offline", updatedAt: older + 1, bangumiId: 3 })]);
  assert.deepEqual(context.repository.listWatchRecords(context.accountId).map(({ bangumiId }) => bangumiId), [2]);
});

test("collection delete, revive, and late clear follow the same version rules", (t) => {
  const context = createContext(t);
  const older = NOW_MS - 20_000;
  const deleted = NOW_MS - 15_000;
  const clearAt = NOW_MS - 10_000;
  const newer = NOW_MS;
  merge(context, [collectionUpsert({ eventId: "collection:old", updatedAt: older, bangumiId: 1 })]);
  merge(context, [itemEvent({
    eventId: "collection:delete",
    updatedAt: deleted,
    domain: "collection",
    op: "collection.delete",
    bangumiId: 1,
  })]);
  merge(context, [collectionUpsert({
    eventId: "collection:blocked",
    updatedAt: older + 1,
    bangumiId: 1,
    type: 3,
  })]);
  assert.equal(context.repository.listCollectionRecords(context.accountId).length, 0);
  merge(context, [collectionUpsert({
    eventId: "collection:revive",
    updatedAt: newer,
    bangumiId: 1,
    type: 4,
  })]);
  merge(context, [collectionUpsert({
    eventId: "collection:other-old",
    updatedAt: older,
    bangumiId: 2,
  })]);
  merge(context, [clearEvent({ eventId: "collection:clear", updatedAt: clearAt, domain: "collection" })]);

  assert.deepEqual(context.repository.listCollectionRecords(context.accountId).map(({ bangumiId, type }) => ({
    bangumiId,
    type,
  })), [{ bangumiId: 1, type: 4 }]);
  assert.equal(context.repository.findCollectionClearVersion(context.accountId),
    syncVersion(clearAt, "collection:clear"));
  merge(context, [collectionUpsert({
    eventId: "collection:offline",
    updatedAt: older + 2,
    bangumiId: 3,
  })]);
  assert.deepEqual(context.repository.listCollectionRecords(context.accountId).map(({ bangumiId }) => bangumiId), [1]);
});

test("an invalid new event rolls back prior ledger and state writes in the batch", (t) => {
  const context = createContext(t);
  const valid = watchUpsert({ eventId: "batch:valid" });
  const invalid = watchUpsert({ eventId: "batch:invalid", bangumiId: 0 });

  assert.throws(() => merge(context, [valid, invalid]), /bangumiId/);
  for (const table of ["sync_events", "watch_records", "watch_progress"]) {
    assert.equal(context.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(context.sqlite.prepare("SELECT last_seen_at FROM account_devices").get().last_seen_at, NOW);
});

test("a database failure rolls back the event ledger and normalized state together", (t) => {
  const context = createContext(t);
  context.sqlite.exec(`
    CREATE TRIGGER fail_watch_record_insert
    BEFORE INSERT ON watch_records
    BEGIN
      SELECT RAISE(ABORT, 'watch write failed');
    END;
  `);

  assert.throws(() => merge(context, [watchUpsert({ eventId: "database:failure" })]),
    /watch write failed/);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM sync_events").get().n, 0);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM watch_records").get().n, 0);
});

test("metadata ensure runs post-commit with unique accepted item IDs and cannot roll back sync", (t) => {
  const calls = [];
  const logs = [];
  const context = createContext(t, {
    ensureMetadata(ids) {
      calls.push(ids);
      assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM sync_events").get().n, 3,
        "ensure must run after commit");
      throw new Error("ensure unavailable");
    },
    logger: {
      error(scope, message, meta) {
        logs.push({ scope, message, meta });
      },
    },
  });
  const first = watchUpsert({ eventId: "ensure:watch", bangumiId: 3 });
  const duplicate = { ...first };
  const remove = itemEvent({
    eventId: "ensure:delete",
    updatedAt: NOW_MS,
    domain: "collection",
    op: "collection.delete",
    bangumiId: 2,
  });
  const clear = clearEvent({ eventId: "ensure:clear", updatedAt: NOW_MS, domain: "watch" });

  assert.deepEqual(merge(context, [first, duplicate, remove, clear]), {
    acceptedEventIds: ["ensure:watch", "ensure:delete", "ensure:clear"],
    duplicateEventIds: ["ensure:watch"],
  });
  assert.deepEqual(calls, [[2, 3]]);
  assert.equal(logs.length, 1);
  assert.match(logs[0].meta.message, /ensure unavailable/);
  assert.equal(context.sqlite.prepare("SELECT COUNT(*) AS n FROM sync_events").get().n, 3);
});

test("repository snapshot reads are deterministic", (t) => {
  const context = createContext(t);
  merge(context, [
    watchUpsert({ eventId: "order:watch-2", bangumiId: 2, episode: 2 }),
    watchUpsert({ eventId: "order:watch-1b", bangumiId: 1, episode: 2 }),
    watchUpsert({ eventId: "order:watch-1a", bangumiId: 1, episode: 1 }),
    collectionUpsert({ eventId: "order:collection-2", updatedAt: NOW_MS, bangumiId: 2 }),
    collectionUpsert({ eventId: "order:collection-1", updatedAt: NOW_MS, bangumiId: 1 }),
  ]);

  assert.deepEqual(context.repository.listWatchRecords(context.accountId).map(({ bangumiId }) => bangumiId), [1, 2]);
  assert.deepEqual(context.repository.listWatchProgress(context.accountId).map(({ bangumiId, episode }) => [
    bangumiId,
    episode,
  ]), [[1, 1], [1, 2], [2, 2]]);
  assert.deepEqual(context.repository.listCollectionRecords(context.accountId).map(({ bangumiId }) => bangumiId), [1, 2]);
});
