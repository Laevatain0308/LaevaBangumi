function tableColumns(connection, tableName) {
  return connection.prepare(`PRAGMA table_info(${tableName})`).all();
}

export function initResourceSourceSchema(connection) {
  const syncColumns = tableColumns(connection, "source_sync_state");
  if (syncColumns.length > 0 && !syncColumns.some((row) => row.name === "source_key")) {
    connection.exec("DROP TABLE source_sync_state");
  }

  connection.exec(`
    CREATE TABLE IF NOT EXISTS source_items (
      source_key TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      year TEXT,
      source_updated_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_fetched_at TEXT NOT NULL,
      detail_fetched_at TEXT,
      PRIMARY KEY (source_key, source_item_id)
    );

    CREATE TABLE IF NOT EXISTS source_item_aliases (
      source_key TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      PRIMARY KEY (source_key, source_item_id, alias),
      FOREIGN KEY (source_key, source_item_id)
        REFERENCES source_items(source_key, source_item_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_episodes (
      source_key TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      episode_index INTEGER NOT NULL CHECK (episode_index >= 1),
      title TEXT NOT NULL,
      video_url TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_key, source_item_id, episode_index),
      FOREIGN KEY (source_key, source_item_id)
        REFERENCES source_items(source_key, source_item_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_sync_state (
      source_key TEXT PRIMARY KEY,
      initialized INTEGER NOT NULL DEFAULT 0,
      watermark_at TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_operation TEXT,
      last_started_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_detail_failures (
      source_key TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      failure_count INTEGER NOT NULL,
      next_retry_at TEXT NOT NULL,
      last_failed_at TEXT NOT NULL,
      last_error TEXT NOT NULL,
      PRIMARY KEY (source_key, source_item_id),
      FOREIGN KEY (source_key, source_item_id)
        REFERENCES source_items(source_key, source_item_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_source_items_title
      ON source_items(source_key, title);
    CREATE INDEX IF NOT EXISTS idx_source_items_updated
      ON source_items(source_key, source_updated_at);
    CREATE INDEX IF NOT EXISTS idx_source_item_aliases_alias
      ON source_item_aliases(source_key, alias);
    CREATE INDEX IF NOT EXISTS idx_source_episodes_item
      ON source_episodes(source_key, source_item_id, episode_index);
    CREATE INDEX IF NOT EXISTS idx_source_detail_failures_due
      ON source_detail_failures(source_key, next_retry_at);
  `);
}
