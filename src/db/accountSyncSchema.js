export function initAccountSyncSchema(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      password_changed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_devices (
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      device_name TEXT,
      platform TEXT,
      app_version TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (account_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS account_tokens (
      token_id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (account_id, device_id) REFERENCES account_devices(account_id, device_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tokens_active_device
      ON account_tokens(account_id, device_id) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS sync_events (
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq >= 0),
      domain TEXT NOT NULL CHECK (domain IN ('watch', 'collection')),
      operation TEXT NOT NULL,
      bangumi_id INTEGER,
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (account_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sync_events_account_domain_version
      ON sync_events(account_id, domain, version);

    CREATE INDEX IF NOT EXISTS idx_sync_events_account_device_seq
      ON sync_events(account_id, device_id, seq);

    CREATE TABLE IF NOT EXISTS watch_records (
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
      last_watch_episode INTEGER NOT NULL CHECK (last_watch_episode >= 1),
      last_watch_time_ms INTEGER NOT NULL CHECK (last_watch_time_ms >= 0),
      last_watch_episode_name TEXT NOT NULL,
      record_version TEXT NOT NULL,
      PRIMARY KEY (account_id, bangumi_id)
    );

    CREATE TABLE IF NOT EXISTS watch_progress (
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
      episode INTEGER NOT NULL CHECK (episode >= 1),
      road INTEGER NOT NULL CHECK (road >= 0),
      progress_ms INTEGER NOT NULL CHECK (progress_ms >= 0),
      progress_version TEXT NOT NULL,
      PRIMARY KEY (account_id, bangumi_id, episode)
    );

    CREATE TABLE IF NOT EXISTS watch_tombstones (
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
      deleted_version TEXT NOT NULL,
      PRIMARY KEY (account_id, bangumi_id)
    );

    CREATE TABLE IF NOT EXISTS watch_state (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
      clear_version TEXT
    );

    CREATE TABLE IF NOT EXISTS collection_records (
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
      type INTEGER NOT NULL CHECK (type BETWEEN 1 AND 5),
      collected_at_ms INTEGER NOT NULL CHECK (collected_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      record_version TEXT NOT NULL,
      PRIMARY KEY (account_id, bangumi_id)
    );

    CREATE TABLE IF NOT EXISTS collection_tombstones (
      account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
      bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
      deleted_version TEXT NOT NULL,
      PRIMARY KEY (account_id, bangumi_id)
    );

    CREATE TABLE IF NOT EXISTS collection_state (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
      clear_version TEXT
    );
  `);
}
