export function initMappingSchema(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS bangumi_resource_mappings (
      bangumi_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_episode_start INTEGER,
      source_episode_end INTEGER,
      PRIMARY KEY (bangumi_id, source_key),
      FOREIGN KEY (bangumi_id)
        REFERENCES bangumi_subjects(bangumi_id),
      FOREIGN KEY (source_key, source_item_id)
        REFERENCES source_items(source_key, source_item_id),
      CHECK (
        (source_episode_start IS NULL AND source_episode_end IS NULL)
        OR (
          source_episode_start IS NOT NULL
          AND source_episode_start >= 1
          AND (source_episode_end IS NULL OR source_episode_end >= source_episode_start)
        )
      )
    );

    CREATE TABLE IF NOT EXISTS auto_match_schedule (
      bangumi_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      eligible_on TEXT NOT NULL,
      PRIMARY KEY (bangumi_id, source_key),
      FOREIGN KEY (bangumi_id) REFERENCES bangumi_subjects(bangumi_id)
    );

    CREATE TABLE IF NOT EXISTS auto_match_exclusions (
      bangumi_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      PRIMARY KEY (bangumi_id, source_key, source_item_id),
      FOREIGN KEY (bangumi_id) REFERENCES bangumi_subjects(bangumi_id),
      FOREIGN KEY (source_key, source_item_id)
        REFERENCES source_items(source_key, source_item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_bangumi_resource_mappings_source_item
      ON bangumi_resource_mappings(source_key, source_item_id);
    CREATE INDEX IF NOT EXISTS idx_auto_match_schedule_eligible
      ON auto_match_schedule(eligible_on, source_key, bangumi_id);
    CREATE INDEX IF NOT EXISTS idx_auto_match_exclusions_source_item
      ON auto_match_exclusions(source_key, source_item_id);
  `);
}
