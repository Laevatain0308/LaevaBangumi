import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DB_PATH = new URL("../../data/anime.db", import.meta.url).pathname;

export const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

function ensureRecommendedIndexes() {
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_subjects_calendar_weekday
      ON subjects(calendar_weekday);

    CREATE INDEX IF NOT EXISTS idx_subjects_updated_at
      ON subjects(updated_at);

    CREATE INDEX IF NOT EXISTS idx_subjects_rating_score
      ON subjects(rating_score);

    CREATE INDEX IF NOT EXISTS idx_subject_aliases_alias
      ON subject_aliases(alias);

    CREATE INDEX IF NOT EXISTS idx_subject_tags_tag_id
      ON subject_tags(tag_id);

    CREATE INDEX IF NOT EXISTS idx_episodes_bangumi_source
      ON episodes(bangumi_id, source, source_aid);

    CREATE INDEX IF NOT EXISTS idx_resource_items_title
      ON resource_items(title);

    CREATE INDEX IF NOT EXISTS idx_retry_state_retry_at
      ON retry_state(retry_at);
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
      priority INTEGER NOT NULL DEFAULT 100,
      base_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source, source_aid)
    );

    CREATE TABLE IF NOT EXISTS resource_mappings (
      bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
      source TEXT NOT NULL REFERENCES resource_sources(source),
      source_aid INTEGER NOT NULL,
      score REAL,
      matched_subject_title TEXT,
      matched_resource_title TEXT,
      source_ep_start INTEGER,
      source_ep_end INTEGER,
      display_ep_offset INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'matched',
      note TEXT,
      matched_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (bangumi_id, source)
    );

    CREATE TABLE IF NOT EXISTS episodes (
      episode_id INTEGER PRIMARY KEY AUTOINCREMENT,
      bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_aid INTEGER NOT NULL,
      ep_index INTEGER NOT NULL,
      source_ep_index INTEGER,
      title TEXT,
      raw_video_url TEXT NOT NULL,
      updated_at TEXT,
      UNIQUE (bangumi_id, source, source_aid, ep_index),
      FOREIGN KEY (source, source_aid)
        REFERENCES resource_items(source, source_aid)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'success',
      last_started_at TEXT,
      last_seen_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    INSERT OR IGNORE INTO resource_sources (source, name, enabled, priority)
      VALUES ('ffzy', '非凡资源', 1, 100);
  `);

  ensureRecommendedIndexes();
}
