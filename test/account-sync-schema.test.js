import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initAccountSyncSchema } from "../src/db/accountSyncSchema.js";

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

const OLD_PRIVATE_TABLES = [
  "sync_users",
  "sync_credentials",
  "sync_invites",
  "sync_tokens",
  "sync_devices",
  "watch_history_items",
  "watch_deleted_items",
  "watch_clear_state",
  "collection_items",
  "collection_deleted_items",
  "collection_clear_state",
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

test("account sync initializer creates only the new private tables", (t) => {
  const sqlite = createAccountSyncDatabase(t);
  const tableNames = new Set(sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name));

  for (const table of PRIVATE_TABLES) {
    assert.equal(tableNames.has(table), true, `${table} table should exist`);
  }
  for (const table of OLD_PRIVATE_TABLES) {
    assert.equal(tableNames.has(table), false, `${table} table should not exist`);
  }
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

test("account tokens define one active token per device", (t) => {
  const sqlite = createAccountSyncDatabase(t);
  const index = sqlite.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_account_tokens_active_device'
  `).get();

  assert.ok(index, "active-device token index should exist");
  assert.match(
    index.sql.replace(/\s+/g, " "),
    /CREATE UNIQUE INDEX .* ON account_tokens\(account_id, device_id\) WHERE revoked_at IS NULL/i,
  );
});
