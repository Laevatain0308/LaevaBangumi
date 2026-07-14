import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initResourceSourceSchema } from "../src/db/resourceSourceSchema.js";

function createDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

test("resource source schema creates the independent five-table domain", (t) => {
  const sqlite = createDatabase();
  t.after(() => sqlite.close());

  initResourceSourceSchema(sqlite);

  const tables = new Set(sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name));
  assert.deepEqual([...tables].sort(), [
    "source_detail_failures",
    "source_episodes",
    "source_item_aliases",
    "source_items",
    "source_sync_state",
  ]);
});

test("resource item IDs use text composite keys", (t) => {
  const sqlite = createDatabase();
  t.after(() => sqlite.close());
  initResourceSourceSchema(sqlite);

  const columns = sqlite.prepare("PRAGMA table_info(source_items)").all();
  assert.equal(columns.find((row) => row.name === "source_item_id").type, "TEXT");
  assert.deepEqual(
    columns.filter((row) => row.pk).sort((a, b) => a.pk - b.pk).map((row) => row.name),
    ["source_key", "source_item_id"],
  );

  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, first_seen_at, last_fetched_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run("ffzy", "item-opaque-001", "Fixture", "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z");
  assert.equal(
    sqlite.prepare("SELECT source_item_id FROM source_items").get().source_item_id,
    "item-opaque-001",
  );
});

test("episode indexes must be positive and resource children keep composite foreign keys", (t) => {
  const sqlite = createDatabase();
  t.after(() => sqlite.close());
  initResourceSourceSchema(sqlite);
  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, first_seen_at, last_fetched_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run("ffzy", "98509", "Fixture", "2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z");

  assert.throws(() => sqlite.prepare(`
    INSERT INTO source_episodes (
      source_key, source_item_id, episode_index, title, video_url, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run("ffzy", "98509", 0, "Invalid", "https://example.invalid/0.m3u8", "2026-07-15T00:00:00.000Z"), /CHECK constraint failed/i);

  assert.throws(() => sqlite.prepare(`
    INSERT INTO source_item_aliases (source_key, source_item_id, alias)
    VALUES (?, ?, ?)
  `).run("ffzy", "missing", "Missing resource"), /FOREIGN KEY constraint failed/i);
});

test("obsolete source_sync_state is replaced without importing its rows", (t) => {
  const sqlite = createDatabase();
  t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TABLE source_sync_state (
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      last_seen_at TEXT
    );
    INSERT INTO source_sync_state (source, category, last_seen_at)
    VALUES ('ffzy', '30', '2026-07-14 12:00:00');
  `);

  initResourceSourceSchema(sqlite);

  const columns = sqlite.prepare("PRAGMA table_info(source_sync_state)").all().map((row) => row.name);
  assert.equal(columns.includes("source_key"), true);
  assert.equal(columns.includes("category"), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM source_sync_state").get().count, 0);
});

test("schema initialization is idempotent", (t) => {
  const sqlite = createDatabase();
  t.after(() => sqlite.close());
  initResourceSourceSchema(sqlite);
  initResourceSourceSchema(sqlite);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM source_items").get().count, 0);
});
