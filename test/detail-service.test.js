import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { getAnimeDetail } from "../src/services/detailService.js";

const MISSING_SUBJECT_ID = 990549901;

test("getAnimeDetail does not synchronously fetch metadata for missing subjects", async () => {
  initDb();
  sqlite.exec(`
    DELETE FROM retry_state WHERE bangumi_id = ${MISSING_SUBJECT_ID};
    DELETE FROM subject_aliases WHERE bangumi_id = ${MISSING_SUBJECT_ID};
    DELETE FROM subject_tags WHERE bangumi_id = ${MISSING_SUBJECT_ID};
    DELETE FROM subjects WHERE bangumi_id = ${MISSING_SUBJECT_ID};
  `);

  const result = await getAnimeDetail(MISSING_SUBJECT_ID);

  assert.equal(result, null);
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM retry_state
    WHERE bangumi_id = ? AND kind = 'metadata_fetch'
  `).get(MISSING_SUBJECT_ID).count, 0);
});
