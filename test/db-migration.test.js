import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { subjects } from "../src/db/schema.js";

const LEGACY_SUBJECT_ID = 990547920;
const LEGACY_SOURCE = "ffzy";
const LEGACY_SOURCE_AID = 990547920;
const LEGACY_SYNC_KEY = "resource:ffzy:legacy_scope_990547920";

function cleanupLegacyFixture() {
  sqlite.exec(`
    DROP TABLE IF EXISTS anime;
    DROP TABLE IF EXISTS cstation_catalog;
    DROP TABLE IF EXISTS bangumi_cstation_map;
    DROP TABLE IF EXISTS match_retry_state;
    DROP TABLE IF EXISTS episode_fetch_retry_state;
    DROP TABLE IF EXISTS manual_match_state;
    DROP TABLE IF EXISTS source_sync_state;

    DELETE FROM episodes
    WHERE bangumi_id = ${LEGACY_SUBJECT_ID}
       OR (source = '${LEGACY_SOURCE}' AND source_aid = ${LEGACY_SOURCE_AID});
    DELETE FROM resource_mappings
    WHERE bangumi_id = ${LEGACY_SUBJECT_ID}
       OR (source = '${LEGACY_SOURCE}' AND source_aid = ${LEGACY_SOURCE_AID});
    DELETE FROM retry_state WHERE bangumi_id = ${LEGACY_SUBJECT_ID};
    DELETE FROM manual_resource_state WHERE bangumi_id = ${LEGACY_SUBJECT_ID};
    DELETE FROM sync_state WHERE key = '${LEGACY_SYNC_KEY}';
    DELETE FROM subject_tags WHERE bangumi_id = ${LEGACY_SUBJECT_ID};
    DELETE FROM subject_aliases WHERE bangumi_id = ${LEGACY_SUBJECT_ID};
    DELETE FROM subjects WHERE bangumi_id = ${LEGACY_SUBJECT_ID};
    DELETE FROM resource_items
    WHERE source = '${LEGACY_SOURCE}' AND source_aid = ${LEGACY_SOURCE_AID};
  `);
}

function createLegacyTablesWithRows() {
  sqlite.exec(`
    CREATE TABLE anime (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_cn TEXT,
      aliases TEXT,
      platform TEXT,
      air_date TEXT,
      air_weekday INTEGER,
      calendar_weekday INTEGER,
      eps INTEGER,
      total_episodes INTEGER,
      summary TEXT,
      cover_url TEXT,
      rating_score REAL,
      rank INTEGER,
      tags TEXT,
      sources_json TEXT,
      detail_fetched_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE cstation_catalog (
      source TEXT NOT NULL,
      id INTEGER NOT NULL,
      category TEXT,
      name TEXT NOT NULL,
      subname TEXT,
      year TEXT,
      last TEXT,
      detail_fetched_at TEXT
    );

    CREATE TABLE bangumi_cstation_map (
      anime_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'ffzy',
      cstation_id INTEGER NOT NULL,
      source_ep_start INTEGER,
      source_ep_end INTEGER,
      display_ep_offset INTEGER NOT NULL DEFAULT 0,
      score REAL,
      matched_bg_name TEXT,
      matched_cs_name TEXT,
      matched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE match_retry_state (
      anime_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE episode_fetch_retry_state (
      anime_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE manual_match_state (
      anime_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE source_sync_state (
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      last_seen_at TEXT,
      last_success_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO anime (
      id, name, name_cn, aliases, platform, air_date, air_weekday,
      calendar_weekday, eps, total_episodes, summary, cover_url,
      rating_score, rank, tags, detail_fetched_at, created_at, updated_at
    ) VALUES (
      ${LEGACY_SUBJECT_ID}, 'Legacy Migration Raw', '迁移中文名',
      '["迁移别名"]', 'TV', '2026-04-03', 5, 5, 13, 13,
      'legacy migration summary', 'https://example.invalid/migration-cover.jpg',
      7.2, 2468, '["迁移Tag"]', '2026-06-03 01:00:00',
      '2026-06-03 00:00:00', '2026-06-03 01:00:00'
    );

    INSERT INTO cstation_catalog (
      source, id, category, name, subname, year, last, detail_fetched_at
    ) VALUES (
      '${LEGACY_SOURCE}', ${LEGACY_SOURCE_AID}, 'TV', '迁移资源站标题',
      '迁移副标题', '2026', '第03集', '2026-06-03 02:00:00'
    );

    INSERT INTO bangumi_cstation_map (
      anime_id, source, cstation_id, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_bg_name, matched_cs_name, matched_at
    ) VALUES (
      ${LEGACY_SUBJECT_ID}, '${LEGACY_SOURCE}', ${LEGACY_SOURCE_AID},
      1, 13, 0, 0.93, '迁移中文名', '迁移资源站标题',
      '2026-06-03 03:00:00'
    );

    INSERT INTO match_retry_state (
      anime_id, source, retry_count, retry_at, updated_at
    ) VALUES (
      ${LEGACY_SUBJECT_ID}, '${LEGACY_SOURCE}', 2,
      '2026-06-03 05:00:00', '2026-06-03 04:30:00'
    );

    INSERT INTO episode_fetch_retry_state (
      anime_id, source, retry_count, retry_at, updated_at
    ) VALUES (
      ${LEGACY_SUBJECT_ID}, '${LEGACY_SOURCE}', 1,
      '2026-06-03 06:00:00', '2026-06-03 05:30:00'
    );

    INSERT INTO manual_match_state (
      anime_id, source, status, note, updated_at
    ) VALUES (
      ${LEGACY_SUBJECT_ID}, '${LEGACY_SOURCE}', 'wait_airing',
      'legacy manual note', '2026-06-03 06:30:00'
    );

    INSERT INTO source_sync_state (
      source, category, last_seen_at, last_success_at, updated_at
    ) VALUES (
      '${LEGACY_SOURCE}', 'legacy_scope_990547920',
      '2026-06-03 07:00:00', '2026-06-03 07:10:00',
      '2026-06-03 07:20:00'
    );
  `);
}

test.beforeEach(() => {
  initDb();
  cleanupLegacyFixture();
});

test.afterEach(() => {
  cleanupLegacyFixture();
});

test("initDb creates the normalized schema tables", () => {
  initDb();
  const tableNames = new Set(sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name));

  for (const table of [
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
  ]) {
    assert.equal(tableNames.has(table), true, `${table} table should exist`);
  }

  const sourceColumns = new Set(sqlite.prepare("PRAGMA table_info(resource_sources)").all().map((row) => row.name));
  assert.equal(sourceColumns.has("priority"), true, "resource_sources.priority column should exist");
  assert.equal(sourceColumns.has("created_at"), true, "resource_sources.created_at column should exist");
  assert.equal(sourceColumns.has("updated_at"), true, "resource_sources.updated_at column should exist");
  assert.equal(sqlite.prepare("SELECT priority FROM resource_sources WHERE source = 'ffzy'").get().priority, 100);

  const itemColumns = new Set(sqlite.prepare("PRAGMA table_info(resource_items)").all().map((row) => row.name));
  assert.equal(itemColumns.has("created_at"), true, "resource_items.created_at column should exist");
  assert.equal(itemColumns.has("updated_at"), true, "resource_items.updated_at column should exist");

  const retryColumns = new Set(sqlite.prepare("PRAGMA table_info(retry_state)").all().map((row) => row.name));
  assert.equal(retryColumns.has("last_error"), true, "retry_state.last_error column should exist");

  assert.equal(Object.hasOwn(subjects, "hasCover"), false, "subjects.hasCover should not exist");

  const mappingColumns = new Set(sqlite.prepare("PRAGMA table_info(resource_mappings)").all().map((row) => row.name));
  assert.equal(mappingColumns.has("status"), true, "resource_mappings.status column should exist");
  assert.equal(mappingColumns.has("note"), true, "resource_mappings.note column should exist");
  assert.equal(mappingColumns.has("matched_subject_title"), true, "resource_mappings.matched_subject_title column should exist");
  assert.equal(mappingColumns.has("matched_resource_title"), true, "resource_mappings.matched_resource_title column should exist");
  assert.equal(mappingColumns.has("matched_bg_name"), false, "resource_mappings.matched_bg_name column should not exist");
  assert.equal(mappingColumns.has("matched_resource_name"), false, "resource_mappings.matched_resource_name column should not exist");

  const syncColumns = new Set(sqlite.prepare("PRAGMA table_info(sync_state)").all().map((row) => row.name));
  assert.equal(syncColumns.has("key"), true, "sync_state.key column should exist");
  assert.equal(syncColumns.has("source"), false, "sync_state.source column should not exist");
  assert.equal(syncColumns.has("scope"), false, "sync_state.scope column should not exist");
  assert.equal(syncColumns.has("status"), true, "sync_state.status column should exist");
  assert.equal(syncColumns.has("last_started_at"), true, "sync_state.last_started_at column should exist");
  assert.equal(syncColumns.has("last_error"), true, "sync_state.last_error column should exist");

  const indexes = new Set(sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name));
  for (const indexName of [
    "idx_subjects_calendar_weekday",
    "idx_subjects_updated_at",
    "idx_subjects_rating_score",
    "idx_subject_aliases_alias",
    "idx_subject_tags_tag_id",
    "idx_episodes_bangumi_source",
    "idx_resource_items_title",
    "idx_retry_state_retry_at",
  ]) {
    assert.equal(indexes.has(indexName), true, `${indexName} index should exist`);
  }
});

test("initDb ignores legacy runtime tables instead of importing their rows", () => {
  createLegacyTablesWithRows();

  initDb();

  assert.equal(sqlite.prepare("SELECT 1 FROM subjects WHERE bangumi_id = ?").get(LEGACY_SUBJECT_ID), undefined);
  assert.equal(sqlite.prepare("SELECT 1 FROM resource_items WHERE source = ? AND source_aid = ?").get(LEGACY_SOURCE, LEGACY_SOURCE_AID), undefined);
  assert.equal(sqlite.prepare("SELECT 1 FROM resource_mappings WHERE bangumi_id = ? AND source = ?").get(LEGACY_SUBJECT_ID, LEGACY_SOURCE), undefined);
  assert.equal(sqlite.prepare("SELECT 1 FROM retry_state WHERE bangumi_id = ?").get(LEGACY_SUBJECT_ID), undefined);
  assert.equal(sqlite.prepare("SELECT 1 FROM manual_resource_state WHERE bangumi_id = ?").get(LEGACY_SUBJECT_ID), undefined);
  assert.equal(sqlite.prepare("SELECT 1 FROM sync_state WHERE key = ?").get(LEGACY_SYNC_KEY), undefined);
});
