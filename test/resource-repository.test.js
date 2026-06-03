import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import {
  deleteManualResourceState,
  deleteResourceEpisodesForSubjectSource,
  deleteResourceMapping,
  deleteResourceRowsForSubject,
  deleteStaleResourceEpisodes,
  deleteManualResourceStateByStatus,
  deleteRetryState,
  findEpisodeVideoUrl,
  listEpisodeChannelRowsForSubject,
  listManualResourceStatesForSubject,
  listResourceMappingsWithEpisodePresenceForSubject,
  listRetryStateForSubject,
  upsertManualResourceState,
  upsertResourceEpisode,
  upsertResourceItem,
  upsertResourceMapping,
  upsertResourceSyncState,
  upsertRetryState,
} from "../src/repositories/resourceRepository.js";

const RESOURCE_SUBJECT_ID = 990547891;
const RESOURCE_STATE_SUBJECT_ID = 990547892;
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

test("resource repository writes retry and manual state rows", () => {
  initDb();
  sqlite.exec(`
    DELETE FROM manual_resource_state WHERE bangumi_id = ${RESOURCE_STATE_SUBJECT_ID};
    DELETE FROM retry_state WHERE bangumi_id = ${RESOURCE_STATE_SUBJECT_ID};
    DELETE FROM subjects WHERE bangumi_id = ${RESOURCE_STATE_SUBJECT_ID};
    INSERT INTO subjects (bangumi_id, name, rating_distribution_json)
      VALUES (${RESOURCE_STATE_SUBJECT_ID}, 'Resource state raw', '[]');
  `);

  upsertRetryState({
    bangumiId: RESOURCE_STATE_SUBJECT_ID,
    source: RESOURCE_SOURCE,
    kind: "mapping",
    retryCount: 3,
    retryAt: "2026-06-03 01:00:00",
  });
  upsertRetryState({
    bangumiId: RESOURCE_STATE_SUBJECT_ID,
    source: RESOURCE_SOURCE,
    kind: "episode_fetch",
    retryCount: 2,
    retryAt: "2026-06-03 02:00:00",
  });

  assert.deepEqual(listRetryStateForSubject(RESOURCE_STATE_SUBJECT_ID, "mapping"), [{
    source: RESOURCE_SOURCE,
    retry_count: 3,
    retry_at: "2026-06-03 01:00:00",
  }]);
  assert.deepEqual(listRetryStateForSubject(RESOURCE_STATE_SUBJECT_ID, "episode_fetch"), [{
    source: RESOURCE_SOURCE,
    retry_count: 2,
    retry_at: "2026-06-03 02:00:00",
  }]);

  upsertRetryState({
    bangumiId: RESOURCE_STATE_SUBJECT_ID,
    source: RESOURCE_SOURCE,
    kind: "mapping",
    retryCount: 0,
    retryAt: null,
  });
  assert.equal(listRetryStateForSubject(RESOURCE_STATE_SUBJECT_ID, "mapping")[0].retry_count, 0);
  assert.equal(listRetryStateForSubject(RESOURCE_STATE_SUBJECT_ID, "mapping")[0].retry_at, null);

  deleteRetryState({
    bangumiId: RESOURCE_STATE_SUBJECT_ID,
    source: RESOURCE_SOURCE,
    kind: "episode_fetch",
  });
  assert.deepEqual(listRetryStateForSubject(RESOURCE_STATE_SUBJECT_ID, "episode_fetch"), []);

  upsertManualResourceState({
    bangumiId: RESOURCE_STATE_SUBJECT_ID,
    source: RESOURCE_SOURCE,
    status: "wait_airing",
    note: "等待开播",
  });
  assert.deepEqual(listManualResourceStatesForSubject(RESOURCE_STATE_SUBJECT_ID), [{
    source: RESOURCE_SOURCE,
    status: "wait_airing",
    note: "等待开播",
  }]);

  deleteManualResourceStateByStatus({
    bangumiId: RESOURCE_STATE_SUBJECT_ID,
    source: RESOURCE_SOURCE,
    status: "no_resource",
  });
  assert.equal(listManualResourceStatesForSubject(RESOURCE_STATE_SUBJECT_ID).length, 1);

  upsertManualResourceState({
    bangumiId: RESOURCE_STATE_SUBJECT_ID,
    source: RESOURCE_SOURCE,
    status: "no_resource",
    note: "暂无资源",
  });
  assert.deepEqual(listManualResourceStatesForSubject(RESOURCE_STATE_SUBJECT_ID), [{
    source: RESOURCE_SOURCE,
    status: "no_resource",
    note: "暂无资源",
  }]);

  deleteManualResourceState({
    bangumiId: RESOURCE_STATE_SUBJECT_ID,
    source: RESOURCE_SOURCE,
  });
  assert.deepEqual(listManualResourceStatesForSubject(RESOURCE_STATE_SUBJECT_ID), []);
});

test("resource repository upserts and deletes resource mappings", () => {
  const id = RESOURCE_STATE_SUBJECT_ID + 1;
  const source = `${RESOURCE_SOURCE}_mapping`;
  const sourceAid = RESOURCE_AID + 10;
  sqlite.exec(`
    DELETE FROM episodes WHERE bangumi_id = ${id};
    DELETE FROM resource_mappings WHERE bangumi_id = ${id};
    DELETE FROM resource_mappings WHERE source = '${source}';
    DELETE FROM resource_items WHERE source = '${source}';
    DELETE FROM resource_sources WHERE source = '${source}';
    DELETE FROM subjects WHERE bangumi_id = ${id};
    INSERT INTO subjects (bangumi_id, name, rating_distribution_json)
      VALUES (${id}, 'Resource mapping raw', '[]');
  `);

  upsertResourceMapping({
    bangumiId: id,
    source,
    sourceAid,
    sourceEpStart: 1,
    sourceEpEnd: 12,
    displayEpOffset: 0,
    score: 0.91,
    matchedBgName: "番剧标题",
    matchedResourceName: "资源站标题",
  });

  let mapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(id, source);
  assert.equal(mapping.source_aid, sourceAid);
  assert.equal(mapping.source_ep_start, 1);
  assert.equal(mapping.source_ep_end, 12);
  assert.equal(mapping.display_ep_offset, 0);
  assert.equal(mapping.score, 0.91);
  assert.equal(mapping.matched_bg_name, "番剧标题");
  assert.equal(mapping.matched_resource_name, "资源站标题");
  assert.ok(mapping.matched_at);
  assert.ok(mapping.updated_at);
  assert.equal(sqlite.prepare("SELECT enabled FROM resource_sources WHERE source = ?").get(source).enabled, 1);

  upsertResourceMapping({
    bangumiId: id,
    source,
    sourceAid: sourceAid + 1,
    sourceEpStart: 3,
    sourceEpEnd: null,
    displayEpOffset: 2,
    score: null,
    matchedBgName: "手动番剧标题",
    matchedResourceName: "手动资源站标题",
  });

  mapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(id, source);
  assert.equal(mapping.source_aid, sourceAid + 1);
  assert.equal(mapping.source_ep_start, 3);
  assert.equal(mapping.source_ep_end, null);
  assert.equal(mapping.display_ep_offset, 2);
  assert.equal(mapping.score, null);
  assert.equal(mapping.matched_bg_name, "手动番剧标题");
  assert.equal(mapping.matched_resource_name, "手动资源站标题");

  assert.deepEqual(listResourceMappingsWithEpisodePresenceForSubject(id), [{
    source,
    source_aid: sourceAid + 1,
    has_episodes: 0,
  }]);

  deleteResourceMapping({ bangumiId: id, source });
  assert.deepEqual(listResourceMappingsWithEpisodePresenceForSubject(id), []);
});

test("resource mappings enforce one subject owner per source item", () => {
  const firstId = RESOURCE_STATE_SUBJECT_ID + 20;
  const secondId = RESOURCE_STATE_SUBJECT_ID + 21;
  const source = `${RESOURCE_SOURCE}_unique`;
  const sourceAid = RESOURCE_AID + 20;
  initDb();
  sqlite.exec(`
    DELETE FROM resource_mappings WHERE source = '${source}';
    DELETE FROM resource_items WHERE source = '${source}';
    DELETE FROM resource_sources WHERE source = '${source}';
    DELETE FROM subjects WHERE bangumi_id IN (${firstId}, ${secondId});
    INSERT INTO subjects (bangumi_id, name, rating_distribution_json)
      VALUES (${firstId}, 'First owner', '[]'), (${secondId}, 'Second owner', '[]');
  `);

  upsertResourceMapping({ bangumiId: firstId, source, sourceAid });

  assert.throws(
    () => upsertResourceMapping({ bangumiId: secondId, source, sourceAid }),
    /UNIQUE constraint failed: resource_mappings\.source, resource_mappings\.source_aid/,
  );
});

test("resource repository upserts resource items without erasing existing optional fields", () => {
  initDb();
  const source = `${RESOURCE_SOURCE}_items`;
  const sourceAid = RESOURCE_AID + 2;
  sqlite.prepare("DELETE FROM resource_items WHERE source = ?").run(source);
  sqlite.prepare("DELETE FROM resource_sources WHERE source = ?").run(source);

  upsertResourceItem({
    source,
    sourceAid,
    title: "目录标题",
    subtitle: "副标题",
    category: "TV",
    year: "2026",
    latestText: "第01集",
    detailFetchedAt: "2026-06-03 01:00:00",
  });

  upsertResourceItem({
    source,
    sourceAid,
    title: "详情标题",
    subtitle: null,
    category: null,
    year: null,
    latestText: null,
    detailFetchedAt: "2026-06-03 02:00:00",
  });

  const item = sqlite.prepare(`
    SELECT * FROM resource_items
    WHERE source = ? AND source_aid = ?
  `).get(source, sourceAid);
  assert.equal(item.title, "详情标题");
  assert.equal(item.subtitle, "副标题");
  assert.equal(item.category, "TV");
  assert.equal(item.year, "2026");
  assert.equal(item.latest_text, "第01集");
  assert.equal(item.detail_fetched_at, "2026-06-03 02:00:00");

  const sourceRow = sqlite.prepare("SELECT * FROM resource_sources WHERE source = ?").get(source);
  assert.equal(sourceRow.name, source);
  assert.equal(sourceRow.enabled, 1);
});

test("resource repository upserts normalized sync state rows", () => {
  initDb();
  const source = `${RESOURCE_SOURCE}_sync`;
  const scope = "2";
  sqlite.prepare("DELETE FROM sync_state WHERE source = ? AND scope = ?").run(source, scope);

  upsertResourceSyncState({
    source,
    scope,
    lastSeenAt: "2026-06-03 01:00:00",
    lastSuccessAt: "2026-06-03 01:10:00",
  });
  upsertResourceSyncState({
    source,
    scope,
    lastSeenAt: "2026-06-03 02:00:00",
    lastSuccessAt: "2026-06-03 02:10:00",
  });

  assert.deepEqual(sqlite.prepare(`
    SELECT source, scope, last_seen_at, last_success_at
    FROM sync_state
    WHERE source = ? AND scope = ?
  `).get(source, scope), {
    source,
    scope,
    last_seen_at: "2026-06-03 02:00:00",
    last_success_at: "2026-06-03 02:10:00",
  });
});

test("resource repository upserts and prunes resource episodes", () => {
  initDb();
  const id = RESOURCE_STATE_SUBJECT_ID + 4;
  const source = `${RESOURCE_SOURCE}_episodes`;
  const sourceAid = RESOURCE_AID + 4;
  sqlite.exec(`
    DELETE FROM episodes WHERE bangumi_id = ${id} OR anime_id = ${id};
    DELETE FROM resource_mappings WHERE bangumi_id = ${id};
    DELETE FROM resource_items WHERE source = '${source}';
    DELETE FROM resource_sources WHERE source = '${source}';
    DELETE FROM subjects WHERE bangumi_id = ${id};
    DELETE FROM anime WHERE id = ${id};
    INSERT INTO anime (id, name) VALUES (${id}, 'Resource episode raw')
      ON CONFLICT(id) DO UPDATE SET name = excluded.name;
    INSERT INTO subjects (bangumi_id, name, rating_distribution_json)
      VALUES (${id}, 'Resource episode raw', '[]')
      ON CONFLICT(bangumi_id) DO UPDATE SET name = excluded.name;
  `);
  upsertResourceItem({ source, sourceAid, title: "资源站条目" });
  upsertResourceMapping({ bangumiId: id, source, sourceAid });

  sqlite.prepare(`
    INSERT INTO episodes (anime_id, source_name, source_aid, ep_index, video_url)
    VALUES (?, ?, ?, 1, ?)
  `).run(id, source, sourceAid, "https://example.invalid/legacy.m3u8");

  upsertResourceEpisode({
    bangumiId: id,
    source,
    sourceAid,
    epIndex: 1,
    sourceEpIndex: 2,
    epName: "第01集",
    videoUrl: "https://example.invalid/1.m3u8",
  });
  upsertResourceEpisode({
    bangumiId: id,
    source,
    sourceAid,
    epIndex: 2,
    sourceEpIndex: 3,
    epName: "第02集",
    videoUrl: "https://example.invalid/2.m3u8",
  });
  upsertResourceEpisode({
    bangumiId: id,
    source,
    sourceAid: sourceAid + 1,
    epIndex: 3,
    sourceEpIndex: 3,
    epName: "旧线路",
    videoUrl: "https://example.invalid/stale.m3u8",
  });

  let rows = sqlite.prepare(`
    SELECT bangumi_id, anime_id, source, source_name, source_aid, ep_index, source_ep_index, ep_name, video_url
    FROM episodes
    WHERE bangumi_id = ? OR anime_id = ?
    ORDER BY ep_index
  `).all(id, id);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].bangumi_id, id);
  assert.equal(rows[0].anime_id, id);
  assert.equal(rows[0].source, source);
  assert.equal(rows[0].source_name, source);
  assert.equal(rows[0].source_ep_index, 2);
  assert.equal(rows[0].video_url, "https://example.invalid/1.m3u8");

  upsertResourceEpisode({
    bangumiId: id,
    source,
    sourceAid,
    epIndex: 1,
    sourceEpIndex: 4,
    epName: "第01集 修正",
    videoUrl: "https://example.invalid/1-fixed.m3u8",
  });
  deleteStaleResourceEpisodes({
    bangumiId: id,
    source,
    sourceAid,
    validEpIndexes: [1],
  });

  rows = sqlite.prepare(`
    SELECT source_aid, ep_index, source_ep_index, ep_name, video_url
    FROM episodes
    WHERE bangumi_id = ? OR anime_id = ?
    ORDER BY ep_index
  `).all(id, id);
  assert.deepEqual(rows, [{
    source_aid: sourceAid,
    ep_index: 1,
    source_ep_index: 4,
    ep_name: "第01集 修正",
    video_url: "https://example.invalid/1-fixed.m3u8",
  }]);

  deleteResourceEpisodesForSubjectSource({ bangumiId: id, source });
  assert.deepEqual(sqlite.prepare("SELECT id FROM episodes WHERE bangumi_id = ? OR anime_id = ?").all(id, id), []);
});

test("resource repository deletes normalized resource rows for a subject", () => {
  initDb();
  const id = RESOURCE_STATE_SUBJECT_ID + 5;
  const source = `${RESOURCE_SOURCE}_cleanup`;
  const sourceAid = RESOURCE_AID + 5;
  sqlite.exec(`
    DELETE FROM episodes WHERE bangumi_id = ${id} OR anime_id = ${id};
    DELETE FROM resource_mappings WHERE bangumi_id = ${id};
    DELETE FROM retry_state WHERE bangumi_id = ${id};
    DELETE FROM manual_resource_state WHERE bangumi_id = ${id};
    DELETE FROM resource_items WHERE source = '${source}';
    DELETE FROM resource_sources WHERE source = '${source}';
    INSERT INTO subjects (bangumi_id, name, rating_distribution_json)
      VALUES (${id}, 'Resource cleanup raw', '[]')
      ON CONFLICT(bangumi_id) DO UPDATE SET name = excluded.name;
  `);

  upsertResourceItem({ source, sourceAid, title: "待清理资源站条目" });
  upsertResourceMapping({ bangumiId: id, source, sourceAid });
  upsertResourceEpisode({
    bangumiId: id,
    source,
    sourceAid,
    epIndex: 1,
    videoUrl: "https://example.invalid/cleanup.m3u8",
  });
  upsertRetryState({ bangumiId: id, source, kind: "mapping", retryCount: 1 });
  upsertManualResourceState({ bangumiId: id, source, status: "no_resource", note: "cleanup" });

  deleteResourceRowsForSubject({ bangumiId: id });

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM episodes WHERE bangumi_id = ? OR anime_id = ?").get(id, id).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM resource_mappings WHERE bangumi_id = ?").get(id).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM retry_state WHERE bangumi_id = ?").get(id).count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM manual_resource_state WHERE bangumi_id = ?").get(id).count, 0);
});
