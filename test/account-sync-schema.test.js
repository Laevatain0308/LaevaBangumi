import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getTableColumns } from "drizzle-orm";
import { initAccountSyncSchema } from "../src/db/accountSyncSchema.js";
import { syncEvents, watchProgress } from "../src/db/schema.js";

const PRIVATE_TABLES = [
  "accounts",
  "account_devices",
  "account_tokens",
  "sync_events",
  "watch_records",
  "watch_progress",
  "watch_tombstones",
  "watch_state",
  "collection_records",
  "collection_tombstones",
  "collection_state",
];

function createAccountSyncDatabase(t) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  initAccountSyncSchema(sqlite);
  t.after(() => sqlite.close());
  return sqlite;
}

function insertAccount(sqlite) {
  return Number(sqlite.prepare(`
    INSERT INTO accounts (username, password_hash, created_at, password_changed_at)
    VALUES ('alice', 'password-hash', '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')
  `).run().lastInsertRowid);
}

function insertDevice(sqlite, accountId, deviceId) {
  sqlite.prepare(`
    INSERT INTO account_devices (
      account_id, device_id, device_name, platform, app_version, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'Device', 'test', '1.0.0', '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')
  `).run(accountId, deviceId);
}

function columnShape(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().map(({ name, notnull, pk }) => ({
    name,
    notnull,
    pk,
  }));
}

function assertCheckConstraint(callback) {
  assert.throws(callback, (error) => error.code === "SQLITE_CONSTRAINT_CHECK");
}

test("account sync initializer creates only the new private tables", (t) => {
  const sqlite = createAccountSyncDatabase(t);
  const tableNames = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);

  assert.deepEqual(tableNames, [...PRIVATE_TABLES].sort());
});

test("reused sync tables expose only the new account-based columns", (t) => {
  const sqlite = createAccountSyncDatabase(t);

  assert.deepEqual(columnShape(sqlite, "sync_events"), [
    { name: "account_id", notnull: 1, pk: 1 },
    { name: "event_id", notnull: 1, pk: 2 },
    { name: "device_id", notnull: 1, pk: 0 },
    { name: "seq", notnull: 1, pk: 0 },
    { name: "domain", notnull: 1, pk: 0 },
    { name: "operation", notnull: 1, pk: 0 },
    { name: "bangumi_id", notnull: 0, pk: 0 },
    { name: "updated_at_ms", notnull: 1, pk: 0 },
    { name: "version", notnull: 1, pk: 0 },
    { name: "payload_json", notnull: 1, pk: 0 },
    { name: "received_at", notnull: 1, pk: 0 },
  ]);
  assert.deepEqual(columnShape(sqlite, "watch_progress"), [
    { name: "account_id", notnull: 1, pk: 1 },
    { name: "bangumi_id", notnull: 1, pk: 2 },
    { name: "episode", notnull: 1, pk: 3 },
    { name: "road", notnull: 1, pk: 0 },
    { name: "progress_ms", notnull: 1, pk: 0 },
    { name: "progress_version", notnull: 1, pk: 0 },
  ]);
});

test("Drizzle declarations match the reused sync table columns", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(getTableColumns(syncEvents)).map(([key, column]) => [key, column.name])),
    {
      accountId: "account_id",
      eventId: "event_id",
      deviceId: "device_id",
      seq: "seq",
      domain: "domain",
      operation: "operation",
      bangumiId: "bangumi_id",
      updatedAtMs: "updated_at_ms",
      version: "version",
      payloadJson: "payload_json",
      receivedAt: "received_at",
    },
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(getTableColumns(watchProgress)).map(([key, column]) => [key, column.name])),
    {
      accountId: "account_id",
      bangumiId: "bangumi_id",
      episode: "episode",
      road: "road",
      progressMs: "progress_ms",
      progressVersion: "progress_version",
    },
  );
});

test("watch and collection records accept unknown Bangumi subjects", (t) => {
  const sqlite = createAccountSyncDatabase(t);
  const accountId = insertAccount(sqlite);
  const unknownBangumiId = 987654321;

  sqlite.prepare(`
    INSERT INTO watch_records (
      account_id, bangumi_id, last_watch_episode, last_watch_time_ms,
      last_watch_episode_name, record_version
    ) VALUES (?, ?, 1, 0, 'Episode 1', 'watch-version')
  `).run(accountId, unknownBangumiId);
  sqlite.prepare(`
    INSERT INTO collection_records (
      account_id, bangumi_id, type, collected_at_ms, updated_at_ms, record_version
    ) VALUES (?, ?, 3, 0, 0, 'collection-version')
  `).run(accountId, unknownBangumiId);

  assert.equal(sqlite.prepare("SELECT bangumi_id FROM watch_records").get().bangumi_id, unknownBangumiId);
  assert.equal(sqlite.prepare("SELECT bangumi_id FROM collection_records").get().bangumi_id, unknownBangumiId);
});

test("private records cascade when an account is deleted", (t) => {
  const sqlite = createAccountSyncDatabase(t);
  const accountId = insertAccount(sqlite);

  sqlite.prepare(`
    INSERT INTO account_devices (
      account_id, device_id, device_name, platform, app_version, first_seen_at, last_seen_at
    ) VALUES (?, 'phone', 'Phone', 'ios', '1.0.0', '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO account_tokens (
      account_id, device_id, token_hash, created_at, last_used_at, revoked_at
    ) VALUES (?, 'phone', 'token-hash', '2026-07-16T00:00:00Z', NULL, NULL)
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO sync_events (
      account_id, event_id, device_id, seq, domain, operation, bangumi_id,
      updated_at_ms, version, payload_json, received_at
    ) VALUES (?, 'event-1', 'phone', 0, 'watch', 'upsert', 42, 0, 'event-version', '{}', '2026-07-16T00:00:00Z')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO watch_records (
      account_id, bangumi_id, last_watch_episode, last_watch_time_ms,
      last_watch_episode_name, record_version
    ) VALUES (?, 42, 1, 0, 'Episode 1', 'watch-version')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO watch_progress (
      account_id, bangumi_id, episode, road, progress_ms, progress_version
    ) VALUES (?, 42, 1, 0, 0, 'progress-version')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO watch_tombstones (account_id, bangumi_id, deleted_version)
    VALUES (?, 43, 'watch-delete-version')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO watch_state (account_id, clear_version)
    VALUES (?, 'watch-clear-version')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO collection_records (
      account_id, bangumi_id, type, collected_at_ms, updated_at_ms, record_version
    ) VALUES (?, 42, 3, 0, 0, 'collection-version')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO collection_tombstones (account_id, bangumi_id, deleted_version)
    VALUES (?, 43, 'collection-delete-version')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO collection_state (account_id, clear_version)
    VALUES (?, 'collection-clear-version')
  `).run(accountId);

  sqlite.prepare("DELETE FROM accounts WHERE account_id = ?").run(accountId);

  for (const table of PRIVATE_TABLES) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} should be empty`);
  }
});

test("watch and collection records have no public metadata foreign keys", (t) => {
  const sqlite = createAccountSyncDatabase(t);

  for (const table of ["watch_records", "collection_records"]) {
    const referencedTables = sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all().map((row) => row.table);
    assert.equal(referencedTables.includes("bangumi_subjects"), false, `${table} should not reference bangumi_subjects`);
  }
});

test("account tokens reference devices through a cascading composite foreign key", (t) => {
  const sqlite = createAccountSyncDatabase(t);
  const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(account_tokens)").all()
    .map(({ seq, table, from, to, on_delete: onDelete }) => ({ seq, table, from, to, onDelete }))
    .sort((left, right) => left.seq - right.seq);

  assert.deepEqual(foreignKeys, [
    { seq: 0, table: "account_devices", from: "account_id", to: "account_id", onDelete: "CASCADE" },
    { seq: 1, table: "account_devices", from: "device_id", to: "device_id", onDelete: "CASCADE" },
  ]);
});

test("sync record range checks reject invalid values", (t) => {
  const sqlite = createAccountSyncDatabase(t);
  const accountId = insertAccount(sqlite);
  const insertEvent = sqlite.prepare(`
    INSERT INTO sync_events (
      account_id, event_id, device_id, seq, domain, operation, bangumi_id,
      updated_at_ms, version, payload_json, received_at
    ) VALUES (?, ?, 'phone', ?, ?, 'upsert', 42, 0, 'event-version', '{}', '2026-07-16T00:00:00Z')
  `);

  assertCheckConstraint(() => insertEvent.run(accountId, "negative-seq", -1, "watch"));
  assertCheckConstraint(() => insertEvent.run(accountId, "invalid-domain", 0, "profile"));
  assertCheckConstraint(() => sqlite.prepare(`
    INSERT INTO watch_progress (
      account_id, bangumi_id, episode, road, progress_ms, progress_version
    ) VALUES (?, 42, 0, 0, 0, 'progress-version')
  `).run(accountId));

  const insertCollection = sqlite.prepare(`
    INSERT INTO collection_records (
      account_id, bangumi_id, type, collected_at_ms, updated_at_ms, record_version
    ) VALUES (?, ?, ?, 0, 0, 'collection-version')
  `);
  assertCheckConstraint(() => insertCollection.run(accountId, 43, 0));
  assertCheckConstraint(() => insertCollection.run(accountId, 44, 6));
});

test("account tokens define one active token per device", (t) => {
  const sqlite = createAccountSyncDatabase(t);
  const accountId = insertAccount(sqlite);
  insertDevice(sqlite, accountId, "phone");
  insertDevice(sqlite, accountId, "tablet");
  const index = sqlite.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_account_tokens_active_device'
  `).get();

  assert.ok(index, "active-device token index should exist");
  assert.match(
    index.sql.replace(/\s+/g, " "),
    /CREATE UNIQUE INDEX .* ON account_tokens\(account_id, device_id\) WHERE revoked_at IS NULL/i,
  );

  const insertToken = sqlite.prepare(`
    INSERT INTO account_tokens (account_id, device_id, token_hash, created_at, revoked_at)
    VALUES (?, ?, ?, '2026-07-16T00:00:00Z', ?)
  `);
  insertToken.run(accountId, "phone", "phone-token-1", null);
  assert.throws(
    () => insertToken.run(accountId, "phone", "phone-token-2", null),
    (error) => error.code === "SQLITE_CONSTRAINT_UNIQUE",
  );

  sqlite.prepare("UPDATE account_tokens SET revoked_at = '2026-07-16T01:00:00Z' WHERE token_hash = 'phone-token-1'").run();
  insertToken.run(accountId, "phone", "phone-token-2", null);
  insertToken.run(accountId, "tablet", "tablet-token-1", null);

  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM account_tokens WHERE revoked_at IS NULL").get().count,
    2,
  );
});
