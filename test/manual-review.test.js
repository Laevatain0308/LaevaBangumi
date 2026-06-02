import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { initDb, db, sqlite } from "../src/db/index.js";
import {
  anime,
  animeOther,
  bangumiCstationMap,
  cstationCatalog,
  episodeFetchRetryState,
  episodes,
  manualMatchState,
  matchRetryState,
} from "../src/db/schema.js";
import {
  analyzeMappedMappings,
  analyzeUnmappedMappings,
  exportMappedReview,
  exportManualReview,
  importMappedReview,
  importManualReview,
} from "../src/services/manualMatches.js";
import { batchMatch, ensureMappingForAnime, getAnimeDetail, getPlayUrl, getUpdates, prewarmAnime, refreshEpisodesForAnime, retryPending, syncCalendar, upsertAnime } from "../src/services/anime.js";
import { saveCatalog } from "../src/services/catalog.js";

const SOURCE = "test_manual";
const ANIME_ID = 999900001;
const SOURCE_AID = 999900101;
const RANGE_ANIME_ID = 999900002;
const RANGE_SOURCE_AID = 999900201;
const EXTRA_ANIME_ID = ANIME_ID + 100;
const EXTRA_SOURCE_AID = SOURCE_AID + 100;
const NEW_SOURCE_AID = SOURCE_AID + 1;

initDb();

async function withCsv(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "manual-review-"));
  const filePath = join(dir, "review.csv");
  await writeFile(filePath, content, "utf8");
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempPath(fn) {
  const dir = await mkdtemp(join(tmpdir(), "manual-review-"));
  const filePath = join(dir, "review.csv");
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cleanup() {
  sqlite.prepare("DELETE FROM episodes WHERE source = ?").run(SOURCE);
  sqlite.prepare("DELETE FROM resource_mappings WHERE source = ?").run(SOURCE);
  sqlite.prepare("DELETE FROM resource_items WHERE source = ?").run(SOURCE);
  sqlite.prepare("DELETE FROM retry_state WHERE source = ?").run(SOURCE);
  sqlite.prepare("DELETE FROM manual_resource_state WHERE source = ?").run(SOURCE);
  sqlite.prepare("DELETE FROM episodes WHERE bangumi_id IN (?, ?, ?)").run(ANIME_ID, RANGE_ANIME_ID, EXTRA_ANIME_ID);
  sqlite.prepare("DELETE FROM resource_mappings WHERE bangumi_id IN (?, ?, ?)").run(ANIME_ID, RANGE_ANIME_ID, EXTRA_ANIME_ID);
  sqlite.prepare("DELETE FROM retry_state WHERE bangumi_id IN (?, ?, ?)").run(ANIME_ID, RANGE_ANIME_ID, EXTRA_ANIME_ID);
  sqlite.prepare("DELETE FROM manual_resource_state WHERE bangumi_id IN (?, ?, ?)").run(ANIME_ID, RANGE_ANIME_ID, EXTRA_ANIME_ID);
  sqlite.prepare("DELETE FROM subjects WHERE bangumi_id IN (?, ?, ?)").run(ANIME_ID, RANGE_ANIME_ID, EXTRA_ANIME_ID);
  db.delete(bangumiCstationMap)
    .where(eq(bangumiCstationMap.source, SOURCE))
    .run();
  db.delete(bangumiCstationMap)
    .where(eq(bangumiCstationMap.animeId, ANIME_ID))
    .run();
  db.delete(bangumiCstationMap)
    .where(eq(bangumiCstationMap.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(bangumiCstationMap)
    .where(eq(bangumiCstationMap.animeId, EXTRA_ANIME_ID))
    .run();
  db.delete(matchRetryState)
    .where(eq(matchRetryState.source, SOURCE))
    .run();
  db.delete(matchRetryState)
    .where(eq(matchRetryState.animeId, ANIME_ID))
    .run();
  db.delete(matchRetryState)
    .where(eq(matchRetryState.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(matchRetryState)
    .where(eq(matchRetryState.animeId, EXTRA_ANIME_ID))
    .run();
  db.delete(episodeFetchRetryState)
    .where(eq(episodeFetchRetryState.source, SOURCE))
    .run();
  db.delete(episodeFetchRetryState)
    .where(eq(episodeFetchRetryState.animeId, ANIME_ID))
    .run();
  db.delete(episodeFetchRetryState)
    .where(eq(episodeFetchRetryState.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(episodeFetchRetryState)
    .where(eq(episodeFetchRetryState.animeId, EXTRA_ANIME_ID))
    .run();
  db.delete(manualMatchState)
    .where(eq(manualMatchState.source, SOURCE))
    .run();
  db.delete(manualMatchState)
    .where(eq(manualMatchState.animeId, ANIME_ID))
    .run();
  db.delete(manualMatchState)
    .where(eq(manualMatchState.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(manualMatchState)
    .where(eq(manualMatchState.animeId, EXTRA_ANIME_ID))
    .run();
  db.delete(episodes)
    .where(eq(episodes.sourceName, SOURCE))
    .run();
  db.delete(episodes)
    .where(eq(episodes.animeId, ANIME_ID))
    .run();
  db.delete(episodes)
    .where(eq(episodes.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(episodes)
    .where(eq(episodes.animeId, EXTRA_ANIME_ID))
    .run();
  db.delete(cstationCatalog)
    .where(eq(cstationCatalog.source, SOURCE))
    .run();
  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, "ffzy"), eq(cstationCatalog.id, RANGE_SOURCE_AID)))
    .run();
  db.delete(anime).where(eq(anime.id, ANIME_ID)).run();
  db.delete(anime).where(eq(anime.id, RANGE_ANIME_ID)).run();
  db.delete(anime).where(eq(anime.id, EXTRA_ANIME_ID)).run();
  db.delete(animeOther).where(eq(animeOther.id, ANIME_ID)).run();
  db.delete(animeOther).where(eq(animeOther.id, RANGE_ANIME_ID)).run();
  db.delete(animeOther).where(eq(animeOther.id, EXTRA_ANIME_ID)).run();
}

function seedAnime() {
  db.insert(anime)
    .values({
      id: ANIME_ID,
      name: "テスト番組",
      nameCn: "测试番剧",
      aliases: JSON.stringify(["Manual Review Test"]),
      airDate: "2026-04-01",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();
}

function seedCatalog() {
  db.insert(cstationCatalog)
    .values({
      source: SOURCE,
      id: SOURCE_AID,
      name: "测试番剧",
      subname: "Manual Review Test",
      year: "2026",
    })
    .run();
}

function seedRangeAnime() {
  db.insert(anime)
    .values({
      id: RANGE_ANIME_ID,
      name: "ONE PIECE エルバフ編",
      nameCn: "航海王 埃鲁巴夫篇",
      aliases: JSON.stringify(["ONE PIECE Elbaf"]),
      airDate: "2026-04-05",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();
}

test.beforeEach(() => {
  cleanup();
  seedAnime();
  seedCatalog();
});

test.afterEach(() => {
  cleanup();
});

test("analyzeUnmappedMappings exports unmapped rows from retry state", () => {
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: SOURCE, retryCount: 5, retryAt: null, updatedAt: "2026-05-30 00:00:00" })
    .run();

  const result = analyzeUnmappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.unmatched_reason, "max_retries");
  assert.equal(row.decision, "");
  assert.equal(row.source_aid, "");
  assert.equal("suggestion_1_source_aid" in row, false);
});

test("analyzeUnmappedMappings exports normalized subjects without legacy anime rows", () => {
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, name_cn, air_date, created_at, updated_at)
    VALUES (${EXTRA_ANIME_ID}, 'Normalized Raw', '标准化番剧', '2026-04-03', datetime('now'), datetime('now'))
    ON CONFLICT(bangumi_id) DO UPDATE SET
      name = excluded.name,
      name_cn = excluded.name_cn,
      air_date = excluded.air_date,
      updated_at = excluded.updated_at;
    INSERT INTO subject_aliases (bangumi_id, alias)
    VALUES (${EXTRA_ANIME_ID}, 'Normalized Alias')
    ON CONFLICT(bangumi_id, alias) DO NOTHING;
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
    VALUES (${EXTRA_ANIME_ID}, '${SOURCE}', 'mapping', 5, null, datetime('now'))
    ON CONFLICT(bangumi_id, source, kind) DO UPDATE SET
      retry_count = excluded.retry_count,
      retry_at = excluded.retry_at,
      updated_at = excluded.updated_at;
  `);

  const result = analyzeUnmappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === EXTRA_ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.bg_title, "标准化番剧");
  assert.equal(row.unmatched_reason, "max_retries");
  assert.equal(row.air_date, "2026-04-03");
  assert.deepEqual(JSON.parse(row.bg_aliases), ["标准化番剧", "Normalized Raw", "Normalized Alias"]);
});

test("prewarmAnime maps requested local IDs and refreshes episodes immediately", async () => {
  let metadataCalls = 0;
  let refreshCalls = 0;

  const result = await prewarmAnime({
    ids: [ANIME_ID],
    sourceKeys: [SOURCE],
  }, {
    enrichSubject: async (id) => {
      metadataCalls++;
      return db.select().from(anime).where(eq(anime.id, id)).get();
    },
    refreshEpisodes: async (id, { source }) => {
      refreshCalls++;
      return { animeId: id, source, refreshed: true, cstationId: SOURCE_AID, epCount: 1 };
    },
  });

  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();
  const normalizedMapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);

  assert.equal(result.requested, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.refreshed, 1);
  assert.equal(result.errors, 0);
  assert.equal(metadataCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(mapping.cstationId, SOURCE_AID);
  assert.equal(normalizedMapping.source_aid, SOURCE_AID);
  assert.equal(result.items[0].sources[0].mapping, "matched");
  assert.equal(result.items[0].sources[0].episodes, "refreshed");
});

test("prewarmAnime mappedOnly skips unmapped sources without creating retry state", async () => {
  let refreshCalls = 0;

  const result = await prewarmAnime({
    ids: [ANIME_ID],
    sourceKeys: [SOURCE],
    mappedOnly: true,
  }, {
    enrichSubject: async (id) => db.select().from(anime).where(eq(anime.id, id)).get(),
    refreshEpisodes: async () => {
      refreshCalls++;
      return { refreshed: true };
    },
  });

  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();
  const retry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, ANIME_ID), eq(matchRetryState.source, SOURCE)))
    .get();

  assert.equal(result.requested, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.matched, 0);
  assert.equal(result.refreshed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(refreshCalls, 0);
  assert.equal(mapping, undefined);
  assert.equal(retry, undefined);
  assert.equal(result.items[0].sources[0].mapping, "skipped");
  assert.equal(result.items[0].sources[0].reason, "not-mapped");
});

test("prewarmAnime continues with cached local metadata when subject detail is missing", async () => {
  const result = await prewarmAnime({
    ids: [ANIME_ID],
    sourceKeys: [SOURCE],
    refreshEpisodes: false,
  }, {
    enrichSubject: async () => null,
  });

  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();

  assert.equal(result.processed, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.items[0].metadata, "cached");
  assert.equal(mapping.cstationId, SOURCE_AID);
});

test("prewarmAnime query upserts search results before matching", async () => {
  cleanup();
  seedCatalog();
  let searchCalls = 0;

  const result = await prewarmAnime({
    query: "测试番剧",
    sourceKeys: [SOURCE],
    refreshEpisodes: false,
  }, {
    searchSubjects: async (keyword) => {
      searchCalls++;
      assert.equal(keyword, "测试番剧");
      return {
        data: [{
          id: ANIME_ID,
          type: 2,
          name: "テスト番組",
          name_cn: "测试番剧",
          platform: "TV",
          date: "2026-04-01",
        }],
      };
    },
    enrichSubject: async (id) => db.select().from(anime).where(eq(anime.id, id)).get(),
  });

  const animeRow = db.select().from(anime).where(eq(anime.id, ANIME_ID)).get();
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();

  assert.equal(searchCalls, 1);
  assert.equal(result.requested, 1);
  assert.equal(result.upserted, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.refreshed, 0);
  assert.equal(animeRow.nameCn, "测试番剧");
  assert.equal(mapping.cstationId, SOURCE_AID);
});

test("analyzeUnmappedMappings does not export rows that already have a mapping", () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = analyzeUnmappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.equal(row, undefined);
});

test("analyzeUnmappedMappings skips normalized mappings without legacy mappings", () => {
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, name_cn, created_at, updated_at)
    VALUES (${ANIME_ID}, 'テスト番組', '测试番剧', datetime('now'), datetime('now'))
    ON CONFLICT(bangumi_id) DO UPDATE SET
      name = excluded.name,
      name_cn = excluded.name_cn,
      updated_at = excluded.updated_at;
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('${SOURCE}', '测试资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_items (source, source_aid, title, updated_at)
    VALUES ('${SOURCE}', ${SOURCE_AID}, '测试番剧', datetime('now'))
    ON CONFLICT(source, source_aid) DO UPDATE SET
      title = excluded.title,
      updated_at = excluded.updated_at;
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, score, matched_bg_name, matched_resource_name, matched_at
    )
    VALUES (
      ${ANIME_ID}, '${SOURCE}', ${SOURCE_AID}, 0.91, '测试番剧', '测试番剧', '2026-05-30 00:00:00'
    )
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      source_aid = excluded.source_aid,
      score = excluded.score,
      matched_bg_name = excluded.matched_bg_name,
      matched_resource_name = excluded.matched_resource_name,
      matched_at = excluded.matched_at;
  `);

  const result = analyzeUnmappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.equal(row, undefined);
});

test("exportManualReview puts human decision columns first", async () => {
  await withTempPath(async (filePath) => {
    await exportManualReview(filePath, { source: SOURCE });
    const header = (await readFile(filePath, "utf8")).split("\n")[0].split(",");

    assert.deepEqual(header.slice(0, 6), [
      "anime_id",
      "bg_title",
      "source",
      "unmatched_reason",
      "decision",
      "source_aid",
    ]);
    assert.equal(header.includes("current_decision"), false);
    assert.equal(header.includes("match_score"), false);
    assert.equal(header.some((column) => column.startsWith("suggestion_")), false);
  });
});

test("analyzeMappedMappings exports existing mappings for review", () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      sourceEpStart: 1156,
      sourceEpEnd: null,
      displayEpOffset: 1155,
      score: 0.91,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: SOURCE,
      sourceAid: SOURCE_AID,
      epIndex: 1,
      sourceEpIndex: 1156,
      epName: "第1156集",
      videoUrl: "https://example.invalid/1156.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = analyzeMappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.decision, "");
  assert.equal(row.source_aid, SOURCE_AID);
  assert.equal(row.source_title, "测试番剧");
  assert.equal(row.source_ep_start, 1156);
  assert.equal(row.source_ep_end, "");
  assert.equal(row.display_ep_offset, 1155);
  assert.equal(row.episode_count, 1);
  assert.equal(row.source_ep_min, 1156);
  assert.equal(row.source_ep_max, 1156);
});

test("analyzeMappedMappings exports normalized mappings without legacy mappings", () => {
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, name_cn, air_date, created_at, updated_at)
    VALUES (${ANIME_ID}, 'テスト番組', '测试番剧', '2026-04-01', datetime('now'), datetime('now'))
    ON CONFLICT(bangumi_id) DO UPDATE SET
      name = excluded.name,
      name_cn = excluded.name_cn,
      air_date = excluded.air_date,
      updated_at = excluded.updated_at;
    INSERT INTO subject_aliases (bangumi_id, alias)
    VALUES (${ANIME_ID}, 'Manual Review Test')
    ON CONFLICT(bangumi_id, alias) DO NOTHING;
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('${SOURCE}', '测试资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_items (source, source_aid, title, subtitle, year, updated_at)
    VALUES ('${SOURCE}', ${SOURCE_AID}, 'Normalized Source Title', 'normalized alias', '2026', datetime('now'))
    ON CONFLICT(source, source_aid) DO UPDATE SET
      title = excluded.title,
      subtitle = excluded.subtitle,
      year = excluded.year,
      updated_at = excluded.updated_at;
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_bg_name, matched_resource_name, matched_at
    )
    VALUES (
      ${ANIME_ID}, '${SOURCE}', ${SOURCE_AID}, 1156, null,
      1155, 0.91, '测试番剧', 'Normalized Source Title', '2026-05-30 00:00:00'
    )
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      source_aid = excluded.source_aid,
      source_ep_start = excluded.source_ep_start,
      source_ep_end = excluded.source_ep_end,
      display_ep_offset = excluded.display_ep_offset,
      score = excluded.score,
      matched_bg_name = excluded.matched_bg_name,
      matched_resource_name = excluded.matched_resource_name,
      matched_at = excluded.matched_at;
    INSERT INTO episodes (
      bangumi_id, source, source_aid, ep_index, source_ep_index, ep_name, video_url, updated_at
    )
    VALUES (
      ${ANIME_ID}, '${SOURCE}', ${SOURCE_AID}, 1, 1156, '第1156集',
      'https://example.invalid/1156.m3u8', datetime('now')
    )
    ON CONFLICT(bangumi_id, source, source_aid, ep_index) DO UPDATE SET
      source_ep_index = excluded.source_ep_index,
      ep_name = excluded.ep_name,
      video_url = excluded.video_url,
      updated_at = excluded.updated_at;
  `);

  const result = analyzeMappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.source_aid, SOURCE_AID);
  assert.equal(row.source_title, "Normalized Source Title");
  assert.equal(row.source_ep_start, 1156);
  assert.equal(row.source_ep_end, "");
  assert.equal(row.display_ep_offset, 1155);
  assert.equal(row.match_score, "0.9100");
  assert.equal(row.matched_source_name, "Normalized Source Title");
  assert.equal(row.episode_count, 1);
  assert.equal(row.source_ep_min, 1156);
  assert.equal(row.source_ep_max, 1156);
  assert.equal(row.source_subname, "normalized alias");
  assert.equal(row.source_year, "2026");
});

test("exportMappedReview puts editable mapping columns first", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  await withTempPath(async (filePath) => {
    await exportMappedReview(filePath, { source: SOURCE });
    const header = (await readFile(filePath, "utf8")).split("\n")[0].split(",");

    assert.deepEqual(header.slice(0, 9), [
      "anime_id",
      "bg_title",
      "source",
      "decision",
      "source_aid",
      "source_title",
      "source_ep_start",
      "source_ep_end",
      "display_ep_offset",
    ]);
  });
});

test("importManualReview leaves blank decisions unchanged", async () => {
  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},,${SOURCE_AID},`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  assert.equal(stats.updated, 0);
  assert.equal(db.select().from(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, ANIME_ID)).get(), undefined);
});

test("importManualReview records no_resource and blocks retry", async () => {
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: SOURCE, retryCount: 1, retryAt: "2026-05-30 00:00:00", updatedAt: "2026-05-30 00:00:00" })
    .run();

  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},no_match,,no resource on source`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));
  const manual = db.select().from(manualMatchState)
    .where(and(eq(manualMatchState.animeId, ANIME_ID), eq(manualMatchState.source, SOURCE)))
    .get();
  const retry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, ANIME_ID), eq(matchRetryState.source, SOURCE)))
    .get();
  const normalizedManual = sqlite.prepare(`
    SELECT * FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);
  const normalizedRetry = sqlite.prepare(`
    SELECT * FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(ANIME_ID, SOURCE);

  assert.equal(stats.updated, 1);
  assert.equal(stats.noResource, 1);
  assert.equal(manual.status, "no_resource");
  assert.equal(manual.note, "no resource on source");
  assert.equal(retry.retryCount, 5);
  assert.equal(retry.retryAt, null);
  assert.equal(normalizedManual.status, "no_resource");
  assert.equal(normalizedManual.note, "no resource on source");
  assert.equal(normalizedRetry.retry_count, 5);
  assert.equal(normalizedRetry.retry_at, null);
  assert.equal(db.select().from(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, ANIME_ID)).get(), undefined);
});

test("importManualReview applies match decisions directly and clears retry state", async () => {
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: SOURCE, retryCount: 5, retryAt: null, updatedAt: "2026-05-30 00:00:00" })
    .run();

  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},match,${SOURCE_AID},confirmed`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();

  assert.equal(stats.updated, 1);
  assert.equal(stats.matched, 1);
  assert.equal(mapping.cstationId, SOURCE_AID);
  assert.equal(mapping.score, null);
  assert.equal(mapping.matchedBgName, "测试番剧");
  assert.equal(mapping.matchedCsName, "测试番剧");
  const retry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, ANIME_ID), eq(matchRetryState.source, SOURCE)))
    .get();
  assert.equal(retry.retryCount, 0);
  assert.equal(retry.retryAt, null);
});

test("importManualReview rejects match decisions without a source_aid", async () => {
  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},match,,missing id`,
  ].join("\n");

  await assert.rejects(
    () => withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false })),
    /source_aid/
  );
});

test("importManualReview validates all rows before applying any decision", async () => {
  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},match,${SOURCE_AID},valid row`,
    `${SOURCE},${ANIME_ID},match,,invalid row`,
  ].join("\n");

  await assert.rejects(
    () => withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false })),
    /source_aid/
  );

  assert.equal(db.select().from(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, ANIME_ID)).get(), undefined);
});

test("importManualReview records wait_airing and clears retry state", async () => {
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: SOURCE, retryCount: 5, retryAt: null, updatedAt: "2026-05-30 00:00:00" })
    .run();

  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},wait_airing,,future broadcast`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));
  const manual = db.select().from(manualMatchState)
    .where(and(eq(manualMatchState.animeId, ANIME_ID), eq(manualMatchState.source, SOURCE)))
    .get();
  const retry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, ANIME_ID), eq(matchRetryState.source, SOURCE)))
    .get();
  const normalizedManual = sqlite.prepare(`
    SELECT * FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);
  const normalizedRetry = sqlite.prepare(`
    SELECT * FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(ANIME_ID, SOURCE);

  assert.equal(stats.updated, 1);
  assert.equal(stats.waitAiring, 1);
  assert.equal(manual.status, "wait_airing");
  assert.equal(manual.note, "future broadcast");
  assert.equal(retry.retryCount, 0);
  assert.equal(retry.retryAt, null);
  assert.equal(normalizedManual.status, "wait_airing");
  assert.equal(normalizedManual.note, "future broadcast");
  assert.equal(normalizedRetry.retry_count, 0);
  assert.equal(normalizedRetry.retry_at, null);
});

test("analyzeUnmappedMappings keeps wait_airing rows exported", async () => {
  await withCsv([
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},wait_airing,,future broadcast`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  const result = analyzeUnmappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.unmatched_reason, "wait_airing");
  assert.equal(row.decision, "");
  assert.equal(row.reviewer_note, "future broadcast");
});

test("analyzeUnmappedMappings keeps wait_airing reason without scoring", async () => {
  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .run();

  await withCsv([
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},wait_airing,,future broadcast`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  const result = analyzeUnmappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.unmatched_reason, "wait_airing");
  assert.equal("suggestion_count" in row, false);
});

test("analyzeUnmappedMappings skips no_resource rows by default", async () => {
  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .run();

  await withCsv([
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},no_resource,,confirmed unavailable`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  const result = analyzeUnmappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.equal(row, undefined);
});

test("analyzeUnmappedMappings can include no_resource rows without scoring", async () => {
  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .run();

  await withCsv([
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},no_resource,,confirmed unavailable`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  const result = analyzeUnmappedMappings({ source: SOURCE, includeNoResource: true });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.unmatched_reason, "no_resource");
  assert.equal("suggestion_count" in row, false);
  assert.equal(row.decision, "");
  assert.equal(row.reviewer_note, "confirmed unavailable");
});

test("analyzeUnmappedMappings keeps source_already_mapped reason without suggestions", () => {
  db.insert(anime)
    .values({
      id: EXTRA_ANIME_ID,
      name: "完全不同番剧",
      nameCn: "完全不同番剧",
      aliases: JSON.stringify([]),
      airDate: "2026-04-01",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(manualMatchState)
    .values({
      animeId: EXTRA_ANIME_ID,
      source: SOURCE,
      status: "source_already_mapped",
      note: "source_aid 1 is already mapped",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = analyzeUnmappedMappings({ source: SOURCE });
  const row = result.rows.find((item) => item.anime_id === EXTRA_ANIME_ID);

  assert.ok(row);
  assert.equal(row.unmatched_reason, "source_already_mapped");
  assert.equal(row.reviewer_note, "source_aid 1 is already mapped");
});

test("match decisions clear previous wait_airing state", async () => {
  await withCsv([
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},wait_airing,,future broadcast`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  await withCsv([
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},match,${SOURCE_AID},now available`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  assert.equal(db.select().from(manualMatchState).where(eq(manualMatchState.animeId, ANIME_ID)).get(), undefined);
  assert.equal(db.select().from(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, ANIME_ID)).get().cstationId, SOURCE_AID);
});

test("importManualReview validates wait_airing anime ids before applying any decision", async () => {
  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},match,${SOURCE_AID},valid row`,
    `${SOURCE},999999999,wait_airing,,invalid row`,
  ].join("\n");

  await assert.rejects(
    () => withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false })),
    /anime_id 999999999 does not exist/
  );

  assert.equal(db.select().from(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, ANIME_ID)).get(), undefined);
  assert.equal(db.select().from(manualMatchState).where(eq(manualMatchState.animeId, 999999999)).get(), undefined);
});

test("importManualReview stores episode range mapping fields", async () => {
  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${ANIME_ID},match,${SOURCE_AID},1156,,1155,split sequel`,
  ].join("\n");

  await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();

  assert.equal(mapping.sourceEpStart, 1156);
  assert.equal(mapping.sourceEpEnd, null);
  assert.equal(mapping.displayEpOffset, 1155);
});

test("ensureMappingForAnime skips source ids already occupied by another mapping", async () => {
  seedRangeAnime();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "航海王 埃鲁巴夫篇",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = await ensureMappingForAnime(ANIME_ID, { source: SOURCE });
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();
  const retry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, ANIME_ID), eq(matchRetryState.source, SOURCE)))
    .get();

  assert.equal(result.matched, false);
  assert.equal(result.reason, "source-already-mapped");
  assert.equal(mapping, undefined);
  assert.equal(retry.retryCount, 5);
  assert.equal(retry.retryAt, null);
});

test("ensureMappingForAnime skips source ids occupied by normalized mappings", async () => {
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, name_cn, created_at, updated_at)
    VALUES (${EXTRA_ANIME_ID}, 'Other Raw', '其他番剧', datetime('now'), datetime('now'))
    ON CONFLICT(bangumi_id) DO UPDATE SET
      name = excluded.name,
      name_cn = excluded.name_cn,
      updated_at = excluded.updated_at;
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('${SOURCE}', '测试资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, score, matched_bg_name, matched_resource_name, matched_at
    )
    VALUES (
      ${EXTRA_ANIME_ID}, '${SOURCE}', ${SOURCE_AID}, 0.95, '其他番剧', '测试番剧', '2026-05-30 00:00:00'
    )
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      source_aid = excluded.source_aid,
      score = excluded.score,
      matched_bg_name = excluded.matched_bg_name,
      matched_resource_name = excluded.matched_resource_name,
      matched_at = excluded.matched_at;
  `);

  const result = await ensureMappingForAnime(ANIME_ID, { source: SOURCE });
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();
  const retry = sqlite.prepare(`
    SELECT * FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(ANIME_ID, SOURCE);

  assert.equal(result.matched, false);
  assert.equal(result.reason, "source-already-mapped");
  assert.equal(mapping, undefined);
  assert.equal(retry.retry_count, 5);
  assert.equal(retry.retry_at, null);
});

test("ensureMappingForAnime reads candidates from normalized resource items", async () => {
  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .run();
  sqlite.exec(`
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('${SOURCE}', '测试资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_items (source, source_aid, title, subtitle, year, detail_fetched_at, updated_at)
    VALUES ('${SOURCE}', ${SOURCE_AID}, '测试番剧', 'Manual Review Test', '2026', '2026-05-30 00:00:00', datetime('now'))
    ON CONFLICT(source, source_aid) DO UPDATE SET
      title = excluded.title,
      subtitle = excluded.subtitle,
      year = excluded.year,
      detail_fetched_at = excluded.detail_fetched_at,
      updated_at = excluded.updated_at;
  `);

  const result = await ensureMappingForAnime(ANIME_ID, { source: SOURCE });
  const normalizedMapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);

  assert.equal(result.matched, true);
  assert.equal(result.cstationId, SOURCE_AID);
  assert.equal(normalizedMapping.source_aid, SOURCE_AID);
  assert.equal(normalizedMapping.matched_resource_name, "测试番剧");
});

test("ensureMappingForAnime honors normalized manual no_resource state", async () => {
  sqlite.exec(`
    INSERT INTO manual_resource_state (bangumi_id, source, status, note, updated_at)
    VALUES (${ANIME_ID}, '${SOURCE}', 'no_resource', 'normalized block', datetime('now'))
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_at = excluded.updated_at;
  `);

  const result = await ensureMappingForAnime(ANIME_ID, { source: SOURCE });
  const mapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);

  assert.equal(result.matched, false);
  assert.equal(result.reason, "no-resource");
  assert.equal(mapping, undefined);
});

test("ensureMappingForAnime honors normalized max mapping retry state", async () => {
  sqlite.exec(`
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
    VALUES (${ANIME_ID}, '${SOURCE}', 'mapping', 5, null, datetime('now'))
    ON CONFLICT(bangumi_id, source, kind) DO UPDATE SET
      retry_count = excluded.retry_count,
      retry_at = excluded.retry_at,
      updated_at = excluded.updated_at;
  `);

  const result = await ensureMappingForAnime(ANIME_ID, { source: SOURCE });
  const mapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);

  assert.equal(result.matched, false);
  assert.equal(result.reason, "max-retries");
  assert.equal(mapping, undefined);
});

test("ensureMappingForAnime skips source ids occupied by ranged manual mappings", async () => {
  seedRangeAnime();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      sourceEpStart: 801,
      sourceEpEnd: 1200,
      displayEpOffset: 800,
      matchedBgName: "航海王 埃鲁巴夫篇",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = await ensureMappingForAnime(ANIME_ID, { source: SOURCE });
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();

  assert.equal(result.matched, false);
  assert.equal(result.reason, "source-already-mapped");
  assert.equal(mapping, undefined);
});

test("ensureMappingForAnime terminally blocks retry when best source id is occupied", async () => {
  seedRangeAnime();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "航海王 埃鲁巴夫篇",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = await ensureMappingForAnime(ANIME_ID, { source: SOURCE });
  const retry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, ANIME_ID), eq(matchRetryState.source, SOURCE)))
    .get();

  assert.equal(result.matched, false);
  assert.equal(result.reason, "source-already-mapped");
  assert.equal(retry.retryCount, 5);
  assert.equal(retry.retryAt, null);
  const manual = db.select().from(manualMatchState)
    .where(and(eq(manualMatchState.animeId, ANIME_ID), eq(manualMatchState.source, SOURCE)))
    .get();
  assert.equal(manual.status, "source_already_mapped");
});

test("retryPending skips source ids blocked for manual review", async () => {
  seedRangeAnime();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "航海王 埃鲁巴夫篇",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  await ensureMappingForAnime(ANIME_ID, { source: SOURCE });

  const stats = await retryPending({ mappingLimit: 10, episodeFetchLimit: 0, refreshEpisodes: false, sourceKeys: [SOURCE] });

  assert.equal(stats.pending.mapping, 0);
  assert.equal(stats.retried, 0);
});

test("retryPending skips manually confirmed no_resource rows", async () => {
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: SOURCE, retryCount: 1, retryAt: "2000-01-01 00:00:00", updatedAt: "2026-05-30 00:00:00" })
    .run();
  db.insert(manualMatchState)
    .values({ animeId: ANIME_ID, source: SOURCE, status: "no_resource", note: "confirmed unavailable", updatedAt: "2026-05-30 00:00:00" })
    .run();

  const stats = await retryPending({ mappingLimit: 10, episodeFetchLimit: 0, refreshEpisodes: false, sourceKeys: [SOURCE] });

  assert.equal(stats.pending.mapping, 0);
  assert.equal(stats.retried, 0);
});

test("batchMatch skips source ids blocked by a previous occupied mapping", async () => {
  seedRangeAnime();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "航海王 埃鲁巴夫篇",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  await ensureMappingForAnime(ANIME_ID, { source: SOURCE });
  db.delete(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, RANGE_ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .run();

  const stats = await batchMatch({ refreshEpisodes: false, sourceKeys: [SOURCE], animeIds: [ANIME_ID] });
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();
  const manual = db.select().from(manualMatchState)
    .where(and(eq(manualMatchState.animeId, ANIME_ID), eq(manualMatchState.source, SOURCE)))
    .get();

  assert.equal(stats.matched, 0);
  assert.equal(mapping, undefined);
  assert.equal(manual.status, "source_already_mapped");
});

test("batchMatch skips manually confirmed no_resource rows", async () => {
  db.insert(manualMatchState)
    .values({ animeId: ANIME_ID, source: SOURCE, status: "no_resource", note: "confirmed unavailable", updatedAt: "2026-05-30 00:00:00" })
    .run();

  const stats = await batchMatch({ refreshEpisodes: false, sourceKeys: [SOURCE], animeIds: [ANIME_ID] });
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();

  assert.equal(stats.matched, 0);
  assert.equal(mapping, undefined);
});

test("ensureMappingForAnime does not bypass no_resource with refresh", async () => {
  db.insert(manualMatchState)
    .values({ animeId: ANIME_ID, source: SOURCE, status: "no_resource", note: "confirmed unavailable", updatedAt: "2026-05-30 00:00:00" })
    .run();

  const result = await ensureMappingForAnime(ANIME_ID, { source: SOURCE, refresh: true });
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();

  assert.equal(result.matched, false);
  assert.equal(result.reason, "no-resource");
  assert.equal(mapping, undefined);
});

test("retryPending limits mapping retries per run", async () => {
  db.insert(anime)
    .values({
      id: EXTRA_ANIME_ID,
      name: "追加テスト番組",
      nameCn: "追加测试番剧",
      aliases: JSON.stringify([]),
      airDate: "2026-04-01",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(cstationCatalog)
    .values({
      source: SOURCE,
      id: EXTRA_SOURCE_AID,
      name: "追加测试番剧",
      year: "2026",
    })
    .run();
  db.insert(matchRetryState)
    .values([
      { animeId: ANIME_ID, source: SOURCE, retryCount: 1, retryAt: "2000-01-01 00:00:00", updatedAt: "2000-01-01 00:00:00" },
      { animeId: EXTRA_ANIME_ID, source: SOURCE, retryCount: 1, retryAt: "2000-01-01 00:00:00", updatedAt: "2000-01-01 00:00:00" },
    ])
    .run();

  try {
    const stats = await retryPending({ mappingLimit: 1, episodeFetchLimit: 0, refreshEpisodes: false, sourceKeys: [SOURCE] });
    const mappedRows = db.select().from(bangumiCstationMap).where(eq(bangumiCstationMap.source, SOURCE)).all();

    assert.equal(stats.retried, 1);
    assert.equal(stats.errors, 0);
    assert.equal(stats.limited.mapping, true);
    assert.equal(mappedRows.length, 1);
  } finally {
    db.delete(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, EXTRA_ANIME_ID)).run();
    db.delete(matchRetryState).where(eq(matchRetryState.animeId, EXTRA_ANIME_ID)).run();
    db.delete(cstationCatalog)
      .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, EXTRA_SOURCE_AID)))
      .run();
    db.delete(anime).where(eq(anime.id, EXTRA_ANIME_ID)).run();
  }
});

test("retryPending reads normalized mapping retry rows", async () => {
  sqlite.exec(`
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
    VALUES (${ANIME_ID}, '${SOURCE}', 'mapping', 1, '2000-01-01 00:00:00', datetime('now'))
    ON CONFLICT(bangumi_id, source, kind) DO UPDATE SET
      retry_count = excluded.retry_count,
      retry_at = excluded.retry_at,
      updated_at = excluded.updated_at;
  `);

  const stats = await retryPending({ mappingLimit: 10, episodeFetchLimit: 0, refreshEpisodes: false, sourceKeys: [SOURCE] });
  const mapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);

  assert.equal(stats.retried, 1);
  assert.equal(stats.matched, 1);
  assert.equal(stats.errors, 0);
  assert.equal(mapping.source_aid, SOURCE_AID);
});

test("retryPending lets normalized manual state override stale legacy blocks", async () => {
  db.insert(manualMatchState)
    .values({ animeId: ANIME_ID, source: SOURCE, status: "no_resource", note: "legacy stale", updatedAt: "2026-05-30 00:00:00" })
    .run();
  sqlite.exec(`
    INSERT INTO manual_resource_state (bangumi_id, source, status, note, updated_at)
    VALUES (${ANIME_ID}, '${SOURCE}', 'ready', 'normalized current', datetime('now'))
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_at = excluded.updated_at;
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
    VALUES (${ANIME_ID}, '${SOURCE}', 'mapping', 1, '2000-01-01 00:00:00', datetime('now'))
    ON CONFLICT(bangumi_id, source, kind) DO UPDATE SET
      retry_count = excluded.retry_count,
      retry_at = excluded.retry_at,
      updated_at = excluded.updated_at;
  `);

  const stats = await retryPending({ mappingLimit: 10, episodeFetchLimit: 0, refreshEpisodes: false, sourceKeys: [SOURCE] });
  const mapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);

  assert.equal(stats.retried, 1);
  assert.equal(stats.matched, 1);
  assert.equal(mapping.source_aid, SOURCE_AID);
});

test("ensureMappingForAnime checks occupied source id before hydrating candidate details", async () => {
  seedRangeAnime();
  db.update(cstationCatalog)
    .set({ subname: null, detailFetchedAt: null })
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "航海王 埃鲁巴夫篇",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected network request");
  };
  try {
    const result = await ensureMappingForAnime(ANIME_ID, { source: SOURCE });

    assert.equal(result.matched, false);
    assert.equal(result.reason, "source-already-mapped");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ensureMappingForAnime does not terminally block retry for weak occupied candidates", async () => {
  const weakAnimeId = EXTRA_ANIME_ID;
  const weakSourceAid = EXTRA_SOURCE_AID;
  db.insert(anime)
    .values({
      id: weakAnimeId,
      name: "弱匹配番剧",
      nameCn: "弱匹配番剧",
      aliases: JSON.stringify([]),
      airDate: "2026-04-01",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(cstationCatalog)
    .values({
      source: SOURCE,
      id: weakSourceAid,
      name: "弱匹配动画",
      subname: "弱匹配动画",
      year: "2026",
      detailFetchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: SOURCE,
      cstationId: weakSourceAid,
      matchedBgName: "航海王 埃鲁巴夫篇",
      matchedCsName: "弱匹配动画",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = await ensureMappingForAnime(weakAnimeId, { source: SOURCE });
  const retry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, weakAnimeId), eq(matchRetryState.source, SOURCE)))
    .get();
  const normalizedRetry = sqlite.prepare(`
    SELECT * FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(weakAnimeId, SOURCE);
  const manual = db.select().from(manualMatchState)
    .where(and(eq(manualMatchState.animeId, weakAnimeId), eq(manualMatchState.source, SOURCE)))
    .get();

  assert.equal(result.matched, false);
  assert.equal(result.reason, "no-catalog-match");
  assert.equal(retry.retryCount, 1);
  assert.ok(retry.retryAt);
  assert.equal(normalizedRetry.retry_count, 1);
  assert.ok(normalizedRetry.retry_at);
  assert.equal(manual, undefined);
});

test("retryPending honors refreshEpisodes=false for already mapped retry rows", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: SOURCE, retryCount: 1, retryAt: "2000-01-01 00:00:00", updatedAt: "2000-01-01 00:00:00" })
    .run();

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected episode refresh");
  };
  try {
    const stats = await retryPending({ mappingLimit: 10, episodeFetchLimit: 0, refreshEpisodes: false, sourceKeys: [SOURCE] });

    assert.equal(stats.retried, 1);
    assert.equal(stats.refreshed, 0);
    assert.equal(stats.errors, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("importMappedReview updates source id and episode range", async () => {
  db.insert(cstationCatalog)
    .values({
      source: SOURCE,
      id: NEW_SOURCE_AID,
      name: "测试番剧 新来源",
      subname: "updated",
      year: "2026",
    })
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      sourceEpStart: null,
      sourceEpEnd: null,
      displayEpOffset: 0,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: SOURCE,
      sourceAid: SOURCE_AID,
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "旧第1集",
      videoUrl: "https://example.invalid/old.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${ANIME_ID},update,${NEW_SOURCE_AID},12,24,11,range update`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importMappedReview(filePath, { refreshEpisodes: false }));
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();
  const staleEpisodes = db.select().from(episodes)
    .where(and(eq(episodes.animeId, ANIME_ID), eq(episodes.sourceName, SOURCE)))
    .all();

  assert.equal(stats.updated, 1);
  assert.equal(stats.matched, 1);
  assert.equal(mapping.cstationId, NEW_SOURCE_AID);
  assert.equal(mapping.sourceEpStart, 12);
  assert.equal(mapping.sourceEpEnd, 24);
  assert.equal(mapping.displayEpOffset, 11);
  assert.equal(mapping.score, null);
  assert.equal(mapping.matchedCsName, "测试番剧 新来源");
  assert.equal(staleEpisodes.length, 0);

  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, NEW_SOURCE_AID)))
    .run();
});

test("importMappedReview updates normalized-only mapping and source item", async () => {
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, name_cn, created_at, updated_at)
    VALUES (${ANIME_ID}, 'テスト番組', '测试番剧', datetime('now'), datetime('now'))
    ON CONFLICT(bangumi_id) DO UPDATE SET
      name = excluded.name,
      name_cn = excluded.name_cn,
      updated_at = excluded.updated_at;
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('${SOURCE}', '测试资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_items (source, source_aid, title, updated_at)
    VALUES ('${SOURCE}', ${NEW_SOURCE_AID}, '测试番剧 新来源', datetime('now'))
    ON CONFLICT(source, source_aid) DO UPDATE SET
      title = excluded.title,
      updated_at = excluded.updated_at;
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, matched_bg_name, matched_resource_name, matched_at
    )
    VALUES (
      ${ANIME_ID}, '${SOURCE}', ${SOURCE_AID}, null, null,
      0, '测试番剧', '测试番剧', '2026-05-30 00:00:00'
    )
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      source_aid = excluded.source_aid,
      source_ep_start = excluded.source_ep_start,
      source_ep_end = excluded.source_ep_end,
      display_ep_offset = excluded.display_ep_offset,
      matched_bg_name = excluded.matched_bg_name,
      matched_resource_name = excluded.matched_resource_name,
      matched_at = excluded.matched_at;
  `);

  const csv = [
    "source,anime_id,decision,source_aid,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${ANIME_ID},update,${NEW_SOURCE_AID},12,24,11,range update`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importMappedReview(filePath, { refreshEpisodes: false }));
  const normalizedMapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);

  assert.equal(stats.updated, 1);
  assert.equal(stats.matched, 1);
  assert.equal(normalizedMapping.source_aid, NEW_SOURCE_AID);
  assert.equal(normalizedMapping.source_ep_start, 12);
  assert.equal(normalizedMapping.source_ep_end, 24);
  assert.equal(normalizedMapping.display_ep_offset, 11);
  assert.equal(normalizedMapping.matched_resource_name, "测试番剧 新来源");
});

test("importMappedReview deletes mappings and marks them as manual unmapped", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: SOURCE,
      sourceAid: SOURCE_AID,
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "第1集",
      videoUrl: "https://example.invalid/1.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},delete,${SOURCE_AID},wrong mapping`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importMappedReview(filePath, { refreshEpisodes: false }));
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();
  const staleEpisodes = db.select().from(episodes)
    .where(and(eq(episodes.animeId, ANIME_ID), eq(episodes.sourceName, SOURCE)))
    .all();
  const retry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, ANIME_ID), eq(matchRetryState.source, SOURCE)))
    .get();
  const normalizedMapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);
  const normalizedEpisodes = sqlite.prepare(`
    SELECT * FROM episodes
    WHERE bangumi_id = ? AND source = ?
  `).all(ANIME_ID, SOURCE);

  assert.equal(stats.updated, 1);
  assert.equal(stats.deleted, 1);
  assert.equal(mapping, undefined);
  assert.equal(staleEpisodes.length, 0);
  assert.equal(normalizedMapping, undefined);
  assert.equal(normalizedEpisodes.length, 0);
  assert.equal(retry.retryCount, 5);
  assert.equal(retry.retryAt, null);
});

test("importMappedReview can convert an existing mapping to wait_airing", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: SOURCE,
      sourceAid: SOURCE_AID,
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "第1集",
      videoUrl: "https://example.invalid/1.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},wait_airing,${SOURCE_AID},future split`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importMappedReview(filePath, { refreshEpisodes: false }));
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();
  const manual = db.select().from(manualMatchState)
    .where(and(eq(manualMatchState.animeId, ANIME_ID), eq(manualMatchState.source, SOURCE)))
    .get();
  const normalizedMapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);
  const normalizedManual = sqlite.prepare(`
    SELECT * FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);

  assert.equal(stats.updated, 1);
  assert.equal(stats.waitAiring, 1);
  assert.equal(mapping, undefined);
  assert.equal(normalizedMapping, undefined);
  assert.equal(manual.status, "wait_airing");
  assert.equal(manual.note, "future split");
  assert.equal(normalizedManual.status, "wait_airing");
  assert.equal(normalizedManual.note, "future split");
});

test("importMappedReview can convert an existing wrong mapping to no_resource", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "错误资源",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: SOURCE,
      sourceAid: SOURCE_AID,
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "第1集",
      videoUrl: "https://example.invalid/1.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},no_resource,${SOURCE_AID},wrong mapping and unavailable`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importMappedReview(filePath, { refreshEpisodes: false }));
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();
  const staleEpisodes = db.select().from(episodes)
    .where(and(eq(episodes.animeId, ANIME_ID), eq(episodes.sourceName, SOURCE)))
    .all();
  const manual = db.select().from(manualMatchState)
    .where(and(eq(manualMatchState.animeId, ANIME_ID), eq(manualMatchState.source, SOURCE)))
    .get();
  const retry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, ANIME_ID), eq(matchRetryState.source, SOURCE)))
    .get();
  const normalizedMapping = sqlite.prepare(`
    SELECT * FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);
  const normalizedManual = sqlite.prepare(`
    SELECT * FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(ANIME_ID, SOURCE);
  const normalizedRetry = sqlite.prepare(`
    SELECT * FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(ANIME_ID, SOURCE);

  assert.equal(stats.updated, 1);
  assert.equal(stats.noResource, 1);
  assert.equal(mapping, undefined);
  assert.equal(staleEpisodes.length, 0);
  assert.equal(normalizedMapping, undefined);
  assert.equal(manual.status, "no_resource");
  assert.equal(manual.note, "wrong mapping and unavailable");
  assert.equal(retry.retryCount, 5);
  assert.equal(retry.retryAt, null);
  assert.equal(normalizedManual.status, "no_resource");
  assert.equal(normalizedManual.note, "wrong mapping and unavailable");
  assert.equal(normalizedRetry.retry_count, 5);
  assert.equal(normalizedRetry.retry_at, null);
});

test("refreshEpisodesForAnime reads normalized resource mappings without legacy mappings", async () => {
  seedRangeAnime();
  sqlite.exec(`
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('ffzy', '非凡资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_bg_name, matched_resource_name, matched_at
    )
    VALUES (
      ${RANGE_ANIME_ID}, 'ffzy', ${RANGE_SOURCE_AID}, 1156, null,
      1155, 0.91, '航海王 埃鲁巴夫篇', '航海王', '2026-05-30 00:00:00'
    )
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      source_aid = excluded.source_aid,
      source_ep_start = excluded.source_ep_start,
      source_ep_end = excluded.source_ep_end,
      display_ep_offset = excluded.display_ep_offset,
      score = excluded.score,
      matched_bg_name = excluded.matched_bg_name,
      matched_resource_name = excluded.matched_resource_name,
      matched_at = excluded.matched_at;
  `);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <rss><list><video>
      <id>${RANGE_SOURCE_AID}</id>
      <name>航海王</name>
      <dl><dd flag="ffm3u8">第1156集$https://example.invalid/1156.m3u8#第1157集$https://example.invalid/1157.m3u8</dd></dl>
    </video></list></rss>
  `, { status: 200, headers: { "content-type": "application/xml" } });
  try {
    const result = await refreshEpisodesForAnime(RANGE_ANIME_ID, { source: "ffzy" });
    assert.equal(result.refreshed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const normalizedRows = sqlite.prepare(`
    SELECT ep_index, source_ep_index, video_url
    FROM episodes
    WHERE bangumi_id = ? AND source = 'ffzy'
    ORDER BY ep_index
  `).all(RANGE_ANIME_ID);

  assert.deepEqual(normalizedRows.map((row) => row.ep_index), [1, 2]);
  assert.deepEqual(normalizedRows.map((row) => row.source_ep_index), [1156, 1157]);
  assert.equal(normalizedRows[0].video_url, "https://example.invalid/1156.m3u8");
});

test("refreshEpisodesForAnime updates normalized-only episode rows", async () => {
  seedRangeAnime();
  sqlite.exec(`
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('ffzy', '非凡资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, display_ep_offset,
      score, matched_bg_name, matched_resource_name, matched_at
    )
    VALUES (${RANGE_ANIME_ID}, 'ffzy', ${RANGE_SOURCE_AID}, 1156, 1155, 0.91, '航海王 埃鲁巴夫篇', '航海王', '2026-05-30 00:00:00')
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      source_aid = excluded.source_aid,
      source_ep_start = excluded.source_ep_start,
      display_ep_offset = excluded.display_ep_offset,
      score = excluded.score,
      matched_bg_name = excluded.matched_bg_name,
      matched_resource_name = excluded.matched_resource_name,
      matched_at = excluded.matched_at;
    INSERT INTO episodes (
      bangumi_id, source, source_aid, ep_index, source_ep_index, ep_name, video_url, updated_at
    )
    VALUES (
      ${RANGE_ANIME_ID}, 'ffzy', ${RANGE_SOURCE_AID}, 1, 1156, '旧标题', 'https://example.invalid/old.m3u8', '2026-05-30 00:00:00'
    );
  `);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <rss><list><video>
      <id>${RANGE_SOURCE_AID}</id>
      <name>航海王</name>
      <dl><dd flag="ffm3u8">第1156集$https://example.invalid/new.m3u8</dd></dl>
    </video></list></rss>
  `, { status: 200, headers: { "content-type": "application/xml" } });
  try {
    const result = await refreshEpisodesForAnime(RANGE_ANIME_ID, { source: "ffzy" });
    assert.equal(result.refreshed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const normalizedRows = sqlite.prepare(`
    SELECT ep_index, source_ep_index, ep_name, video_url
    FROM episodes
    WHERE bangumi_id = ? AND source = 'ffzy'
    ORDER BY ep_index
  `).all(RANGE_ANIME_ID);

  assert.equal(normalizedRows.length, 1);
  assert.equal(normalizedRows[0].ep_index, 1);
  assert.equal(normalizedRows[0].source_ep_index, 1156);
  assert.equal(normalizedRows[0].video_url, "https://example.invalid/new.m3u8");
});

test("refreshEpisodesForAnime filters source episodes and stores display indexes", async () => {
  seedRangeAnime();
  db.insert(cstationCatalog)
    .values({ source: "ffzy", id: RANGE_SOURCE_AID, name: "航海王", year: "2026" })
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: "ffzy",
      cstationId: RANGE_SOURCE_AID,
      sourceEpStart: 1156,
      sourceEpEnd: null,
      displayEpOffset: 1155,
      matchedBgName: "航海王 埃鲁巴夫篇",
      matchedCsName: "航海王",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <rss><list><video>
      <id>${RANGE_SOURCE_AID}</id>
      <name>航海王</name>
      <dl><dd flag="ffm3u8">第1155集$https://example.invalid/1155.m3u8#第1156集$https://example.invalid/1156.m3u8#第1157集$https://example.invalid/1157.m3u8</dd></dl>
    </video></list></rss>
  `, { status: 200, headers: { "content-type": "application/xml" } });
  try {
    const result = await refreshEpisodesForAnime(RANGE_ANIME_ID, { source: "ffzy" });
    assert.equal(result.refreshed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rows = db.select().from(episodes)
    .where(eq(episodes.animeId, RANGE_ANIME_ID))
    .all()
    .sort((a, b) => a.epIndex - b.epIndex);

  assert.deepEqual(rows.map((row) => row.epIndex), [1, 2]);
  assert.deepEqual(rows.map((row) => row.sourceEpIndex), [1156, 1157]);
  assert.equal(rows[0].videoUrl, "https://example.invalid/1156.m3u8");

  const normalizedRows = sqlite.prepare(`
    SELECT bangumi_id, source, source_aid, ep_index, source_ep_index, video_url
    FROM episodes
    WHERE bangumi_id = ? AND source = 'ffzy'
    ORDER BY ep_index
  `).all(RANGE_ANIME_ID);
  assert.deepEqual(normalizedRows.map((row) => row.ep_index), [1, 2]);
  assert.deepEqual(normalizedRows.map((row) => row.source_ep_index), [1156, 1157]);
  assert.equal(normalizedRows[0].source_aid, RANGE_SOURCE_AID);
  assert.equal(normalizedRows[0].video_url, "https://example.invalid/1156.m3u8");

  const play = await getPlayUrl(RANGE_ANIME_ID, 1, 1);
  assert.equal(play.videoUrl, "https://example.invalid/1156.m3u8");
});

test("refreshEpisodesForAnime records catalog last on manually created mappings", async () => {
  db.insert(cstationCatalog)
    .values({ source: "ffzy", id: SOURCE_AID, name: "测试番剧", year: "2026" })
    .onConflictDoUpdate({
      target: [cstationCatalog.source, cstationCatalog.id],
      set: { last: null },
    })
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: "ffzy",
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <rss><list><video>
      <id>${SOURCE_AID}</id>
      <name>测试番剧</name>
      <last>2026-05-30 21:00:00</last>
      <dl><dd flag="ffm3u8">第1集$https://example.invalid/1.m3u8</dd></dl>
    </video></list></rss>
  `, { status: 200, headers: { "content-type": "application/xml" } });
  try {
    const result = await refreshEpisodesForAnime(ANIME_ID, { source: "ffzy" });
    assert.equal(result.refreshed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const catalog = db.select().from(cstationCatalog)
    .where(and(eq(cstationCatalog.source, "ffzy"), eq(cstationCatalog.id, SOURCE_AID)))
    .get();
  const result = await getUpdates({ days: 7, limit: 20, today: "2026-05-30 23:59:59" });
  const current = result.data.find((item) => item.id === ANIME_ID);

  assert.equal(catalog.last, "2026-05-30 21:00:00");
  assert.equal(current.updatedAt, "2026-05-30T13:00:00.000Z");
  assert.equal(current.latestEpisode, "更新至第01集");
});

test("refreshEpisodesForAnime removes stale episodes after a successful refresh", async () => {
  seedRangeAnime();
  db.insert(cstationCatalog)
    .values({ source: "ffzy", id: RANGE_SOURCE_AID, name: "航海王", year: "2026" })
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: "ffzy",
      cstationId: RANGE_SOURCE_AID,
      matchedBgName: "航海王 埃鲁巴夫篇",
      matchedCsName: "航海王",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: RANGE_ANIME_ID,
      sourceName: "ffzy",
      sourceAid: RANGE_SOURCE_AID,
      epIndex: 99,
      sourceEpIndex: 99,
      epName: "旧第99集",
      videoUrl: "https://example.invalid/stale.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <rss><list><video>
      <id>${RANGE_SOURCE_AID}</id>
      <name>航海王</name>
      <dl><dd flag="ffm3u8">第1集$https://example.invalid/1.m3u8#第2集$https://example.invalid/2.m3u8</dd></dl>
    </video></list></rss>
  `, { status: 200, headers: { "content-type": "application/xml" } });
  try {
    const result = await refreshEpisodesForAnime(RANGE_ANIME_ID, { source: "ffzy" });
    assert.equal(result.refreshed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const rows = db.select().from(episodes)
    .where(eq(episodes.animeId, RANGE_ANIME_ID))
    .all()
    .sort((a, b) => a.epIndex - b.epIndex);

  assert.deepEqual(rows.map((row) => row.epIndex), [1, 2]);
  assert.equal(rows.some((row) => row.videoUrl.includes("stale")), false);
});

test("getAnimeDetail does not report ready for stale episodes from a previous source id", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: "ffzy",
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: "ffzy",
      sourceAid: SOURCE_AID + 9,
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "旧来源第1集",
      videoUrl: "https://example.invalid/stale-source.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const detail = await getAnimeDetail(ANIME_ID);
  const sourceStatus = detail.resourceSources.find((item) => item.source === "ffzy");

  assert.equal(sourceStatus.status, "fetching");
  assert.equal(detail.data.channels.length, 0);
});

test("getPlayUrl ignores stale episodes from previous source ids", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: "ffzy",
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values([
      {
        animeId: ANIME_ID,
        sourceName: "ffzy",
        sourceAid: SOURCE_AID - 1,
        epIndex: 1,
        sourceEpIndex: 1,
        epName: "旧来源第1集",
        videoUrl: "https://example.invalid/stale-source.m3u8",
        updatedAt: "2026-05-30 00:00:00",
      },
      {
        animeId: ANIME_ID,
        sourceName: "ffzy",
        sourceAid: SOURCE_AID,
        epIndex: 1,
        sourceEpIndex: 1,
        epName: "当前来源第1集",
        videoUrl: "https://example.invalid/current-source.m3u8",
        updatedAt: "2026-05-30 00:00:00",
      },
    ])
    .run();

  const result = await getPlayUrl(ANIME_ID, 1, 1);

  assert.equal(result.videoUrl, "https://example.invalid/current-source.m3u8");
});

test("getPlayUrl returns null when episodes exist without a current mapping", async () => {
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: "ffzy",
      sourceAid: SOURCE_AID,
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "残留第1集",
      videoUrl: "https://example.invalid/stale-without-map.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = await getPlayUrl(ANIME_ID, 1, 1);

  assert.equal(result, null);
});

test("episode fetch failures do not exhaust mapping retry state for existing mappings", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: "ffzy",
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 500 });
  try {
    for (let i = 0; i < 5; i++) {
      const result = await refreshEpisodesForAnime(ANIME_ID, { source: "ffzy" });
      assert.equal(result.refreshed, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const mappingRetry = db.select().from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, ANIME_ID), eq(matchRetryState.source, "ffzy")))
    .get();
  const fetchRetry = db.select().from(episodeFetchRetryState)
    .where(and(eq(episodeFetchRetryState.animeId, ANIME_ID), eq(episodeFetchRetryState.source, "ffzy")))
    .get();
  const detail = await getAnimeDetail(ANIME_ID);
  const sourceStatus = detail.resourceSources.find((item) => item.source === "ffzy");

  assert.equal(mappingRetry, undefined);
  assert.equal(fetchRetry.retryCount, 5);
  assert.equal(sourceStatus.status, "fetching");
});

test("episode fetch failures continue from normalized episode retry state", async () => {
  sqlite.exec(`
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('ffzy', '非凡资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, matched_bg_name, matched_resource_name, matched_at
    )
    VALUES (${ANIME_ID}, 'ffzy', ${SOURCE_AID}, '测试番剧', '测试番剧', '2026-05-30 00:00:00')
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      source_aid = excluded.source_aid,
      matched_bg_name = excluded.matched_bg_name,
      matched_resource_name = excluded.matched_resource_name,
      matched_at = excluded.matched_at;
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
    VALUES (${ANIME_ID}, 'ffzy', 'episode_fetch', 2, '2000-01-01 00:00:00', datetime('now'))
    ON CONFLICT(bangumi_id, source, kind) DO UPDATE SET
      retry_count = excluded.retry_count,
      retry_at = excluded.retry_at,
      updated_at = excluded.updated_at;
  `);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 500 });
  try {
    const result = await refreshEpisodesForAnime(ANIME_ID, { source: "ffzy" });
    assert.equal(result.refreshed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const normalizedRetry = sqlite.prepare(`
    SELECT * FROM retry_state
    WHERE bangumi_id = ? AND source = 'ffzy' AND kind = 'episode_fetch'
  `).get(ANIME_ID);

  assert.equal(normalizedRetry.retry_count, 3);
  assert.ok(normalizedRetry.retry_at);
});

test("getAnimeDetail ignores mappings and episodes from disabled sources", async () => {
  db.update(cstationCatalog)
    .set({ last: "2026-05-30 21:00:00" })
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: SOURCE,
      sourceAid: SOURCE_AID,
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "禁用源第1集",
      videoUrl: "https://example.invalid/disabled-source.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const detail = await getAnimeDetail(ANIME_ID);

  assert.equal(detail.data.channels.length, 0);
  assert.equal(detail.resourceSources.some((item) => item.source === SOURCE), false);
});

test("getPlayUrl ignores mappings from disabled sources", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: SOURCE,
      sourceAid: SOURCE_AID,
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "禁用源第1集",
      videoUrl: "https://example.invalid/disabled-source.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = await getPlayUrl(ANIME_ID, 1, 1);

  assert.equal(result, null);
});

test("upsertAnime cleans dependent rows when a subject becomes non-anime", async () => {
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedBgName: "测试番剧",
      matchedCsName: "测试番剧",
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: SOURCE, retryCount: 5, retryAt: null, updatedAt: "2026-05-30 00:00:00" })
    .run();
  db.insert(manualMatchState)
    .values({ animeId: ANIME_ID, source: SOURCE, status: "wait_airing", note: "future", updatedAt: "2026-05-30 00:00:00" })
    .run();
  db.insert(episodeFetchRetryState)
    .values({ animeId: ANIME_ID, source: SOURCE, retryCount: 2, retryAt: null, updatedAt: "2026-05-30 00:00:00" })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: SOURCE,
      sourceAid: SOURCE_AID,
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "第1集",
      videoUrl: "https://example.invalid/1.m3u8",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const result = await upsertAnime({
    id: ANIME_ID,
    name: "测试小说",
    name_cn: "测试小说",
    platform: "小说",
  });

  assert.equal(result, null);
  assert.equal(db.select().from(anime).where(eq(anime.id, ANIME_ID)).get(), undefined);
  assert.equal(db.select().from(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, ANIME_ID)).get(), undefined);
  assert.equal(db.select().from(episodes).where(eq(episodes.animeId, ANIME_ID)).get(), undefined);
  assert.equal(db.select().from(matchRetryState).where(eq(matchRetryState.animeId, ANIME_ID)).get(), undefined);
  assert.equal(db.select().from(episodeFetchRetryState).where(eq(episodeFetchRetryState.animeId, ANIME_ID)).get(), undefined);
  assert.equal(db.select().from(manualMatchState).where(eq(manualMatchState.animeId, ANIME_ID)).get(), undefined);
  assert.equal(db.select().from(animeOther).where(eq(animeOther.id, ANIME_ID)).get().platform, "小说");
});

test("getAnimeDetail reports no_data when mapping retries are exhausted", async () => {
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: "ffzy", retryCount: 5, retryAt: null, updatedAt: "2026-05-30 00:00:00" })
    .run();

  const detail = await getAnimeDetail(ANIME_ID);
  const ffzy = detail.resourceSources.find((item) => item.source === "ffzy");

  assert.equal(detail.resourceStatus, "no_data");
  assert.equal(ffzy.status, "no_data");
});

test("getAnimeDetail treats source_already_mapped as no_data without exposing internal notes", async () => {
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: "ffzy", retryCount: 5, retryAt: null, updatedAt: "2026-05-30 00:00:00" })
    .run();
  db.insert(manualMatchState)
    .values({
      animeId: ANIME_ID,
      source: "ffzy",
      status: "source_already_mapped",
      note: "source_aid 999 is already mapped by Bangumi ID 123",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const detail = await getAnimeDetail(ANIME_ID);
  const ffzy = detail.resourceSources.find((item) => item.source === "ffzy");

  assert.equal(detail.resourceStatus, "no_data");
  assert.equal(ffzy.status, "no_data");
  assert.equal(ffzy.note, "no mapping after retries");
});

test("getAnimeDetail treats no_resource as no_data without exposing reviewer notes", async () => {
  db.insert(manualMatchState)
    .values({
      animeId: ANIME_ID,
      source: "ffzy",
      status: "no_resource",
      note: "reviewer confirmed no resource",
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();

  const detail = await getAnimeDetail(ANIME_ID);
  const ffzy = detail.resourceSources.find((item) => item.source === "ffzy");

  assert.equal(detail.resourceStatus, "no_data");
  assert.equal(ffzy.status, "no_data");
  assert.equal(ffzy.note, "no mapping after retries");
});

test("getAnimeDetail reports wait_airing without treating it as matching", async () => {
  db.insert(manualMatchState)
    .values({ animeId: ANIME_ID, source: "ffzy", status: "wait_airing", note: "future broadcast", updatedAt: "2026-05-30 00:00:00" })
    .run();

  const detail = await getAnimeDetail(ANIME_ID);
  const ffzy = detail.resourceSources.find((item) => item.source === "ffzy");

  assert.equal(detail.resourceStatus, "wait_airing");
  assert.equal(ffzy.status, "wait_airing");
  assert.equal(ffzy.note, "future broadcast");
});

test("getUpdates uses mapped cstation last timestamps instead of episode refresh time", async () => {
  const staleAnimeId = ANIME_ID + 1000;
  db.insert(cstationCatalog)
    .values({ source: "ffzy", id: SOURCE_AID, name: "测试番剧", last: "2026-05-30 21:00:00" })
    .onConflictDoUpdate({
      target: [cstationCatalog.source, cstationCatalog.id],
      set: { last: "2026-05-30 21:00:00" },
    })
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: "ffzy",
      cstationId: SOURCE_AID,
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: "ffzy",
      sourceAid: SOURCE_AID,
      epIndex: 9,
      sourceEpIndex: 9,
      epName: "第9集",
      videoUrl: "https://example.invalid/9.m3u8",
      updatedAt: "2026-01-01 00:00:00",
    })
    .run();

  db.insert(anime)
    .values({
      id: staleAnimeId,
      name: "旧季度番",
      nameCn: "旧季度番",
      airDate: "2026-04-01",
      calendarWeekday: null,
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.update(anime)
    .set({ detailFetchedAt: "2026-05-30 00:00:00" })
    .where(eq(anime.id, ANIME_ID))
    .run();
  db.insert(cstationCatalog)
    .values({
      source: "ffzy",
      id: SOURCE_AID + 1000,
      name: "旧季度番",
      last: "2026-05-20 23:59:59",
    })
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: staleAnimeId,
      source: "ffzy",
      cstationId: SOURCE_AID + 1000,
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: staleAnimeId,
      sourceName: "ffzy",
      sourceAid: SOURCE_AID + 1000,
      epIndex: 12,
      sourceEpIndex: 12,
      epName: "第12集",
      videoUrl: "https://example.invalid/12.m3u8",
      updatedAt: "2026-05-30 23:59:59",
    })
    .run();

  try {
    const result = await getUpdates({ days: 7, limit: 20, today: "2026-05-30 23:59:59" });
    const ids = result.data.map((item) => item.id);
    const current = result.data.find((item) => item.id === ANIME_ID);

    assert.ok(ids.includes(ANIME_ID));
    assert.ok(!ids.includes(staleAnimeId));
    assert.equal(current.updatedAt, "2026-05-30T13:00:00.000Z");
    assert.equal(current.latestEp, 9);
    assert.equal(current.source, "ffzy");
    assert.equal(current.sourceAid, SOURCE_AID);
  } finally {
    db.delete(episodes).where(eq(episodes.animeId, staleAnimeId)).run();
    db.delete(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, staleAnimeId)).run();
    db.delete(cstationCatalog).where(and(eq(cstationCatalog.source, "ffzy"), eq(cstationCatalog.id, SOURCE_AID + 1000))).run();
    db.delete(anime).where(eq(anime.id, staleAnimeId)).run();
  }
});

test("getUpdates aggregates multiple mapped sources by newest catalog last", async () => {
  db.insert(cstationCatalog)
    .values({ source: "ffzy", id: SOURCE_AID, name: "测试番剧", last: "2026-05-30 18:00:00" })
    .onConflictDoUpdate({
      target: [cstationCatalog.source, cstationCatalog.id],
      set: { last: "2026-05-30 18:00:00" },
    })
    .run();
  db.insert(bangumiCstationMap)
    .values({ animeId: ANIME_ID, source: "ffzy", cstationId: SOURCE_AID, matchedAt: "2026-05-30 00:00:00" })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: "ffzy",
      sourceAid: SOURCE_AID,
      epIndex: 3,
      sourceEpIndex: 3,
      epName: "第3集",
      videoUrl: "https://example.invalid/3.m3u8",
      updatedAt: "2026-05-30 18:01:00",
    })
    .run();

  const result = await getUpdates({ days: 7, limit: 20, today: "2026-05-30 23:59:59" });
  const current = result.data.find((item) => item.id === ANIME_ID);

  assert.equal(current.source, "ffzy");
  assert.equal(current.sourceAid, SOURCE_AID);
  assert.equal(current.updatedAt, "2026-05-30T10:00:00.000Z");
  assert.equal(current.latestEp, 3);
  assert.equal(current.sourceUpdates.length, 1);
  assert.deepEqual(current.sourceUpdates.map((item) => item.source), ["ffzy"]);
});

test("getUpdates skips closed ranged mappings even when the source item updates", async () => {
  seedRangeAnime();
  db.insert(cstationCatalog)
    .values({
      source: "ffzy",
      id: RANGE_SOURCE_AID,
      name: "航海王",
      last: "2026-05-30 22:00:00",
    })
    .onConflictDoUpdate({
      target: [cstationCatalog.source, cstationCatalog.id],
      set: { last: "2026-05-30 22:00:00" },
    })
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: "ffzy",
      cstationId: RANGE_SOURCE_AID,
      sourceEpStart: 1,
      sourceEpEnd: 2,
      displayEpOffset: 0,
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: RANGE_ANIME_ID,
      sourceName: "ffzy",
      sourceAid: RANGE_SOURCE_AID,
      epIndex: 2,
      sourceEpIndex: 2,
      epName: "第2集",
      videoUrl: "https://example.invalid/range-2.m3u8",
      updatedAt: "2026-05-30 22:01:00",
    })
    .run();

  const result = await getUpdates({ days: 7, limit: 20, today: "2026-05-30 23:59:59" });
  const current = result.data.find((item) => item.id === RANGE_ANIME_ID);

  assert.equal(current, undefined);
});

test("getUpdates includes the active ranged mapping when source latest episode is inside the slice", async () => {
  seedRangeAnime();
  db.insert(cstationCatalog)
    .values({
      source: "ffzy",
      id: RANGE_SOURCE_AID,
      name: "航海王",
      last: "2026-05-30 22:00:00",
    })
    .onConflictDoUpdate({
      target: [cstationCatalog.source, cstationCatalog.id],
      set: { last: "2026-05-30 22:00:00" },
    })
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: RANGE_ANIME_ID,
      source: "ffzy",
      cstationId: RANGE_SOURCE_AID,
      sourceEpStart: 1156,
      sourceEpEnd: null,
      displayEpOffset: 1155,
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: RANGE_ANIME_ID,
      sourceName: "ffzy",
      sourceAid: RANGE_SOURCE_AID,
      epIndex: 3,
      sourceEpIndex: 1158,
      epName: "第1158集",
      videoUrl: "https://example.invalid/range-1158.m3u8",
      updatedAt: "2026-05-01 00:00:00",
    })
    .run();

  const result = await getUpdates({ days: 7, limit: 20, today: "2026-05-30 23:59:59" });
  const current = result.data.find((item) => item.id === RANGE_ANIME_ID);

  assert.ok(current);
  assert.equal(current.updatedAt, "2026-05-30T14:00:00.000Z");
  assert.equal(current.latestEp, 3);
  assert.equal(current.latestEpisode, "更新至第03集");
});

test("getUpdates ignores mappings from disabled sources", async () => {
  db.update(cstationCatalog)
    .set({ last: "2026-05-30 22:00:00" })
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .run();
  db.insert(bangumiCstationMap)
    .values({
      animeId: ANIME_ID,
      source: SOURCE,
      cstationId: SOURCE_AID,
      matchedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.insert(episodes)
    .values({
      animeId: ANIME_ID,
      sourceName: SOURCE,
      sourceAid: SOURCE_AID,
      epIndex: 3,
      sourceEpIndex: 3,
      epName: "禁用源第3集",
      videoUrl: "https://example.invalid/disabled-source-3.m3u8",
      updatedAt: "2026-05-30 22:01:00",
    })
    .run();

  const result = await getUpdates({ days: 7, limit: 20, today: "2026-05-30 23:59:59" });
  const current = result.data.find((item) => item.id === ANIME_ID);

  assert.equal(current, undefined);
});

test("saveCatalog detail hydration does not erase existing catalog last timestamp", async () => {
  await saveCatalog([{ id: SOURCE_AID, name: "测试番剧", last: "2026-05-30 21:00:00" }], { source: SOURCE });
  await saveCatalog([{ id: SOURCE_AID, name: "测试番剧", subname: "详情别名", detailFetchedAt: "2026-05-30 21:01:00" }], { source: SOURCE });

  const row = db.select().from(cstationCatalog)
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .get();

  assert.equal(row.last, "2026-05-30 21:00:00");
  assert.equal(row.subname, "详情别名");
});

test("syncCalendar clears stale calendar weekdays only after a successful calendar sync", async () => {
  const staleAnimeId = ANIME_ID + 3000;
  db.insert(anime)
    .values({
      id: staleAnimeId,
      name: "旧放送番",
      nameCn: "旧放送番",
      calendarWeekday: 5,
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.update(anime)
    .set({ detailFetchedAt: "2026-05-30 00:00:00" })
    .where(eq(anime.id, ANIME_ID))
    .run();

  try {
    const stats = await syncCalendar({
      enqueueEpisodes: false,
      matchSources: false,
      calendar: [
        {
          weekday: { id: 1 },
          items: [
            {
              id: ANIME_ID,
              name: "テスト番組",
              name_cn: "测试番剧",
              platform: "TV",
              air_date: "2026-05-30",
            },
          ],
        },
      ],
    });
    const active = db.select().from(anime).where(eq(anime.id, ANIME_ID)).get();
    const stale = db.select().from(anime).where(eq(anime.id, staleAnimeId)).get();

    assert.equal(stats.errors, 0);
    assert.ok(stats.staleCleared >= 1);
    assert.equal(active.calendarWeekday, 1);
    assert.equal(stale.calendarWeekday, null);
  } finally {
    db.delete(anime).where(eq(anime.id, staleAnimeId)).run();
  }
});

test("syncCalendar keeps stale calendar weekdays when item processing has errors", async () => {
  const staleAnimeId = ANIME_ID + 3001;
  db.insert(anime)
    .values({
      id: staleAnimeId,
      name: "旧放送番",
      nameCn: "旧放送番",
      calendarWeekday: 5,
      updatedAt: "2026-05-30 00:00:00",
    })
    .run();
  db.update(anime)
    .set({ detailFetchedAt: "2026-05-30 00:00:00" })
    .where(eq(anime.id, ANIME_ID))
    .run();

  try {
    const stats = await syncCalendar({
      enqueueEpisodes: false,
      matchSources: false,
      calendar: [
        {
          weekday: { id: 1 },
          items: [
            {
              id: ANIME_ID,
              name: "テスト番組",
              name_cn: "测试番剧",
              platform: "TV",
              air_date: "2026-05-30",
            },
            {
              id: ANIME_ID + 3002,
              platform: "TV",
            },
          ],
        },
      ],
    });
    const stale = db.select().from(anime).where(eq(anime.id, staleAnimeId)).get();

    assert.equal(stats.errors, 1);
    assert.equal(stats.staleCleared, 0);
    assert.equal(stale.calendarWeekday, 5);
  } finally {
    db.delete(anime).where(eq(anime.id, staleAnimeId)).run();
  }
});
