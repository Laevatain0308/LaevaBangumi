import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as databaseModule from "../src/db/index.js";

const EXPECTED_TABLES = [
  "account_devices",
  "account_tokens",
  "accounts",
  "auto_match_exclusions",
  "auto_match_schedule",
  "bangumi_calendar_subjects",
  "bangumi_calendar_sync_state",
  "bangumi_resource_mappings",
  "bangumi_subject_collection",
  "bangumi_subject_images",
  "bangumi_subject_infobox_entries",
  "bangumi_subject_infobox_values",
  "bangumi_subject_meta_tags",
  "bangumi_subject_rating",
  "bangumi_subject_refresh_state",
  "bangumi_subject_tags",
  "bangumi_subjects",
  "collection_records",
  "collection_state",
  "collection_tombstones",
  "source_detail_failures",
  "source_episodes",
  "source_item_aliases",
  "source_items",
  "source_sync_state",
  "sync_events",
  "watch_progress",
  "watch_records",
  "watch_state",
  "watch_tombstones",
];

const FORBIDDEN_TABLES = [
  "anime_other",
  "subjects",
  "subject_aliases",
  "tags",
  "subject_tags",
  "resource_sources",
  "resource_items",
  "resource_mappings",
  "episodes",
  "sync_state",
  "retry_state",
  "manual_resource_state",
];

function createFreshDatabase(t) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  t.after(() => sqlite.close());
  return sqlite;
}

function listApplicationTables(sqlite) {
  return sqlite.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(({ name }) => name);
}

test("initDb creates exactly the four normalized domains in a fresh database", (t) => {
  const sqlite = createFreshDatabase(t);
  databaseModule.initDb(sqlite);

  assert.deepEqual(listApplicationTables(sqlite), EXPECTED_TABLES);
  for (const table of FORBIDDEN_TABLES) {
    assert.equal(listApplicationTables(sqlite).includes(table), false, table);
  }
});

test("database entrypoint exposes only the better-sqlite3 connection", () => {
  assert.equal(Object.hasOwn(databaseModule, "db"), false);
  assert.equal(Object.hasOwn(databaseModule, "initLegacyDb"), false);
  assert.equal(typeof databaseModule.sqlite.prepare, "function");
});
