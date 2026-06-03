import { sqlite } from "../db/index.js";
import * as bangumi from "./bangumi.js";
import * as cstation from "./cstation.js";
import { hydrateCatalogDetails, saveCatalog } from "./catalog.js";
import { enqueueJob, registerJob } from "./queue.js";
import { getEnabledSources } from "../lib/cstationConfig.js";
import { matchOne, rankMatches } from "../lib/matcher.js";
import { normalizeResourceEpisodes, normalizeResourceItem } from "../normalizers/resourceItemNormalizer.js";
import {
  deleteManualResourceStateByStatus,
  deleteRetryState,
  deleteStaleResourceEpisodes,
  listManualResourceStatesForSubject,
  listResourceMappingsWithEpisodePresenceForSubject,
  listRetryStateForSubject,
  upsertManualResourceState,
  upsertResourceEpisode,
  upsertResourceMapping,
  upsertRetryState,
} from "../repositories/resourceRepository.js";
import {
  AUTO_MATCH_SCORE,
  DEFAULT_EPISODE_FETCH_RETRY_BATCH_LIMIT,
  DEFAULT_MAPPING_RETRY_BATCH_LIMIT,
  MANUAL_MATCH_BLOCKING_STATUSES,
  MANUAL_NO_DATA_STATUSES,
  MAX_RETRIES,
  RETRY_DELAYS,
  applyBatchLimit,
  fromNow,
  now,
  retryStateRowToFacade,
} from "./animeShared.js";
import {
  ensureSubjectFromAnime,
  findAnimeFacadeById,
  listAnimeFacades,
  titleNamesForAnime,
  upsertAnime,
  enrichFromSubject,
} from "./subjectSyncService.js";
import { debug, log, warn, error } from "../lib/logger.js";

function scheduleRetry(animeId, source, count) {
  if (!source) throw new Error("scheduleRetry requires source");
  if (count > MAX_RETRIES) return;
  const idx = Math.min(count - 1, RETRY_DELAYS.length - 1);
  const retryAt = fromNow(RETRY_DELAYS[idx]);
  upsertRetryState({ bangumiId: animeId, source, kind: "mapping", retryCount: count, retryAt });
}

function blockMappingRetry(animeId, source) {
  upsertRetryState({ bangumiId: animeId, source, kind: "mapping", retryCount: MAX_RETRIES, retryAt: null });
}

function scheduleEpisodeFetchRetry(animeId, source, count) {
  if (!source) throw new Error("scheduleEpisodeFetchRetry requires source");
  const idx = Math.min(Math.max(count, 1) - 1, RETRY_DELAYS.length - 1);
  const retryAt = fromNow(RETRY_DELAYS[idx]);
  upsertRetryState({ bangumiId: animeId, source, kind: "episode_fetch", retryCount: count, retryAt });
}

function clearRetry(animeId, source) {
  upsertRetryState({ bangumiId: animeId, source, kind: "mapping", retryCount: 0, retryAt: null });
}

function clearEpisodeFetchRetry(animeId, source) {
  deleteRetryState({ bangumiId: animeId, source, kind: "episode_fetch" });
}

function getRetryState(animeId, source) {
  const normalized = sqlite.prepare(`
    SELECT bangumi_id, source, retry_count, retry_at, updated_at
    FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(animeId, source);
  return normalized ? retryStateRowToFacade(normalized) : undefined;
}

function getEpisodeFetchRetryState(animeId, source) {
  const normalized = sqlite.prepare(`
    SELECT bangumi_id, source, retry_count, retry_at, updated_at
    FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'episode_fetch'
  `).get(animeId, source);
  return normalized ? retryStateRowToFacade(normalized) : undefined;
}

function getManualBlockingState(animeId, source) {
  const normalized = sqlite.prepare(`
    SELECT bangumi_id, source, status, note, updated_at
    FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(animeId, source);
  if (!normalized) return undefined;
  return MANUAL_MATCH_BLOCKING_STATUSES.has(normalized.status) ? {
    animeId: normalized.bangumi_id,
    source: normalized.source,
    status: normalized.status,
    note: normalized.note,
    updatedAt: normalized.updated_at,
  } : undefined;
}

function setManualMatchState(animeId, source, status, note = null) {
  upsertManualResourceState({ bangumiId: animeId, source, status, note });
}

function clearManualStateByStatus(animeId, source, status) {
  deleteManualResourceStateByStatus({ bangumiId: animeId, source, status });
}

function markSourceAlreadyMapped(animeId, source, ownerAnimeId, sourceAid) {
  setManualMatchState(animeId, source, "source_already_mapped", `source_aid ${sourceAid} is already mapped by Bangumi ID ${ownerAnimeId}`);
}

function clearSourceAlreadyMapped(animeId, source) {
  clearManualStateByStatus(animeId, source, "source_already_mapped");
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

async function upsertEpisodes(animeId, source, sourceAid, episodesList) {
  if (!ensureSubjectFromAnime(animeId)) throw new Error(`subject ${animeId} does not exist`);
  for (const episode of normalizeResourceEpisodes(episodesList, { bangumiId: animeId, source, sourceAid })) {
    upsertResourceEpisode(episode);
  }
}

function pruneEpisodesForRefresh(animeId, source, sourceAid, episodesList) {
  deleteStaleResourceEpisodes({
    bangumiId: animeId,
    source,
    sourceAid,
    validEpIndexes: episodesList.map((ep) => ep.epIndex),
  });
}

async function upsertMap(animeId, source, sourceAid, score, matchedBgName, matchedResourceName, range = {}) {
  upsertResourceMapping({
    bangumiId: animeId,
    source,
    sourceAid,
    sourceEpStart: range.sourceEpStart ?? null,
    sourceEpEnd: range.sourceEpEnd ?? null,
    displayEpOffset: range.displayEpOffset ?? 0,
    score,
    matchedBgName,
    matchedResourceName,
  });
}

export function getMap(animeId, source) {
  const normalized = sqlite.prepare(`
    SELECT
      bangumi_id,
      source,
      source_aid,
      source_ep_start,
      source_ep_end,
      display_ep_offset,
      score,
      matched_bg_name,
      matched_resource_name,
      matched_at
    FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(animeId, source);
  if (!normalized) return undefined;
  return {
    animeId: normalized.bangumi_id,
    source: normalized.source,
    cstationId: normalized.source_aid,
    sourceEpStart: normalized.source_ep_start,
    sourceEpEnd: normalized.source_ep_end,
    displayEpOffset: normalized.display_ep_offset,
    score: normalized.score,
    matchedBgName: normalized.matched_bg_name,
    matchedCsName: normalized.matched_resource_name,
    matchedAt: normalized.matched_at,
  };
}

function getAutoExclusiveSourceOwner(source, sourceAid, animeId) {
  const normalizedOwner = sqlite.prepare(`
    SELECT bangumi_id, source, source_aid
    FROM resource_mappings
    WHERE source = ? AND source_aid = ? AND bangumi_id <> ?
  `).get(source, sourceAid, animeId);
  if (!normalizedOwner) return undefined;
  return {
    animeId: normalizedOwner.bangumi_id,
    source: normalizedOwner.source,
    cstationId: normalizedOwner.source_aid,
  };
}

function getCandidatesForAnime(a, source) {
  const year = bangumi.extractYear(a.airDate);
  const candidatesById = new Map();
  const normalizedRows = sqlite.prepare(`
    SELECT source, source_aid, title, subtitle, category, year, latest_text, detail_fetched_at
    FROM resource_items
    WHERE source = ?
  `).all(source);
  for (const row of normalizedRows) {
    const existing = candidatesById.get(row.source_aid);
    candidatesById.set(row.source_aid, {
      ...existing,
      source: row.source,
      id: row.source_aid,
      category: row.category ?? existing?.category ?? null,
      name: row.title ?? existing?.name,
      subname: row.subtitle ?? existing?.subname ?? null,
      year: row.year ?? existing?.year ?? null,
      last: row.latest_text ?? existing?.last ?? null,
      detailFetchedAt: row.detail_fetched_at ?? existing?.detailFetchedAt ?? null,
    });
  }

  return [...candidatesById.values()]
    .filter((c) => {
      if (!year || !c.year) return true;
      const cy = parseInt(c.year, 10);
      return !Number.isNaN(cy) && Math.abs(year - cy) <= 1;
    });
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
    const detailed = getCandidatesForAnime(a, source)
      .filter((c) => needDetailIds.includes(c.id));
    const detailedBest = matchOne(names, year, detailed);
    if (detailedBest && (!best || detailedBest.score > best.score)) best = detailedBest;
  }

  return best;
}

export async function ensureMappingForAnime(animeId, { source, refresh = false } = {}) {
  if (!source) throw new Error("ensureMappingForAnime requires source");
  const a = findAnimeFacadeById(animeId);
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
  await upsertMap(animeId, source, mapped.cstationId, mapped.score, mapped.matchedBgName, mapped.matchedCsName, {
    sourceEpStart: mapped.sourceEpStart,
    sourceEpEnd: mapped.sourceEpEnd,
    displayEpOffset: mapped.displayEpOffset,
  });

  const detail = await cstation.fetchById(mapped.cstationId, { source });
  if (!detail) {
    const retry = getEpisodeFetchRetryState(animeId, source);
    scheduleEpisodeFetchRetry(animeId, source, (retry?.retryCount ?? 0) + 1);
    warn("episodes", "fetch detail failed", { animeId, source, cstationId: mapped.cstationId });
    return { animeId, refreshed: false, reason: "fetch-detail-failed" };
  }

  await saveCatalog([normalizeResourceItem(detail, { source, detailFetchedAt: now() })], { source });

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

export function getEnabledSourceKeys(sourceKeys = null) {
  if (sourceKeys) return sourceKeys;
  return getEnabledSources().map((source) => source.key);
}

export function enabledSourceSet(sourceKeys = null) {
  return new Set(getEnabledSourceKeys(sourceKeys));
}

function retryRowsForKind(kind) {
  const normalizedRows = sqlite.prepare(`
    SELECT bangumi_id, source, retry_count, retry_at, updated_at
    FROM retry_state
    WHERE kind = ?
  `).all(kind);
  return normalizedRows.map(retryStateRowToFacade);
}

function mappedAnimeSourceKeys(sourceKeys) {
  const keys = new Set();
  for (const row of sqlite.prepare(`
    SELECT bangumi_id, source
    FROM resource_mappings
  `).all()) {
    if (sourceKeys.includes(row.source)) keys.add(`${row.bangumi_id}:${row.source}`);
  }
  return keys;
}

function episodeAnimeSourceKeys(sourceKeys) {
  const keys = new Set();
  for (const row of sqlite.prepare(`
    SELECT bangumi_id, source
    FROM episodes
    WHERE bangumi_id IS NOT NULL AND source IS NOT NULL
  `).all()) {
    if (sourceKeys.includes(row.source)) keys.add(`${row.bangumi_id}:${row.source}`);
  }
  return keys;
}

function retryStateByAnimeSource(sourceKeys) {
  return new Map(
    retryRowsForKind("mapping")
      .filter((r) => sourceKeys.includes(r.source))
      .map((r) => [`${r.animeId}:${r.source}`, r])
  );
}

export function manualBlockingKeys(sourceKeys) {
  const stateByKey = new Map();
  for (const row of sqlite.prepare(`
    SELECT bangumi_id, source, status
    FROM manual_resource_state
  `).all()) {
    if (sourceKeys.includes(row.source)) {
      stateByKey.set(`${row.bangumi_id}:${row.source}`, row.status);
    }
  }
  return new Set(
    [...stateByKey.entries()]
      .filter(([, status]) => MANUAL_MATCH_BLOCKING_STATUSES.has(status))
      .map(([key]) => key)
  );
}

export async function retryPending({
  mappingLimit = DEFAULT_MAPPING_RETRY_BATCH_LIMIT,
  episodeFetchLimit = DEFAULT_EPISODE_FETCH_RETRY_BATCH_LIMIT,
  refreshEpisodes = true,
  sourceKeys: explicitSourceKeys = null,
} = {}) {
  const list = listAnimeFacades();
  const sourceKeys = getEnabledSourceKeys(explicitSourceKeys);
  const mapped = mappedAnimeSourceKeys(sourceKeys);
  const episodeSourceKeys = episodeAnimeSourceKeys(sourceKeys);
  const retryRows = retryRowsForKind("mapping");
  const episodeRetryRows = retryRowsForKind("episode_fetch");
  const blockedKeys = manualBlockingKeys(sourceKeys);
  const animeById = new Map(list.map((a) => [a.id, a]));
  const pending = retryRows.filter((row) => {
    if (!sourceKeys.includes(row.source)) return false;
    if (blockedKeys.has(`${row.animeId}:${row.source}`)) return false;
    if (episodeSourceKeys.has(`${row.animeId}:${row.source}`)) return false;
    if (!animeById.has(row.animeId)) return false;
    if (!row.retryAt) return false;
    if (row.retryCount >= MAX_RETRIES) return false;
    return row.retryAt <= now();
  });
  const pendingEpisodeFetches = episodeRetryRows.filter((row) => {
    if (!sourceKeys.includes(row.source)) return false;
    if (blockedKeys.has(`${row.animeId}:${row.source}`)) return false;
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
  const blockedKeys = manualBlockingKeys(sourceKeys);

  const animeIdSet = animeIds ? new Set(animeIds.map((id) => parseInt(id, 10)).filter(Boolean)) : null;
  const unmatched = listAnimeFacades({ ids: animeIdSet }).filter((a) => {
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
        if (blockedKeys.has(`${a.id}:${source}`)) continue;
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
    const animeIds = new Set();
    const normalizedRows = sqlite.prepare(`
      SELECT bangumi_id
      FROM resource_mappings
      WHERE source = ? AND source_aid = ?
    `).all(source, sourceId);
    for (const row of normalizedRows) {
      animeIds.add(row.bangumi_id);
    }
    for (const animeId of animeIds) {
      if (enqueueEpisodeRefresh(animeId, { source })) queued++;
    }
  }

  return queued;
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

export function enqueueMapping(animeId, options = {}) {
  const payload = { animeId, refresh: !!options.refresh };
  if (options.source) payload.source = options.source;
  const key = options.source ? `ensure-mapping:${options.source}:${animeId}` : `ensure-mapping:${animeId}`;
  enqueueJob("ensure-mapping", payload, { key });
}

export function enqueueEpisodeRefresh(animeId, { source } = {}) {
  if (!source) throw new Error("enqueueEpisodeRefresh requires source");
  return enqueueJob("refresh-episodes", { animeId, source }, { key: `refresh-episodes:${source}:${animeId}` });
}

export function resourceSourceStatuses(id) {
  const mappings = listResourceMappingsWithEpisodePresenceForSubject(id);
  const retries = listRetryStateForSubject(id, "mapping");
  const manualRows = listManualResourceStatesForSubject(id);

  const mappedBySource = new Map(mappings.map((row) => [row.source, row]));
  const retryBySource = new Map(retries.map((row) => [row.source, row]));
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
    const retryCount = retry?.retry_count ?? 0;
    const retrying = retry?.retry_at && retry.retry_at > nowTs;
    let status = "matching";
    if (mapped?.has_episodes) status = "ready";
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
      sourceAid: mapped?.source_aid ?? null,
      note,
    };
  });
}
