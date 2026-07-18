import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  SyncEventValidationError,
  compareSyncVersions,
  normalizeEventIdentity,
  normalizeNewEvent,
  syncVersion,
  validateBatchContainer,
} from "../src/sync/syncEventValidator.js";

const RECEIVED_AT_MS = 1_784_131_200_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function watchUpsert(overrides = {}) {
  const payload = {
    episode: 3,
    lastWatchEpisode: 3,
    road: 0,
    progressMs: 120_000,
    lastWatchTime: RECEIVED_AT_MS,
    lastWatchEpisodeName: "第 3 集",
    ...(overrides.payload ?? {}),
  };
  return {
    eventId: "device-a:1",
    deviceId: "device-a",
    seq: 1,
    domain: "watch",
    op: "watch.upsertProgress",
    updatedAt: RECEIVED_AT_MS,
    bangumiId: 123,
    payload,
    ...overrides,
    payload,
  };
}

function eventFor(operation) {
  const common = {
    eventId: `device-a:${operation}`,
    deviceId: "device-a",
    seq: 1,
    updatedAt: RECEIVED_AT_MS,
    payload: {},
  };
  switch (operation) {
    case "watch.upsertProgress":
      return watchUpsert({ eventId: "device-a:watch-upsert" });
    case "watch.delete":
      return { ...common, domain: "watch", op: operation, bangumiId: 123 };
    case "watch.clear":
      return { ...common, domain: "watch", op: operation };
    case "collection.upsert":
      return {
        ...common,
        domain: "collection",
        op: operation,
        bangumiId: 123,
        payload: { type: 2, collectedAt: RECEIVED_AT_MS },
      };
    case "collection.delete":
      return { ...common, domain: "collection", op: operation, bangumiId: 123 };
    case "collection.clear":
      return { ...common, domain: "collection", op: operation };
    default:
      throw new Error(`unknown fixture operation: ${operation}`);
  }
}

function normalize(event) {
  return normalizeNewEvent(event, {
    expectedDeviceId: "device-a",
    receivedAtMs: RECEIVED_AT_MS,
  });
}

function expectCode(callback, code = "invalid_sync_event") {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof SyncEventValidationError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("sync versions use fixed-width timestamps and SQLite BINARY UTF-8 order", (t) => {
  assert.equal(syncVersion(42, "device-a:1"), "0000000000000042|device-a:1");
  const versions = ["a", "é", "中", "z"].map((eventId) => syncVersion(42, eventId));
  const javascriptOrder = [...versions].sort(compareSyncVersions);

  const sqlite = new Database(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE versions (value TEXT NOT NULL)");
  const insert = sqlite.prepare("INSERT INTO versions (value) VALUES (?)");
  for (const version of versions) insert.run(version);
  const sqliteOrder = sqlite.prepare("SELECT value FROM versions ORDER BY value COLLATE BINARY")
    .all()
    .map(({ value }) => value);

  assert.deepEqual(javascriptOrder, sqliteOrder);
  assert.equal(compareSyncVersions(versions[0], versions[0]), 0);
});

test("batch validation accepts zero through 100 events and rejects other containers", () => {
  assert.deepEqual(validateBatchContainer([]), []);
  const hundred = Array.from({ length: 100 }, () => ({}));
  assert.equal(validateBatchContainer(hundred), hundred);
  for (const invalid of [null, {}, "events", Array.from({ length: 101 }, () => ({}))]) {
    expectCode(() => validateBatchContainer(invalid));
  }
});

test("identity-only parsing validates binding without inspecting stale business fields", () => {
  const duplicateShape = {
    eventId: "device-a:old",
    deviceId: "device-a",
    seq: -1,
    domain: "obsolete",
    op: "removed.operation",
    updatedAt: 0,
    payload: null,
    legacy: true,
  };
  assert.deepEqual(normalizeEventIdentity(duplicateShape, { expectedDeviceId: "device-a" }), {
    eventId: "device-a:old",
    deviceId: "device-a",
  });

  expectCode(
    () => normalizeEventIdentity({ ...duplicateShape, deviceId: "other-device" }, { expectedDeviceId: "device-a" }),
    "device_mismatch",
  );
  for (const event of [
    { eventId: "", deviceId: "device-a" },
    { eventId: "e".repeat(129), deviceId: "device-a" },
    { eventId: "event", deviceId: "" },
    { eventId: "event", deviceId: "d".repeat(129) },
  ]) {
    expectCode(() => normalizeEventIdentity(event, { expectedDeviceId: "device-a" }));
  }
});

test("watch progress normalization returns only the new minimal payload", () => {
  const result = normalize(watchUpsert());
  assert.deepEqual(result, {
    eventId: "device-a:1",
    deviceId: "device-a",
    seq: 1,
    domain: "watch",
    operation: "watch.upsertProgress",
    bangumiId: 123,
    updatedAtMs: RECEIVED_AT_MS,
    receivedAtMs: RECEIVED_AT_MS,
    version: syncVersion(RECEIVED_AT_MS, "device-a:1"),
    payload: {
      episode: 3,
      lastWatchEpisode: 3,
      road: 0,
      progressMs: 120_000,
      lastWatchTime: RECEIVED_AT_MS,
      lastWatchEpisodeName: "第 3 集",
    },
  });
});

test("all six exact operations normalize with matching domains and item keys", () => {
  for (const operation of [
    "watch.upsertProgress",
    "watch.delete",
    "watch.clear",
    "collection.upsert",
    "collection.delete",
    "collection.clear",
  ]) {
    const result = normalize(eventFor(operation));
    assert.equal(result.operation, operation);
    assert.equal(result.domain, operation.split(".")[0]);
    assert.deepEqual(result.payload, eventFor(operation).payload);
    assert.equal(result.bangumiId, operation.endsWith("clear") ? null : 123);
  }
});

test("new events reject unknown, cross-domain, and legacy fields instead of ignoring them", () => {
  for (const event of [
    { ...watchUpsert(), extra: true },
    { ...watchUpsert(), entityKey: "old-key" },
    { ...watchUpsert(), adapterName: "old-adapter" },
    watchUpsert({ payload: { lastSrc: "old-url" } }),
    watchUpsert({ payload: { bangumiItem: {} } }),
    { ...eventFor("watch.delete"), payload: { entityKey: "old-key" } },
    { ...eventFor("watch.delete"), domain: "collection" },
    { ...eventFor("collection.upsert"), op: "collection.unknown" },
  ]) {
    expectCode(() => normalize(event));
  }
});

test("common integer, identifier, and clock-skew boundaries are strict", () => {
  assert.ok(normalize(watchUpsert({ updatedAt: RECEIVED_AT_MS - DAY_MS })));
  assert.ok(normalize(watchUpsert({ updatedAt: RECEIVED_AT_MS + DAY_MS })));
  expectCode(() => normalize(watchUpsert({ updatedAt: RECEIVED_AT_MS - DAY_MS - 1 })), "clock_skew");
  expectCode(() => normalize(watchUpsert({ updatedAt: RECEIVED_AT_MS + DAY_MS + 1 })), "clock_skew");

  for (const event of [
    watchUpsert({ seq: -1 }),
    watchUpsert({ seq: 1.5 }),
    watchUpsert({ updatedAt: -1 }),
    watchUpsert({ updatedAt: Number.MAX_SAFE_INTEGER + 1 }),
    watchUpsert({ bangumiId: 0 }),
    watchUpsert({ bangumiId: 1.5 }),
  ]) {
    expectCode(() => normalize(event));
  }
});

test("watch progress validates exact field types and bounds", () => {
  assert.ok(normalize(watchUpsert({ payload: { lastWatchEpisodeName: "" } })));
  assert.ok(normalize(watchUpsert({ payload: { lastWatchEpisodeName: "x".repeat(256) } })));
  for (const payload of [
    { episode: 0 },
    { episode: 1.5 },
    { lastWatchEpisode: 0 },
    { road: -1 },
    { progressMs: -1 },
    { lastWatchTime: -1 },
    { lastWatchEpisodeName: "x".repeat(257) },
    { lastWatchEpisodeName: null },
  ]) {
    expectCode(() => normalize(watchUpsert({ payload })));
  }
});

test("delete and clear require exact empty payload and correct bangumiId presence", () => {
  for (const operation of ["watch.delete", "collection.delete"]) {
    expectCode(() => normalize({ ...eventFor(operation), bangumiId: 0 }));
    expectCode(() => normalize({ ...eventFor(operation), payload: { unexpected: true } }));
    const { bangumiId: _bangumiId, ...missing } = eventFor(operation);
    expectCode(() => normalize(missing));
  }
  for (const operation of ["watch.clear", "collection.clear"]) {
    expectCode(() => normalize({ ...eventFor(operation), bangumiId: null }));
    expectCode(() => normalize({ ...eventFor(operation), bangumiId: 123 }));
    expectCode(() => normalize({ ...eventFor(operation), payload: { unexpected: true } }));
  }
});

test("collection upsert enforces type 1 through 5 and non-negative collected time", () => {
  for (const type of [1, 2, 3, 4, 5]) {
    assert.equal(normalize({
      ...eventFor("collection.upsert"),
      payload: { type, collectedAt: 0 },
    }).payload.type, type);
  }
  for (const payload of [
    { type: 0, collectedAt: 0 },
    { type: 6, collectedAt: 0 },
    { type: 1.5, collectedAt: 0 },
    { type: 2, collectedAt: -1 },
    { type: 2, collectedAt: 1.5 },
  ]) {
    expectCode(() => normalize({ ...eventFor("collection.upsert"), payload }));
  }
});
