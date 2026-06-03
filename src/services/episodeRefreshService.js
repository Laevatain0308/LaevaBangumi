import * as resourceClient from "../clients/resourceClient.js";
import { normalizeResourceEpisodes, normalizeResourceItem } from "../normalizers/resourceItemNormalizer.js";
import {
  deleteRetryState,
  upsertRetryState,
} from "../repositories/resourceRepository.js";
import {
  deleteStaleResourceEpisodes,
  upsertResourceEpisode,
} from "../repositories/episodeRepository.js";
import { fromNow, MAX_RETRIES, now, RETRY_DELAYS } from "./animeShared.js";
import {
  ensureMappingForAnime,
  getEpisodeFetchRetryState,
  getMap,
  upsertMap,
} from "./resourceMatchService.js";
import { ensureSubjectFromAnime } from "./subjectSyncService.js";
import { saveCatalog } from "./catalog.js";
import { log, warn } from "../lib/logger.js";

function scheduleEpisodeFetchRetry(animeId, source, count) {
  if (!source) throw new Error("scheduleEpisodeFetchRetry requires source");
  const retryCount = Math.min(Math.max(count, 1), MAX_RETRIES);
  const idx = Math.min(retryCount - 1, RETRY_DELAYS.length - 1);
  const retryAt = fromNow(RETRY_DELAYS[idx]);
  upsertRetryState({ bangumiId: animeId, source, kind: "episode_fetch", retryCount, retryAt });
}

function clearMappingRetry(animeId, source) {
  upsertRetryState({ bangumiId: animeId, source, kind: "mapping", retryCount: 0, retryAt: null });
}

function clearEpisodeFetchRetry(animeId, source) {
  deleteRetryState({ bangumiId: animeId, source, kind: "episode_fetch" });
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

export async function refreshEpisodesForAnime(animeId, { source } = {}) {
  if (!source) throw new Error("refreshEpisodesForAnime requires source");
  log("episodes", "refresh started", { animeId, source });
  let mapped = getMap(animeId, source);
  if (!mapped) {
    const mapping = await ensureMappingForAnime(animeId, { source });
    if (!mapping.matched) return { animeId, refreshed: false, reason: mapping.reason };
    mapped = getMap(animeId, source);
  }
  await upsertMap(animeId, source, mapped.sourceAid, mapped.score, mapped.matchedBgName, mapped.matchedResourceName, {
    sourceEpStart: mapped.sourceEpStart,
    sourceEpEnd: mapped.sourceEpEnd,
    displayEpOffset: mapped.displayEpOffset,
  });

  const detail = await resourceClient.fetchById(mapped.sourceAid, { source });
  if (!detail) {
    const retry = getEpisodeFetchRetryState(animeId, source);
    scheduleEpisodeFetchRetry(animeId, source, (retry?.retryCount ?? 0) + 1);
    warn("episodes", "fetch detail failed", { animeId, source, sourceAid: mapped.sourceAid });
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
  clearMappingRetry(animeId, source);
  clearEpisodeFetchRetry(animeId, source);
  log("episodes", "refresh completed", { animeId, source, sourceAid: detail.id, epCount: rangedEpisodes.length, sourceEpCount: detail.epCount });
  return { animeId, refreshed: true, sourceAid: detail.id, epCount: rangedEpisodes.length, sourceEpCount: detail.epCount };
}
