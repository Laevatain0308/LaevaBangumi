import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.js";
import { createAccountSyncRuntime } from "../src/runtime/accountSyncRuntime.js";
import { createPublicApiRuntime } from "../src/runtime/publicApiRuntime.js";
import { createTestDatabase } from "./helpers/testDatabase.js";

const SUBJECT_ID = 501;

function getJson(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port: server.address().port, path }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function seedNormalizedFacts(sqlite) {
  sqlite.exec(`
    INSERT INTO bangumi_subjects (
      bangumi_id, name, name_cn, summary, air_date, air_weekday, platform,
      eps, total_episodes, discovered_at, updated_at
    ) VALUES (
      ${SUBJECT_ID}, 'Raw title', '中文标题', 'summary', '2026-04-01', 3, 'TV',
      12, 12, '2026-07-01T00:00:00.000Z', '2026-07-28T00:00:00.000Z'
    );
    INSERT INTO bangumi_subject_images (bangumi_id, large_url)
      VALUES (${SUBJECT_ID}, 'https://example.invalid/cover.jpg');
    INSERT INTO bangumi_subject_rating (
      bangumi_id, score, rank, total,
      count_1, count_2, count_3, count_4, count_5,
      count_6, count_7, count_8, count_9, count_10
    ) VALUES (${SUBJECT_ID}, 7.6, 1234, 420, 0, 0, 1, 2, 3, 10, 20, 30, 5, 1);
    INSERT INTO bangumi_subject_tags (bangumi_id, position, name, count, total_count)
      VALUES (${SUBJECT_ID}, 0, '原创', 10, 20);
    INSERT INTO bangumi_subject_infobox_entries (bangumi_id, entry_position, key, value_kind)
      VALUES (${SUBJECT_ID}, 0, '别名', 'list');
    INSERT INTO bangumi_subject_infobox_values (
      bangumi_id, entry_position, value_position, label, value
    ) VALUES (${SUBJECT_ID}, 0, 0, NULL, 'Alias A');
    INSERT INTO bangumi_subject_refresh_state (
      bangumi_id, last_succeeded_at, next_refresh_at, last_attempted_at,
      consecutive_failures, last_error, updated_at
    ) VALUES (
      ${SUBJECT_ID}, '2026-07-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z',
      '2026-07-28T00:00:00.000Z', 0, NULL, '2026-07-28T00:00:00.000Z'
    );
    INSERT INTO bangumi_calendar_subjects (bangumi_id, weekday) VALUES (${SUBJECT_ID}, 3);

    INSERT INTO source_items (
      source_key, source_item_id, title, year, source_updated_at,
      first_seen_at, last_fetched_at, detail_fetched_at
    ) VALUES (
      'ffzy', '123', '资源站标题', '2026', '2026-07-28T02:00:00.000Z',
      '2026-07-01T00:00:00.000Z', '2026-07-28T02:00:00.000Z',
      '2026-07-28T02:00:00.000Z'
    );
    INSERT INTO source_episodes (
      source_key, source_item_id, episode_index, title, video_url, updated_at
    ) VALUES
      ('ffzy', '123', 13, '第13集', 'https://example.invalid/13.m3u8', '2026-07-27T02:00:00.000Z'),
      ('ffzy', '123', 14, '第14集', 'https://example.invalid/14.m3u8', '2026-07-28T02:00:00.000Z');
    INSERT INTO bangumi_resource_mappings (
      bangumi_id, source_key, source_item_id, source_episode_start, source_episode_end
    ) VALUES (${SUBJECT_ID}, 'ffzy', '123', 13, 24);
  `);
}

function setup(t) {
  const database = createTestDatabase();
  t.after(database.close);
  seedNormalizedFacts(database.sqlite);
  const ensured = [];
  const queued = [];
  const registry = {
    list() { return [{ sourceKey: "ffzy", displayName: "非凡资源" }]; },
  };
  const metadataEnsureService = { ensure(ids) { ensured.push(ids); } };
  const publicApiRuntime = createPublicApiRuntime({
    sqlite: database.sqlite,
    resourceSourceRegistry: registry,
    metadataEnsureService,
    clock: () => new Date("2026-07-28T04:00:00.000Z"),
  });
  const accountSyncRuntime = createAccountSyncRuntime({
    sqlite: database.sqlite,
    metadataEnsureService,
  });
  const server = createServer({
    publicApiRuntime,
    accountSyncRuntime,
    enqueueRemoteSearch(keyword) { queued.push({ keyword }); },
    logger: { log() {}, error() {} },
  }).listen(0);
  t.after(() => server.close());
  return { database, server, ensured, queued };
}

test("public HTTP endpoints read only normalized facts", async (t) => {
  const { server, ensured, queued } = setup(t);

  const search = await getJson(server, "/api/search?q=%E4%B8%AD%E6%96%87");
  assert.equal(search.status, 200);
  assert.equal(search.body.data[0].id, SUBJECT_ID);
  assert.equal(search.body.data[0].nameCn, "中文标题");
  assert.equal(search.body.meta.type, "anime");
  assert.deepEqual(queued, [{ keyword: "中文" }]);

  const tag = await getJson(server, "/api/search?tag=%E5%8E%9F%E5%88%9B");
  assert.equal(tag.status, 200);
  assert.equal(tag.body.data[0].id, SUBJECT_ID);
  assert.equal(queued.length, 1);

  const calendar = await getJson(server, "/api/calendar");
  assert.equal(calendar.status, 200);
  const item = calendar.body.data.find((day) => day.weekday.id === 3).items[0];
  assert.equal(item.latestEp, 2);
  assert.equal(item.lastUpdated, "2026-07-28T02:00:00.000Z");

  const detail = await getJson(server, `/api/detail?id=${SUBJECT_ID}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.meta.resourceStatus, "ready");
  assert.deepEqual(detail.body.data.aliases, ["Alias A"]);
  assert.equal(detail.body.data.channels[0].episodes[0].index, 1);
  assert.equal(detail.body.data.channels[0].episodes[0].sourceIndex, 13);
  assert.equal(detail.body.data.channels[0].episodes[0].name, "第13集");
  assert.equal(detail.body.data.channels[0].episodes[0].playUrl,
    `/anime/api/play?id=${SUBJECT_ID}&ch=1&ep=1`);
  assert.deepEqual(ensured, [[SUBJECT_ID]]);

  const play = await getJson(server, `/api/play?id=${SUBJECT_ID}&ch=1&ep=2`);
  assert.equal(play.status, 200);
  assert.equal(play.body.data.videoUrl, "https://example.invalid/14.m3u8");

  const updates = await getJson(server, "/api/updates?days=1&limit=10&today=2026-07-28");
  assert.equal(updates.status, 200);
  assert.equal(updates.body.data[0].id, SUBJECT_ID);
  assert.equal(updates.body.data[0].latestEp, 2);
  assert.equal(updates.body.data[0].sourceAid, 123);
});

test("HTTP validation and misses retain stable error envelopes", async (t) => {
  const { server, ensured, queued } = setup(t);

  for (const path of [
    "/api/search?q=a",
    "/api/search?q=aa&tag=tag",
    "/api/search?q=aa&type=unknown",
    "/api/search?q=aa&type=tv",
    "/api/search?q=aa&type=movie",
    "/api/search?q=aa&type=variety",
    "/api/updates?type=movie",
    "/api/detail?id=1.5",
    "/api/play?id=501&ch=0&ep=1",
  ]) {
    const response = await getJson(server, path);
    assert.equal(response.status, 400, path);
    assert.equal(response.body.meta.error, "invalid_query", path);
  }

  const missing = await getJson(server, "/api/detail?id=999");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.meta.error, "subject_not_found");
  assert.deepEqual(ensured, [[999]]);

  const missingEpisode = await getJson(server, `/api/play?id=${SUBJECT_ID}&ch=1&ep=13`);
  assert.equal(missingEpisode.status, 404);
  assert.equal(missingEpisode.body.meta.error, "episode_not_found");
});

test("heartbeat is removed while health stays available", async (t) => {
  const { server } = setup(t);

  const heartbeatStatus = await new Promise((resolve, reject) => {
    http.get({
      hostname: "127.0.0.1",
      port: server.address().port,
      path: "/api/heartbeat",
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
  assert.equal(heartbeatStatus, 404);

  const health = await getJson(server, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
});

test("server source no longer imports legacy anime services or database singletons", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("../src/server.js", import.meta.url), "utf8")
  ));
  assert.doesNotMatch(source, /services\/anime\.js|services\/queue\.js|db\/index\.js/);
  assert.match(source, /publicApiRuntime/);
});
