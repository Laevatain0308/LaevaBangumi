import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createTestDatabase } from "./helpers/testDatabase.js";
import {
  analyzeMappingThresholds,
  parseAnalyzerArgs,
} from "../src/scripts/analyze-mapping-thresholds.js";

test("threshold analyzer requires an explicit database and validates options", () => {
  assert.deepEqual(parseAnalyzerArgs([
    "--db", "fixture.db", "--source", "ffzy", "--today", "2026-07-25",
  ]), { dbPath: "fixture.db", sourceKey: "ffzy", today: "2026-07-25" });
  assert.throws(() => parseAnalyzerArgs([]), /--db.*required/i);
  assert.throws(() => parseAnalyzerArgs(["--db", "fixture.db", "--today", "2026-02-30"]), /--today/i);
  assert.throws(() => parseAnalyzerArgs(["--db", "fixture.db", "--write"]), /unknown option/i);
});

test("threshold analyzer opens an existing database read-only and reports production score bands", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mapping-thresholds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "fixture.db");
  const fixture = createTestDatabase();
  fixture.sqlite.prepare(`
    INSERT INTO bangumi_subjects (
      bangumi_id, name, name_cn, air_date, discovered_at, updated_at
    ) VALUES (1, 'Bocchi', '孤独摇滚', '2022-10-09', 'now', 'now')
  `).run();
  fixture.sqlite.prepare(`
    INSERT INTO bangumi_subject_refresh_state (
      bangumi_id, last_succeeded_at, next_refresh_at, updated_at
    ) VALUES (1, 'now', 'now', 'now')
  `).run();
  fixture.sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, year,
      first_seen_at, last_fetched_at, detail_fetched_at
    ) VALUES ('ffzy', '100', '孤独摇滚', '2022', 'now', 'now', 'now')
  `).run();
  fixture.sqlite.prepare(`
    INSERT INTO source_episodes (
      source_key, source_item_id, episode_index, title, video_url, updated_at
    ) VALUES ('ffzy', '100', 1, '第1集', 'https://example.invalid/1', 'now')
  `).run();
  fixture.sqlite.prepare(`
    INSERT INTO source_sync_state (source_key, initialized, updated_at)
    VALUES ('ffzy', 1, 'now')
  `).run();
  await fixture.sqlite.backup(dbPath);
  fixture.close();

  const lines = [];
  const report = analyzeMappingThresholds({
    dbPath,
    sourceKey: "ffzy",
    today: "2026-07-25",
    writeLine(line) { lines.push(line); },
  });
  assert.deepEqual(report, [
    { threshold: 0.75, mapped: 1 },
    { threshold: 0.80, mapped: 1 },
    { threshold: 0.85, mapped: 1 },
    { threshold: 0.90, mapped: 1 },
  ]);
  assert.match(lines[0], /^threshold=0\.75 mapped=1$/);

  const readonly = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.equal(readonly.prepare("SELECT COUNT(*) AS count FROM bangumi_resource_mappings").get().count, 0);
  readonly.close();
  assert.throws(() => analyzeMappingThresholds({
    dbPath: join(directory, "missing.db"),
    sourceKey: "ffzy",
    today: "2026-07-25",
  }), /unable to open database/i);
});
