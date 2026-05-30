import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DB_PATH = new URL("../../data/anime.db", import.meta.url).pathname;

export const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

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

    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anime_id INTEGER NOT NULL REFERENCES anime(id),
      source_name TEXT NOT NULL,
      source_aid INTEGER NOT NULL,
      ep_index INTEGER NOT NULL,
      source_ep_index INTEGER,
      ep_name TEXT,
      video_url TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_ep_unique
      ON episodes(anime_id, source_name, source_aid, ep_index);

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
  `);
}
