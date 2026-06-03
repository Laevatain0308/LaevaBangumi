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
  sqlite.exec(`
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
    SELECT anime_id, source, 'mapping', retry_count, retry_at, updated_at
    FROM match_retry_state
    WHERE anime_id IN (SELECT bangumi_id FROM subjects)
    ON CONFLICT(bangumi_id, source, kind) DO NOTHING;

    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
    SELECT anime_id, source, 'episode_fetch', retry_count, retry_at, updated_at
    FROM episode_fetch_retry_state
    WHERE anime_id IN (SELECT bangumi_id FROM subjects)
    ON CONFLICT(bangumi_id, source, kind) DO NOTHING;

    INSERT INTO manual_resource_state (bangumi_id, source, status, note, updated_at)
    SELECT anime_id, source, status, note, updated_at
    FROM manual_match_state
    WHERE anime_id IN (SELECT bangumi_id FROM subjects)
    ON CONFLICT(bangumi_id, source) DO NOTHING;

    INSERT INTO sync_state (source, scope, last_seen_at, last_success_at, updated_at)
    SELECT source, category, last_seen_at, last_success_at, updated_at
    FROM source_sync_state
    WHERE true
    ON CONFLICT(source, scope) DO NOTHING;
  `);
}

function createEpisodesTable() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anime_id INTEGER REFERENCES anime(id),
      bangumi_id INTEGER REFERENCES subjects(bangumi_id),
      source_name TEXT,
      source TEXT,
      source_aid INTEGER NOT NULL,
      ep_index INTEGER NOT NULL,
      source_ep_index INTEGER,
      ep_name TEXT,
      video_url TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ep_unique
      ON episodes(anime_id, source_name, source_aid, ep_index);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_resource_unique
      ON episodes(bangumi_id, source, source_aid, ep_index);
  `);
}

function migrateEpisodesTableIfNeeded() {
  const columns = tableColumns("episodes");
  if (columns.size === 0) {
    createEpisodesTable();
    return;
  }
  if (columns.has("bangumi_id") && columns.has("source")) return;

  const legacyName = "episodes_legacy_before_subjects";
  if (!tableExists(legacyName)) {
    sqlite.exec(`ALTER TABLE episodes RENAME TO ${legacyName};`);
  } else {
    sqlite.exec("DROP TABLE episodes;");
  }
  createEpisodesTable();
  sqlite.exec(`
    INSERT INTO episodes (
      id, anime_id, bangumi_id, source_name, source, source_aid, ep_index,
      source_ep_index, ep_name, video_url, updated_at
    )
    SELECT
      id, anime_id, anime_id, source_name, source_name, source_aid, ep_index,
      source_ep_index, ep_name, video_url, updated_at
    FROM ${legacyName};
  `);
}

export function initDb() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS anime (
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
      has_cover INTEGER DEFAULT 0,
      rating_score REAL,
      rank INTEGER,
      tags TEXT,
      sources_json TEXT,
      detail_fetched_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bangumi_cstation_map (
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_map_unique
      ON bangumi_cstation_map(anime_id, source);

    CREATE TABLE IF NOT EXISTS match_retry_state (
      anime_id INTEGER NOT NULL REFERENCES anime(id),
      source TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_match_retry_state_unique
      ON match_retry_state(anime_id, source);

    CREATE TABLE IF NOT EXISTS episode_fetch_retry_state (
      anime_id INTEGER NOT NULL REFERENCES anime(id),
      source TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_fetch_retry_state_unique
      ON episode_fetch_retry_state(anime_id, source);

    CREATE TABLE IF NOT EXISTS manual_match_state (
      anime_id INTEGER NOT NULL REFERENCES anime(id),
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_match_state_unique
      ON manual_match_state(anime_id, source);

    CREATE TABLE IF NOT EXISTS cstation_catalog (
      source TEXT NOT NULL,
      id INTEGER NOT NULL,
      category TEXT,
      name TEXT NOT NULL,
      subname TEXT,
      year TEXT,
      last TEXT,
      detail_fetched_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_unique
      ON cstation_catalog(source, id);

    CREATE TABLE IF NOT EXISTS source_sync_state (
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      last_seen_at TEXT,
      last_success_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_source_sync_unique
      ON source_sync_state(source, category);

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

    CREATE TABLE IF NOT EXISTS sync_state (
      source TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      last_started_at TEXT,
      last_seen_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source, scope)
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

  migrateEpisodesTableIfNeeded();
  addColumnIfMissing("resource_sources", "priority", "INTEGER NOT NULL DEFAULT 100");
  addColumnIfMissing("retry_state", "last_error", "TEXT");
  addColumnIfMissing("resource_mappings", "status", "TEXT NOT NULL DEFAULT 'matched'");
  addColumnIfMissing("resource_mappings", "note", "TEXT");
  addColumnIfMissing("sync_state", "status", "TEXT NOT NULL DEFAULT 'success'");
  addColumnIfMissing("sync_state", "last_started_at", "TEXT");
  addColumnIfMissing("sync_state", "last_error", "TEXT");
  addColumnIfMissing("resource_mappings", "updated_at", "TEXT");
  sqlite.exec(`
    UPDATE sync_state
    SET status = COALESCE(status, 'success')
    WHERE status IS NULL;
  `);
  sqlite.exec(`
    UPDATE resource_mappings
    SET updated_at = COALESCE(updated_at, matched_at, datetime('now'))
    WHERE updated_at IS NULL;
  `);
  sqlite.exec(`
    INSERT OR IGNORE INTO resource_sources (source, name, enabled)
      VALUES ('ffzy', '非凡资源', 1);

    INSERT OR IGNORE INTO resource_sources (source, name, enabled)
    SELECT DISTINCT source, source, 1
    FROM bangumi_cstation_map
    WHERE source IS NOT NULL;

    INSERT OR IGNORE INTO resource_sources (source, name, enabled)
    SELECT DISTINCT source, source, 1
    FROM cstation_catalog
    WHERE source IS NOT NULL;

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

    DELETE FROM resource_mappings
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM resource_mappings
      GROUP BY source, source_aid
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_mappings_source_aid_unique
      ON resource_mappings(source, source_aid);

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

    UPDATE episodes
    SET bangumi_id = COALESCE(bangumi_id, anime_id),
        source = COALESCE(source, source_name)
    WHERE bangumi_id IS NULL OR source IS NULL;

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

    CREATE TRIGGER IF NOT EXISTS trg_anime_subjects_ai
    AFTER INSERT ON anime
    BEGIN
      INSERT INTO subjects (
        bangumi_id, name, name_cn, summary, platform, air_date, air_weekday,
        calendar_weekday, eps, total_episodes, cover_url, has_cover,
        rating_score, rating_rank, metadata_fetched_at, created_at, updated_at
      )
      VALUES (
        NEW.id, NEW.name, NEW.name_cn, NEW.summary, NEW.platform, NEW.air_date, NEW.air_weekday,
        NEW.calendar_weekday, NEW.eps, NEW.total_episodes, NEW.cover_url, COALESCE(NEW.has_cover, 0),
        NEW.rating_score, NEW.rank, NEW.detail_fetched_at, NEW.created_at, NEW.updated_at
      )
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
    END;

    CREATE TRIGGER IF NOT EXISTS trg_anime_subjects_au
    AFTER UPDATE ON anime
    BEGIN
      INSERT INTO subjects (
        bangumi_id, name, name_cn, summary, platform, air_date, air_weekday,
        calendar_weekday, eps, total_episodes, cover_url, has_cover,
        rating_score, rating_rank, metadata_fetched_at, created_at, updated_at
      )
      VALUES (
        NEW.id, NEW.name, NEW.name_cn, NEW.summary, NEW.platform, NEW.air_date, NEW.air_weekday,
        NEW.calendar_weekday, NEW.eps, NEW.total_episodes, NEW.cover_url, COALESCE(NEW.has_cover, 0),
        NEW.rating_score, NEW.rank, NEW.detail_fetched_at, NEW.created_at, NEW.updated_at
      )
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
    END;

    CREATE TRIGGER IF NOT EXISTS trg_cstation_catalog_resource_items_ai
    AFTER INSERT ON cstation_catalog
    BEGIN
      INSERT OR IGNORE INTO resource_sources (source, name, enabled)
      VALUES (NEW.source, NEW.source, 1);

      INSERT INTO resource_items (
        source, source_aid, title, subtitle, category, year, latest_text, detail_fetched_at
      )
      VALUES (
        NEW.source, NEW.id, NEW.name, NEW.subname, NEW.category, NEW.year, NEW.last, NEW.detail_fetched_at
      )
      ON CONFLICT(source, source_aid) DO UPDATE SET
        title = excluded.title,
        subtitle = excluded.subtitle,
        category = excluded.category,
        year = excluded.year,
        latest_text = COALESCE(excluded.latest_text, resource_items.latest_text),
        detail_fetched_at = COALESCE(excluded.detail_fetched_at, resource_items.detail_fetched_at),
        updated_at = datetime('now');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_cstation_catalog_resource_items_au
    AFTER UPDATE ON cstation_catalog
    BEGIN
      INSERT INTO resource_items (
        source, source_aid, title, subtitle, category, year, latest_text, detail_fetched_at
      )
      VALUES (
        NEW.source, NEW.id, NEW.name, NEW.subname, NEW.category, NEW.year, NEW.last, NEW.detail_fetched_at
      )
      ON CONFLICT(source, source_aid) DO UPDATE SET
        title = excluded.title,
        subtitle = excluded.subtitle,
        category = excluded.category,
        year = excluded.year,
        latest_text = COALESCE(excluded.latest_text, resource_items.latest_text),
        detail_fetched_at = COALESCE(excluded.detail_fetched_at, resource_items.detail_fetched_at),
        updated_at = datetime('now');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_bangumi_cstation_map_resource_mappings_ai
    AFTER INSERT ON bangumi_cstation_map
    BEGIN
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
      WHERE id = NEW.anime_id
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

      INSERT OR IGNORE INTO resource_sources (source, name, enabled)
      VALUES (NEW.source, NEW.source, 1);

      INSERT INTO resource_mappings (
        bangumi_id, source, source_aid, source_ep_start, source_ep_end,
        display_ep_offset, score, matched_bg_name, matched_resource_name, matched_at, updated_at
      )
      SELECT
        NEW.anime_id, NEW.source, NEW.cstation_id, NEW.source_ep_start, NEW.source_ep_end,
        NEW.display_ep_offset, NEW.score, NEW.matched_bg_name, NEW.matched_cs_name, NEW.matched_at,
        COALESCE(NEW.matched_at, datetime('now'))
      WHERE EXISTS (SELECT 1 FROM subjects WHERE bangumi_id = NEW.anime_id)
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
    END;

    CREATE TRIGGER IF NOT EXISTS trg_match_retry_state_retry_ai
    AFTER INSERT ON match_retry_state
    BEGIN
      INSERT INTO subjects (bangumi_id, name, name_cn, summary, platform, air_date, air_weekday, calendar_weekday, eps, total_episodes, cover_url, has_cover, rating_score, rating_rank, metadata_fetched_at, created_at, updated_at)
      SELECT id, name, name_cn, summary, platform, air_date, air_weekday, calendar_weekday, eps, total_episodes, cover_url, COALESCE(has_cover, 0), rating_score, rank, detail_fetched_at, created_at, updated_at
      FROM anime
      WHERE id = NEW.anime_id
      AND true
      ON CONFLICT(bangumi_id) DO NOTHING;

      INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
      VALUES (NEW.anime_id, NEW.source, 'mapping', NEW.retry_count, NEW.retry_at, NEW.updated_at)
      ON CONFLICT(bangumi_id, source, kind) DO UPDATE SET
        retry_count = excluded.retry_count,
        retry_at = excluded.retry_at,
        updated_at = excluded.updated_at;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_match_retry_state_retry_au
    AFTER UPDATE ON match_retry_state
    BEGIN
      INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
      VALUES (NEW.anime_id, NEW.source, 'mapping', NEW.retry_count, NEW.retry_at, NEW.updated_at)
      ON CONFLICT(bangumi_id, source, kind) DO UPDATE SET
        retry_count = excluded.retry_count,
        retry_at = excluded.retry_at,
        updated_at = excluded.updated_at;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_manual_match_state_resource_ai
    AFTER INSERT ON manual_match_state
    BEGIN
      INSERT INTO subjects (bangumi_id, name, name_cn, summary, platform, air_date, air_weekday, calendar_weekday, eps, total_episodes, cover_url, has_cover, rating_score, rating_rank, metadata_fetched_at, created_at, updated_at)
      SELECT id, name, name_cn, summary, platform, air_date, air_weekday, calendar_weekday, eps, total_episodes, cover_url, COALESCE(has_cover, 0), rating_score, rank, detail_fetched_at, created_at, updated_at
      FROM anime
      WHERE id = NEW.anime_id
      AND true
      ON CONFLICT(bangumi_id) DO NOTHING;

      INSERT INTO manual_resource_state (bangumi_id, source, status, note, updated_at)
      VALUES (NEW.anime_id, NEW.source, NEW.status, NEW.note, NEW.updated_at)
      ON CONFLICT(bangumi_id, source) DO UPDATE SET
        status = excluded.status,
        note = excluded.note,
        updated_at = excluded.updated_at;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_manual_match_state_resource_au
    AFTER UPDATE ON manual_match_state
    BEGIN
      INSERT INTO manual_resource_state (bangumi_id, source, status, note, updated_at)
      VALUES (NEW.anime_id, NEW.source, NEW.status, NEW.note, NEW.updated_at)
      ON CONFLICT(bangumi_id, source) DO UPDATE SET
        status = excluded.status,
        note = excluded.note,
        updated_at = excluded.updated_at;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_episodes_normalized_ai
    AFTER INSERT ON episodes
    BEGIN
      UPDATE episodes
      SET bangumi_id = COALESCE(NEW.bangumi_id, NEW.anime_id),
          source = COALESCE(NEW.source, NEW.source_name)
      WHERE id = NEW.id;
    END;
  `);

  migrateLegacyAliasesAndTags();
  migrateLegacyStateRows();
}
