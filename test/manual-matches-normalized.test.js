import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import {
  analyzeMappedMappings,
  analyzeUnmappedMappings,
  importManualReview,
} from "../src/services/manualMatches.js";

const SUBJECT_ID = 990548301;
const SOURCE = "manual_normalized";
const SOURCE_AID = 990548401;

async function withCsv(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "manual-normalized-"));
  const filePath = join(dir, "review.csv");
  await writeFile(filePath, content, "utf8");
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cleanup() {
  sqlite.exec(`
    DELETE FROM episodes WHERE bangumi_id = ${SUBJECT_ID} OR source = '${SOURCE}';
    DELETE FROM resource_mappings WHERE bangumi_id = ${SUBJECT_ID} OR source = '${SOURCE}';
    DELETE FROM retry_state WHERE bangumi_id = ${SUBJECT_ID} OR source = '${SOURCE}';
    DELETE FROM manual_resource_state WHERE bangumi_id = ${SUBJECT_ID} OR source = '${SOURCE}';
    DELETE FROM resource_items WHERE source = '${SOURCE}';
    DELETE FROM resource_sources WHERE source = '${SOURCE}';
    DELETE FROM subject_aliases WHERE bangumi_id = ${SUBJECT_ID};
    DELETE FROM subjects WHERE bangumi_id = ${SUBJECT_ID};
  `);
}

function seedSubjectAndResource() {
  initDb();
  cleanup();
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, name_cn, air_date, rating_distribution_json)
    VALUES (${SUBJECT_ID}, 'Manual Normalized Raw', '手动标准化番剧', '2026-04-01', '[]');
    INSERT INTO subject_aliases (bangumi_id, alias)
    VALUES (${SUBJECT_ID}, 'Manual Normalized Alias');
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('${SOURCE}', 'Manual Normalized Source', 1);
    INSERT INTO resource_items (source, source_aid, title, subtitle, year)
    VALUES ('${SOURCE}', ${SOURCE_AID}, '手动标准化番剧', 'Manual Normalized Alias', '2026');
  `);
}

test.afterEach(() => {
  cleanup();
});

test("manual review exports normalized unmapped retry rows", () => {
  seedSubjectAndResource();
  sqlite.exec(`
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at)
    VALUES (${SUBJECT_ID}, '${SOURCE}', 'mapping', 5, null);
  `);

  const result = analyzeUnmappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === SUBJECT_ID);

  assert.ok(row);
  assert.equal(row.bg_title, "手动标准化番剧");
  assert.equal(row.unmatched_reason, "max_retries");
  assert.deepEqual(JSON.parse(row.bg_aliases), [
    "手动标准化番剧",
    "Manual Normalized Raw",
    "Manual Normalized Alias",
  ]);
});

test("manual review no_resource writes normalized manual and retry state", async () => {
  seedSubjectAndResource();
  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${SUBJECT_ID},no_resource,,manual no resource`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));
  const manual = sqlite.prepare(`
    SELECT status, note FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(SUBJECT_ID, SOURCE);
  const retry = sqlite.prepare(`
    SELECT retry_count, retry_at FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(SUBJECT_ID, SOURCE);

  assert.equal(stats.noResource, 1);
  assert.deepEqual(manual, { status: "no_resource", note: "manual no resource" });
  assert.deepEqual(retry, { retry_count: 5, retry_at: null });
});

test("manual review match writes normalized mapping for mapped review export", async () => {
  seedSubjectAndResource();
  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${SUBJECT_ID},match,${SOURCE_AID},confirmed`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));
  const mapping = sqlite.prepare(`
    SELECT source_aid, matched_bg_name, matched_resource_name
    FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(SUBJECT_ID, SOURCE);
  const review = analyzeMappedMappings({ source: SOURCE });
  const row = review.rows.find((item) => item.anime_id === SUBJECT_ID);

  assert.equal(stats.matched, 1);
  assert.deepEqual(mapping, {
    source_aid: SOURCE_AID,
    matched_bg_name: "手动标准化番剧",
    matched_resource_name: "手动标准化番剧",
  });
  assert.ok(row);
  assert.equal(row.source_aid, SOURCE_AID);
  assert.equal(row.source_title, "手动标准化番剧");
});
