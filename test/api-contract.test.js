import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.js";
import { initDb, sqlite } from "../src/db/index.js";

const CONTRACT_SUBJECT_ID = 990547888;
const EPISODE_UPDATE_SUBJECT_ID = CONTRACT_SUBJECT_ID + 1000;

function getJson(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http
      .get({ hostname: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

function getRaw(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http
      .get({ hostname: "127.0.0.1", port, path }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      })
      .on("error", reject);
  });
}

function seedContractSubject() {
  initDb();
  sqlite.exec(`
    INSERT INTO subjects (
      bangumi_id, name, name_cn, summary, platform, air_date, air_weekday,
      eps, total_episodes, cover_url, rating_score, rating_rank,
      rating_total, rating_distribution_json, metadata_fetched_at, rating_fetched_at
    ) VALUES (
      ${CONTRACT_SUBJECT_ID}, 'Raw title', '中文标题', 'summary', 'TV', '2026-04-01', 3,
      12, 12, 'https://example.invalid/cover.jpg', 7.6, 1234,
      420, '[0,0,1,2,3,10,20,30,5,1]', datetime('now'), datetime('now')
    )
    ON CONFLICT(bangumi_id) DO UPDATE SET
      name = excluded.name,
      name_cn = excluded.name_cn,
      summary = excluded.summary,
      platform = excluded.platform,
      air_date = excluded.air_date,
      air_weekday = excluded.air_weekday,
      eps = excluded.eps,
      total_episodes = excluded.total_episodes,
      cover_url = excluded.cover_url,
      rating_score = excluded.rating_score,
      rating_rank = excluded.rating_rank,
      rating_total = excluded.rating_total,
      rating_distribution_json = excluded.rating_distribution_json,
      metadata_fetched_at = excluded.metadata_fetched_at,
      rating_fetched_at = excluded.rating_fetched_at,
      updated_at = datetime('now');
    INSERT INTO subject_aliases (bangumi_id, alias) VALUES (${CONTRACT_SUBJECT_ID}, 'Alias A')
      ON CONFLICT(bangumi_id, alias) DO NOTHING;
    INSERT INTO tags (name) VALUES ('原创')
      ON CONFLICT(name) DO UPDATE SET updated_at = datetime('now');
    INSERT INTO subject_tags (bangumi_id, tag_id, count, total_count)
      SELECT ${CONTRACT_SUBJECT_ID}, tag_id, 10, 20 FROM tags WHERE name = '原创'
      ON CONFLICT(bangumi_id, tag_id) DO UPDATE SET
        count = excluded.count,
        total_count = excluded.total_count,
        updated_at = datetime('now');
    INSERT INTO resource_sources (source, name, enabled) VALUES ('ffzy', '非凡资源', 1)
      ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_items (source, source_aid, title, latest_text, detail_fetched_at)
      VALUES ('ffzy', 123, '资源站标题', datetime('now'), datetime('now'))
      ON CONFLICT(source, source_aid) DO UPDATE SET
        title = excluded.title,
        latest_text = excluded.latest_text,
        detail_fetched_at = excluded.detail_fetched_at,
        updated_at = datetime('now');
    INSERT INTO resource_mappings (bangumi_id, source, source_aid, score, matched_at)
      VALUES (${CONTRACT_SUBJECT_ID}, 'ffzy', 123, 0.92, datetime('now'))
      ON CONFLICT(bangumi_id, source) DO UPDATE SET
        source_aid = excluded.source_aid,
        score = excluded.score,
        matched_at = excluded.matched_at,
        updated_at = datetime('now');
    INSERT INTO episodes (bangumi_id, source, source_aid, ep_index, source_ep_index, title, raw_video_url, updated_at)
      VALUES (${CONTRACT_SUBJECT_ID}, 'ffzy', 123, 1, 1, '第01集', 'https://example.invalid/1.m3u8', datetime('now'))
      ON CONFLICT(bangumi_id, source, source_aid, ep_index) DO UPDATE SET
        source_ep_index = excluded.source_ep_index,
        title = excluded.title,
        raw_video_url = excluded.raw_video_url,
        updated_at = excluded.updated_at;
  `);
}

test("detail exposes the new stable Aslan DTO contract", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, `/api/detail?id=${CONTRACT_SUBJECT_ID}`);
    assert.equal(response.status, 200);
    const detail = response.body.data;
    assert.equal(detail.id, CONTRACT_SUBJECT_ID);
    assert.equal(detail.title, "中文标题");
    assert.equal(detail.ratingScore, 7.6);
    assert.equal(detail.rank, 1234);
    assert.equal(detail.votes, 420);
    assert.deepEqual(detail.votesCount, [0, 0, 1, 2, 3, 10, 20, 30, 5, 1]);
    assert.deepEqual(detail.tags, [{ name: "原创", count: 10, totalCount: 20 }]);
    assert.deepEqual(detail.aliases, ["Alias A"]);
    assert.equal(detail.channels[0].id, "ffzy:123");
    assert.equal(detail.channels[0].name, "非凡资源");
    assert.equal(detail.channels[0].source, "ffzy");
    assert.equal(detail.channels[0].sourceAid, 123);
    assert.equal(detail.channels[0].resourceTitle, "资源站标题");
    assert.equal(detail.channels[0].episodes[0].playUrl, `/anime/api/play?id=${CONTRACT_SUBJECT_ID}&ch=1&ep=1`);
    assert.equal(Object.hasOwn(detail.channels[0].episodes[0], "url"), false);
    assert.equal(Object.hasOwn(detail, "bangumiId"), false);
    assert.equal(response.body.meta.resourceSources[0].sourceAid, 123);
    assert.equal(Object.hasOwn(response.body.meta.resourceSources[0], "cstationId"), false);
  } finally {
    server.close();
  }
});

test("cover endpoint reads normalized subject cover URLs", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getRaw(server, `/api/cover?id=${CONTRACT_SUBJECT_ID}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, "https://example.invalid/cover.jpg");
  } finally {
    server.close();
  }
});

test("play exposes videoUrl without legacy videoURL", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, `/api/play?id=${CONTRACT_SUBJECT_ID}&ch=1&ep=1`);
    assert.equal(response.status, 200);
    assert.equal(response.body.meta.freshness, "cache");
    assert.equal(response.body.data.videoUrl, "https://example.invalid/1.m3u8");
    assert.equal(response.body.data.directPlay, false);
    assert.equal(Object.hasOwn(response.body.data, "videoURL"), false);
  } finally {
    server.close();
  }
});

test("tag search returns subject summaries", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/search?tag=%E5%8E%9F%E5%88%9B");
    assert.equal(response.status, 200);
    assert.equal(response.body.meta.query, null);
    assert.equal(response.body.meta.tag, "原创");
    const item = response.body.data.find((row) => row.id === CONTRACT_SUBJECT_ID);
    assert.ok(item);
    assert.equal(item.name, "Raw title");
    assert.equal(item.nameCn, "中文标题");
    assert.equal(item.summary, "summary");
    assert.equal(item.airDate, "2026-04-01");
    assert.equal(item.airWeekday, 3);
    assert.equal(item.platform, "TV");
    assert.equal(item.eps, 12);
    assert.equal(item.totalEpisodes, 12);
    assert.equal(item.ratingScore, 7.6);
    assert.equal(item.rank, 1234);
    assert.equal(item.votes, 420);
    assert.deepEqual(item.votesCount, [0, 0, 1, 2, 3, 10, 20, 30, 5, 1]);
    assert.deepEqual(item.tags, [{ name: "原创", count: 10, totalCount: 20 }]);
    assert.equal(Object.hasOwn(item, "bangumiId"), false);
  } finally {
    server.close();
  }
});

test("keyword search matches local tag names", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/search?q=%E5%8E%9F%E5%88%9B");
    assert.equal(response.status, 200);
    assert.equal(response.body.meta.query, "原创");
    assert.equal(response.body.meta.tag, null);
    const item = response.body.data.find((row) => row.id === CONTRACT_SUBJECT_ID);
    assert.ok(item);
    assert.deepEqual(item.tags, [{ name: "原创", count: 10, totalCount: 20 }]);
  } finally {
    server.close();
  }
});

test("calendar reads normalized subjects and episodes", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/calendar");
    assert.equal(response.status, 200);
    const wednesday = response.body.data.find((day) => day.weekday.id === 3);
    assert.ok(wednesday);
    const item = wednesday.items.find((row) => row.id === CONTRACT_SUBJECT_ID);
    assert.ok(item);
    assert.equal(item.latestEp, 1);
    assert.equal(item.ratingScore, 7.6);
    assert.equal(item.name, "Raw title");
    assert.equal(item.nameCn, "中文标题");
    assert.equal(item.summary, "summary");
    assert.equal(item.airWeekday, 3);
    assert.equal(item.platform, "TV");
    assert.equal(item.rank, 1234);
    assert.equal(item.votes, 420);
    assert.deepEqual(item.votesCount, [0, 0, 1, 2, 3, 10, 20, 30, 5, 1]);
    assert.deepEqual(item.tags, [{ name: "原创", count: 10, totalCount: 20 }]);
    assert.equal(Object.hasOwn(item, "bangumiId"), false);
  } finally {
    server.close();
  }
});

test("updates read normalized resource mappings and items", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/updates?days=1&limit=10");
    assert.equal(response.status, 200);
    const item = response.body.data.find((row) => row.id === CONTRACT_SUBJECT_ID);
    assert.ok(item);
    assert.equal(item.latestEp, 1);
    assert.equal(item.latestEpisode, "更新至第01集");
    assert.equal(item.source, "ffzy");
    assert.equal(item.sourceAid, 123);
    assert.equal(item.name, "Raw title");
    assert.equal(item.nameCn, "中文标题");
    assert.equal(item.airDate, "2026-04-01");
    assert.equal(item.airWeekday, 3);
    assert.equal(item.platform, "TV");
    assert.equal(item.eps, 12);
    assert.equal(item.totalEpisodes, 12);
    assert.equal(item.ratingScore, 7.6);
    assert.equal(item.rank, 1234);
    assert.equal(item.votes, 420);
    assert.deepEqual(item.votesCount, [0, 0, 1, 2, 3, 10, 20, 30, 5, 1]);
    assert.deepEqual(item.tags, [{ name: "原创", count: 10, totalCount: 20 }]);
    assert.equal(Object.hasOwn(item, "sourceUpdates"), false);
    assert.equal(Object.hasOwn(item, "bangumiId"), false);
  } finally {
    server.close();
  }
});

test("updates use episode update time when it is newer than catalog time", async () => {
  seedContractSubject();
  sqlite.exec(`
    DELETE FROM episodes WHERE bangumi_id = ${EPISODE_UPDATE_SUBJECT_ID};
    DELETE FROM resource_mappings WHERE bangumi_id = ${EPISODE_UPDATE_SUBJECT_ID};
    DELETE FROM resource_items WHERE source = 'ffzy' AND source_aid = 124;
    DELETE FROM subjects WHERE bangumi_id = ${EPISODE_UPDATE_SUBJECT_ID};

    INSERT INTO subjects (
      bangumi_id, name, name_cn, summary, platform, air_date, air_weekday,
      eps, total_episodes, rating_distribution_json, metadata_fetched_at
    ) VALUES (
      ${EPISODE_UPDATE_SUBJECT_ID}, 'Episode update raw', '剧集更新时间标题',
      'episode update summary', 'TV', '2026-04-02', 4, 12, 12, '[]', datetime('now')
    );
    INSERT INTO resource_items (source, source_aid, title, latest_text, detail_fetched_at)
      VALUES ('ffzy', 124, '剧集更新时间资源站', '2026-05-01 00:00:00', datetime('now'))
      ON CONFLICT(source, source_aid) DO UPDATE SET
        title = excluded.title,
        latest_text = excluded.latest_text,
        detail_fetched_at = excluded.detail_fetched_at;
    INSERT INTO resource_mappings (bangumi_id, source, source_aid, score, matched_at)
      VALUES (${EPISODE_UPDATE_SUBJECT_ID}, 'ffzy', 124, 0.91, datetime('now'))
      ON CONFLICT(bangumi_id, source) DO UPDATE SET source_aid = excluded.source_aid;
    INSERT INTO episodes (bangumi_id, source, source_aid, ep_index, source_ep_index, title, raw_video_url, updated_at)
      VALUES (${EPISODE_UPDATE_SUBJECT_ID}, 'ffzy', 124, 7, 7, '第07集', 'https://example.invalid/7.m3u8', '2026-06-03 11:00:00')
      ON CONFLICT(bangumi_id, source, source_aid, ep_index) DO UPDATE SET updated_at = excluded.updated_at;
  `);

  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/updates?days=1&limit=10&today=2026-06-03");
    assert.equal(response.status, 200);
    const item = response.body.data.find((row) => row.id === EPISODE_UPDATE_SUBJECT_ID);
    assert.ok(item);
    assert.equal(item.latestEp, 7);
    assert.equal(item.latestEpisode, "更新至第07集");
    assert.equal(item.updatedAt, "2026-06-03T03:00:00.000Z");
  } finally {
    server.close();
  }
});

test("search rejects q and tag together", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/search?q=abc&tag=%E5%8E%9F%E5%88%9B");
    assert.equal(response.status, 400);
    assert.equal(response.body.data, null);
    assert.equal(response.body.meta.freshness, "error");
    assert.equal(response.body.meta.error, "invalid_query");
    assert.deepEqual(response.body.meta.warnings, ["q 和 tag 不能同时使用"]);
  } finally {
    server.close();
  }
});

test("missing detail returns the documented error envelope without inline metadata fetch", async () => {
  initDb();
  const missingId = CONTRACT_SUBJECT_ID + 9000;
  sqlite.exec(`
    DELETE FROM retry_state WHERE bangumi_id = ${missingId};
    DELETE FROM subject_aliases WHERE bangumi_id = ${missingId};
    DELETE FROM subject_tags WHERE bangumi_id = ${missingId};
    DELETE FROM subjects WHERE bangumi_id = ${missingId};
  `);

  const server = createServer().listen(0);
  try {
    const response = await getJson(server, `/api/detail?id=${missingId}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.data, null);
    assert.equal(response.body.meta.freshness, "error");
    assert.equal(response.body.meta.error, "subject_not_found");
    assert.deepEqual(response.body.meta.warnings, ["番剧不存在"]);
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS count FROM retry_state WHERE bangumi_id = ? AND kind = 'metadata_fetch'").get(missingId).count,
      0,
    );
  } finally {
    server.close();
  }
});
