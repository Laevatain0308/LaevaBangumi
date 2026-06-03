import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DB_PATH = new URL("../../data/anime.db", import.meta.url).pathname;

export const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

function tableExists(name) {
  return !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function tableColumns(name) {
  if (!tableExists(name)) return new Set();
  return new Set(sqlite.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
}

function addColumnIfMissing(table, column, definition) {
  if (!tableColumns(table).has(column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compactUniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function legacyAliasName(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.alias ?? value.name ?? value.value ?? value.v ?? null;
}

function legacyTagName(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.name ?? value.value ?? value.v ?? null;
}

function legacyJsonList(value, mapper) {
  const parsed = safeJson(value, null);
  if (Array.isArray(parsed)) return compactUniqueStrings(parsed.map(mapper));
  return compactUniqueStrings([parsed]);
}

function migrateLegacyAliasesAndTags() {
  if (!tableExists("anime")) return;

  const rows = sqlite.prepare(`
    SELECT id, aliases, tags
    FROM anime
    WHERE id IN (SELECT bangumi_id FROM subjects)
  `).all();

  const insertAlias = sqlite.prepare(`
    INSERT OR IGNORE INTO subject_aliases (bangumi_id, alias, source)
    VALUES (?, ?, 'legacy')
  `);
  const insertTag = sqlite.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const findTag = sqlite.prepare("SELECT tag_id FROM tags WHERE name = ?");
  const insertSubjectTag = sqlite.prepare(`
    INSERT OR IGNORE INTO subject_tags (
      bangumi_id, tag_id, count, total_count, source, updated_at
    )
    VALUES (?, ?, 0, 0, 'legacy', datetime('now'))
  `);

  sqlite.transaction(() => {
    for (const row of rows) {
      for (const alias of legacyJsonList(row.aliases, legacyAliasName)) {
        insertAlias.run(row.id, alias);
      }

      for (const tag of legacyJsonList(row.tags, legacyTagName)) {
        insertTag.run(tag);
        const tagRow = findTag.get(tag);
        if (tagRow) insertSubjectTag.run(row.id, tagRow.tag_id);
      }
    }
  })();
}

function migrateLegacyStateRows() {
  if (tableExists("match_retry_state")) {
    sqlite.exec(`
      INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
      SELECT anime_id, source, 'mapping', retry_count, retry_at, updated_at
      FROM match_retry_state
      WHERE anime_id IN (SELECT bangumi_id FROM subjects)
      ON CONFLICT(bangumi_id, source, kind) DO NOTHING;
    `);
  }

  if (tableExists("episode_fetch_retry_state")) {
    sqlite.exec(`
      INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
      SELECT anime_id, source, 'episode_fetch', retry_count, retry_at, updated_at
      FROM episode_fetch_retry_state
      WHERE anime_id IN (SELECT bangumi_id FROM subjects)
      ON CONFLICT(bangumi_id, source, kind) DO NOTHING;
    `);
  }

  if (tableExists("manual_match_state")) {
    sqlite.exec(`
      INSERT INTO manual_resource_state (bangumi_id, source, status, note, updated_at)
      SELECT anime_id, source, status, note, updated_at
      FROM manual_match_state
      WHERE anime_id IN (SELECT bangumi_id FROM subjects)
      ON CONFLICT(bangumi_id, source) DO NOTHING;
    `);
  }

  if (tableExists("source_sync_state")) {
    sqlite.exec(`
      INSERT INTO sync_state (key, status, last_seen_at, last_success_at, updated_at)
      SELECT 'resource:' || source || ':' || category, 'success', last_seen_at, last_success_at, updated_at
      FROM source_sync_state
      WHERE true
      ON CONFLICT(key) DO NOTHING;
    `);
  }
}

function dropLegacyRuntimeTables() {
  sqlite.exec(`
    DROP TABLE IF EXISTS episodes_legacy_before_subjects;
    DROP TABLE IF EXISTS episodes_legacy_before_terminal;
    DROP TABLE IF EXISTS sync_state_legacy_before_key;
    DROP TABLE IF EXISTS bangumi_cstation_map;
    DROP TABLE IF EXISTS cstation_catalog;
    DROP TABLE IF EXISTS match_retry_state;
    DROP TABLE IF EXISTS episode_fetch_retry_state;
    DROP TABLE IF EXISTS manual_match_state;
    DROP TABLE IF EXISTS source_sync_state;
    DROP TABLE IF EXISTS anime;
  `);
}

function createSyncStateTable() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'success',
      last_started_at TEXT,
      last_seen_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function migrateSyncStateTableIfNeeded() {
  const columns = tableColumns("sync_state");
  const isTerminal =
    columns.has("key")
    && !columns.has("source")
    && !columns.has("scope");

  if (columns.size === 0 || isTerminal) {
    createSyncStateTable();
  } else {
    const legacyName = "sync_state_legacy_before_key";
    if (!tableExists(legacyName)) {
      sqlite.exec(`ALTER TABLE sync_state RENAME TO ${legacyName};`);
    } else {
      sqlite.exec("DROP TABLE sync_state;");
    }
    createSyncStateTable();
  }

  const legacyName = "sync_state_legacy_before_key";
  if (!tableExists(legacyName)) return;
  const legacyColumns = tableColumns(legacyName);
  const keyExpr = legacyColumns.has("key")
    ? "key"
    : "'resource:' || source || ':' || scope";
  const statusExpr = legacyColumns.has("status") ? "status" : "'success'";
  const lastStartedExpr = legacyColumns.has("last_started_at") ? "last_started_at" : "NULL";
  const lastErrorExpr = legacyColumns.has("last_error") ? "last_error" : "NULL";

  sqlite.exec(`
    INSERT INTO sync_state (
      key, status, last_started_at, last_seen_at, last_success_at, last_error, updated_at
    )
    SELECT
      ${keyExpr},
      COALESCE(${statusExpr}, 'success'),
      ${lastStartedExpr},
      last_seen_at,
      last_success_at,
      ${lastErrorExpr},
      COALESCE(updated_at, datetime('now'))
    FROM ${legacyName}
    WHERE ${keyExpr} IS NOT NULL
    ON CONFLICT(key) DO NOTHING;
  `);
}

function createEpisodesTable() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      episode_id INTEGER PRIMARY KEY AUTOINCREMENT,
      bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_aid INTEGER NOT NULL,
      ep_index INTEGER NOT NULL,
      source_ep_index INTEGER,
      title TEXT,
      raw_video_url TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (bangumi_id, source, source_aid, ep_index),
      FOREIGN KEY (source, source_aid)
        REFERENCES resource_items(source, source_aid)
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_bangumi_source
      ON episodes(bangumi_id, source, source_aid);
  `);
}

function migrateEpisodesTableIfNeeded() {
  const columns = tableColumns("episodes");
  const isTerminal =
    columns.has("episode_id")
    && columns.has("title")
    && columns.has("raw_video_url")
    && !columns.has("anime_id")
    && !columns.has("source_name")
    && !columns.has("ep_name")
    && !columns.has("video_url");

  if (columns.size === 0 || isTerminal) {
    createEpisodesTable();
  } else {
    const legacyName = "episodes_legacy_before_terminal";
    if (!tableExists(legacyName)) {
      sqlite.exec(`ALTER TABLE episodes RENAME TO ${legacyName};`);
    } else {
      sqlite.exec("DROP TABLE episodes;");
    }
    createEpisodesTable();
  }

  const legacyName = "episodes_legacy_before_terminal";
  if (!tableExists(legacyName)) return;
  const legacyColumns = tableColumns(legacyName);
  const idExpr = legacyColumns.has("id") ? "id" : "NULL";
  const bangumiExpr = legacyColumns.has("bangumi_id") && legacyColumns.has("anime_id")
    ? "COALESCE(bangumi_id, anime_id)"
    : legacyColumns.has("bangumi_id") ? "bangumi_id" : "anime_id";
  const sourceExpr = legacyColumns.has("source") && legacyColumns.has("source_name")
    ? "COALESCE(source, source_name)"
    : legacyColumns.has("source") ? "source" : "source_name";
  const titleExpr = legacyColumns.has("title") && legacyColumns.has("ep_name")
    ? "COALESCE(title, ep_name)"
    : legacyColumns.has("title") ? "title" : "ep_name";
  const videoExpr = legacyColumns.has("raw_video_url") && legacyColumns.has("video_url")
    ? "COALESCE(raw_video_url, video_url)"
    : legacyColumns.has("raw_video_url") ? "raw_video_url" : "video_url";

  sqlite.exec(`
    INSERT OR IGNORE INTO resource_sources (source, name, enabled)
    SELECT DISTINCT ${sourceExpr}, ${sourceExpr}, 1
    FROM ${legacyName}
    WHERE ${sourceExpr} IS NOT NULL;

    INSERT OR IGNORE INTO resource_items (source, source_aid, title)
    SELECT DISTINCT ${sourceExpr}, source_aid, ${sourceExpr} || ':' || source_aid
    FROM ${legacyName}
    WHERE ${sourceExpr} IS NOT NULL
      AND source_aid IS NOT NULL;
  `);
  sqlite.exec(`
    INSERT INTO episodes (
      episode_id, bangumi_id, source, source_aid, ep_index,
      source_ep_index, title, raw_video_url, updated_at
    )
    SELECT
      ${idExpr}, ${bangumiExpr}, ${sourceExpr}, source_aid, ep_index,
      source_ep_index, ${titleExpr}, ${videoExpr}, COALESCE(updated_at, datetime('now'))
    FROM ${legacyName}
    WHERE ${bangumiExpr} IN (SELECT bangumi_id FROM subjects)
      AND ${sourceExpr} IS NOT NULL
      AND source_aid IS NOT NULL
      AND ep_index IS NOT NULL
      AND ${videoExpr} IS NOT NULL
    ON CONFLICT(bangumi_id, source, source_aid, ep_index) DO UPDATE SET
      source_ep_index = excluded.source_ep_index,
      title = excluded.title,
      raw_video_url = excluded.raw_video_url,
      updated_at = excluded.updated_at;
  `);
}

function migrateLegacyResourceSources() {
  if (tableExists("bangumi_cstation_map")) {
    sqlite.exec(`
      INSERT OR IGNORE INTO resource_sources (source, name, enabled)
      SELECT DISTINCT source, source, 1
      FROM bangumi_cstation_map
      WHERE source IS NOT NULL;
    `);
  }

  if (tableExists("cstation_catalog")) {
    sqlite.exec(`
      INSERT OR IGNORE INTO resource_sources (source, name, enabled)
      SELECT DISTINCT source, source, 1
      FROM cstation_catalog
      WHERE source IS NOT NULL;
    `);
  }
}

function migrateLegacySubjects() {
  if (!tableExists("anime")) return;
  sqlite.exec(`
    INSERT INTO subjects (
      bangumi_id, name, name_cn, summary, platform, air_date, air_weekday,
      calendar_weekday, eps, total_episodes, cover_url, has_cover,
      rating_score, rating_rank, metadata_fetched_at, created_at, updated_at
    )
    SELECT
      id, name, name_cn, summary, platform, air_date, air_weekday,
      calendar_weekday, eps, total_episodes, cover_url, COALESCE(has_cover, 0),
      rating_score, rank, detail_fetched_at, created_at, updated_at
    FROM anime
    WHERE true
    ON CONFLICT(bangumi_id) DO UPDATE SET
      name = excluded.name,
      name_cn = excluded.name_cn,
      summary = excluded.summary,
      platform = excluded.platform,
      air_date = excluded.air_date,
      air_weekday = excluded.air_weekday,
      calendar_weekday = excluded.calendar_weekday,
      eps = excluded.eps,
      total_episodes = excluded.total_episodes,
      cover_url = excluded.cover_url,
      has_cover = excluded.has_cover,
      rating_score = excluded.rating_score,
      rating_rank = excluded.rating_rank,
      metadata_fetched_at = excluded.metadata_fetched_at,
      updated_at = excluded.updated_at;
  `);
}

function migrateLegacyResourceMappings() {
  if (!tableExists("bangumi_cstation_map")) return;
  sqlite.exec(`
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_bg_name, matched_resource_name, matched_at, updated_at
    )
    SELECT
      anime_id, source, cstation_id, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_bg_name, matched_cs_name, matched_at,
      COALESCE(matched_at, datetime('now'))
    FROM bangumi_cstation_map
    WHERE anime_id IN (SELECT bangumi_id FROM subjects)
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      source_aid = excluded.source_aid,
      source_ep_start = excluded.source_ep_start,
      source_ep_end = excluded.source_ep_end,
      display_ep_offset = excluded.display_ep_offset,
      score = excluded.score,
      matched_bg_name = excluded.matched_bg_name,
      matched_resource_name = excluded.matched_resource_name,
      matched_at = excluded.matched_at,
      updated_at = excluded.updated_at;
  `);
}

function dedupeResourceMappingsAndEnsureIndex() {
  sqlite.exec(`
    DELETE FROM resource_mappings
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM resource_mappings
      GROUP BY source, source_aid
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_mappings_source_aid_unique
      ON resource_mappings(source, source_aid);
  `);
}

function migrateLegacyResourceItems() {
  if (!tableExists("cstation_catalog")) return;
  sqlite.exec(`
    INSERT INTO resource_items (
      source, source_aid, title, subtitle, category, year, latest_text, detail_fetched_at
    )
    SELECT source, id, name, subname, category, year, last, detail_fetched_at
    FROM cstation_catalog
    WHERE true
    ON CONFLICT(source, source_aid) DO UPDATE SET
      title = excluded.title,
      subtitle = excluded.subtitle,
      category = excluded.category,
      year = excluded.year,
      latest_text = COALESCE(excluded.latest_text, resource_items.latest_text),
      detail_fetched_at = COALESCE(excluded.detail_fetched_at, resource_items.detail_fetched_at),
      updated_at = datetime('now');
  `);
}

export function initDb() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS anime_other (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_cn TEXT,
      aliases TEXT,
      platform TEXT,
      summary TEXT,
      cover_url TEXT,
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subjects (
      bangumi_id INTEGER PRIMARY KEY,
      type INTEGER NOT NULL DEFAULT 2,
      name TEXT NOT NULL,
      name_cn TEXT,
      summary TEXT,
      platform TEXT,
      air_date TEXT,
      air_weekday INTEGER,
      calendar_weekday INTEGER,
      eps INTEGER,
      total_episodes INTEGER,
      cover_url TEXT,
      has_cover INTEGER NOT NULL DEFAULT 0,
      rating_score REAL,
      rating_rank INTEGER,
      rating_total INTEGER,
      rating_distribution_json TEXT NOT NULL DEFAULT '[]',
      metadata_fetched_at TEXT,
      rating_fetched_at TEXT,
      calendar_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subject_aliases (
      bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      locale TEXT,
      source TEXT NOT NULL DEFAULT 'bangumi',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (bangumi_id, alias)
    );

    CREATE TABLE IF NOT EXISTS tags (
      tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subject_tags (
      bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
      count INTEGER NOT NULL DEFAULT 0,
      total_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'bangumi',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (bangumi_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS resource_sources (
      source TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      base_url TEXT,
      priority INTEGER NOT NULL DEFAULT 100,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS resource_items (
      source TEXT NOT NULL REFERENCES resource_sources(source),
      source_aid INTEGER NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      category TEXT,
      year TEXT,
      latest_text TEXT,
      detail_fetched_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source, source_aid)
    );

    CREATE TABLE IF NOT EXISTS resource_mappings (
      bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
      source TEXT NOT NULL REFERENCES resource_sources(source),
      source_aid INTEGER NOT NULL,
      source_ep_start INTEGER,
      source_ep_end INTEGER,
      display_ep_offset INTEGER NOT NULL DEFAULT 0,
      score REAL,
      matched_bg_name TEXT,
      matched_resource_name TEXT,
      status TEXT NOT NULL DEFAULT 'matched',
      note TEXT,
      matched_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (bangumi_id, source)
    );

    CREATE TABLE IF NOT EXISTS retry_state (
      bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (bangumi_id, source, kind)
    );

    CREATE TABLE IF NOT EXISTS manual_resource_state (
      bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (bangumi_id, source)
    );

    CREATE INDEX IF NOT EXISTS idx_subject_aliases_alias
      ON subject_aliases(alias);

    CREATE INDEX IF NOT EXISTS idx_subject_tags_tag_id
      ON subject_tags(tag_id);
  `);

  addColumnIfMissing("resource_sources", "priority", "INTEGER NOT NULL DEFAULT 100");
  addColumnIfMissing("retry_state", "last_error", "TEXT");
  addColumnIfMissing("resource_mappings", "status", "TEXT NOT NULL DEFAULT 'matched'");
  addColumnIfMissing("resource_mappings", "note", "TEXT");
  addColumnIfMissing("resource_mappings", "updated_at", "TEXT");
  sqlite.exec(`
    UPDATE resource_mappings
    SET updated_at = COALESCE(updated_at, matched_at, datetime('now'))
    WHERE updated_at IS NULL;
  `);
  sqlite.exec(`
    INSERT OR IGNORE INTO resource_sources (source, name, enabled)
      VALUES ('ffzy', '非凡资源', 1);

    DROP TRIGGER IF EXISTS trg_anime_subjects_ai;
    DROP TRIGGER IF EXISTS trg_anime_subjects_au;
    DROP TRIGGER IF EXISTS trg_cstation_catalog_resource_items_ai;
    DROP TRIGGER IF EXISTS trg_cstation_catalog_resource_items_au;
    DROP TRIGGER IF EXISTS trg_bangumi_cstation_map_resource_mappings_ai;
    DROP TRIGGER IF EXISTS trg_match_retry_state_retry_ai;
    DROP TRIGGER IF EXISTS trg_match_retry_state_retry_au;
    DROP TRIGGER IF EXISTS trg_manual_match_state_resource_ai;
    DROP TRIGGER IF EXISTS trg_manual_match_state_resource_au;
    DROP TRIGGER IF EXISTS trg_episodes_normalized_ai;
  `);

  migrateLegacyResourceSources();
  migrateLegacySubjects();
  migrateLegacyAliasesAndTags();
  migrateLegacyResourceItems();
  migrateLegacyResourceMappings();
  dedupeResourceMappingsAndEnsureIndex();
  migrateEpisodesTableIfNeeded();
  migrateSyncStateTableIfNeeded();
  migrateLegacyStateRows();
  dropLegacyRuntimeTables();
}
