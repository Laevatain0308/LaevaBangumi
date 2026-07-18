import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createSyncRepository } from "../src/sync/syncRepository.js";
import { createSyncSnapshotService } from "../src/sync/syncSnapshotService.js";
import { createBangumiSummaryRepository } from "../src/bangumi/bangumiSummaryRepository.js";
import { createSyncMergeService } from "../src/sync/syncMergeService.js";

const NOW = "2026-07-16T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function createContext(t, { ensureMetadata = () => {}, logger = {} } = {}) {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  sqlite.prepare(`
    INSERT INTO accounts (username, password_hash, created_at, password_changed_at)
    VALUES ('alice', 'hash', ?, ?)
  `).run(NOW, NOW);
  const accountId = Number(sqlite.prepare("SELECT account_id FROM accounts").get().account_id);
  const syncRepository = createSyncRepository({ sqlite, clock: () => new Date(NOW) });
  const summaryRepository = createBangumiSummaryRepository(sqlite);
  const service = createSyncSnapshotService({
    syncRepository,
    summaryRepository,
    ensureMetadata,
    clock: () => new Date(NOW),
    logger,
  });
  return { sqlite, accountId, syncRepository, summaryRepository, service };
}

function seedPrivateState(sqlite, accountId) {
  sqlite.prepare(`
    INSERT INTO watch_records (
      account_id, bangumi_id, last_watch_episode, last_watch_time_ms,
      last_watch_episode_name, record_version
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, 123, 3, NOW_MS, "第 3 集", "watch-v3");
  sqlite.prepare(`
    INSERT INTO watch_progress (
      account_id, bangumi_id, episode, road, progress_ms, progress_version
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, 123, 3, 1, 120_000, "progress-v3");
  sqlite.prepare(`
    INSERT INTO watch_records (
      account_id, bangumi_id, last_watch_episode, last_watch_time_ms,
      last_watch_episode_name, record_version
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, 999, 1, NOW_MS - 1, "Unknown", "watch-unknown");
  sqlite.prepare("INSERT INTO watch_state (account_id, clear_version) VALUES (?, ?)")
    .run(accountId, "watch-clear");
  sqlite.prepare(`
    INSERT INTO collection_records (
      account_id, bangumi_id, type, collected_at_ms, updated_at_ms, record_version
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(accountId, 123, 2, NOW_MS - 2, NOW_MS, "collection-v2");
  sqlite.prepare("INSERT INTO collection_state (account_id, clear_version) VALUES (?, ?)")
    .run(accountId, "collection-clear");
}

function seedSubject(sqlite) {
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (
      bangumi_id, name, name_cn, summary, air_date, air_weekday,
      platform, eps, total_episodes, discovered_at, updated_at
    ) VALUES (123, 'Original title', '中文标题', 'summary', '2026-07-01', 3,
      'TV', 12, 12, ?, ?)
  `).run(NOW, NOW);
  sqlite.prepare(`
    INSERT INTO bangumi_subject_images (bangumi_id, large_url)
    VALUES (123, 'https://example.invalid/cover.jpg')
  `).run();
  sqlite.prepare(`
    INSERT INTO bangumi_subject_rating (bangumi_id, score, rank, total)
    VALUES (123, 8.2, 20, 100)
  `).run();
  const insertTag = sqlite.prepare(`
    INSERT INTO bangumi_subject_tags (bangumi_id, position, name, count, total_count)
    VALUES (123, ?, ?, 1, 1)
  `);
  insertTag.run(0, "动画");
  insertTag.run(1, "冒险");
}

test("snapshot assembles exact normalized state and batched public summaries", (t) => {
  const ensured = [];
  const context = createContext(t, { ensureMetadata(ids) { ensured.push(ids); } });
  seedPrivateState(context.sqlite, context.accountId);
  seedSubject(context.sqlite);
  const calls = [];
  const summaryRepository = {
    findByIds(ids) {
      calls.push(ids);
      return context.summaryRepository.findByIds(ids);
    },
  };
  const service = createSyncSnapshotService({
    syncRepository: context.syncRepository,
    summaryRepository,
    ensureMetadata(ids) { ensured.push(ids); },
    clock: () => new Date(NOW),
  });

  const snapshot = service.build(context.accountId);
  const subject = {
    id: 123,
    title: "中文标题",
    name: "Original title",
    nameCn: "中文标题",
    summary: "summary",
    airDate: "2026-07-01",
    airWeekday: 3,
    platform: "TV",
    eps: 12,
    totalEpisodes: 12,
    coverUrl: "https://example.invalid/cover.jpg",
    ratingScore: 8.2,
    rank: 20,
    votes: 100,
    tags: ["动画", "冒险"],
  };
  assert.deepEqual(snapshot, {
    generatedAt: NOW_MS,
    watch: {
      clearVersion: "watch-clear",
      records: [
        {
          bangumiId: 123,
          lastWatchEpisode: 3,
          lastWatchTime: NOW_MS,
          lastWatchEpisodeName: "第 3 集",
          recordVersion: "watch-v3",
          progresses: {
            "3": { episode: 3, road: 1, progressMs: 120_000, version: "progress-v3" },
          },
          subject,
        },
        {
          bangumiId: 999,
          lastWatchEpisode: 1,
          lastWatchTime: NOW_MS - 1,
          lastWatchEpisodeName: "Unknown",
          recordVersion: "watch-unknown",
          progresses: {},
          subject: null,
        },
      ],
    },
    collection: {
      clearVersion: "collection-clear",
      records: [{
        bangumiId: 123,
        type: 2,
        collectedAt: NOW_MS - 2,
        updatedAt: NOW_MS,
        recordVersion: "collection-v2",
        subject,
      }],
    },
  });
  assert.deepEqual(calls, [[123, 999]], "watch and collection IDs must share one summary lookup");
  assert.deepEqual(ensured, [[123, 999]]);
  assert.equal(/bangumiItem|entityKey|adapterName|lastSrc/.test(JSON.stringify(snapshot)), false);
});

test("snapshot metadata registration failure is logged after local reads and never changes output", (t) => {
  const logs = [];
  const context = createContext(t, {
    ensureMetadata() { throw new Error("ensure failed"); },
    logger: { error(scope, message, meta) { logs.push({ scope, message, meta }); } },
  });
  seedPrivateState(context.sqlite, context.accountId);
  seedSubject(context.sqlite);

  const snapshot = context.service.build(context.accountId);
  assert.equal(snapshot.watch.records.length, 2);
  assert.equal(snapshot.watch.records[0].subject.id, 123);
  assert.equal(snapshot.watch.records[1].subject, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0].meta.message, /ensure failed/);
});

test("summary repository filters IDs, chunks at 500, and reads only the new metadata tables", (t) => {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  seedSubject(sqlite);
  const statements = [];
  const observedSqlite = new Proxy(sqlite, {
    get(target, property) {
      if (property === "prepare") {
        return (sql) => {
          statements.push(String(sql));
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const repository = createBangumiSummaryRepository(observedSqlite);
  const ids = Array.from({ length: 501 }, (_, index) => index + 1);
  const result = repository.findByIds([0, -1, 1.5, 123, 123, ...ids]);

  assert.equal(result.get(123).title, "中文标题");
  assert.equal(result.size, 1);
  assert.equal(statements.length, 8, "two chunks must each issue four batched table reads");
  assert.equal(statements.every((sql) => /bangumi_subjects|bangumi_subject_images|bangumi_subject_rating|bangumi_subject_tags/.test(sql)), true);
  assert.equal(statements.every((sql) => !/\bFROM\s+subjects\b/i.test(sql)), true);
  statements.length = 0;
  assert.deepEqual(repository.findByIds([]), new Map());
  assert.equal(statements.length, 0);
});

test("merge attaches the injected local snapshot after a successful transaction", (t) => {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  sqlite.prepare(`
    INSERT INTO accounts (username, password_hash, created_at, password_changed_at)
    VALUES ('alice', 'hash', ?, ?)
  `).run(NOW, NOW);
  const accountId = Number(sqlite.prepare("SELECT account_id FROM accounts").get().account_id);
  sqlite.prepare(`
    INSERT INTO account_devices (
      account_id, device_id, first_seen_at, last_seen_at
    ) VALUES (?, 'device-a', ?, ?)
  `).run(accountId, NOW, NOW);
  const repository = createSyncRepository({ sqlite, clock: () => new Date(NOW) });
  const calls = [];
  const expectedSnapshot = { generatedAt: NOW_MS, watch: {}, collection: {} };
  const service = createSyncMergeService({
    repository,
    clock: () => new Date(NOW),
    snapshotService: {
      build(value) {
        calls.push(value);
        assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sync_events").get().n, 1);
        return expectedSnapshot;
      },
    },
  });
  const result = service.merge({
    accountId,
    deviceId: "device-a",
    events: [{
      eventId: "snapshot:1",
      deviceId: "device-a",
      seq: 1,
      domain: "collection",
      op: "collection.upsert",
      updatedAt: NOW_MS,
      bangumiId: 123,
      payload: { type: 2, collectedAt: NOW_MS },
    }],
  });

  assert.equal(result.snapshot, expectedSnapshot);
  assert.deepEqual(calls, [accountId]);
});
