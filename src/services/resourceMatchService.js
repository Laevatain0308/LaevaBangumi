import * as bangumi from "../clients/bangumiClient.js";
import { hydrateCatalogDetails } from "./catalog.js";
import { enqueueJob, registerJob } from "./queue.js";
import { matchOne, rankMatches } from "../lib/matcher.js";
import {
  deleteManualResourceStateByStatus,
  findManualResourceState,
  findResourceMapping,
  findResourceMappingOwner,
  findRetryState,
  listMappingSubjectIdsBySourceAid,
  listResourceItemsForSource,
  upsertManualResourceState,
  upsertResourceMapping,
  upsertRetryState,
} from "../repositories/resourceRepository.js";
import {
  AUTO_MATCH_SCORE,
  MANUAL_MATCH_BLOCKING_STATUSES,
  MAX_RETRIES,
  RETRY_DELAYS,
  fromNow,
  now,
  retryStateRowToFacade,
} from "./animeShared.js";
import {
  getEnabledSourceKeys,
  manualBlockingKeys,
  mappedAnimeSourceKeys,
  retryStateByAnimeSource,
} from "./resourceStateService.js";
import { refreshEpisodesForAnime } from "./episodeRefreshService.js";
import {
  findAnimeFacadeById,
  listAnimeFacades,
  titleNamesForAnime,
  upsertAnime,
} from "./subjectSyncService.js";
import { enqueueMetadataRefresh } from "./metadataRefreshService.js";
import { error, log, warn } from "../lib/logger.js";

export { refreshEpisodesForAnime } from "./episodeRefreshService.js";
export { retryPending } from "./retryService.js";
export {
  enabledSourceSet,
  getEnabledSourceKeys,
  manualBlockingKeys,
  mappedAnimeSourceKeys,
  resourceSourceStatuses,
  retryStateByAnimeSource,
} from "./resourceStateService.js";

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

function clearRetry(animeId, source) {
  upsertRetryState({ bangumiId: animeId, source, kind: "mapping", retryCount: 0, retryAt: null });
}

export function getRetryState(animeId, source) {
  const normalized = findRetryState({ bangumiId: animeId, source, kind: "mapping" });
  return normalized ? retryStateRowToFacade(normalized) : undefined;
}

export function getEpisodeFetchRetryState(animeId, source) {
  const normalized = findRetryState({ bangumiId: animeId, source, kind: "episode_fetch" });
  return normalized ? retryStateRowToFacade(normalized) : undefined;
}

function getManualBlockingState(animeId, source) {
  const normalized = findManualResourceState({ bangumiId: animeId, source });
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

export async function upsertMap(animeId, source, sourceAid, score, matchedSubjectTitle, matchedResourceTitle, range = {}) {
  upsertResourceMapping({
    bangumiId: animeId,
    source,
    sourceAid,
    sourceEpStart: range.sourceEpStart ?? null,
    sourceEpEnd: range.sourceEpEnd ?? null,
    displayEpOffset: range.displayEpOffset ?? 0,
    score,
    matchedSubjectTitle,
    matchedResourceTitle,
  });
}

export function getMap(animeId, source) {
  const normalized = findResourceMapping({ bangumiId: animeId, source });
  if (!normalized) return undefined;
  return {
    animeId: normalized.bangumi_id,
    source: normalized.source,
    sourceAid: normalized.source_aid,
    sourceEpStart: normalized.source_ep_start,
    sourceEpEnd: normalized.source_ep_end,
    displayEpOffset: normalized.display_ep_offset,
    score: normalized.score,
    matchedSubjectTitle: normalized.matched_subject_title,
    matchedResourceTitle: normalized.matched_resource_title,
    matchedAt: normalized.matched_at,
  };
}

function getAutoExclusiveSourceOwner(source, sourceAid, animeId) {
  const normalizedOwner = findResourceMappingOwner({ source, sourceAid, exceptBangumiId: animeId });
  if (!normalizedOwner) return undefined;
  return {
    animeId: normalizedOwner.bangumi_id,
    source: normalizedOwner.source,
    sourceAid: normalizedOwner.source_aid,
  };
}

function getCandidatesForAnime(a, source) {
  const year = bangumi.extractYear(a.airDate);
  const candidatesById = new Map();
  const normalizedRows = listResourceItemsForSource(source);
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
    log("match", "mapping exists", { animeId, source, sourceAid: existing.sourceAid });
    return { animeId, matched: true, sourceAid: existing.sourceAid, reason: "already-mapped" };
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
        sourceAid: top.video.id,
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
      sourceAid: best.video.id,
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
    sourceAid: best.video.id,
    score: Number(best.score.toFixed(3)),
    bgTitle: best.matchedName,
    sourceTitle: best.matchedSourceName || best.video.name,
  });
  return { animeId, matched: true, sourceAid: best.video.id, score: best.score, matchedName: best.matchedName };
}

export async function matchAndPersist(item, weekday) {
  const a = await upsertAnime(item, weekday);
  if (!a) return { animeId: item.id, matched: false, reason: "non-anime" };

  const queuedMetadata = !a.detailFetchedAt && enqueueMetadataRefresh(item.id, { weekday });

  let lastMapping = null;
  for (const source of getEnabledSourceKeys()) {
    const mapping = await ensureMappingForAnime(item.id, { source });
    lastMapping = mapping;
    if (mapping.matched) await refreshEpisodesForAnime(item.id, { source });
  }
  return {
    ...(lastMapping || { animeId: item.id, matched: false, reason: "no-source" }),
    queuedMetadata,
  };
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
    for (const animeId of listMappingSubjectIdsBySourceAid({ source, sourceAid: sourceId })) {
      animeIds.add(animeId);
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
