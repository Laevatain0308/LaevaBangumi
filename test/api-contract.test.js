import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.js";
import { initDb, sqlite } from "../src/db/index.js";

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

function seedContractSubject() {
  initDb();
  sqlite.exec(`
    DELETE FROM episodes;
    DELETE FROM resource_mappings;
    DELETE FROM resource_items;
    DELETE FROM subject_tags;
    DELETE FROM tags;
    DELETE FROM subject_aliases;
    DELETE FROM subjects;

    INSERT INTO subjects (
      bangumi_id, name, name_cn, summary, platform, air_date, air_weekday,
      eps, total_episodes, cover_url, rating_score, rating_rank,
      rating_total, rating_distribution_json, metadata_fetched_at, rating_fetched_at
    ) VALUES (
      547888, 'Raw title', '中文标题', 'summary', 'TV', '2026-04-01', 3,
      12, 12, 'https://example.invalid/cover.jpg', 7.6, 1234,
      420, '[0,0,1,2,3,10,20,30,5,1]', datetime('now'), datetime('now')
    );
    INSERT INTO subject_aliases (bangumi_id, alias) VALUES (547888, 'Alias A');
    INSERT INTO tags (tag_id, name) VALUES (1, '原创');
    INSERT INTO subject_tags (bangumi_id, tag_id, count, total_count) VALUES (547888, 1, 10, 20);
    INSERT INTO resource_sources (source, name, enabled) VALUES ('ffzy', '非凡资源', 1)
      ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_items (source, source_aid, title, detail_fetched_at)
      VALUES ('ffzy', 123, '资源站标题', datetime('now'));
    INSERT INTO resource_mappings (bangumi_id, source, source_aid, score, matched_at)
      VALUES (547888, 'ffzy', 123, 0.92, datetime('now'));
    INSERT INTO episodes (bangumi_id, source, source_aid, ep_index, source_ep_index, ep_name, video_url)
      VALUES (547888, 'ffzy', 123, 1, 1, '第01集', 'https://example.invalid/1.m3u8');
  `);
}

test("detail exposes the new stable Aslan DTO contract", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/detail?id=547888");
    assert.equal(response.status, 200);
    const detail = response.body.data;
    assert.equal(detail.id, 547888);
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
    assert.equal(detail.channels[0].episodes[0].playUrl, "/anime/api/play?id=547888&ch=1&ep=1");
    assert.equal(Object.hasOwn(detail.channels[0].episodes[0], "url"), false);
    assert.equal(Object.hasOwn(detail, "bangumiId"), false);
  } finally {
    server.close();
  }
});

test("play exposes videoUrl without legacy videoURL", async () => {
  seedContractSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/play?id=547888&ch=1&ep=1");
    assert.equal(response.status, 200);
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
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].id, 547888);
    assert.equal(Object.hasOwn(response.body.data[0], "bangumiId"), false);
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
  } finally {
    server.close();
  }
});
