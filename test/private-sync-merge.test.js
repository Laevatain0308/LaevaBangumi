import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { createSyncUser } from "../src/services/syncTokenService.js";
import {
  mergePrivateSyncEvents,
  syncVersion,
} from "../src/services/privateSyncMergeService.js";

function cleanupSyncFixtures() {
  sqlite.exec(`
    DELETE FROM sync_users WHERE display_name LIKE 'private-sync-merge-%';
  `);
}

function watchUpsert({
  eventId = "device-a:1",
  deviceId = "device-a",
  seq = 1,
  updatedAt = 1000,
  entityKey = "LaevaBangumi1",
  bangumiId = 1,
  episode = 1,
  lastWatchEpisode = episode,
  road = 0,
  progressMs = 10000,
} = {}) {
  return {
    eventId,
    deviceId,
    seq,
    domain: "watch",
    op: "watch.upsertProgress",
    updatedAt,
    entityKey,
    bangumiId,
    payload: {
      entityKey,
      adapterName: "LaevaBangumi",
      bangumiId,
      bangumiItem: item(bangumiId),
      episode,
      lastWatchEpisode,
      road,
      progressMs,
      lastSrc: `https://example.invalid/${bangumiId}/${episode}`,
      lastWatchEpisodeName: `EP${episode}`,
    },
  };
}

function watchDelete({
  eventId = "device-b:1",
  deviceId = "device-b",
  seq = 1,
  updatedAt = 2000,
  entityKey = "LaevaBangumi1",
  bangumiId = 1,
} = {}) {
  return {
    eventId,
    deviceId,
    seq,
    domain: "watch",
    op: "watch.deleteHistory",
    updatedAt,
    entityKey,
    bangumiId,
    payload: { entityKey },
  };
}

function watchClear({
  eventId = "device-b:2",
  deviceId = "device-b",
  seq = 2,
  updatedAt = 2000,
} = {}) {
  return {
    eventId,
    deviceId,
    seq,
    domain: "watch",
    op: "watch.clearAll",
    updatedAt,
    payload: {},
  };
}

function collectionUpsert({
  eventId = "device-a:1",
  deviceId = "device-a",
  seq = 1,
  updatedAt = 1000,
  bangumiId = 1,
  type = 1,
} = {}) {
  return {
    eventId,
    deviceId,
    seq,
    domain: "collection",
    op: "collection.upsert",
    updatedAt,
    bangumiId,
    payload: {
      bangumiId,
      type,
      bangumiItem: item(bangumiId),
      collectedAt: updatedAt,
    },
  };
}

function collectionDelete({
  eventId = "device-b:1",
  deviceId = "device-b",
  seq = 1,
  updatedAt = 2000,
  bangumiId = 1,
} = {}) {
  return {
    eventId,
    deviceId,
    seq,
    domain: "collection",
    op: "collection.delete",
    updatedAt,
    bangumiId,
    payload: { bangumiId },
  };
}

function collectionClear({
  eventId = "device-b:2",
  deviceId = "device-b",
  seq = 2,
  updatedAt = 2000,
} = {}) {
  return {
    eventId,
    deviceId,
    seq,
    domain: "collection",
    op: "collection.clearAll",
    updatedAt,
    payload: {},
  };
}

function item(id) {
  return {
    id,
    type: 2,
    name: `subject ${id}`,
    nameCn: `条目 ${id}`,
    summary: "",
    airDate: "2026-01-01",
    airWeekday: 4,
    images: {},
    tags: [],
    alias: [],
    ratingScore: 0,
    votes: 0,
    votesCount: [],
    info: "",
  };
}

test.beforeEach(() => {
  initDb();
  cleanupSyncFixtures();
});

test.afterEach(() => {
  cleanupSyncFixtures();
});

test("syncVersion sorts by timestamp and event id", () => {
  assert.equal(syncVersion(1000, "b") > syncVersion(1000, "a"), true);
  assert.equal(syncVersion(1001, "a") > syncVersion(1000, "z"), true);
  assert.equal(syncVersion(42, "x"), "0000000000000042|x");
});

test("watch merge keeps per-episode progress while latest item metadata wins", () => {
  const user = createSyncUser("private-sync-merge-Alice");

  const result = mergePrivateSyncEvents({
    userId: user.userId,
    events: [
      watchUpsert({
        eventId: "device-a:1",
        updatedAt: 1000,
        episode: 1,
        progressMs: 10000,
      }),
      watchUpsert({
        eventId: "device-b:1",
        deviceId: "device-b",
        updatedAt: 2000,
        episode: 2,
        progressMs: 20000,
      }),
    ],
  });

  assert.deepEqual(result.acceptedEventIds, ["device-a:1", "device-b:1"]);
  assert.equal(result.snapshot.watch.histories.length, 1);
  const history = result.snapshot.watch.histories[0];
  assert.equal(history.lastWatchEpisode, 2);
  assert.equal(history.progresses["1"].progressMs, 10000);
  assert.equal(history.progresses["2"].progressMs, 20000);
});

test("watch merge keeps explicit last watched episode separate from progress episode", () => {
  const user = createSyncUser("private-sync-merge-WatchEpisode");

  const result = mergePrivateSyncEvents({
    userId: user.userId,
    events: [
      watchUpsert({
        eventId: "device-a:1",
        updatedAt: 1000,
        episode: 1,
        lastWatchEpisode: 3,
        progressMs: 10000,
      }),
    ],
  });

  assert.equal(result.snapshot.watch.histories[0].lastWatchEpisode, 3);
  assert.equal(result.snapshot.watch.histories[0].progresses["1"].progressMs, 10000);
});

test("watch delete tombstone blocks older upserts and newer upserts revive", () => {
  const user = createSyncUser("private-sync-merge-Alice");

  const result = mergePrivateSyncEvents({
    userId: user.userId,
    events: [
      watchUpsert({ eventId: "device-a:1", updatedAt: 1000, episode: 1 }),
      watchDelete({ eventId: "device-b:1", updatedAt: 2000 }),
      watchUpsert({
        eventId: "device-a:2",
        seq: 2,
        updatedAt: 1500,
        episode: 2,
      }),
      watchUpsert({
        eventId: "device-a:3",
        seq: 3,
        updatedAt: 2500,
        episode: 3,
        progressMs: 30000,
      }),
    ],
  });

  assert.equal(result.snapshot.watch.histories.length, 1);
  const history = result.snapshot.watch.histories[0];
  assert.deepEqual(Object.keys(history.progresses), ["3"]);
  assert.equal(history.progresses["3"].progressMs, 30000);
});

test("watch clear blocks older upserts", () => {
  const user = createSyncUser("private-sync-merge-Alice");

  const result = mergePrivateSyncEvents({
    userId: user.userId,
    events: [
      watchUpsert({ eventId: "device-a:1", updatedAt: 1000, episode: 1 }),
      watchClear({ eventId: "device-b:2", updatedAt: 2000 }),
      watchUpsert({
        eventId: "device-a:2",
        seq: 2,
        updatedAt: 1500,
        episode: 2,
      }),
      watchUpsert({
        eventId: "device-a:3",
        seq: 3,
        updatedAt: 2500,
        episode: 3,
      }),
    ],
  });

  assert.equal(result.snapshot.watch.histories.length, 1);
  assert.equal(result.snapshot.watch.histories[0].lastWatchEpisode, 3);
  assert.equal(
    result.snapshot.watch.clearVersion,
    syncVersion(2000, "device-b:2"),
  );
});

test("collection merge handles upsert delete clear and duplicate uploads", () => {
  const user = createSyncUser("private-sync-merge-Alice");

  const first = mergePrivateSyncEvents({
    userId: user.userId,
    events: [
      collectionUpsert({ eventId: "device-a:1", updatedAt: 1000, type: 1 }),
      collectionDelete({ eventId: "device-b:1", updatedAt: 2000 }),
      collectionUpsert({
        eventId: "device-a:2",
        seq: 2,
        updatedAt: 1500,
        type: 4,
      }),
      collectionUpsert({
        eventId: "device-a:3",
        seq: 3,
        updatedAt: 2500,
        type: 2,
      }),
    ],
  });

  assert.equal(first.snapshot.collection.items.length, 1);
  assert.equal(first.snapshot.collection.items[0].type, 2);

  const duplicate = mergePrivateSyncEvents({
    userId: user.userId,
    events: [
      collectionUpsert({
        eventId: "device-a:3",
        seq: 3,
        updatedAt: 2500,
        type: 2,
      }),
      collectionClear({ eventId: "device-b:2", updatedAt: 3000 }),
      collectionUpsert({
        eventId: "device-a:4",
        seq: 4,
        updatedAt: 2800,
        bangumiId: 2,
        type: 1,
      }),
    ],
  });

  assert.deepEqual(duplicate.ignoredDuplicateEventIds, ["device-a:3"]);
  assert.equal(duplicate.snapshot.collection.items.length, 0);
  assert.equal(
    duplicate.snapshot.collection.clearVersion,
    syncVersion(3000, "device-b:2"),
  );
});

test("merge rejects excessive event counts and oversized payloads", () => {
  const user = createSyncUser("private-sync-merge-Limits");

  assert.throws(
    () =>
      mergePrivateSyncEvents({
        userId: user.userId,
        events: Array.from({ length: 101 }, (_, index) =>
          watchClear({ eventId: `device-a:${index}`, seq: index + 1 }),
        ),
      }),
    /Too many sync events/,
  );

  assert.throws(
    () =>
      mergePrivateSyncEvents({
        userId: user.userId,
        events: [watchClear({ eventId: "x".repeat(129) })],
      }),
    /Invalid sync event/,
  );

  assert.throws(
    () =>
      mergePrivateSyncEvents({
        userId: user.userId,
        events: [
          watchUpsert({
            eventId: "device-a:oversized",
            entityKey: "LaevaBangumi2",
            bangumiId: 2,
          }),
        ].map((event) => ({
          ...event,
          payload: {
            ...event.payload,
            bangumiItem: {
              ...event.payload.bangumiItem,
              summary: "x".repeat(65536),
            },
          },
        })),
      }),
    /Sync event payload is too large/,
  );
});

test("merge rejects collection status outside the client range", () => {
  const user = createSyncUser("private-sync-merge-TypeLimit");

  assert.throws(
    () =>
      mergePrivateSyncEvents({
        userId: user.userId,
        events: [collectionUpsert({ type: 6 })],
      }),
    /Invalid collection.upsert payload/,
  );
});
