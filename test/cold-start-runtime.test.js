import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initDb } from "../src/db/index.js";
import { createBangumiRuntime } from "../src/runtime/bangumiRuntime.js";
import { createMappingRuntime } from "../src/mappings/mappingRuntime.js";
import { createAccountSyncRuntime } from "../src/runtime/accountSyncRuntime.js";
import { createPublicApiRuntime } from "../src/runtime/publicApiRuntime.js";
import { ResourceSourceRegistry } from "../src/resourceSources/pluginRegistry.js";
import FFZYSource from "../src/resourceSources/ffzy/FFZYSource.js";

const NOW = "2026-07-28T04:00:00.000Z";
const BANGUMI_ID = 547888;

const summary = {
  id: BANGUMI_ID,
  type: 2,
  name: "Bocchi the Rock!",
  name_cn: "孤独摇滚！",
  date: "2026-04-01",
  platform: "TV",
};

const detail = {
  ...summary,
  summary: "乐队少女的故事",
  air_weekday: 3,
  eps: 2,
  total_episodes: 2,
  images: { large: "https://example.invalid/bocchi.jpg" },
  rating: { score: 8.2, rank: 100, total: 500, count: { 8: 300 } },
  tags: [{ name: "音乐", count: 50, total_count: 100 }],
  infobox: [{ key: "别名", value: [{ v: "孤独摇滚" }] }],
};

function createFileDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "laeva-cold-start-"));
  const databasePath = join(directory, "anime.db");
  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  initDb(sqlite);
  t.after(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return sqlite;
}

test("a fresh database composes every normalized runtime into one public lifecycle", async (t) => {
  const sqlite = createFileDatabase(t);
  const clock = () => new Date(NOW);
  const logger = { log() {}, warn() {}, error() {} };
  const registry = new ResourceSourceRegistry([new FFZYSource({
    db: sqlite,
    logger,
    clock,
    client: {},
  })]);
  const sourceKeys = registry.list().map(({ sourceKey }) => sourceKey);
  const mappingRuntime = createMappingRuntime({ sqlite, sourceKeys, clock, logger });
  let detailRequests = 0;
  const bangumiRuntime = createBangumiRuntime({
    sqlite,
    clock,
    logger,
    client: {
      async search() { return { data: [summary] }; },
      async getCalendar() {
        return [{ weekday: { id: 3 }, items: [summary] }];
      },
      async getSubject(id) {
        detailRequests += 1;
        assert.equal(id, BANGUMI_ID);
        return detail;
      },
    },
    onSubjectsPersisted: mappingRuntime.onSubjectsPersisted,
    onDetailPersisted: mappingRuntime.onDetailPersisted,
  });
  const accountSyncRuntime = createAccountSyncRuntime({
    sqlite,
    metadataEnsureService: bangumiRuntime.metadataEnsureService,
    clock,
    logger,
  });
  const publicApiRuntime = createPublicApiRuntime({
    sqlite,
    resourceSourceRegistry: registry,
    metadataEnsureService: bangumiRuntime.metadataEnsureService,
    clock,
    logger,
  });

  assert.equal(typeof accountSyncRuntime.syncSnapshotService.build, "function");
  assert.deepEqual(
    await bangumiRuntime.metadataService.searchAndPersist("孤独摇滚", { mediaType: "anime" }),
    { received: 1, persisted: 1, rejected: 0 },
  );
  await bangumiRuntime.metadataWorker.drain();
  assert.equal(detailRequests, 1);
  assert.equal(
    bangumiRuntime.repository.findRefreshState(BANGUMI_ID).lastSucceededAt,
    NOW,
  );
  assert.equal((await bangumiRuntime.calendarService.sync()).members, 1);

  const ffzy = registry.get("ffzy");
  const resource = {
    sourceKey: "ffzy",
    sourceItemId: "98509",
    title: "孤独摇滚！",
    aliases: ["Bocchi the Rock!"],
    year: "2026",
    sourceUpdatedAt: NOW,
  };
  assert.equal(await ffzy.saveCatalogItems([resource]), 1);
  assert.equal(await ffzy.saveDetail({
    ...resource,
    episodes: [
      { episodeIndex: 1, title: "第01集", videoUrl: "https://example.invalid/1.m3u8" },
      { episodeIndex: 2, title: "第02集", videoUrl: "https://example.invalid/2.m3u8" },
    ],
  }), 2);
  ffzy.repository.markSuccess("initialize", { initialized: true, watermarkAt: NOW });

  assert.deepEqual(mappingRuntime.autoMatcher.matchSubject({
    bangumiId: BANGUMI_ID,
    sourceKey: "ffzy",
  }), {
    status: "mapped",
    bangumiId: BANGUMI_ID,
    sourceKey: "ffzy",
    sourceItemId: "98509",
  });

  const search = await publicApiRuntime.search({ query: "孤独摇滚", mediaType: "anime" });
  assert.equal(search.data[0].id, BANGUMI_ID);
  const calendar = await publicApiRuntime.calendar();
  assert.equal(calendar.data.find(({ weekday }) => weekday.id === 3).items[0].latestEp, 2);
  const publicDetail = await publicApiRuntime.detail(BANGUMI_ID);
  assert.equal(publicDetail.resourceStatus, "ready");
  assert.equal(publicDetail.data.channels[0].episodes[1].sourceIndex, 2);
  assert.deepEqual(await publicApiRuntime.play({
    bangumiId: BANGUMI_ID,
    channelIndex: 1,
    episodeIndex: 2,
  }), {
    videoUrl: "https://example.invalid/2.m3u8",
    directPlay: false,
    headers: {},
    expiresAt: null,
  });
  assert.equal(publicApiRuntime.repository.listUpdateCandidates({
    cutoffAt: "2026-07-27T04:00:00.000Z",
    nowAt: NOW,
  }).length, 1);
  const updates = await publicApiRuntime.updates({ days: 1, limit: 10, mediaType: "anime" });
  assert.equal(updates.data[0].id, BANGUMI_ID);
  assert.equal(updates.data[0].latestEp, 2);

  const forbiddenTables = new Set([
    "anime_other", "subjects", "subject_aliases", "tags", "subject_tags",
    "resource_sources", "resource_items", "resource_mappings", "episodes",
    "sync_state", "retry_state", "manual_resource_state",
  ]);
  const tables = sqlite.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map(({ name }) => name);
  assert.deepEqual(tables.filter((name) => forbiddenTables.has(name)), []);
});
