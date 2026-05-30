import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { initDb, db } from "../src/db/index.js";
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
import { getAnimeDetail, getPlayUrl, refreshEpisodesForAnime, upsertAnime } from "../src/services/anime.js";

const SOURCE = "test_manual";
const ANIME_ID = 999900001;
const SOURCE_AID = 999900101;
const RANGE_ANIME_ID = 999900002;
const RANGE_SOURCE_AID = 999900201;

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
  db.delete(bangumiCstationMap)
    .where(eq(bangumiCstationMap.animeId, ANIME_ID))
    .run();
  db.delete(bangumiCstationMap)
    .where(eq(bangumiCstationMap.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(matchRetryState)
    .where(eq(matchRetryState.animeId, ANIME_ID))
    .run();
  db.delete(matchRetryState)
    .where(eq(matchRetryState.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(episodeFetchRetryState)
    .where(eq(episodeFetchRetryState.animeId, ANIME_ID))
    .run();
  db.delete(episodeFetchRetryState)
    .where(eq(episodeFetchRetryState.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(manualMatchState)
    .where(eq(manualMatchState.animeId, ANIME_ID))
    .run();
  db.delete(manualMatchState)
    .where(eq(manualMatchState.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(episodes)
    .where(eq(episodes.animeId, ANIME_ID))
    .run();
  db.delete(episodes)
    .where(eq(episodes.animeId, RANGE_ANIME_ID))
    .run();
  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .run();
  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, "ffzy"), eq(cstationCatalog.id, RANGE_SOURCE_AID)))
    .run();
  db.delete(anime).where(eq(anime.id, ANIME_ID)).run();
  db.delete(anime).where(eq(anime.id, RANGE_ANIME_ID)).run();
  db.delete(animeOther).where(eq(animeOther.id, ANIME_ID)).run();
  db.delete(animeOther).where(eq(animeOther.id, RANGE_ANIME_ID)).run();
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

  const result = analyzeUnmappedMappings({ source: SOURCE, limit: 1 });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.unmatched_reason, "max_retries");
  assert.equal(row.decision, "");
  assert.equal(row.source_aid, SOURCE_AID);
  assert.equal(row.suggestion_1_source_aid, SOURCE_AID);
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

  const result = analyzeUnmappedMappings({ source: SOURCE, limit: 1 });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.equal(row, undefined);
});

test("exportManualReview puts human decision columns first", async () => {
  await withTempPath(async (filePath) => {
    await exportManualReview(filePath, { source: SOURCE, limit: 1 });
    const header = (await readFile(filePath, "utf8")).split("\n")[0].split(",");

    assert.deepEqual(header.slice(0, 7), [
      "anime_id",
      "bg_title",
      "source",
      "match_score",
      "unmatched_reason",
      "decision",
      "source_aid",
    ]);
    assert.equal(header.includes("current_decision"), false);
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

test("importManualReview rejects no_match decisions because blank means unmapped", async () => {
  const csv = [
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},no_match,,no resource on source`,
  ].join("\n");

  await assert.rejects(
    () => withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false })),
    /unsupported decision/
  );
  assert.equal(db.select().from(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, ANIME_ID)).get(), undefined);
});

test("importManualReview applies match decisions directly and clears retry state", async () => {
  db.insert(matchRetryState)
    .values({ animeId: ANIME_ID, source: SOURCE, retryCount: 5, retryAt: null, updatedAt: "2026-05-30 00:00:00" })
    .run();

  const csv = [
    "source,anime_id,decision,source_aid,match_score,reviewer_note",
    `${SOURCE},${ANIME_ID},match,${SOURCE_AID},0.92,confirmed`,
  ].join("\n");

  const stats = await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();

  assert.equal(stats.updated, 1);
  assert.equal(stats.matched, 1);
  assert.equal(mapping.cstationId, SOURCE_AID);
  assert.equal(mapping.score, 0.92);
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

  assert.equal(stats.updated, 1);
  assert.equal(stats.waitAiring, 1);
  assert.equal(manual.status, "wait_airing");
  assert.equal(manual.note, "future broadcast");
  assert.equal(retry.retryCount, 0);
  assert.equal(retry.retryAt, null);
});

test("analyzeUnmappedMappings keeps wait_airing rows exported", async () => {
  await withCsv([
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},wait_airing,,future broadcast`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  const result = analyzeUnmappedMappings({ source: SOURCE, limit: 1 });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.unmatched_reason, "wait_airing");
  assert.equal(row.decision, "");
  assert.equal(row.reviewer_note, "future broadcast");
});

test("analyzeUnmappedMappings keeps wait_airing reason without suggestions", async () => {
  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, SOURCE_AID)))
    .run();

  await withCsv([
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},wait_airing,,future broadcast`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  const result = analyzeUnmappedMappings({ source: SOURCE, limit: 1 });
  const row = result.rows.find((item) => item.anime_id === ANIME_ID && item.source === SOURCE);

  assert.ok(row);
  assert.equal(row.unmatched_reason, "wait_airing");
  assert.equal(row.suggestion_count, 0);
});

test("match decisions clear previous wait_airing state", async () => {
  await withCsv([
    "source,anime_id,decision,source_aid,reviewer_note",
    `${SOURCE},${ANIME_ID},wait_airing,,future broadcast`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  await withCsv([
    "source,anime_id,decision,source_aid,match_score,reviewer_note",
    `${SOURCE},${ANIME_ID},match,${SOURCE_AID},0.95,now available`,
  ].join("\n"), (filePath) => importManualReview(filePath, { refreshEpisodes: false }));

  assert.equal(db.select().from(manualMatchState).where(eq(manualMatchState.animeId, ANIME_ID)).get(), undefined);
  assert.equal(db.select().from(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, ANIME_ID)).get().cstationId, SOURCE_AID);
});

test("importManualReview validates wait_airing anime ids before applying any decision", async () => {
  const csv = [
    "source,anime_id,decision,source_aid,match_score,reviewer_note",
    `${SOURCE},${ANIME_ID},match,${SOURCE_AID},0.95,valid row`,
    `${SOURCE},999999999,wait_airing,,,invalid row`,
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
    "source,anime_id,decision,source_aid,match_score,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${ANIME_ID},match,${SOURCE_AID},0.95,1156,,1155,split sequel`,
  ].join("\n");

  await withCsv(csv, (filePath) => importManualReview(filePath, { refreshEpisodes: false }));
  const mapping = db.select().from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, ANIME_ID), eq(bangumiCstationMap.source, SOURCE)))
    .get();

  assert.equal(mapping.sourceEpStart, 1156);
  assert.equal(mapping.sourceEpEnd, null);
  assert.equal(mapping.displayEpOffset, 1155);
});

test("importMappedReview updates source id and episode range", async () => {
  const NEW_SOURCE_AID = SOURCE_AID + 1;
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
    "source,anime_id,decision,source_aid,match_score,source_ep_start,source_ep_end,display_ep_offset,reviewer_note",
    `${SOURCE},${ANIME_ID},update,${NEW_SOURCE_AID},0.88,12,24,11,range update`,
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
  assert.equal(mapping.matchedCsName, "测试番剧 新来源");
  assert.equal(staleEpisodes.length, 0);

  db.delete(cstationCatalog)
    .where(and(eq(cstationCatalog.source, SOURCE), eq(cstationCatalog.id, NEW_SOURCE_AID)))
    .run();
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

  assert.equal(stats.updated, 1);
  assert.equal(stats.deleted, 1);
  assert.equal(mapping, undefined);
  assert.equal(staleEpisodes.length, 0);
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

  assert.equal(stats.updated, 1);
  assert.equal(stats.waitAiring, 1);
  assert.equal(mapping, undefined);
  assert.equal(manual.status, "wait_airing");
  assert.equal(manual.note, "future split");
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

  const play = await getPlayUrl(RANGE_ANIME_ID, 1, 1);
  assert.equal(play.videoURL, "https://example.invalid/1156.m3u8");
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
