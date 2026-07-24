import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initResourceSourceSchema } from "../src/db/resourceSourceSchema.js";
import { initBangumiMetadataSchema } from "../src/db/bangumiMetadataSchema.js";
import { initMappingSchema } from "../src/db/mappingSchema.js";

function createDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  initResourceSourceSchema(sqlite);
  initBangumiMetadataSchema(sqlite);
  initMappingSchema(sqlite);
  return sqlite;
}

function seedSubject(sqlite, bangumiId) {
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (
      bangumi_id, name, discovered_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(bangumiId, `Subject ${bangumiId}`, "2026-07-25", "2026-07-25");
}

function seedSourceItem(sqlite, sourceItemId) {
  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, first_seen_at, last_fetched_at
    ) VALUES ('ffzy', ?, ?, '2026-07-25', '2026-07-25')
  `).run(sourceItemId, `Source ${sourceItemId}`);
}

test("mapping schema creates the three isolated domain tables", (t) => {
  const sqlite = createDatabase();
  t.after(() => sqlite.close());

  const tables = sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'bangumi_resource_mappings', 'auto_match_schedule', 'auto_match_exclusions'
    ) ORDER BY name
  `).all().map(({ name }) => name);
  assert.deepEqual(tables, [
    "auto_match_exclusions",
    "auto_match_schedule",
    "bangumi_resource_mappings",
  ]);

  assert.deepEqual(
    sqlite.prepare("PRAGMA table_info(bangumi_resource_mappings)").all().map((row) => row.name),
    [
      "bangumi_id",
      "source_key",
      "source_item_id",
      "source_episode_start",
      "source_episode_end",
    ],
  );
});

test("mapping schema accepts one-to-one and valid segmented rows", (t) => {
  const sqlite = createDatabase();
  t.after(() => sqlite.close());
  for (const id of [1, 2, 3, 4]) seedSubject(sqlite, id);
  for (const id of ["100", "200"]) seedSourceItem(sqlite, id);

  const insert = sqlite.prepare(`
    INSERT INTO bangumi_resource_mappings (
      bangumi_id, source_key, source_item_id,
      source_episode_start, source_episode_end
    ) VALUES (?, 'ffzy', ?, ?, ?)
  `);
  insert.run(1, "100", null, null);
  insert.run(2, "200", 1, 12);
  insert.run(3, "200", 14, null);

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM bangumi_resource_mappings").get().count, 3);
  assert.throws(() => insert.run(4, "200", null, 12), /CHECK constraint failed/i);
});

test("mapping schema enforces normalized subject and source references", (t) => {
  const sqlite = createDatabase();
  t.after(() => sqlite.close());
  seedSubject(sqlite, 1);
  seedSourceItem(sqlite, "100");

  const insert = sqlite.prepare(`
    INSERT INTO bangumi_resource_mappings (
      bangumi_id, source_key, source_item_id,
      source_episode_start, source_episode_end
    ) VALUES (?, ?, ?, NULL, NULL)
  `);
  assert.throws(() => insert.run(999, "ffzy", "100"), /FOREIGN KEY constraint failed/i);
  assert.throws(() => insert.run(1, "missing", "100"), /FOREIGN KEY constraint failed/i);
  assert.throws(() => insert.run(1, "ffzy", "missing"), /FOREIGN KEY constraint failed/i);
});
