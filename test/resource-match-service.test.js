import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { ensureMappingForAnime } from "../src/services/resourceMatchService.js";
import { upsertResourceItem } from "../src/repositories/resourceRepository.js";

const SOURCE = "auto_match_owner";
const SOURCE_AID = 991001;
const FIRST_SUBJECT_ID = 990559001;
const SECOND_SUBJECT_ID = 990559002;

function seedAutoMatchRows() {
  initDb();
  sqlite.exec(`
    DELETE FROM manual_resource_state WHERE bangumi_id IN (${FIRST_SUBJECT_ID}, ${SECOND_SUBJECT_ID});
    DELETE FROM retry_state WHERE bangumi_id IN (${FIRST_SUBJECT_ID}, ${SECOND_SUBJECT_ID});
    DELETE FROM resource_mappings WHERE bangumi_id IN (${FIRST_SUBJECT_ID}, ${SECOND_SUBJECT_ID}) OR source = '${SOURCE}';
    DELETE FROM episodes WHERE bangumi_id IN (${FIRST_SUBJECT_ID}, ${SECOND_SUBJECT_ID}) OR source = '${SOURCE}';
    DELETE FROM resource_items WHERE source = '${SOURCE}';
    DELETE FROM resource_sources WHERE source = '${SOURCE}';
    DELETE FROM subject_aliases WHERE bangumi_id IN (${FIRST_SUBJECT_ID}, ${SECOND_SUBJECT_ID});
    DELETE FROM subject_tags WHERE bangumi_id IN (${FIRST_SUBJECT_ID}, ${SECOND_SUBJECT_ID});
    DELETE FROM subjects WHERE bangumi_id IN (${FIRST_SUBJECT_ID}, ${SECOND_SUBJECT_ID});

    INSERT INTO subjects (bangumi_id, name, name_cn, air_date, rating_distribution_json)
      VALUES
        (${FIRST_SUBJECT_ID}, 'Auto Shared Title', '自动共享标题', '2026-04-01', '[]'),
        (${SECOND_SUBJECT_ID}, 'Auto Shared Title', '自动共享标题', '2026-04-01', '[]');
    INSERT INTO resource_sources (source, name, enabled)
      VALUES ('${SOURCE}', '自动匹配测试源', 1);
    INSERT INTO resource_mappings (bangumi_id, source, source_aid, score, matched_at)
      VALUES (${FIRST_SUBJECT_ID}, '${SOURCE}', ${SOURCE_AID}, 0.95, datetime('now'));
  `);
  upsertResourceItem({
    source: SOURCE,
    sourceAid: SOURCE_AID,
    title: "自动共享标题",
    year: "2026",
  });
}

test("automatic matching still blocks a second subject from claiming the same source item", async () => {
  seedAutoMatchRows();

  const result = await ensureMappingForAnime(SECOND_SUBJECT_ID, { source: SOURCE });

  assert.equal(result.matched, false);
  assert.equal(result.reason, "source-already-mapped");
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM resource_mappings
      WHERE bangumi_id = ? AND source = ?
    `).get(SECOND_SUBJECT_ID, SOURCE).count,
    0,
  );
  assert.deepEqual(
    sqlite.prepare(`
      SELECT status FROM manual_resource_state
      WHERE bangumi_id = ? AND source = ?
    `).get(SECOND_SUBJECT_ID, SOURCE),
    { status: "source_already_mapped" },
  );
});
