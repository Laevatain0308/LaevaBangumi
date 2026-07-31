import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createPublicReadRepository } from "../src/publicApi/publicReadRepository.js";

function seedSubject(sqlite, {
  id,
  name,
  nameCn,
  score,
  votes,
  weekday = null,
  updatedAt = "2026-07-20T00:00:00.000Z",
  detailSucceededAt = "2026-07-20T00:00:00.000Z",
  nextRefreshAt = "2026-08-20T00:00:00.000Z",
} = {}) {
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (
      bangumi_id, name, name_cn, summary, air_date, air_weekday, platform,
      eps, total_episodes, discovered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'TV', 12, 12, ?, ?)
  `).run(id, name, nameCn, `${name} summary`, "2026-04-01", weekday, updatedAt, updatedAt);
  sqlite.prepare(`
    INSERT INTO bangumi_subject_images (
      bangumi_id, large_url, common_url, medium_url, small_url, grid_url
    ) VALUES (?, NULL, ?, ?, NULL, NULL)
  `).run(id, `https://images/${id}-common.jpg`, `https://images/${id}-medium.jpg`);
  sqlite.prepare(`
    INSERT INTO bangumi_subject_rating (
      bangumi_id, score, rank, total,
      count_1, count_2, count_3, count_4, count_5,
      count_6, count_7, count_8, count_9, count_10
    ) VALUES (?, ?, ?, ?, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
  `).run(id, score, id, votes);
  if (detailSucceededAt || nextRefreshAt) {
    sqlite.prepare(`
      INSERT INTO bangumi_subject_refresh_state (
        bangumi_id, last_succeeded_at, next_refresh_at, last_attempted_at,
        consecutive_failures, last_error, updated_at
      ) VALUES (?, ?, ?, ?, 0, NULL, ?)
    `).run(id, detailSucceededAt, nextRefreshAt, detailSucceededAt, updatedAt);
  }
  if (weekday != null) {
    sqlite.prepare(`
      INSERT INTO bangumi_calendar_subjects (bangumi_id, weekday) VALUES (?, ?)
    `).run(id, weekday);
  }
}

function seedSource(sqlite) {
  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, year, source_updated_at,
      first_seen_at, last_fetched_at, detail_fetched_at
    ) VALUES ('ffzy', '500', '采集站标题', '2026', '2026-07-28T02:00:00.000Z',
      '2026-07-01T00:00:00.000Z', '2026-07-28T02:00:00.000Z', '2026-07-28T02:00:00.000Z')
  `).run();
  const insert = sqlite.prepare(`
    INSERT INTO source_episodes (
      source_key, source_item_id, episode_index, title, video_url, updated_at
    ) VALUES ('ffzy', '500', ?, ?, ?, ?)
  `);
  insert.run(13, "第13集", "https://video/13.m3u8", "2026-07-20T00:00:00.000Z");
  insert.run(25, "第25集", "https://video/25.m3u8", "2026-07-28T02:00:00.000Z");
}

function seedFixture(sqlite) {
  seedSubject(sqlite, {
    id: 101,
    name: "Original Name",
    nameCn: "中文名",
    score: 8.1,
    votes: 900,
    weekday: 3,
  });
  seedSubject(sqlite, {
    id: 102,
    name: "Another Work",
    nameCn: "另一部",
    score: 9.0,
    votes: 100,
  });
  const insertEntry = sqlite.prepare(`
    INSERT INTO bangumi_subject_infobox_entries (
      bangumi_id, entry_position, key, value_kind
    ) VALUES (101, ?, ?, ?)
  `);
  const insertValue = sqlite.prepare(`
    INSERT INTO bangumi_subject_infobox_values (
      bangumi_id, entry_position, value_position, label, value
    ) VALUES (101, ?, ?, NULL, ?)
  `);
  insertEntry.run(0, "别名", "list");
  insertValue.run(0, 0, "别名甲");
  insertValue.run(0, 1, "Original Name");
  insertValue.run(0, 2, "");
  insertEntry.run(1, "英文名", "scalar");
  insertValue.run(1, 0, "English Name");
  insertEntry.run(2, "别名", "list");
  insertValue.run(2, 0, "别名甲");
  insertEntry.run(3, "导演", "scalar");
  insertValue.run(3, 0, "不应成为别名");
  sqlite.prepare(`
    INSERT INTO bangumi_subject_tags (bangumi_id, position, name, count, total_count)
    VALUES (101, 0, '原创', 10, 20)
  `).run();
  sqlite.prepare(`
    INSERT INTO bangumi_subject_tags (bangumi_id, position, name, count, total_count)
    VALUES (102, 0, '原创', 5, 10)
  `).run();
  seedSource(sqlite);
  sqlite.prepare(`
    INSERT INTO bangumi_resource_mappings (
      bangumi_id, source_key, source_item_id, source_episode_start, source_episode_end
    ) VALUES (101, 'ffzy', '500', 13, 24)
  `).run();
}

function createFixture(t) {
  const database = createTestDatabase();
  t.after(database.close);
  seedFixture(database.sqlite);
  return database;
}

test("subject projection reads normalized metadata and ordered aliases", (t) => {
  const { sqlite } = createFixture(t);
  const repository = createPublicReadRepository(sqlite);

  assert.deepEqual(repository.findSubject(101), {
    bangumiId: 101,
    name: "Original Name",
    nameCn: "中文名",
    summary: "Original Name summary",
    airDate: "2026-04-01",
    airWeekday: 3,
    platform: "TV",
    eps: 12,
    totalEpisodes: 12,
    updatedAt: "2026-07-20T00:00:00.000Z",
    detailSucceededAt: "2026-07-20T00:00:00.000Z",
    nextRefreshAt: "2026-08-20T00:00:00.000Z",
    coverUrl: "https://images/101-common.jpg",
    ratingScore: 8.1,
    rank: 101,
    votes: 900,
    votesCount: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    tags: [{ name: "原创", count: 10, totalCount: 20 }],
  });
  assert.deepEqual(repository.listAliases(101), ["别名甲", "English Name"]);
  assert.equal(repository.findSubject(999), null);
  assert.deepEqual(repository.listAliases(999), []);
});

test("local search matches names aliases and tags with stable ranking", (t) => {
  const { sqlite } = createFixture(t);
  const repository = createPublicReadRepository(sqlite);

  assert.deepEqual(repository.searchSubjects({ query: "中文" }).map((row) => row.bangumiId), [101]);
  assert.deepEqual(repository.searchSubjects({ query: "English Name" }).map((row) => row.bangumiId), [101]);
  assert.deepEqual(repository.searchSubjects({ query: "原创" }).map((row) => row.bangumiId), [101, 102]);
  assert.deepEqual(repository.searchSubjects({ tag: "原创" }).map((row) => row.bangumiId), [101, 102]);
  assert.deepEqual(repository.searchSubjects({ tag: "原" }), []);
  assert.deepEqual(repository.searchSubjects({ query: "%_\\" }), []);
});

test("calendar mappings and latest source episode use only normalized tables", (t) => {
  const { sqlite } = createFixture(t);
  const repository = createPublicReadRepository(sqlite);

  const calendar = repository.listCalendarSubjects();
  assert.equal(calendar.length, 1);
  assert.equal(calendar[0].weekday, 3);
  assert.equal(calendar[0].subject.bangumiId, 101);

  assert.deepEqual(repository.listMappingsWithEpisodes(101), [{
    bangumiId: 101,
    sourceKey: "ffzy",
    sourceItemId: "500",
    sourceTitle: "采集站标题",
    sourceEpisodeStart: 13,
    sourceEpisodeEnd: 24,
    episodes: [
      {
        sourceIndex: 13,
        title: "第13集",
        videoUrl: "https://video/13.m3u8",
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
      {
        sourceIndex: 25,
        title: "第25集",
        videoUrl: "https://video/25.m3u8",
        updatedAt: "2026-07-28T02:00:00.000Z",
      },
    ],
  }]);

  const candidates = repository.listUpdateCandidates({
    cutoffAt: "2026-07-27T00:00:00.000Z",
    nowAt: "2026-07-28T23:59:59.999Z",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceIndex, 25);
  assert.equal(candidates[0].bangumiId, 101);
  assert.equal(candidates[0].subject.nameCn, "中文名");
  assert.deepEqual(repository.listUpdateCandidates({
    cutoffAt: "2026-07-28T03:00:00.000Z",
    nowAt: "2026-07-29T00:00:00.000Z",
  }), []);
});

test("updates candidates include only subjects from the Bangumi calendar", (t) => {
  const { sqlite } = createFixture(t);
  seedSubject(sqlite, {
    id: 103,
    name: "Old Anime",
    nameCn: "老番",
    score: 7.0,
    votes: 10,
  });
  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, year, source_updated_at,
      first_seen_at, last_fetched_at, detail_fetched_at
    ) VALUES ('ffzy', '501', '老番资源', '2022', '2026-07-28T02:00:00.000Z',
      '2026-07-01T00:00:00.000Z', '2026-07-28T02:00:00.000Z', '2026-07-28T02:00:00.000Z')
  `).run();
  sqlite.prepare(`
    INSERT INTO source_episodes (
      source_key, source_item_id, episode_index, title, video_url, updated_at
    ) VALUES ('ffzy', '501', 12, '第12集', 'https://video/501.m3u8', '2026-07-28T02:00:00.000Z')
  `).run();
  sqlite.prepare(`
    INSERT INTO bangumi_resource_mappings (
      bangumi_id, source_key, source_item_id, source_episode_start, source_episode_end
    ) VALUES (103, 'ffzy', '501', 1, 12)
  `).run();

  const repository = createPublicReadRepository(sqlite);
  const candidates = repository.listUpdateCandidates({
    cutoffAt: "2026-07-27T00:00:00.000Z",
    nowAt: "2026-07-28T23:59:59.999Z",
  });

  assert.deepEqual(candidates.map((row) => row.bangumiId), [101]);
});

test("public read repository prepares only read statements", (t) => {
  const { sqlite } = createFixture(t);
  const statements = [];
  const observedSqlite = {
    prepare(sql) {
      statements.push(sql.trim());
      return sqlite.prepare(sql);
    },
  };
  const repository = createPublicReadRepository(observedSqlite);
  repository.findSubject(101);
  repository.listAliases(101);
  repository.searchSubjects({ query: "中文" });
  repository.listCalendarSubjects();
  repository.listMappingsWithEpisodes(101);
  repository.listUpdateCandidates({
    cutoffAt: "2026-07-27T00:00:00.000Z",
    nowAt: "2026-07-28T23:59:59.999Z",
  });

  assert.ok(statements.length > 0);
  for (const sql of statements) assert.match(sql, /^(SELECT|WITH)\b/i, sql);
});
