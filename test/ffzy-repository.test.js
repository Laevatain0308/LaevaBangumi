import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createFFZYRepository } from "../src/resourceSources/ffzy/ffzyRepository.js";

const item = {
  sourceKey: "ffzy",
  sourceItemId: "98509",
  title: "魔法少女奈叶EXCEEDS",
  aliases: [],
  year: "2026",
  sourceUpdatedAt: "2026-07-11T17:16:35.000Z",
};

function detail({ aliases = ["Nanoha"], episodeCount = 3 } = {}) {
  return {
    ...item,
    aliases,
    episodes: Array.from({ length: episodeCount }, (_, index) => ({
      episodeIndex: index + 1,
      title: `播放项 ${index + 1}`,
      videoUrl: `https://example.invalid/${index + 1}.m3u8`,
    })),
  };
}

function createFixture(start = "2026-07-15T00:00:00.000Z") {
  const database = createTestDatabase();
  let now = new Date(start);
  const repository = createFFZYRepository({
    sqlite: database.sqlite,
    clock: () => new Date(now),
  });
  return {
    ...database,
    repository,
    setNow(value) { now = new Date(value); },
  };
}

test("catalog upsert preserves first observation and reports changed IDs", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  assert.deepEqual(fixture.repository.listChangedItemIds([item]), ["98509"]);
  assert.equal(fixture.repository.saveCatalogItems([item]), 1);
  assert.deepEqual(fixture.repository.listChangedItemIds([item]), []);

  fixture.setNow("2026-07-15T01:00:00.000Z");
  const changed = { ...item, title: "更新标题", sourceUpdatedAt: "2026-07-11T18:00:00.000Z" };
  assert.deepEqual(fixture.repository.listChangedItemIds([changed]), ["98509"]);
  fixture.repository.saveCatalogItems([changed]);
  assert.deepEqual(fixture.repository.getItem("98509"), {
    ...changed,
    aliases: [],
    firstSeenAt: "2026-07-15T00:00:00.000Z",
    lastFetchedAt: "2026-07-15T01:00:00.000Z",
  });
});

test("catalog hydration changes are separate from automatic-match fact changes", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  fixture.repository.saveCatalogItems([
    item,
    { ...item, sourceItemId: "no-episodes" },
  ]);
  fixture.repository.saveDetail(detail());

  assert.deepEqual(fixture.repository.listMatchableItemIds([
    "missing", "98509", "no-episodes", "98509",
  ]), ["98509"]);
  const timestampOnly = { ...item, sourceUpdatedAt: "2026-07-25T00:00:00.000Z" };
  assert.deepEqual(fixture.repository.listChangedItemIds([timestampOnly]), ["98509"]);
  assert.deepEqual(fixture.repository.listChangedMatchFactItemIds([timestampOnly]), []);
  assert.deepEqual(fixture.repository.listChangedMatchFactItemIds([
    { ...timestampOnly, title: "更新标题" },
  ]), ["98509"]);
});

test("catalog updates do not clear detail timestamps aliases or episodes", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  fixture.repository.saveDetail(detail());
  fixture.setNow("2026-07-15T02:00:00.000Z");
  fixture.repository.saveCatalogItems([{ ...item, title: "目录标题" }]);

  assert.deepEqual(fixture.repository.getItem("98509").aliases, ["Nanoha"]);
  assert.equal(fixture.repository.getEpisodes("98509").length, 3);
  assert.equal(fixture.sqlite.prepare(`
    SELECT detail_fetched_at FROM source_items
    WHERE source_key = 'ffzy' AND source_item_id = '98509'
  `).get().detail_fetched_at, "2026-07-15T00:00:00.000Z");
});

test("detail replacement reports normalized matching-fact changes", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  assert.deepEqual(
    fixture.repository.saveDetailWithChanges(detail({ aliases: ["Nanoha", "奈叶"], episodeCount: 3 })),
    { savedEpisodes: 3, matchingFactsChanged: true },
  );
  fixture.setNow("2026-07-15T03:00:00.000Z");
  assert.deepEqual(fixture.repository.saveDetailWithChanges({
    ...detail({ aliases: ["奈叶", "Nanoha"], episodeCount: 3 }),
    episodes: detail({ episodeCount: 3 }).episodes.map((episode) => ({
      ...episode,
      title: `新${episode.title}`,
      videoUrl: `${episode.videoUrl}?updated=1`,
    })),
  }), { savedEpisodes: 3, matchingFactsChanged: false });

  assert.deepEqual(fixture.repository.saveDetailWithChanges({
    ...detail({ aliases: ["魔法少女"], episodeCount: 2 }),
    episodes: [
      { episodeIndex: 1, title: "新顺序 1", videoUrl: "https://example.invalid/new-1.m3u8" },
      { episodeIndex: 2, title: "新顺序 2", videoUrl: "https://example.invalid/new-2.m3u8" },
    ],
  }), { savedEpisodes: 2, matchingFactsChanged: true });

  assert.deepEqual(fixture.repository.getItem("98509").aliases, ["魔法少女"]);
  assert.deepEqual(fixture.repository.getEpisodes("98509").map((episode) => episode.episodeIndex), [1, 2]);
  assert.deepEqual(fixture.repository.getEpisode("98509", 1), {
    episodeIndex: 1,
    title: "新顺序 1",
    videoUrl: "https://example.invalid/new-1.m3u8",
  });

  assert.equal(fixture.repository.saveDetailWithChanges({
    ...detail({ aliases: ["魔法少女"], episodeCount: 2 }),
    title: "更新标题",
  }).matchingFactsChanged, true);
  assert.equal(fixture.repository.saveDetailWithChanges({
    ...detail({ aliases: ["魔法少女"], episodeCount: 2 }),
    title: "更新标题",
    year: "2027",
  }).matchingFactsChanged, true);
});

test("detail replacement timestamps only new and changed episodes", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  fixture.repository.saveDetail(detail({ episodeCount: 3 }));

  fixture.setNow("2026-07-15T03:00:00.000Z");
  fixture.repository.saveDetail({
    ...detail({ episodeCount: 3 }),
    episodes: [
      { episodeIndex: 1, title: "播放项 1", videoUrl: "https://example.invalid/1.m3u8" },
      { episodeIndex: 2, title: "修正播放项 2", videoUrl: "https://example.invalid/2-fixed.m3u8" },
      { episodeIndex: 4, title: "播放项 4", videoUrl: "https://example.invalid/4.m3u8" },
    ],
  });

  assert.deepEqual(fixture.sqlite.prepare(`
    SELECT episode_index, updated_at
    FROM source_episodes
    WHERE source_key = 'ffzy' AND source_item_id = '98509'
    ORDER BY episode_index
  `).all(), [
    { episode_index: 1, updated_at: "2026-07-15T00:00:00.000Z" },
    { episode_index: 2, updated_at: "2026-07-15T03:00:00.000Z" },
    { episode_index: 4, updated_at: "2026-07-15T03:00:00.000Z" },
  ]);
});

test("identical detail refresh preserves every episode timestamp", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  fixture.repository.saveDetail(detail({ episodeCount: 2 }));
  fixture.setNow("2026-07-16T00:00:00.000Z");
  fixture.repository.saveDetail(detail({ episodeCount: 2 }));

  assert.deepEqual(fixture.sqlite.prepare(`
    SELECT DISTINCT updated_at
    FROM source_episodes
    WHERE source_key = 'ffzy' AND source_item_id = '98509'
  `).all(), [{ updated_at: "2026-07-15T00:00:00.000Z" }]);
});

test("detail write is atomic", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  fixture.repository.saveDetail(detail());
  assert.throws(() => fixture.repository.saveDetail({
    ...detail({ aliases: ["Should Roll Back"], episodeCount: 1 }),
    episodes: [{ episodeIndex: 0, title: "Invalid", videoUrl: "https://example.invalid/invalid.m3u8" }],
  }), /CHECK constraint failed/i);
  assert.equal(fixture.repository.getItem("98509").aliases.includes("Should Roll Back"), false);
});

test("local search reads titles and aliases only from SQLite", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  fixture.repository.saveDetail(detail({ aliases: ["Nanoha"] }));
  assert.deepEqual(fixture.repository.searchItems("Nanoha").map((row) => row.sourceItemId), ["98509"]);
  assert.deepEqual(fixture.repository.searchItems("奈叶").map((row) => row.sourceItemId), ["98509"]);
  assert.deepEqual(fixture.repository.searchItems("missing"), []);
});

test("sync state success advances state while failure preserves initialization and watermark", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  assert.deepEqual(fixture.repository.getSyncState(), {
    initialized: false,
    watermarkAt: null,
    status: "idle",
    lastOperation: null,
    lastStartedAt: null,
    lastSuccessAt: null,
    lastError: null,
  });
  fixture.repository.markRunning("initialize");
  fixture.repository.markSuccess("initialize", {
    initialized: true,
    watermarkAt: "2026-07-11T17:16:35.000Z",
  });
  fixture.setNow("2026-07-15T04:00:00.000Z");
  fixture.repository.markFailed("update", new Error("disk full"));
  const state = fixture.repository.getSyncState();
  assert.equal(state.initialized, true);
  assert.equal(state.watermarkAt, "2026-07-11T17:16:35.000Z");
  assert.equal(state.status, "failed");
  assert.equal(state.lastError, "disk full");
});

test("detail failures back off for 6, 12, then 24 hours and clear after detail save", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  fixture.repository.saveCatalogItems([item]);

  const expected = [
    "2026-07-15T06:00:00.000Z",
    "2026-07-15T12:00:00.000Z",
    "2026-07-16T00:00:00.000Z",
    "2026-07-16T00:00:00.000Z",
  ];
  for (let index = 0; index < expected.length; index += 1) {
    fixture.repository.recordDetailFailure("98509", new Error(`failure ${index + 1}`));
    const row = fixture.sqlite.prepare(`
      SELECT failure_count, next_retry_at FROM source_detail_failures
      WHERE source_key = 'ffzy' AND source_item_id = '98509'
    `).get();
    assert.equal(row.failure_count, index + 1);
    assert.equal(row.next_retry_at, expected[index]);
  }
  fixture.setNow("2026-07-16T01:00:00.000Z");
  assert.deepEqual(fixture.repository.listDueDetailFailures().map((row) => row.sourceItemId), ["98509"]);
  fixture.repository.saveDetail(detail());
  assert.deepEqual(fixture.repository.listDueDetailFailures(), []);
});

test("sync skip is persisted without initializing the source", (t) => {
  const fixture = createFixture();
  t.after(fixture.close);
  fixture.repository.markSkipped("update", "full initialization required");
  const state = fixture.repository.getSyncState();
  assert.equal(state.initialized, false);
  assert.equal(state.status, "skipped");
  assert.equal(state.lastError, "full initialization required");
});
