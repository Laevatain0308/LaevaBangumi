import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import {
  findEpisodeVideoUrl,
  listEpisodeChannelRowsForSubject,
  listManualResourceStatesForSubject,
  listResourceMappingsWithEpisodePresenceForSubject,
  listRetryStateForSubject,
} from "../src/repositories/resourceRepository.js";

const RESOURCE_SUBJECT_ID = 990547891;
const RESOURCE_SOURCE = "repo_source";
const RESOURCE_AID = 777001;

function seedResourceRows() {
  initDb();
  sqlite.exec(`
    DELETE FROM manual_resource_state WHERE bangumi_id = ${RESOURCE_SUBJECT_ID};
    DELETE FROM retry_state WHERE bangumi_id = ${RESOURCE_SUBJECT_ID};
    DELETE FROM episodes WHERE bangumi_id = ${RESOURCE_SUBJECT_ID};
    DELETE FROM resource_mappings WHERE bangumi_id = ${RESOURCE_SUBJECT_ID};
    DELETE FROM resource_items WHERE source = '${RESOURCE_SOURCE}' AND source_aid = ${RESOURCE_AID};
    DELETE FROM resource_sources WHERE source = '${RESOURCE_SOURCE}';
    DELETE FROM subjects WHERE bangumi_id = ${RESOURCE_SUBJECT_ID};

    INSERT INTO subjects (bangumi_id, name, name_cn, rating_distribution_json)
      VALUES (${RESOURCE_SUBJECT_ID}, 'Resource raw', '资源标题', '[]');
    INSERT INTO resource_sources (source, name, enabled)
      VALUES ('${RESOURCE_SOURCE}', 'Repository Source', 1);
    INSERT INTO resource_items (source, source_aid, title, detail_fetched_at)
      VALUES ('${RESOURCE_SOURCE}', ${RESOURCE_AID}, '资源站条目', datetime('now'));
    INSERT INTO resource_mappings (bangumi_id, source, source_aid, score, matched_at)
      VALUES (${RESOURCE_SUBJECT_ID}, '${RESOURCE_SOURCE}', ${RESOURCE_AID}, 0.95, datetime('now'));
    INSERT INTO episodes (bangumi_id, source, source_aid, ep_index, source_ep_index, ep_name, video_url, updated_at)
      VALUES (${RESOURCE_SUBJECT_ID}, '${RESOURCE_SOURCE}', ${RESOURCE_AID}, 1, 1, '第01集', 'https://example.invalid/repo-1.m3u8', datetime('now'));
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
      VALUES (${RESOURCE_SUBJECT_ID}, '${RESOURCE_SOURCE}', 'mapping', 2, '2026-06-03 01:00:00', datetime('now'));
    INSERT INTO manual_resource_state (bangumi_id, source, status, note, updated_at)
      VALUES (${RESOURCE_SUBJECT_ID}, '${RESOURCE_SOURCE}', 'wait_airing', '等待开播', datetime('now'));
  `);
}

test("resource repository reads normalized detail and playback rows", () => {
  seedResourceRows();

  assert.deepEqual(listResourceMappingsWithEpisodePresenceForSubject(RESOURCE_SUBJECT_ID), [{
    source: RESOURCE_SOURCE,
    source_aid: RESOURCE_AID,
    has_episodes: 1,
  }]);

  const episodeRows = listEpisodeChannelRowsForSubject(RESOURCE_SUBJECT_ID);
  assert.equal(episodeRows.length, 1);
  assert.equal(episodeRows[0].source_name, "Repository Source");
  assert.equal(episodeRows[0].resource_title, "资源站条目");
  assert.equal(episodeRows[0].video_url, undefined);

  assert.deepEqual(findEpisodeVideoUrl({
    bangumiId: RESOURCE_SUBJECT_ID,
    source: RESOURCE_SOURCE,
    sourceAid: RESOURCE_AID,
    epIndex: 1,
  }), { video_url: "https://example.invalid/repo-1.m3u8" });
});

test("resource repository reads normalized retry and manual state rows", () => {
  seedResourceRows();

  assert.deepEqual(listRetryStateForSubject(RESOURCE_SUBJECT_ID, "mapping"), [{
    source: RESOURCE_SOURCE,
    retry_count: 2,
    retry_at: "2026-06-03 01:00:00",
  }]);
  assert.deepEqual(listManualResourceStatesForSubject(RESOURCE_SUBJECT_ID), [{
    source: RESOURCE_SOURCE,
    status: "wait_airing",
    note: "等待开播",
  }]);
});
