import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { importManualReview, importMappedReview } from "../src/services/manualMatches.js";

const SOURCE = "manual_validation";
const FIRST_ID = 990562001;
const SECOND_ID = 990562002;
const THIRD_ID = 990562003;
const UNRELATED_FIRST_ID = 990562004;
const UNRELATED_SECOND_ID = 990562005;
const SOURCE_AID = 990562101;
const UNRELATED_SOURCE_AID = 990562102;

async function withCsv(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "manual-import-validation-"));
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
    DELETE FROM episodes WHERE bangumi_id IN (${FIRST_ID}, ${SECOND_ID}, ${THIRD_ID}) OR source = '${SOURCE}';
    DELETE FROM resource_mappings WHERE bangumi_id IN (${FIRST_ID}, ${SECOND_ID}, ${THIRD_ID}, ${UNRELATED_FIRST_ID}, ${UNRELATED_SECOND_ID}) OR source = '${SOURCE}';
    DELETE FROM retry_state WHERE bangumi_id IN (${FIRST_ID}, ${SECOND_ID}, ${THIRD_ID}, ${UNRELATED_FIRST_ID}, ${UNRELATED_SECOND_ID}) OR source = '${SOURCE}';
    DELETE FROM manual_resource_state WHERE bangumi_id IN (${FIRST_ID}, ${SECOND_ID}, ${THIRD_ID}, ${UNRELATED_FIRST_ID}, ${UNRELATED_SECOND_ID}) OR source = '${SOURCE}';
    DELETE FROM resource_items WHERE source = '${SOURCE}';
    DELETE FROM resource_sources WHERE source = '${SOURCE}';
    DELETE FROM subject_aliases WHERE bangumi_id IN (${FIRST_ID}, ${SECOND_ID}, ${THIRD_ID}, ${UNRELATED_FIRST_ID}, ${UNRELATED_SECOND_ID});
    DELETE FROM subjects WHERE bangumi_id IN (${FIRST_ID}, ${SECOND_ID}, ${THIRD_ID}, ${UNRELATED_FIRST_ID}, ${UNRELATED_SECOND_ID});
  `);
}

function seedRows() {
  initDb();
  cleanup();
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, name_cn, air_date, eps, total_episodes, rating_distribution_json)
    VALUES
      (${FIRST_ID}, 'Range Part 1', '分段第一部', '2026-01-01', 12, 12, '[]'),
      (${SECOND_ID}, 'Range Part 2', '分段第二部', '2026-04-01', 12, 12, '[]'),
      (${THIRD_ID}, 'Range Part 3', '分段第三部', '2026-07-01', 12, 12, '[]'),
      (${UNRELATED_FIRST_ID}, 'Unrelated Range Part 1', '无关分段第一部', '2026-01-01', 12, 12, '[]'),
      (${UNRELATED_SECOND_ID}, 'Unrelated Range Part 2', '无关分段第二部', '2026-04-01', 12, 12, '[]');
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('${SOURCE}', 'Manual Validation Source', 1);
    INSERT INTO resource_items (source, source_aid, title, year)
    VALUES
      ('${SOURCE}', ${SOURCE_AID}, '分段合集', '2026'),
      ('${SOURCE}', ${UNRELATED_SOURCE_AID}, '无关旧分段合集', '2026');
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, matched_subject_title, matched_resource_title, matched_at
    )
    VALUES (
      ${FIRST_ID}, '${SOURCE}', ${SOURCE_AID}, 1, 12,
      0, '分段第一部', '分段合集', datetime('now')
    );
  `);
}

test.afterEach(() => {
  cleanup();
});

test("manual import dry-run validates but does not write mappings or retry state", async () => {
  seedRows();
  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${SECOND_ID},match,${SOURCE_AID},13,,12,dry run`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, {
    refreshEpisodes: false,
    dryRun: true,
  }));
  const mapping = sqlite.prepare(`
    SELECT source_aid FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(SECOND_ID, SOURCE);
  const retry = sqlite.prepare(`
    SELECT retry_count FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(SECOND_ID, SOURCE);

  assert.equal(stats.dryRun, true);
  assert.equal(stats.matched, 1);
  assert.equal(mapping, undefined);
  assert.equal(retry, undefined);
});

test("manual import allows the last shared source range to omit source_ep_end", async () => {
  seedRows();
  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${SECOND_ID},match,${SOURCE_AID},13,,12,ongoing final range`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));
  const mapping = sqlite.prepare(`
    SELECT source_ep_start, source_ep_end, display_ep_offset
    FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(SECOND_ID, SOURCE);

  assert.equal(stats.matched, 1);
  assert.deepEqual(mapping, {
    source_ep_start: 13,
    source_ep_end: null,
    display_ep_offset: 12,
  });
});

test("manual import rejects a middle shared source range without source_ep_end", async () => {
  seedRows();
  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${SECOND_ID},match,${SOURCE_AID},13,,12,middle has no end`,
    `${SOURCE},${THIRD_ID},match,${SOURCE_AID},25,,24,last ongoing`,
  ].join("\n");

  await withCsv(csv, async (filePath) => {
    await assert.rejects(
      () => importManualReview(filePath, { refreshEpisodes: false }),
      /non-final shared range must include source_ep_end/
    );
  });
});

test("manual import rejects overlapping shared source ranges", async () => {
  seedRows();
  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${SECOND_ID},match,${SOURCE_AID},12,,11,overlaps first range`,
  ].join("\n");

  await withCsv(csv, async (filePath) => {
    await assert.rejects(
      () => importManualReview(filePath, { refreshEpisodes: false }),
      /shared ranges must not overlap/
    );
  });
});

test("manual import validates only source_aid groups affected by this import", async () => {
  seedRows();
  sqlite.exec(`
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, matched_subject_title, matched_resource_title, matched_at
    )
    VALUES
      (${UNRELATED_FIRST_ID}, '${SOURCE}', ${UNRELATED_SOURCE_AID}, 1, null, 0, '无关分段第一部', '无关旧分段合集', datetime('now')),
      (${UNRELATED_SECOND_ID}, '${SOURCE}', ${UNRELATED_SOURCE_AID}, 13, null, 12, '无关分段第二部', '无关旧分段合集', datetime('now'));
  `);
  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${SECOND_ID},match,${SOURCE_AID},13,,12,valid affected source aid`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  assert.equal(stats.matched, 1);
});

test("mapped import dry-run validates shared ranges without writing updates", async () => {
  seedRows();
  sqlite.exec(`
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, matched_subject_title, matched_resource_title, matched_at
    )
    VALUES (
      ${SECOND_ID}, '${SOURCE}', ${SOURCE_AID}, 13, null,
      12, '分段第二部', '分段合集', datetime('now')
    );
  `);
  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${SECOND_ID},update,${SOURCE_AID},13,24,12,dry-run mapped update`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importMappedReview(filePath, {
    refreshEpisodes: false,
    dryRun: true,
  }));
  const mapping = sqlite.prepare(`
    SELECT source_ep_start, source_ep_end, display_ep_offset
    FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(SECOND_ID, SOURCE);

  assert.equal(stats.dryRun, true);
  assert.equal(stats.matched, 1);
  assert.deepEqual(mapping, {
    source_ep_start: 13,
    source_ep_end: null,
    display_ep_offset: 12,
  });
});

test("mapped import validates shared ranges affected by delete decisions", async () => {
  seedRows();
  sqlite.exec(`
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, matched_subject_title, matched_resource_title, matched_at
    )
    VALUES
      (${SECOND_ID}, '${SOURCE}', ${SOURCE_AID}, 13, null, 12, '分段第二部', '分段合集', datetime('now')),
      (${THIRD_ID}, '${SOURCE}', ${SOURCE_AID}, 25, null, 24, '分段第三部', '分段合集', datetime('now'));
  `);
  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${FIRST_ID},delete,${SOURCE_AID},,,,,`,
  ].join("\n");

  await withCsv(csv, async (filePath) => {
    await assert.rejects(
      () => importMappedReview(filePath, { refreshEpisodes: false, dryRun: true }),
      /non-final shared range must include source_ep_end/
    );
  });
});
