import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import {
  findEpisodeRawVideoUrl,
  listEpisodeChannelRowsForSubject,
  upsertResourceEpisode,
} from "../src/repositories/episodeRepository.js";

const SUBJECT_ID = 990548101;
const SOURCE = "normalized_arch_source";
const SOURCE_AID = 990548201;

function cleanup() {
  sqlite.exec(`
    DELETE FROM episodes WHERE bangumi_id = ${SUBJECT_ID};
    DELETE FROM resource_mappings WHERE bangumi_id = ${SUBJECT_ID}
       OR (source = '${SOURCE}' AND source_aid = ${SOURCE_AID});
    DELETE FROM resource_items WHERE source = '${SOURCE}' AND source_aid = ${SOURCE_AID};
    DELETE FROM resource_sources WHERE source = '${SOURCE}';
    DELETE FROM subjects WHERE bangumi_id = ${SUBJECT_ID};
  `);
}

test.afterEach(() => {
  cleanup();
});

test("initDb creates only terminal normalized runtime tables", () => {
  initDb();
  const tableNames = new Set(sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name));

  for (const legacyTable of [
    "anime",
    "bangumi_cstation_map",
    "cstation_catalog",
    "match_retry_state",
    "episode_fetch_retry_state",
    "manual_match_state",
    "source_sync_state",
  ]) {
    assert.equal(tableNames.has(legacyTable), false, `${legacyTable} should not be a runtime table`);
  }

  const episodeColumns = new Set(sqlite.prepare("PRAGMA table_info(episodes)").all().map((row) => row.name));
  assert.equal(episodeColumns.has("episode_id"), true);
  assert.equal(episodeColumns.has("title"), true);
  assert.equal(episodeColumns.has("raw_video_url"), true);

  for (const legacyColumn of ["id", "anime_id", "source_name", "ep_name", "video_url"]) {
    assert.equal(episodeColumns.has(legacyColumn), false, `episodes.${legacyColumn} should not exist`);
  }
});

test("resource episodes are stored with terminal normalized column names", () => {
  initDb();
  cleanup();
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, rating_distribution_json)
      VALUES (${SUBJECT_ID}, 'Normalized Architecture Subject', '[]');
    INSERT INTO resource_sources (source, name, enabled)
      VALUES ('${SOURCE}', 'Normalized Source', 1);
    INSERT INTO resource_items (source, source_aid, title, detail_fetched_at)
      VALUES ('${SOURCE}', ${SOURCE_AID}, 'Normalized Resource', datetime('now'));
    INSERT INTO resource_mappings (bangumi_id, source, source_aid, score, matched_at)
      VALUES (${SUBJECT_ID}, '${SOURCE}', ${SOURCE_AID}, 0.9, datetime('now'));
  `);

  upsertResourceEpisode({
    bangumiId: SUBJECT_ID,
    source: SOURCE,
    sourceAid: SOURCE_AID,
    epIndex: 1,
    sourceEpIndex: 2,
    title: "第01集",
    rawVideoUrl: "https://example.invalid/normalized-1.m3u8",
  });

  assert.deepEqual(sqlite.prepare(`
    SELECT bangumi_id, source, source_aid, ep_index, source_ep_index, title, raw_video_url
    FROM episodes
    WHERE bangumi_id = ? AND source = ?
  `).get(SUBJECT_ID, SOURCE), {
    bangumi_id: SUBJECT_ID,
    source: SOURCE,
    source_aid: SOURCE_AID,
    ep_index: 1,
    source_ep_index: 2,
    title: "第01集",
    raw_video_url: "https://example.invalid/normalized-1.m3u8",
  });

  assert.equal(findEpisodeRawVideoUrl({
    bangumiId: SUBJECT_ID,
    source: SOURCE,
    sourceAid: SOURCE_AID,
    epIndex: 1,
  }).raw_video_url, "https://example.invalid/normalized-1.m3u8");
  const channelRow = listEpisodeChannelRowsForSubject(SUBJECT_ID)[0];
  assert.equal(channelRow.title, "第01集");
  assert.equal(channelRow.ep_name, undefined);
});
