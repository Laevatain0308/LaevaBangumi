import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import {
  refreshSubjectMetadata,
  registerMetadataRefreshJob,
  scheduleMetadataFetchRetry,
} from "../src/services/metadataRefreshService.js";
import { retryPending } from "../src/services/retryService.js";
import { registerJob } from "../src/services/queue.js";

const SUBJECT_ID = 990548701;
const SOURCE = "metadata";

function resetSubject() {
  initDb();
  sqlite.exec(`
    DELETE FROM retry_state WHERE bangumi_id = ${SUBJECT_ID};
    DELETE FROM subject_tags WHERE bangumi_id = ${SUBJECT_ID};
    DELETE FROM subject_aliases WHERE bangumi_id = ${SUBJECT_ID};
    DELETE FROM subjects WHERE bangumi_id = ${SUBJECT_ID};
    INSERT INTO subjects (bangumi_id, name, name_cn, rating_distribution_json)
    VALUES (${SUBJECT_ID}, 'Metadata Raw', '元数据旧标题', '[]');
  `);
}

test("refreshSubjectMetadata fetches Bangumi detail and clears metadata retry state", async () => {
  resetSubject();
  sqlite.prepare(`
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, last_error)
    VALUES (?, ?, 'metadata_fetch', 2, '2026-06-03 01:00:00', 'previous failure')
  `).run(SUBJECT_ID, SOURCE);

  const result = await refreshSubjectMetadata(SUBJECT_ID, {
    source: SOURCE,
    fetchSubject: async (id) => ({
      id,
      type: 2,
      name: "Metadata Raw",
      name_cn: "元数据新标题",
      summary: "元数据简介",
      date: "2026-04-01",
      platform: "TV",
      rating: { score: 8.1, rank: 123, total: 456, count: { 8: 9 } },
      tags: [{ name: "测试", count: 3, total_count: 4 }],
      infobox: [{ key: "别名", value: "Metadata Alias" }],
    }),
  });

  assert.deepEqual(result, { animeId: SUBJECT_ID, refreshed: true });
  const subject = sqlite.prepare("SELECT name_cn, summary, rating_score FROM subjects WHERE bangumi_id = ?").get(SUBJECT_ID);
  assert.deepEqual(subject, { name_cn: "元数据新标题", summary: "元数据简介", rating_score: 8.1 });
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'metadata_fetch'
  `).get(SUBJECT_ID, SOURCE).count, 0);
});

test("refreshSubjectMetadata schedules metadata_fetch retry when Bangumi detail fetch fails", async () => {
  resetSubject();

  const result = await refreshSubjectMetadata(SUBJECT_ID, {
    source: SOURCE,
    fetchSubject: async () => {
      throw new Error("Bangumi unavailable");
    },
  });

  assert.equal(result.refreshed, false);
  assert.equal(result.reason, "fetch-failed");
  const retry = sqlite.prepare(`
    SELECT retry_count, retry_at, last_error FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'metadata_fetch'
  `).get(SUBJECT_ID, SOURCE);
  assert.equal(retry.retry_count, 1);
  assert.ok(retry.retry_at);
  assert.match(retry.last_error, /Bangumi unavailable/);
});

test("retryPending processes due metadata_fetch retry rows", async () => {
  resetSubject();
  scheduleMetadataFetchRetry(SUBJECT_ID, SOURCE, 1, "manual retry");
  sqlite.prepare(`
    UPDATE retry_state
    SET retry_at = '2000-01-01 00:00:00'
    WHERE bangumi_id = ? AND source = ? AND kind = 'metadata_fetch'
  `).run(SUBJECT_ID, SOURCE);

  let called = 0;
  const stats = await retryPending({
    sourceKeys: [SOURCE],
    refreshEpisodes: false,
    refreshSubjectMetadata: async (animeId, { source }) => {
      called += 1;
      assert.equal(animeId, SUBJECT_ID);
      assert.equal(source, SOURCE);
      return { refreshed: true };
    },
  });

  assert.equal(called, 1);
  assert.equal(stats.refreshedMetadata, 1);
  assert.equal(stats.processed.metadataFetch, 1);
});

test("registerMetadataRefreshJob wires the documented refresh-subject-metadata queue job", async () => {
  let called = 0;
  registerMetadataRefreshJob({
    register: registerJob,
    refreshSubjectMetadata: async (animeId, options) => {
      called += 1;
      assert.equal(animeId, SUBJECT_ID);
      assert.equal(options.source, SOURCE);
      return { refreshed: true };
    },
  });

  registerJob("metadata-refresh-test-dispatch", async () => {});
  const { queueStats } = await import("../src/services/queue.js");
  assert.ok(queueStats().registered.includes("refresh-subject-metadata"));
});
