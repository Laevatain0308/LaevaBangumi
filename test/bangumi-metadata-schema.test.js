import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initBangumiMetadataSchema } from "../src/db/bangumiMetadataSchema.js";
import { createTestDatabase } from "./helpers/testDatabase.js";

const REQUIRED_TABLES = [
  "bangumi_subjects",
  "bangumi_subject_images",
  "bangumi_subject_rating",
  "bangumi_subject_collection",
  "bangumi_subject_tags",
  "bangumi_subject_meta_tags",
  "bangumi_subject_infobox_entries",
  "bangumi_subject_infobox_values",
  "bangumi_subject_refresh_state",
  "bangumi_calendar_subjects",
  "bangumi_calendar_sync_state",
];

test("initializes the independent Bangumi metadata schema", (t) => {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const names = sqlite.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => row.name);
  for (const table of REQUIRED_TABLES) assert.ok(names.includes(table), table);

  const subjectColumns = sqlite.prepare("PRAGMA table_info(bangumi_subjects)").all().map((row) => row.name);
  assert.equal(subjectColumns.includes("type"), false);
  assert.equal(subjectColumns.includes("media_type"), false);
  assert.deepEqual(subjectColumns, [
    "bangumi_id", "name", "name_cn", "summary", "air_date", "air_weekday",
    "platform", "eps", "total_episodes", "volumes", "series", "locked",
    "nsfw", "discovered_at", "updated_at",
  ]);
});

test("metadata schema initializer works without legacy tables", (t) => {
  const sqlite = new Database(":memory:");
  t.after(() => sqlite.close());
  sqlite.pragma("foreign_keys = ON");
  initBangumiMetadataSchema(sqlite);
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'bangumi_subjects'").get());
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'subjects'").get(), undefined);
});

test("refresh state supports pending unknown Bangumi IDs", (t) => {
  const sqlite = new Database(":memory:");
  t.after(() => sqlite.close());
  sqlite.pragma("foreign_keys = ON");
  initBangumiMetadataSchema(sqlite);

  const columns = sqlite.prepare("PRAGMA table_info(bangumi_subject_refresh_state)").all();
  assert.deepEqual(columns.map(({ name, notnull, dflt_value: defaultValue }) => ({
    name,
    notnull,
    defaultValue,
  })), [
    { name: "bangumi_id", notnull: 0, defaultValue: null },
    { name: "last_succeeded_at", notnull: 0, defaultValue: null },
    { name: "next_refresh_at", notnull: 1, defaultValue: null },
    { name: "last_attempted_at", notnull: 0, defaultValue: null },
    { name: "consecutive_failures", notnull: 1, defaultValue: "0" },
    { name: "last_error", notnull: 0, defaultValue: null },
    { name: "updated_at", notnull: 1, defaultValue: null },
  ]);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_list(bangumi_subject_refresh_state)").all(), []);

  assert.doesNotThrow(() => sqlite.prepare(`
    INSERT INTO bangumi_subject_refresh_state (bangumi_id, next_refresh_at, updated_at)
    VALUES (99, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run());
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM bangumi_subjects").get().count, 0);
});
