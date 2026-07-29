import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as accountSchema from "../src/db/schema.js";
import { initDb } from "../src/db/index.js";

const ACCOUNT_SCHEMA_EXPORTS = [
  "accountDevices",
  "accountTokens",
  "accounts",
  "collectionRecords",
  "collectionState",
  "collectionTombstones",
  "syncEvents",
  "watchProgress",
  "watchRecords",
  "watchState",
  "watchTombstones",
];

function createDatabase(t) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  initDb(sqlite);
  t.after(() => sqlite.close());
  return sqlite;
}

test("Drizzle declarations describe only the account and sync domain", () => {
  assert.deepEqual(Object.keys(accountSchema).sort(), ACCOUNT_SCHEMA_EXPORTS);
});

test("mapping facts reference only normalized Bangumi and source facts", (t) => {
  const sqlite = createDatabase(t);
  const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(bangumi_resource_mappings)").all()
    .map(({ table, from, to }) => ({ table, from, to }));

  assert.deepEqual(foreignKeys, [
    { table: "source_items", from: "source_key", to: "source_key" },
    { table: "source_items", from: "source_item_id", to: "source_item_id" },
    { table: "bangumi_subjects", from: "bangumi_id", to: "bangumi_id" },
  ]);
});

test("source episodes retain source-native indexes and immutable ownership", (t) => {
  const sqlite = createDatabase(t);
  const columns = sqlite.prepare("PRAGMA table_info(source_episodes)").all()
    .map(({ name }) => name);

  assert.deepEqual(columns, [
    "source_key",
    "source_item_id",
    "episode_index",
    "title",
    "video_url",
    "updated_at",
  ]);
  assert.equal(columns.includes("bangumi_id"), false);
  assert.equal(columns.includes("display_episode_index"), false);
});

test("private watch and collection records stay independent from public metadata", (t) => {
  const sqlite = createDatabase(t);
  for (const table of ["watch_records", "watch_progress", "collection_records"]) {
    const targets = sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .map(({ table: target }) => target);
    assert.equal(targets.includes("bangumi_subjects"), false, table);
  }
});
