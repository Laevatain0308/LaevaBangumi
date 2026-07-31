function tableColumns(connection, tableName) {
  return connection.prepare(`PRAGMA table_info(${tableName})`).all();
}

export function initBangumiMetadataSchema(connection) {
  const refreshStateColumns = tableColumns(connection, "bangumi_subject_refresh_state");
  if (refreshStateColumns.length > 0 && !refreshStateColumns.some((row) => row.name === "updated_at")) {
    connection.exec("DROP TABLE bangumi_subject_refresh_state");
  }

  connection.exec(`
    CREATE TABLE IF NOT EXISTS bangumi_subjects (
      bangumi_id INTEGER PRIMARY KEY CHECK (bangumi_id > 0),
      name TEXT NOT NULL,
      name_cn TEXT,
      summary TEXT,
      air_date TEXT,
      air_weekday INTEGER CHECK (air_weekday BETWEEN 1 AND 7),
      platform TEXT,
      eps INTEGER,
      total_episodes INTEGER,
      volumes INTEGER,
      series INTEGER CHECK (series IS NULL OR series IN (0, 1)),
      locked INTEGER CHECK (locked IS NULL OR locked IN (0, 1)),
      nsfw INTEGER CHECK (nsfw IS NULL OR nsfw IN (0, 1)),
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bangumi_subject_images (
      bangumi_id INTEGER PRIMARY KEY REFERENCES bangumi_subjects(bangumi_id) ON DELETE CASCADE,
      large_url TEXT,
      common_url TEXT,
      medium_url TEXT,
      small_url TEXT,
      grid_url TEXT
    );

    CREATE TABLE IF NOT EXISTS bangumi_subject_rating (
      bangumi_id INTEGER PRIMARY KEY REFERENCES bangumi_subjects(bangumi_id) ON DELETE CASCADE,
      score REAL,
      rank INTEGER,
      total INTEGER,
      count_1 INTEGER NOT NULL DEFAULT 0,
      count_2 INTEGER NOT NULL DEFAULT 0,
      count_3 INTEGER NOT NULL DEFAULT 0,
      count_4 INTEGER NOT NULL DEFAULT 0,
      count_5 INTEGER NOT NULL DEFAULT 0,
      count_6 INTEGER NOT NULL DEFAULT 0,
      count_7 INTEGER NOT NULL DEFAULT 0,
      count_8 INTEGER NOT NULL DEFAULT 0,
      count_9 INTEGER NOT NULL DEFAULT 0,
      count_10 INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bangumi_subject_collection (
      bangumi_id INTEGER PRIMARY KEY REFERENCES bangumi_subjects(bangumi_id) ON DELETE CASCADE,
      wish INTEGER NOT NULL DEFAULT 0,
      collect INTEGER NOT NULL DEFAULT 0,
      doing INTEGER NOT NULL DEFAULT 0,
      on_hold INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bangumi_subject_tags (
      bangumi_id INTEGER NOT NULL REFERENCES bangumi_subjects(bangumi_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      name TEXT NOT NULL,
      count INTEGER NOT NULL,
      total_count INTEGER NOT NULL,
      PRIMARY KEY (bangumi_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_bangumi_subject_tags_name
      ON bangumi_subject_tags(name);

    CREATE TABLE IF NOT EXISTS bangumi_subject_meta_tags (
      bangumi_id INTEGER NOT NULL REFERENCES bangumi_subjects(bangumi_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      name TEXT NOT NULL,
      PRIMARY KEY (bangumi_id, position)
    );

    CREATE TABLE IF NOT EXISTS bangumi_subject_infobox_entries (
      bangumi_id INTEGER NOT NULL REFERENCES bangumi_subjects(bangumi_id) ON DELETE CASCADE,
      entry_position INTEGER NOT NULL CHECK (entry_position >= 0),
      key TEXT NOT NULL,
      value_kind TEXT NOT NULL CHECK (value_kind IN ('scalar', 'list')),
      PRIMARY KEY (bangumi_id, entry_position)
    );

    CREATE TABLE IF NOT EXISTS bangumi_subject_infobox_values (
      bangumi_id INTEGER NOT NULL,
      entry_position INTEGER NOT NULL,
      value_position INTEGER NOT NULL CHECK (value_position >= 0),
      label TEXT,
      value TEXT NOT NULL,
      PRIMARY KEY (bangumi_id, entry_position, value_position),
      FOREIGN KEY (bangumi_id, entry_position)
        REFERENCES bangumi_subject_infobox_entries(bangumi_id, entry_position)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bangumi_subject_refresh_state (
      bangumi_id INTEGER PRIMARY KEY CHECK (bangumi_id > 0),
      last_succeeded_at TEXT,
      next_refresh_at TEXT NOT NULL,
      last_attempted_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bangumi_subject_refresh_due
      ON bangumi_subject_refresh_state(next_refresh_at);

    CREATE TABLE IF NOT EXISTS bangumi_calendar_subjects (
      bangumi_id INTEGER PRIMARY KEY REFERENCES bangumi_subjects(bangumi_id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7)
    );

    CREATE INDEX IF NOT EXISTS idx_bangumi_calendar_subjects_weekday
      ON bangumi_calendar_subjects(weekday);

    CREATE TABLE IF NOT EXISTS bangumi_calendar_sync_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      last_succeeded_at TEXT,
      last_attempted_at TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      last_error TEXT
    );
  `);
}
