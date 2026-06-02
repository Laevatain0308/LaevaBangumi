import { eq, and, like, or, sql, isNotNull, notInArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  anime,
  episodes,
  bangumiCstationMap,
  cstationCatalog,
  animeOther,
  matchRetryState,
  episodeFetchRetryState,
  manualMatchState,
  ANIME_PLATFORMS,
} from "../db/schema.js";
import * as bangumi from "./bangumi.js";
import * as cstation from "./cstation.js";
import { enqueueJob, registerJob } from "./queue.js";
import { hydrateCatalogDetails, saveCatalog } from "./catalog.js";
import { getEnabledSources } from "../lib/cstationConfig.js";
import { collectBangumiTitles, matchOne, rankMatches } from "../lib/matcher.js";
import { downloadCover } from "../lib/cover.js";
import { buildCoverProxyUrl } from "../lib/coverProxyUrl.js";
import { debug, log, warn, error } from "../lib/logger.js";

const DETAIL_FRESH_MS = 12 * 60 * 60 * 1000;
const DETAIL_SHORT_TIMEOUT_MS = 3500;
const DAY_MS = 24 * 60 * 60 * 1000;

const RETRY_DELAYS = [10, 20, 40, 80, 160];
const MAX_RETRIES = RETRY_DELAYS.length;
const AUTO_MATCH_SCORE = 0.8;
const DEFAULT_MAPPING_RETRY_BATCH_LIMIT = 20;
const DEFAULT_EPISODE_FETCH_RETRY_BATCH_LIMIT = 30;
const MANUAL_MATCH_BLOCKING_STATUSES = new Set(["wait_airing", "no_resource", "source_already_mapped"]);
const MANUAL_NO_DATA_STATUSES = new Set(["no_resource", "source_already_mapped"]);

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function fromNow(minutes) {
  const d = new Date(Date.now() + minutes * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function isFresh(timestamp, windowMs) {
  if (!timestamp) return false;
  return (Date.now() - new Date(timestamp).getTime()) < windowMs;
}

function parseTimestamp(value) {
  return cstation.parseLastTime(value);
}

function normalizeTimestamp(value) {
  const ms = parseTimestamp(value);
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

function parseUpdateNow(value) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return Date.parse(`${value}T23:59:59+08:00`);
  }
  return parseTimestamp(value);
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function isBlank(value) {
  return typeof value === "string" && value.trim() === "";
}

function knownOrSkip(value, detailFetched) {
  if (value === undefined) return detailFetched ? null : undefined;
  if (value === null) return detailFetched ? null : undefined;
  if (isBlank(value)) return detailFetched ? null : undefined;
  return value;
}

function displaySummary(value) {
  if (!value) return value;
  const text = String(value);
  const markers = ["[简介原文]", "【简介原文】"];
  const markerIndex = markers
    .map((marker) => text.indexOf(marker))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  return (markerIndex == null ? text : text.slice(0, markerIndex)).trim();
}

function compactRow(row) {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
}

function scheduleRetry(animeId, source, count) {
  if (!source) throw new Error("scheduleRetry requires source");
  if (count > MAX_RETRIES) return;
  const idx = Math.min(count - 1, RETRY_DELAYS.length - 1);
  const retryAt = fromNow(RETRY_DELAYS[idx]);
  db.insert(matchRetryState)
    .values({ animeId, source, retryCount: count, retryAt, updatedAt: now() })
    .onConflictDoUpdate({
      target: [matchRetryState.animeId, matchRetryState.source],
      set: { retryCount: count, retryAt, updatedAt: now() },
    })
    .run();
}

function blockMappingRetry(animeId, source) {
  db.insert(matchRetryState)
    .values({ animeId, source, retryCount: MAX_RETRIES, retryAt: null, updatedAt: now() })
    .onConflictDoUpdate({
      target: [matchRetryState.animeId, matchRetryState.source],
      set: { retryCount: MAX_RETRIES, retryAt: null, updatedAt: now() },
    })
    .run();
}

function scheduleEpisodeFetchRetry(animeId, source, count) {
  if (!source) throw new Error("scheduleEpisodeFetchRetry requires source");
  const idx = Math.min(Math.max(count, 1) - 1, RETRY_DELAYS.length - 1);
  const retryAt = fromNow(RETRY_DELAYS[idx]);
  db.insert(episodeFetchRetryState)
    .values({ animeId, source, retryCount: count, retryAt, updatedAt: now() })
    .onConflictDoUpdate({
      target: [episodeFetchRetryState.animeId, episodeFetchRetryState.source],
      set: { retryCount: count, retryAt, updatedAt: now() },
    })
    .run();
}

function clearRetry(animeId, source) {
  db.insert(matchRetryState)
    .values({ animeId, source, retryCount: 0, retryAt: null, updatedAt: now() })
    .onConflictDoUpdate({
      target: [matchRetryState.animeId, matchRetryState.source],
      set: { retryCount: 0, retryAt: null, updatedAt: now() },
    })
    .run();
}

function clearEpisodeFetchRetry(animeId, source) {
  db.delete(episodeFetchRetryState)
    .where(and(eq(episodeFetchRetryState.animeId, animeId), eq(episodeFetchRetryState.source, source)))
    .run();
}

function getRetryState(animeId, source) {
  return db.select()
    .from(matchRetryState)
    .where(and(eq(matchRetryState.animeId, animeId), eq(matchRetryState.source, source)))
    .get();
}

function getEpisodeFetchRetryState(animeId, source) {
  return db.select()
    .from(episodeFetchRetryState)
    .where(and(eq(episodeFetchRetryState.animeId, animeId), eq(episodeFetchRetryState.source, source)))
    .get();
}

function getManualBlockingState(animeId, source) {
  return db.select()
    .from(manualMatchState)
    .where(and(
      eq(manualMatchState.animeId, animeId),
      eq(manualMatchState.source, source)
    ))
    .all()
    .find((row) => MANUAL_MATCH_BLOCKING_STATUSES.has(row.status));
}

function setManualMatchState(animeId, source, status, note = null) {
  db.insert(manualMatchState)
    .values({ animeId, source, status, note, updatedAt: now() })
    .onConflictDoUpdate({
      target: [manualMatchState.animeId, manualMatchState.source],
      set: { status, note, updatedAt: now() },
    })
    .run();
}

function clearManualStateByStatus(animeId, source, status) {
  db.delete(manualMatchState)
    .where(and(
      eq(manualMatchState.animeId, animeId),
      eq(manualMatchState.source, source),
      eq(manualMatchState.status, status)
    ))
    .run();
}

function markSourceAlreadyMapped(animeId, source, ownerAnimeId, cstationId) {
  setManualMatchState(animeId, source, "source_already_mapped", `source_aid ${cstationId} is already mapped by Bangumi ID ${ownerAnimeId}`);
}

function clearSourceAlreadyMapped(animeId, source) {
  clearManualStateByStatus(animeId, source, "source_already_mapped");
}

function proxyCover(id, coverUrl, hasCover) {
  const normalizedCoverUrl = normalizeCoverUrl(coverUrl);
  const externalProxyUrl = buildCoverProxyUrl({ id, sourceUrl: normalizedCoverUrl });
  if (externalProxyUrl) return externalProxyUrl;
  if (hasCover) return `/anime/api/cover?id=${id}`;
  return normalizedCoverUrl;
}

function coverFromItem(item) {
  return normalizeCoverUrl((item.images && (item.images.large || item.images.common)) || item.image || null);
}

export function normalizeCoverUrl(url) {
  if (!url) return null;
  return String(url)
    .replace(/^http:\/\//, "https://")
    .replace("/r/400/pic/cover/", "/pic/cover/");
}

function infoboxValue(infobox, keys) {
  if (!Array.isArray(infobox)) return undefined;
  const wanted = Array.isArray(keys) ? keys : [keys];
  const item = infobox.find((box) => wanted.includes(box.key));
  if (!item) return undefined;
  if (Array.isArray(item.value)) return item.value.map((v) => v.v || v.value || v).filter(Boolean).join(" / ");
  return item.value;
}

function normalizeDateValue(value) {
  if (!value) return value;
  const text = String(value).trim();
  const cn = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (cn) return `${cn[1]}-${cn[2].padStart(2, "0")}-${cn[3].padStart(2, "0")}`;
  const cnMonth = text.match(/^(\d{4})年(\d{1,2})月$/);
  if (cnMonth) return `${cnMonth[1]}-${cnMonth[2].padStart(2, "0")}`;
  const cnYear = text.match(/^(\d{4})年$/);
  if (cnYear) return cnYear[1];
  return text;
}

function dateFromItem(item) {
  return normalizeDateValue(item.date ?? item.air_date ?? infoboxValue(item.infobox, "放送开始"));
}

function intFromItem(value) {
  if (value == null || value === "") return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function positiveIntFromItem(value) {
  const parsed = intFromItem(value);
  return parsed && parsed > 0 ? parsed : undefined;
}

function rankFromItem(item) {
  return positiveIntFromItem(item.rating?.rank ?? item.rank);
}

function epsFromItem(item) {
  return positiveIntFromItem(item.eps) ?? positiveIntFromItem(infoboxValue(item.infobox, "话数"));
}

function totalEpisodesFromItem(item) {
  return positiveIntFromItem(item.total_episodes) ?? epsFromItem(item);
}

function weekdayFromDate(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const day = new Date(`${date}T00:00:00+09:00`).getDay();
  return day === 0 ? 7 : day;
}

function tagsFromItem(item, detailFetched) {
  if (Array.isArray(item.meta_tags)) return JSON.stringify(item.meta_tags);
  if (Array.isArray(item.tags)) return JSON.stringify(item.tags.map((tag) => tag.name).filter(Boolean).slice(0, 8));
  return detailFetched ? "[]" : undefined;
}

function aliasesFromItem(item, detailFetched) {
  const titles = collectBangumiTitles(item).filter((title) => title !== item.name && title !== item.name_cn);
  if (titles.length > 0) return JSON.stringify(titles);
  return detailFetched ? "[]" : undefined;
}

function bangumiItemToAnime(item, weekday, { detailFetched = false } = {}) {
  const airDate = dateFromItem(item);
  const coverUrl = coverFromItem(item);
  return {
    id: item.id,
    name: item.name,
    nameCn: knownOrSkip(item.name_cn, detailFetched),
    summary: knownOrSkip(item.summary, detailFetched),
    airDate: knownOrSkip(airDate, detailFetched),
    airWeekday: knownOrSkip(item.air_weekday ?? weekdayFromDate(airDate), detailFetched),
    eps: knownOrSkip(epsFromItem(item), detailFetched),
    totalEpisodes: knownOrSkip(totalEpisodesFromItem(item), detailFetched),
    platform: knownOrSkip(item.platform, detailFetched),
    coverUrl: knownOrSkip(coverUrl, detailFetched),
    ratingScore: knownOrSkip(item.rating?.score, detailFetched),
    rank: knownOrSkip(rankFromItem(item), detailFetched),
    tags: tagsFromItem(item, detailFetched),
    aliases: aliasesFromItem(item, detailFetched),
    calendarWeekday: weekday,
    detailFetchedAt: detailFetched ? now() : undefined,
    updatedAt: now(),
  };
}

function animeRowToBangumiLike(a) {
  return {
    id: a.id,
    name: a.name,
    name_cn: a.nameCn,
    aliases: safeJson(a.aliases, []),
    air_date: a.airDate,
    air_weekday: a.airWeekday,
    eps: a.eps,
    total_episodes: a.totalEpisodes,
    platform: a.platform,
  };
}

function deleteAnimeDependencies(animeId) {
  db.delete(episodes).where(eq(episodes.animeId, animeId)).run();
  db.delete(bangumiCstationMap).where(eq(bangumiCstationMap.animeId, animeId)).run();
  db.delete(matchRetryState).where(eq(matchRetryState.animeId, animeId)).run();
  db.delete(episodeFetchRetryState).where(eq(episodeFetchRetryState.animeId, animeId)).run();
  db.delete(manualMatchState).where(eq(manualMatchState.animeId, animeId)).run();
}

export async function upsertAnime(item, weekday = undefined, options = {}) {
  const platform = item.platform || null;

  if (platform && !ANIME_PLATFORMS.has(platform)) {
    log("anime", "skip non-anime subject", { id: item.id, name: item.name, platform });
    deleteAnimeDependencies(item.id);
    db.delete(anime).where(eq(anime.id, item.id)).run();
    db.insert(animeOther)
      .values(compactRow({
        id: item.id,
        name: item.name,
        nameCn: item.name_cn,
        summary: item.summary,
        platform,
        coverUrl: coverFromItem(item),
        tags: tagsFromItem(item, !!options.detailFetched),
        aliases: aliasesFromItem(item, !!options.detailFetched),
      }))
      .onConflictDoNothing()
      .run();
    return null;
  }

  const row = compactRow(bangumiItemToAnime(item, weekday, options));
  const existing = db.select().from(anime).where(eq(anime.id, item.id)).get();
  if (existing) {
    delete row.id;
    delete row.createdAt;
    db.update(anime).set(row).where(eq(anime.id, item.id)).run();
    debug("anime", "updated subject", { id: item.id, title: item.name_cn || item.name, detailFetched: !!options.detailFetched });
  } else {
    db.insert(anime).values(row).run();
    debug("anime", "inserted subject", { id: item.id, title: item.name_cn || item.name, detailFetched: !!options.detailFetched });
  }

  const coverUrl = row.coverUrl;
  if (coverUrl) {
    downloadCover(item.id, coverUrl).then((ok) => {
      if (ok) db.update(anime).set({ hasCover: 1 }).where(eq(anime.id, item.id)).run();
    }).catch(() => {});
  }

  return db.select().from(anime).where(eq(anime.id, item.id)).get();
}

export async function enrichFromSubject(itemOrId, weekday = undefined, options = {}) {
  const id = typeof itemOrId === "object" ? itemOrId.id : itemOrId;
  log("bangumi", "fetch subject detail", { id, timeoutMs: options.timeoutMs });
  const subject = await bangumi.getSubject(id, { timeoutMs: options.timeoutMs });
  if (!subject) return null;
  return upsertAnime(subject, weekday, { detailFetched: true });
}

function applyEpisodeRange(episodesList, mapping) {
  const start = mapping.sourceEpStart ?? null;
  const end = mapping.sourceEpEnd ?? null;
  const offset = mapping.displayEpOffset ?? 0;
  return episodesList
    .filter((ep) => {
      if (start != null && ep.epIndex < start) return false;
      if (end != null && ep.epIndex > end) return false;
      return true;
    })
    .map((ep) => ({
      ...ep,
      sourceEpIndex: ep.epIndex,
      epIndex: ep.epIndex - offset,
    }))
    .filter((ep) => ep.epIndex > 0);
}

async function upsertEpisodes(animeId, source, cstationId, episodesList) {
  for (const ep of episodesList) {
    const sourceEpIndex = ep.sourceEpIndex ?? ep.epIndex;
    const existing = db.select()
      .from(episodes)
      .where(and(
        eq(episodes.animeId, animeId),
        eq(episodes.sourceName, source),
        eq(episodes.sourceAid, cstationId),
        eq(episodes.epIndex, ep.epIndex)
      ))
      .get();

    if (!existing) {
      db.insert(episodes)
        .values({
          animeId,
          sourceName: source,
          sourceAid: cstationId,
          epIndex: ep.epIndex,
          sourceEpIndex,
          epName: ep.epName,
          videoUrl: ep.videoUrl,
          updatedAt: now(),
        })
        .run();
      continue;
    }

    if (
      existing.videoUrl !== ep.videoUrl ||
      existing.epName !== ep.epName ||
      existing.sourceEpIndex !== sourceEpIndex
    ) {
      db.update(episodes)
        .set({ videoUrl: ep.videoUrl, epName: ep.epName, sourceEpIndex, updatedAt: now() })
        .where(eq(episodes.id, existing.id))
        .run();
    }
  }
}

function pruneEpisodesForRefresh(animeId, source, cstationId, episodesList) {
  const validIndexes = new Set(episodesList.map((ep) => ep.epIndex));
  const existing = db.select()
    .from(episodes)
    .where(and(eq(episodes.animeId, animeId), eq(episodes.sourceName, source)))
    .all();

  for (const ep of existing) {
    if (ep.sourceAid !== cstationId || !validIndexes.has(ep.epIndex)) {
      db.delete(episodes).where(eq(episodes.id, ep.id)).run();
    }
  }
}

async function upsertMap(animeId, source, cstationId, score, matchedBgName, matchedCsName, range = {}) {
  db.insert(bangumiCstationMap)
    .values({
      animeId,
      source,
      cstationId,
      sourceEpStart: range.sourceEpStart ?? null,
      sourceEpEnd: range.sourceEpEnd ?? null,
      displayEpOffset: range.displayEpOffset ?? 0,
      score,
      matchedBgName,
      matchedCsName,
      matchedAt: now(),
    })
    .onConflictDoUpdate({
      target: [bangumiCstationMap.animeId, bangumiCstationMap.source],
      set: {
        cstationId,
        sourceEpStart: range.sourceEpStart ?? null,
        sourceEpEnd: range.sourceEpEnd ?? null,
        displayEpOffset: range.displayEpOffset ?? 0,
        score,
        matchedBgName,
        matchedCsName,
        matchedAt: now(),
      },
    })
    .run();
}

function getMap(animeId, source) {
  return db.select()
    .from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, animeId), eq(bangumiCstationMap.source, source)))
    .get();
}

function getAutoExclusiveSourceOwner(source, cstationId, animeId) {
  return db.select()
    .from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.source, source), eq(bangumiCstationMap.cstationId, cstationId)))
    .all()
    .find((mapping) => mapping.animeId !== animeId);
}

function getCandidatesForAnime(a, source) {
  const year = bangumi.extractYear(a.airDate);
  return db.select()
    .from(cstationCatalog)
    .where(eq(cstationCatalog.source, source))
    .all()
    .filter((c) => {
      if (!year || !c.year) return true;
      const cy = parseInt(c.year, 10);
      return !Number.isNaN(cy) && Math.abs(year - cy) <= 1;
    });
}

function titleNamesForAnime(a) {
  return collectBangumiTitles(animeRowToBangumiLike(a));
}

function rankSourceMatches(a, source, { limit = 20, minScore = 0.45 } = {}) {
  const year = bangumi.extractYear(a.airDate);
  const names = titleNamesForAnime(a);
  return rankMatches(names, year, getCandidatesForAnime(a, source), { limit, minScore });
}

async function findBestSourceMatch(a, source, ranked = null) {
  const year = bangumi.extractYear(a.airDate);
  const names = titleNamesForAnime(a);
  const top = ranked ?? rankSourceMatches(a, source);
  let best = top[0]?.score >= AUTO_MATCH_SCORE ? top[0] : null;
  if (best?.confidence === "high") return best;

  const needDetailIds = top
    .filter((match) => !match.video.subname || !match.video.detailFetchedAt)
    .map((match) => match.video.id);

  if (needDetailIds.length > 0) {
    await hydrateCatalogDetails(needDetailIds, { source });
    const detailed = db.select()
      .from(cstationCatalog)
      .where(eq(cstationCatalog.source, source))
      .all()
      .filter((c) => needDetailIds.includes(c.id));
    const detailedBest = matchOne(names, year, detailed);
    if (detailedBest && (!best || detailedBest.score > best.score)) best = detailedBest;
  }

  return best;
}

export async function ensureMappingForAnime(animeId, { source, refresh = false } = {}) {
  if (!source) throw new Error("ensureMappingForAnime requires source");
  const a = db.select().from(anime).where(eq(anime.id, animeId)).get();
  if (!a) return { animeId, matched: false, reason: "missing-anime" };

  const existing = getMap(animeId, source);
  if (existing && !refresh) {
    log("match", "mapping exists", { animeId, source, cstationId: existing.cstationId });
    return { animeId, matched: true, cstationId: existing.cstationId, reason: "already-mapped" };
  }

  const manualBlock = getManualBlockingState(animeId, source);
  if (!existing && manualBlock) {
    return { animeId, matched: false, reason: manualBlock.status.replaceAll("_", "-") };
  }

  const retry = getRetryState(animeId, source);
  if (!existing && !refresh && retry?.retryAt && retry.retryAt > now()) {
    return { animeId, matched: false, reason: "retry-wait" };
  }
  if (!existing && !refresh && (retry?.retryCount ?? 0) >= MAX_RETRIES) {
    return { animeId, matched: false, reason: "max-retries" };
  }

  log("match", "matching started", { animeId, source, refresh });
  const ranked = rankSourceMatches(a, source);
  const top = ranked[0] || null;
  if (top?.score >= AUTO_MATCH_SCORE) {
    const sourceOwner = getAutoExclusiveSourceOwner(source, top.video.id, animeId);
    if (sourceOwner) {
      blockMappingRetry(animeId, source);
      markSourceAlreadyMapped(animeId, source, sourceOwner.animeId, top.video.id);
      warn("match", "source id already mapped by another Bangumi subject", {
        animeId,
        source,
        cstationId: top.video.id,
        ownerAnimeId: sourceOwner.animeId,
        retryCount: MAX_RETRIES,
      });
      return { animeId, matched: false, reason: "source-already-mapped" };
    }
  }

  const best = await findBestSourceMatch(a, source, ranked);
  if (!best) {
    const retryCount = (retry?.retryCount ?? 0) + 1;
    scheduleRetry(animeId, source, retryCount);
    warn("match", "no catalog match", { animeId, source, title: a.nameCn || a.name, retryCount });
    return { animeId, matched: false, reason: "no-catalog-match" };
  }

  const sourceOwner = getAutoExclusiveSourceOwner(source, best.video.id, animeId);
  if (sourceOwner) {
    blockMappingRetry(animeId, source);
    markSourceAlreadyMapped(animeId, source, sourceOwner.animeId, best.video.id);
    warn("match", "source id already mapped by another Bangumi subject", {
      animeId,
      source,
      cstationId: best.video.id,
      ownerAnimeId: sourceOwner.animeId,
      retryCount: MAX_RETRIES,
    });
    return { animeId, matched: false, reason: "source-already-mapped" };
  }

  await upsertMap(animeId, source, best.video.id, best.score, best.matchedName, best.matchedSourceName || best.video.name);
  clearSourceAlreadyMapped(animeId, source);
  clearRetry(animeId, source);
  log("match", "matched", {
    animeId,
    title: a.nameCn || a.name,
    source,
    cstationId: best.video.id,
    score: Number(best.score.toFixed(3)),
    bgTitle: best.matchedName,
    sourceTitle: best.matchedSourceName || best.video.name,
  });
  return { animeId, matched: true, cstationId: best.video.id, score: best.score, matchedName: best.matchedName };
}

export async function refreshEpisodesForAnime(animeId, { source } = {}) {
  if (!source) throw new Error("refreshEpisodesForAnime requires source");
  log("episodes", "refresh started", { animeId, source });
  let mapped = getMap(animeId, source);
  if (!mapped) {
    const mapping = await ensureMappingForAnime(animeId, { source });
    if (!mapping.matched) return { animeId, refreshed: false, reason: mapping.reason };
    mapped = getMap(animeId, source);
  }

  const detail = await cstation.fetchById(mapped.cstationId, { source });
  if (!detail) {
    const retry = getEpisodeFetchRetryState(animeId, source);
    scheduleEpisodeFetchRetry(animeId, source, (retry?.retryCount ?? 0) + 1);
    warn("episodes", "fetch detail failed", { animeId, source, cstationId: mapped.cstationId });
    return { animeId, refreshed: false, reason: "fetch-detail-failed" };
  }

  await saveCatalog([{
    id: detail.id,
    name: detail.name,
    subname: detail.subname || null,
    year: detail.year || null,
    last: detail.last || null,
    category: detail.type || null,
    detailFetchedAt: now(),
  }], { source });

  const rangedEpisodes = applyEpisodeRange(detail.episodes, mapped);
  pruneEpisodesForRefresh(animeId, source, detail.id, rangedEpisodes);
  await upsertEpisodes(animeId, source, detail.id, rangedEpisodes);
  await upsertMap(animeId, source, detail.id, mapped.score, mapped.matchedBgName, detail.name, {
    sourceEpStart: mapped.sourceEpStart,
    sourceEpEnd: mapped.sourceEpEnd,
    displayEpOffset: mapped.displayEpOffset,
  });
  clearRetry(animeId, source);
  clearEpisodeFetchRetry(animeId, source);
  log("episodes", "refresh completed", { animeId, source, cstationId: detail.id, epCount: rangedEpisodes.length, sourceEpCount: detail.epCount });
  return { animeId, refreshed: true, cstationId: detail.id, epCount: rangedEpisodes.length, sourceEpCount: detail.epCount };
}

export async function matchAndPersist(item, weekday) {
  const a = await upsertAnime(item, weekday);
  if (!a) return { animeId: item.id, matched: false, reason: "non-anime" };

  if (!a.detailFetchedAt) {
    try {
      await enrichFromSubject(item.id, weekday);
    } catch (err) {
      console.error(`enrich subject ${item.id} failed:`, err.message);
    }
  }

  let lastMapping = null;
  for (const source of getEnabledSourceKeys()) {
    const mapping = await ensureMappingForAnime(item.id, { source });
    lastMapping = mapping;
    if (mapping.matched) await refreshEpisodesForAnime(item.id, { source });
  }
  return lastMapping || { animeId: item.id, matched: false, reason: "no-source" };
}

export async function syncCalendar({ enqueueEpisodes = true, matchSources = true, calendar: calendarOverride = null } = {}) {
  log("calendar", "sync started", { enqueueEpisodes, matchSources });
  const calendar = calendarOverride ?? await bangumi.getCalendar();
  const stats = { upserted: 0, mapped: 0, queuedEpisodes: 0, staleCleared: 0, errors: 0 };
  const activeAnimeIds = new Set();

  for (const day of calendar) {
    log("calendar", "sync weekday started", { weekday: day.weekday?.id, total: day.items?.length ?? 0 });
    for (const item of day.items) {
      try {
        const a = await upsertAnime(item, day.weekday?.id);
        if (!a) continue;
        activeAnimeIds.add(item.id);
        stats.upserted++;

        if (!a.detailFetchedAt) {
          try {
            await enrichFromSubject(item.id, day.weekday?.id);
          } catch (err) {
            error("calendar", `enrich failed for ${item.id}`, err);
          }
        }

        if (matchSources) {
          for (const source of getEnabledSourceKeys()) {
            const mapping = await ensureMappingForAnime(item.id, { source });
            if (mapping.matched) {
              stats.mapped++;
            }
            if (enqueueEpisodes && mapping.matched) {
              if (enqueueEpisodeRefresh(item.id, { source })) {
                stats.queuedEpisodes++;
              }
            } else if (enqueueEpisodes && !mapping.matched) {
              debug("calendar", "skip episode refresh without mapping", { animeId: item.id, source, reason: mapping.reason });
            }
          }
        }
      } catch (err) {
        error("calendar", `sync item failed for ${item.id}`, err);
        stats.errors++;
      }
    }
    log("calendar", "sync weekday completed", { weekday: day.weekday?.id, stats });
  }

  if (stats.errors === 0) {
    stats.staleCleared = clearStaleCalendarEntries(activeAnimeIds);
  } else {
    warn("calendar", "skip stale calendar cleanup because sync had errors", { errors: stats.errors });
  }
  log("calendar", "sync completed", stats);
  return stats;
}

function applyBatchLimit(rows, limit) {
  if (limit == null) return { rows, limited: false, total: rows.length };
  const parsed = parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return { rows, limited: false, total: rows.length };
  return {
    rows: rows.slice(0, parsed),
    limited: rows.length > parsed,
    total: rows.length,
  };
}

export async function retryPending({
  mappingLimit = DEFAULT_MAPPING_RETRY_BATCH_LIMIT,
  episodeFetchLimit = DEFAULT_EPISODE_FETCH_RETRY_BATCH_LIMIT,
  refreshEpisodes = true,
  sourceKeys: explicitSourceKeys = null,
} = {}) {
  const list = db.select().from(anime).all();
  const sourceKeys = getEnabledSourceKeys(explicitSourceKeys);
  const mapped = mappedAnimeSourceKeys(sourceKeys);
  const episodeSourceKeys = episodeAnimeSourceKeys(sourceKeys);
  const retryRows = db.select().from(matchRetryState).all();
  const episodeRetryRows = db.select().from(episodeFetchRetryState).all();
  const manualBlockedKeys = manualBlockingKeys(sourceKeys);
  const animeById = new Map(list.map((a) => [a.id, a]));
  const pending = retryRows.filter((row) => {
    if (!sourceKeys.includes(row.source)) return false;
    if (manualBlockedKeys.has(`${row.animeId}:${row.source}`)) return false;
    if (episodeSourceKeys.has(`${row.animeId}:${row.source}`)) return false;
    if (!animeById.has(row.animeId)) return false;
    if (!row.retryAt) return false;
    if (row.retryCount >= MAX_RETRIES) return false;
    return row.retryAt <= now();
  });
  const pendingEpisodeFetches = episodeRetryRows.filter((row) => {
    if (!sourceKeys.includes(row.source)) return false;
    if (manualBlockedKeys.has(`${row.animeId}:${row.source}`)) return false;
    if (!animeById.has(row.animeId)) return false;
    if (!mapped.has(`${row.animeId}:${row.source}`)) return false;
    if (!row.retryAt) return false;
    return row.retryAt <= now();
  });

  const mappingBatch = applyBatchLimit(pending, mappingLimit);
  const episodeFetchBatch = applyBatchLimit(pendingEpisodeFetches, episodeFetchLimit);
  const mappingPending = mappingBatch.rows;
  const episodeFetchPending = episodeFetchBatch.rows;

  const stats = {
    retried: 0,
    matched: 0,
    refreshed: 0,
    errors: 0,
    pending: {
      mapping: mappingBatch.total,
      episodeFetch: episodeFetchBatch.total,
    },
    processed: {
      mapping: mappingPending.length,
      episodeFetch: episodeFetchPending.length,
    },
    limited: {
      mapping: mappingBatch.limited,
      episodeFetch: episodeFetchBatch.limited,
    },
  };
  if (pending.length + pendingEpisodeFetches.length > 0) {
    log("retry", "pending retry started", {
      mapping: mappingBatch.total,
      episodeFetch: episodeFetchBatch.total,
      processingMapping: mappingPending.length,
      processingEpisodeFetch: episodeFetchPending.length,
      limited: stats.limited,
    });
  }
  for (const row of mappingPending) {
    try {
      stats.retried++;
      if (mapped.has(`${row.animeId}:${row.source}`)) {
        if (refreshEpisodes) {
          const refresh = await refreshEpisodesForAnime(row.animeId, { source: row.source });
          if (refresh.refreshed) stats.refreshed++;
        }
        continue;
      }

      const mapping = await ensureMappingForAnime(row.animeId, { source: row.source });
      if (mapping.matched) {
        stats.matched++;
        if (refreshEpisodes) {
          const refresh = await refreshEpisodesForAnime(row.animeId, { source: row.source });
          if (refresh.refreshed) stats.refreshed++;
        }
      }
    } catch (err) {
      error("retry", `retry failed for ${row.animeId}:${row.source}`, err);
      stats.errors++;
    }
  }
  for (const row of episodeFetchPending) {
    try {
      stats.retried++;
      const refresh = await refreshEpisodesForAnime(row.animeId, { source: row.source });
      if (refresh.refreshed) stats.refreshed++;
    } catch (err) {
      error("retry", `episode fetch retry failed for ${row.animeId}:${row.source}`, err);
      stats.errors++;
    }
  }
  if (pending.length + pendingEpisodeFetches.length > 0) log("retry", "pending retry completed", stats);
  return stats;
}

export async function batchMatch({ refreshEpisodes = true, includeCoolingDown = false, sourceKeys: explicitSourceKeys = null, animeIds = null } = {}) {
  const sourceKeys = getEnabledSourceKeys(explicitSourceKeys);
  const mapped = mappedAnimeSourceKeys(sourceKeys);
  const retryByAnimeSource = retryStateByAnimeSource(sourceKeys);
  const manualBlockedKeys = manualBlockingKeys(sourceKeys);

  const animeIdSet = animeIds ? new Set(animeIds.map((id) => parseInt(id, 10)).filter(Boolean)) : null;
  const unmatched = db.select().from(anime).all().filter((a) => {
    if (animeIdSet && !animeIdSet.has(a.id)) return false;
    if (sourceKeys.every((source) => mapped.has(`${a.id}:${source}`))) return false;
    return true;
  });
  const stats = { matched: 0, refreshed: 0, errors: 0 };
  log("match", "batch match started", { total: unmatched.length, refreshEpisodes, includeCoolingDown });

  for (const a of unmatched) {
    try {
      for (const source of sourceKeys) {
        if (mapped.has(`${a.id}:${source}`)) continue;
        if (manualBlockedKeys.has(`${a.id}:${source}`)) continue;
        const retry = retryByAnimeSource.get(`${a.id}:${source}`);
        if (!includeCoolingDown && retry?.retryAt && retry.retryAt > now()) continue;
        if ((retry?.retryCount ?? 0) >= MAX_RETRIES) continue;
        const mapping = await ensureMappingForAnime(a.id, { source });
        if (!mapping.matched) continue;
        stats.matched++;
        if (refreshEpisodes) {
          const refresh = await refreshEpisodesForAnime(a.id, { source });
          if (refresh.refreshed) stats.refreshed++;
        }
      }
    } catch (err) {
      error("match", `batch match failed for ${a.id}`, err);
      stats.errors++;
    }
  }

  log("match", "batch match completed", stats);
  return stats;
}

export function enqueueEpisodeRefreshesBySourceIds(sourceIds, { source } = {}) {
  if (!source) throw new Error("enqueueEpisodeRefreshesBySourceIds requires source");
  const ids = [...new Set(sourceIds.map((id) => parseInt(id, 10)).filter(Boolean))];
  let queued = 0;

  for (const sourceId of ids) {
    const rows = db.select({ animeId: bangumiCstationMap.animeId })
      .from(bangumiCstationMap)
      .where(and(eq(bangumiCstationMap.source, source), eq(bangumiCstationMap.cstationId, sourceId)))
      .all();
    for (const row of rows) {
      if (enqueueEpisodeRefresh(row.animeId, { source })) queued++;
    }
  }

  return queued;
}

function getEnabledSourceKeys(sourceKeys = null) {
  if (sourceKeys) return sourceKeys;
  return getEnabledSources().map((source) => source.key);
}

function enabledSourceSet(sourceKeys = null) {
  return new Set(getEnabledSourceKeys(sourceKeys));
}

function normalizeIdList(ids) {
  if (ids == null || ids === "") return [];
  const raw = Array.isArray(ids) ? ids : String(ids).split(",");
  return [...new Set(raw
    .flatMap((value) => String(value).split(","))
    .map((value) => parseInt(String(value).trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0))];
}

function normalizeSourceKeys(sourceKeys) {
  if (sourceKeys == null || sourceKeys === "") return null;
  const raw = Array.isArray(sourceKeys) ? sourceKeys : String(sourceKeys).split(",");
  const keys = raw
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return keys.length > 0 ? [...new Set(keys)] : null;
}

function normalizeLimit(limit) {
  if (limit == null || limit === "") return null;
  const parsed = parseInt(limit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function animeTitle(a) {
  return a?.nameCn || a?.name || "";
}

export async function prewarmAnime({
  ids = [],
  query = null,
  sourceKeys = null,
  mappedOnly = false,
  refreshEpisodes = true,
  limit = null,
} = {}, deps = {}) {
  const searchSubjects = deps.searchSubjects ?? bangumi.searchSubjects;
  const enrichSubject = deps.enrichSubject ?? enrichFromSubject;
  const ensureMapping = deps.ensureMapping ?? ensureMappingForAnime;
  const refreshEpisodeList = deps.refreshEpisodes ?? refreshEpisodesForAnime;
  const upsertSubject = deps.upsertSubject ?? upsertAnime;
  const normalizedSources = getEnabledSourceKeys(normalizeSourceKeys(sourceKeys));
  const rowLimit = normalizeLimit(limit);
  const targets = new Map();

  for (const id of normalizeIdList(ids)) {
    targets.set(id, { id, row: null });
  }

  const keyword = String(query || "").trim();
  const stats = {
    requested: 0,
    upserted: 0,
    processed: 0,
    matched: 0,
    refreshed: 0,
    skipped: 0,
    errors: 0,
    items: [],
  };

  if (keyword) {
    log("prewarm", "bangumi search started", { keyword, limit: rowLimit });
    const searchResult = await searchSubjects(keyword);
    const subjects = (searchResult?.data || []).slice(0, rowLimit ?? undefined);
    for (const subject of subjects) {
      const row = await upsertSubject(subject);
      if (!row) continue;
      stats.upserted++;
      targets.set(row.id, { id: row.id, row });
    }
  }

  stats.requested = targets.size;

  for (const target of targets.values()) {
    const item = {
      animeId: target.id,
      title: animeTitle(target.row),
      metadata: "pending",
      sources: [],
    };
    stats.items.push(item);

    let animeRow = target.row;
    try {
      const enriched = await enrichSubject(target.id);
      if (enriched) {
        animeRow = enriched;
        item.metadata = "enriched";
      } else if (animeRow) {
        item.metadata = "cached";
      } else {
        animeRow = db.select().from(anime).where(eq(anime.id, target.id)).get();
        item.metadata = animeRow ? "cached" : "missing";
      }
    } catch (err) {
      animeRow = animeRow ?? db.select().from(anime).where(eq(anime.id, target.id)).get();
      item.metadata = animeRow ? "cached" : "failed";
      item.error = err.message;
      if (!animeRow) {
        stats.errors++;
        error("prewarm", `metadata fetch failed for ${target.id}`, err);
        continue;
      }
      warn("prewarm", "metadata fetch failed, using local cache", { animeId: target.id, message: err.message });
    }

    if (!animeRow) {
      stats.errors++;
      continue;
    }

    item.title = animeTitle(animeRow);
    stats.processed++;

    for (const source of normalizedSources) {
      const sourceItem = {
        source,
        mapping: "pending",
        episodes: "skipped",
      };
      item.sources.push(sourceItem);

      try {
        const existing = getMap(animeRow.id, source);
        if (mappedOnly && !existing) {
          stats.skipped++;
          sourceItem.mapping = "skipped";
          sourceItem.reason = "not-mapped";
          continue;
        }

        const mapping = existing
          ? { animeId: animeRow.id, matched: true, cstationId: existing.cstationId, reason: "already-mapped" }
          : await ensureMapping(animeRow.id, { source });

        sourceItem.mapping = mapping.matched ? "matched" : "skipped";
        sourceItem.reason = mapping.reason || "";
        if (mapping.cstationId) sourceItem.cstationId = mapping.cstationId;

        if (!mapping.matched) {
          stats.skipped++;
          continue;
        }

        stats.matched++;
        if (!refreshEpisodes) {
          sourceItem.episodes = "skipped";
          sourceItem.episodeReason = "refresh-disabled";
          continue;
        }

        const refresh = await refreshEpisodeList(animeRow.id, { source });
        sourceItem.episodes = refresh.refreshed ? "refreshed" : "skipped";
        sourceItem.episodeReason = refresh.reason || "";
        if (refresh.cstationId) sourceItem.cstationId = refresh.cstationId;
        if (refresh.epCount != null) sourceItem.epCount = refresh.epCount;
        if (refresh.refreshed) {
          stats.refreshed++;
        } else {
          stats.skipped++;
        }
      } catch (err) {
        stats.errors++;
        sourceItem.mapping = sourceItem.mapping === "pending" ? "failed" : sourceItem.mapping;
        sourceItem.episodes = "failed";
        sourceItem.reason = err.message;
        error("prewarm", `source processing failed for ${animeRow.id}:${source}`, err);
      }
    }
  }

  log("prewarm", "completed", {
    requested: stats.requested,
    upserted: stats.upserted,
    processed: stats.processed,
    matched: stats.matched,
    refreshed: stats.refreshed,
    skipped: stats.skipped,
    errors: stats.errors,
  });
  return stats;
}

function mappedAnimeSourceKeys(sourceKeys) {
  return new Set(
    db.select({ animeId: bangumiCstationMap.animeId, source: bangumiCstationMap.source })
      .from(bangumiCstationMap)
      .all()
      .filter((r) => sourceKeys.includes(r.source))
      .map((r) => `${r.animeId}:${r.source}`)
  );
}

function episodeAnimeSourceKeys(sourceKeys) {
  return new Set(
    db.select({ animeId: episodes.animeId, sourceName: episodes.sourceName })
      .from(episodes)
      .all()
      .filter((r) => sourceKeys.includes(r.sourceName))
      .map((r) => `${r.animeId}:${r.sourceName}`)
  );
}

function retryStateByAnimeSource(sourceKeys) {
  return new Map(
    db.select().from(matchRetryState).all()
      .filter((r) => sourceKeys.includes(r.source))
      .map((r) => [`${r.animeId}:${r.source}`, r])
  );
}

function manualBlockingKeys(sourceKeys) {
  return new Set(
    db.select({ animeId: manualMatchState.animeId, source: manualMatchState.source, status: manualMatchState.status })
      .from(manualMatchState)
      .all()
      .filter((r) => sourceKeys.includes(r.source) && MANUAL_MATCH_BLOCKING_STATUSES.has(r.status))
      .map((r) => `${r.animeId}:${r.source}`)
  );
}

function clearStaleCalendarEntries(activeAnimeIds) {
  if (activeAnimeIds.size === 0) {
    warn("calendar", "skip stale calendar cleanup because active anime set is empty");
    return 0;
  }

  const result = db.update(anime)
    .set({ calendarWeekday: null, updatedAt: now() })
    .where(and(isNotNull(anime.calendarWeekday), notInArray(anime.id, [...activeAnimeIds])))
    .run();
  return result.changes ?? 0;
}

export async function searchAnime(keyword) {
  const q = `%${keyword}%`;
  const local = db.select()
    .from(anime)
    .where(or(
      like(anime.name, q),
      like(anime.nameCn, q),
      like(anime.aliases, q)
    ))
    .all();

  return {
    data: local.map((a) => ({
      id: a.id,
      title: a.nameCn || a.name,
      coverUrl: proxyCover(a.id, a.coverUrl, a.hasCover),
    })),
    freshness: "cache",
  };
}

export async function enrichFromBangumiSearch(keyword) {
  log("search", "bangumi search started", { keyword });
  let subjects;
  try {
    const bgResult = await bangumi.searchSubjects(keyword);
    subjects = bgResult?.data || [];
  } catch (err) {
    error("search", "bangumi search failed", err);
    return { upserted: 0, matched: 0, queuedEpisodes: 0, errors: 1 };
  }

  const stats = { upserted: 0, matched: 0, queuedEpisodes: 0, errors: 0 };
  log("search", "bangumi search returned", { keyword, total: subjects.length });
  for (const item of subjects) {
    try {
      const a = await upsertAnime(item);
      if (!a) continue;
      stats.upserted++;

      if (!a.detailFetchedAt) {
        try {
          await enrichFromSubject(item.id);
        } catch (err) {
          error("search", `subject enrich failed for ${item.id}`, err);
        }
      }

      for (const source of getEnabledSourceKeys()) {
        const mapping = await ensureMappingForAnime(item.id, { source });
        if (mapping.matched) {
          stats.matched++;
          if (enqueueEpisodeRefresh(item.id, { source })) {
            stats.queuedEpisodes++;
          }
        }
      }
    } catch (err) {
      error("search", `search item failed for ${item.id}`, err);
      stats.errors++;
    }
  }
  log("search", "bangumi search processing completed", { keyword, ...stats });
  return stats;
}

export async function getAnimeDetail(id) {
  let a = db.select().from(anime).where(eq(anime.id, id)).get();

  if (!a) {
    try {
      a = await enrichFromSubject(id, undefined, { timeoutMs: DETAIL_SHORT_TIMEOUT_MS });
    } catch (err) {
      error("detail", `initial subject fetch failed for ${id}`, err);
      return null;
    }
    if (!a) return null;
  } else if (!isFresh(a.detailFetchedAt, DETAIL_FRESH_MS)) {
    try {
      const enriched = await enrichFromSubject(id, a.calendarWeekday, { timeoutMs: DETAIL_SHORT_TIMEOUT_MS });
      if (enriched) a = enriched;
    } catch (err) {
      warn("detail", "short subject enrich failed, returning cached data", { id, message: err.message });
    }
  }

  const enabledSources = enabledSourceSet();
  const mappedRows = db.select()
    .from(bangumiCstationMap)
    .where(eq(bangumiCstationMap.animeId, id))
    .all()
    .filter((row) => enabledSources.has(row.source));
  const episodeRows = db.select({ sourceName: episodes.sourceName, sourceAid: episodes.sourceAid }).from(episodes).where(eq(episodes.animeId, id)).all();
  const retryRows = db.select().from(matchRetryState).where(eq(matchRetryState.animeId, id)).all();
  const manualRows = db.select().from(manualMatchState).where(eq(manualMatchState.animeId, id)).all();
  const sourceStatuses = getResourceSourceStatuses(mappedRows, episodeRows, retryRows, manualRows);
  const resourceStatus = aggregateResourceStatus(sourceStatuses);
  const matchingSources = sourceStatuses.filter((row) => row.status === "matching").map((row) => row.source);
  if (matchingSources.length > 0) {
    log("detail", "enqueue mapping from detail page", { id, sources: matchingSources });
    for (const source of matchingSources) {
      enqueueMapping(id, { source });
    }
  }

  for (const row of sourceStatuses) {
    if (row.status === "fetching") {
      log("detail", "enqueue episode refresh from detail page", { id, source: row.source, cstationId: row.cstationId });
      enqueueEpisodeRefresh(id, { source: row.source });
    }
  }

  return {
    ...formatAnimeDetail(a, isFresh(a.detailFetchedAt, DETAIL_FRESH_MS), mappedRows),
    resourceStatus,
    resourceSources: sourceStatuses,
  };
}

function getResourceSourceStatuses(mappedRows, episodeRows, retryRows, manualRows = []) {
  const mappedBySource = new Map(mappedRows.map((row) => [row.source, row]));
  const episodeSources = new Set(episodeRows.map((row) => `${row.sourceName}:${row.sourceAid}`));
  const retryBySource = new Map(retryRows.map((row) => [row.source, row]));
  const manualBySource = new Map(
    manualRows
      .filter((row) => MANUAL_MATCH_BLOCKING_STATUSES.has(row.status))
      .map((row) => [row.source, row])
  );
  const nowTs = now();

  return getEnabledSources().map((source) => {
    const mapped = mappedBySource.get(source.key);
    const retry = retryBySource.get(source.key);
    const manual = manualBySource.get(source.key);
    const retryCount = retry?.retryCount ?? 0;
    const retrying = retry?.retryAt && retry.retryAt > nowTs;
    let status = "matching";
    if (mapped && episodeSources.has(`${source.key}:${mapped.cstationId}`)) status = "ready";
    else if (!mapped && manual?.status === "wait_airing") status = "wait_airing";
    else if (!mapped && manual && MANUAL_NO_DATA_STATUSES.has(manual.status)) status = "no_data";
    else if (retryCount >= MAX_RETRIES) status = "no_data";
    else if (retrying) status = "retrying";
    else if (mapped) status = "fetching";

    const note = manual?.status === "wait_airing"
      ? manual.note
      : (manual && MANUAL_NO_DATA_STATUSES.has(manual.status)) || retryCount >= MAX_RETRIES
        ? "no mapping after retries"
        : null;

    return {
      source: source.key,
      name: source.name,
      status,
      cstationId: mapped?.cstationId ?? null,
      note,
    };
  });
}

function aggregateResourceStatus(sourceStatuses) {
  if (sourceStatuses.some((row) => row.status === "ready")) return "ready";
  if (sourceStatuses.some((row) => row.status === "fetching")) return "fetching";
  if (sourceStatuses.some((row) => row.status === "matching")) return "matching";
  if (sourceStatuses.some((row) => row.status === "retrying")) return "retrying";
  if (sourceStatuses.some((row) => row.status === "wait_airing")) return "wait_airing";
  if (sourceStatuses.some((row) => row.status === "no_data")) return "no_data";
  return "no_data";
}

function channelKey(ep) {
  return `${ep.sourceName}:${ep.sourceAid}`;
}

function collectEpisodeChannels(rows) {
  const chMap = {};
  for (const ep of rows) {
    const key = channelKey(ep);
    if (!chMap[key]) chMap[key] = { sourceName: ep.sourceName, sourceAid: ep.sourceAid, episodes: [] };
    chMap[key].episodes.push(ep);
  }
  return Object.values(chMap).sort((a, b) => {
    const sourceCmp = a.sourceName.localeCompare(b.sourceName);
    if (sourceCmp !== 0) return sourceCmp;
    return a.sourceAid - b.sourceAid;
  });
}

function formatAnimeDetail(a, fresh, mappedRows = null) {
  const mappedKeys = mappedRows
    ? new Set(mappedRows.map((row) => `${row.source}:${row.cstationId}`))
    : null;
  const eps = db.select().from(episodes).where(eq(episodes.animeId, a.id)).all()
    .filter((ep) => !mappedKeys || mappedKeys.has(`${ep.sourceName}:${ep.sourceAid}`));

  const channels = collectEpisodeChannels(eps).map((channel, chIdx) => ({
    name: channel.sourceName,
    sourceAid: channel.sourceAid,
    episodes: channel.episodes
      .sort((aEp, bEp) => aEp.epIndex - bEp.epIndex)
      .map((ep) => ({
        index: ep.epIndex,
        name: ep.epName,
        url: `/anime/api/play?id=${a.id}&ch=${chIdx + 1}&ep=${ep.epIndex}`,
      })),
  }));

  return {
    data: {
      id: a.id,
      title: a.nameCn || a.name,
      summary: displaySummary(a.summary),
      coverUrl: proxyCover(a.id, a.coverUrl, a.hasCover),
      eps: a.eps,
      totalEpisodes: a.totalEpisodes,
      airDate: a.airDate,
      platform: a.platform,
      ratingScore: a.ratingScore,
      rank: a.rank,
      tags: safeJson(a.tags, null),
      channels,
    },
    freshness: fresh ? "cache" : "stale",
  };
}

export async function getPlayUrl(id, ch, ep) {
  const enabledSources = enabledSourceSet();
  const mappedRows = db.select()
    .from(bangumiCstationMap)
    .where(eq(bangumiCstationMap.animeId, id))
    .all()
    .filter((row) => enabledSources.has(row.source));
  if (mappedRows.length === 0) return null;
  const mappedKeys = new Set(mappedRows.map((row) => `${row.source}:${row.cstationId}`));
  const eps = db.select().from(episodes).where(eq(episodes.animeId, id)).all()
    .filter((row) => mappedKeys.has(`${row.sourceName}:${row.sourceAid}`));
  const channels = collectEpisodeChannels(eps);
  const chIdx = ch - 1;
  if (chIdx < 0 || chIdx >= channels.length) return null;

  const epList = channels[chIdx].episodes.filter((e) => e.epIndex === ep);
  if (epList.length === 0) return null;

  return { videoURL: epList[0].videoUrl, directPlay: false };
}

export async function getCalendarView() {
  const all = db.select().from(anime).all();
  if (all.length === 0) {
    return { data: [], freshness: "empty", error: "暂无数据，请等待首次同步完成" };
  }

  const epStats = db.all(sql`
    SELECT anime_id, ep_index, updated_at FROM episodes e1
    WHERE updated_at = (SELECT MAX(updated_at) FROM episodes e2 WHERE e2.anime_id = e1.anime_id)
  `);
  const epMap = {};
  for (const s of epStats) {
    epMap[s.anime_id] = { latestEp: s.ep_index, lastUpdated: s.updated_at };
  }

  return { data: groupByWeekday(all, epMap), freshness: "cache" };
}

export async function getUpdates({ days = 7, limit = 60, today: todayOption = null } = {}) {
  const windowMs = Math.max(1, days) * DAY_MS;
  const nowMs = parseUpdateNow(todayOption) ?? Date.now();
  const cutoffMs = nowMs - windowMs;
  const enabledSources = getEnabledSourceKeys();
  const enabledSourcesSet = new Set(enabledSources);
  const sourceOrder = new Map(enabledSources.map((source, index) => [source, index]));
  const rows = db.all(sql`
    SELECT
      a.id,
      a.name,
      a.name_cn AS nameCn,
      a.summary,
      a.cover_url AS coverUrl,
      a.has_cover AS hasCover,
      m.source,
      m.cstation_id AS sourceAid,
      m.source_ep_start AS sourceEpStart,
      m.source_ep_end AS sourceEpEnd,
      m.display_ep_offset AS displayEpOffset,
      c.last AS sourceUpdatedAt,
      MAX(e.ep_index) AS latestEp,
      MAX(e.updated_at) AS episodeUpdatedAt
    FROM bangumi_cstation_map m
    JOIN anime a ON a.id = m.anime_id
    JOIN cstation_catalog c ON c.source = m.source AND c.id = m.cstation_id
    LEFT JOIN episodes e
      ON e.anime_id = m.anime_id
      AND e.source_name = m.source
      AND e.source_aid = m.cstation_id
    GROUP BY m.anime_id, m.source, m.cstation_id
  `);

  const latestByAnime = new Map();
  for (const row of rows) {
    if (!enabledSourcesSet.has(row.source)) continue;
    const sourceUpdatedMs = parseTimestamp(row.sourceUpdatedAt);
    if (sourceUpdatedMs == null || sourceUpdatedMs < cutoffMs || sourceUpdatedMs > nowMs) continue;

    const isClosedRange = row.sourceEpEnd != null;
    if (isClosedRange) continue;
    const hasEpisodeChange = row.latestEp != null;

    const sourceUpdate = {
      source: row.source,
      sourceAid: row.sourceAid,
      updatedAt: normalizeTimestamp(row.sourceUpdatedAt),
      latestEp: row.latestEp ?? null,
      sourceEpStart: row.sourceEpStart ?? null,
      sourceEpEnd: row.sourceEpEnd ?? null,
      displayEpOffset: row.displayEpOffset ?? 0,
      hasEpisodeChange,
    };
    const existing = latestByAnime.get(row.id);
    const existingMs = parseTimestamp(existing?.updatedAt);
    const sourceRank = sourceOrder.get(row.source) ?? Number.MAX_SAFE_INTEGER;
    const existingRank = sourceOrder.get(existing?.source) ?? Number.MAX_SAFE_INTEGER;

    const shouldReplace =
      !existing ||
      sourceUpdatedMs > existingMs ||
      (sourceUpdatedMs === existingMs && sourceRank < existingRank);

    if (shouldReplace) {
      const sourceUpdates = existing?.sourceUpdates ? [...existing.sourceUpdates, sourceUpdate] : [sourceUpdate];
      latestByAnime.set(row.id, {
        id: row.id,
        title: row.nameCn || row.name,
        coverUrl: proxyCover(row.id, row.coverUrl, row.hasCover),
        summary: displaySummary(row.summary),
        latestEp: row.latestEp ?? null,
        updatedAt: sourceUpdate.updatedAt,
        source: row.source,
        sourceAid: row.sourceAid,
        sourceUpdates,
      });
    } else {
      existing.sourceUpdates.push(sourceUpdate);
    }
  }

  const data = [...latestByAnime.values()]
    .map((row) => {
      const sourceUpdates = row.sourceUpdates.sort((a, b) => {
        const timeCmp = (parseTimestamp(b.updatedAt) ?? 0) - (parseTimestamp(a.updatedAt) ?? 0);
        if (timeCmp !== 0) return timeCmp;
        return (sourceOrder.get(a.source) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(b.source) ?? Number.MAX_SAFE_INTEGER);
      });
      const primary = sourceUpdates[0];
      return {
        ...row,
        sourceUpdates,
        latestEp: primary?.latestEp ?? null,
        latestEpisode: primary?.hasEpisodeChange && primary?.latestEp
          ? `更新至第${String(primary.latestEp).padStart(2, "0")}集`
          : "资源有更新",
        updatedAt: primary?.updatedAt ?? row.updatedAt,
        source: primary?.source ?? row.source,
        sourceAid: primary?.sourceAid ?? row.sourceAid,
      };
    })
    .sort((a, b) => {
      const timeCmp = (parseTimestamp(b.updatedAt) ?? 0) - (parseTimestamp(a.updatedAt) ?? 0);
      if (timeCmp !== 0) return timeCmp;
      return a.id - b.id;
    })
    .slice(0, Math.max(1, limit));

  return { data, freshness: data.length > 0 ? "cache" : "empty" };
}

function groupByWeekday(list, epMap) {
  const weekdayNames = [
    { en: "Mon", cn: "星期一", ja: "月曜日", id: 1 },
    { en: "Tue", cn: "星期二", ja: "火曜日", id: 2 },
    { en: "Wed", cn: "星期三", ja: "水曜日", id: 3 },
    { en: "Thu", cn: "星期四", ja: "木曜日", id: 4 },
    { en: "Fri", cn: "星期五", ja: "金曜日", id: 5 },
    { en: "Sat", cn: "星期六", ja: "土曜日", id: 6 },
    { en: "Sun", cn: "星期日", ja: "日曜日", id: 7 },
  ];

  return weekdayNames.map((wd) => {
    const items = list
      .filter((a) => a.calendarWeekday === wd.id)
      .map((a) => {
        const ep = epMap[a.id];
        return {
          id: a.id,
          title: a.nameCn || a.name,
          coverUrl: proxyCover(a.id, a.coverUrl, a.hasCover),
          ratingScore: a.ratingScore,
          eps: a.eps,
          totalEpisodes: a.totalEpisodes,
          latestEp: ep?.latestEp ?? null,
          lastUpdated: ep?.lastUpdated ?? null,
          airDate: a.airDate,
        };
      });
    return { weekday: wd, items };
  });
}

export function registerAnimeJobs() {
  registerJob("ensure-mapping", async ({ animeId, source = null, refresh = false }) => {
    const sources = source ? [source] : getEnabledSourceKeys();
    for (const source of sources) {
      const mapping = await ensureMappingForAnime(animeId, { source, refresh });
      if (mapping.matched) enqueueEpisodeRefresh(animeId, { source });
    }
  });

  registerJob("refresh-episodes", async ({ animeId, source }) => {
    await refreshEpisodesForAnime(animeId, { source });
  });
}

function enqueueMapping(animeId, options = {}) {
  const payload = { animeId, refresh: !!options.refresh };
  if (options.source) payload.source = options.source;
  const key = options.source ? `ensure-mapping:${options.source}:${animeId}` : `ensure-mapping:${animeId}`;
  enqueueJob("ensure-mapping", payload, { key });
}

function enqueueEpisodeRefresh(animeId, { source } = {}) {
  if (!source) throw new Error("enqueueEpisodeRefresh requires source");
  return enqueueJob("refresh-episodes", { animeId, source }, { key: `refresh-episodes:${source}:${animeId}` });
}
