import { listRetryStatesByKind } from "../repositories/resourceRepository.js";
import {
  applyBatchLimit,
  DEFAULT_EPISODE_FETCH_RETRY_BATCH_LIMIT,
  DEFAULT_MAPPING_RETRY_BATCH_LIMIT,
  MAX_RETRIES,
  now,
  retryStateRowToFacade,
} from "./animeShared.js";
import { refreshEpisodesForAnime } from "./episodeRefreshService.js";
import { refreshSubjectMetadata as defaultRefreshSubjectMetadata } from "./metadataRefreshService.js";
import { ensureMappingForAnime } from "./resourceMatchService.js";
import {
  episodeAnimeSourceKeys,
  getEnabledSourceKeys,
  manualBlockingKeys,
  mappedAnimeSourceKeys,
} from "./resourceStateService.js";
import { listAnimeFacades } from "./subjectSyncService.js";
import { error, log } from "../lib/logger.js";

function retryRowsForKind(kind, sourceKeys) {
  return listRetryStatesByKind(kind, { sourceKeys }).map(retryStateRowToFacade);
}

export async function retryPending({
  mappingLimit = DEFAULT_MAPPING_RETRY_BATCH_LIMIT,
  episodeFetchLimit = DEFAULT_EPISODE_FETCH_RETRY_BATCH_LIMIT,
  metadataFetchLimit = DEFAULT_MAPPING_RETRY_BATCH_LIMIT,
  refreshEpisodes = true,
  refreshSubjectMetadata = defaultRefreshSubjectMetadata,
  sourceKeys: explicitSourceKeys = null,
} = {}) {
  const list = listAnimeFacades();
  const sourceKeys = getEnabledSourceKeys(explicitSourceKeys);
  const mapped = mappedAnimeSourceKeys(sourceKeys);
  const episodeSourceKeys = episodeAnimeSourceKeys(sourceKeys);
  const retryRows = retryRowsForKind("mapping", sourceKeys);
  const episodeRetryRows = retryRowsForKind("episode_fetch", sourceKeys);
  const metadataRetryRows = retryRowsForKind("metadata_fetch", explicitSourceKeys ? sourceKeys : null);
  const blockedKeys = manualBlockingKeys(sourceKeys);
  const animeById = new Map(list.map((a) => [a.id, a]));
  const pending = retryRows.filter((row) => {
    if (blockedKeys.has(`${row.animeId}:${row.source}`)) return false;
    if (episodeSourceKeys.has(`${row.animeId}:${row.source}`)) return false;
    if (!animeById.has(row.animeId)) return false;
    if (!row.retryAt) return false;
    if (row.retryCount >= MAX_RETRIES) return false;
    return row.retryAt <= now();
  });
  const pendingEpisodeFetches = episodeRetryRows.filter((row) => {
    if (blockedKeys.has(`${row.animeId}:${row.source}`)) return false;
    if (!animeById.has(row.animeId)) return false;
    if (!mapped.has(`${row.animeId}:${row.source}`)) return false;
    if (!row.retryAt) return false;
    return row.retryAt <= now();
  });
  const pendingMetadataFetches = metadataRetryRows.filter((row) => {
    if (!animeById.has(row.animeId)) return false;
    if (!row.retryAt) return false;
    if (row.retryCount >= MAX_RETRIES) return false;
    return row.retryAt <= now();
  });

  const mappingBatch = applyBatchLimit(pending, mappingLimit);
  const episodeFetchBatch = applyBatchLimit(pendingEpisodeFetches, episodeFetchLimit);
  const metadataFetchBatch = applyBatchLimit(pendingMetadataFetches, metadataFetchLimit);
  const mappingPending = mappingBatch.rows;
  const episodeFetchPending = episodeFetchBatch.rows;
  const metadataFetchPending = metadataFetchBatch.rows;

  const stats = {
    retried: 0,
    matched: 0,
    refreshed: 0,
    refreshedMetadata: 0,
    errors: 0,
    pending: {
      mapping: mappingBatch.total,
      episodeFetch: episodeFetchBatch.total,
      metadataFetch: metadataFetchBatch.total,
    },
    processed: {
      mapping: mappingPending.length,
      episodeFetch: episodeFetchPending.length,
      metadataFetch: metadataFetchPending.length,
    },
    limited: {
      mapping: mappingBatch.limited,
      episodeFetch: episodeFetchBatch.limited,
      metadataFetch: metadataFetchBatch.limited,
    },
  };
  if (pending.length + pendingEpisodeFetches.length + pendingMetadataFetches.length > 0) {
    log("retry", "pending retry started", {
      mapping: mappingBatch.total,
      episodeFetch: episodeFetchBatch.total,
      metadataFetch: metadataFetchBatch.total,
      processingMapping: mappingPending.length,
      processingEpisodeFetch: episodeFetchPending.length,
      processingMetadataFetch: metadataFetchPending.length,
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
  for (const row of metadataFetchPending) {
    try {
      stats.retried++;
      const refresh = await refreshSubjectMetadata(row.animeId, { source: row.source });
      if (refresh.refreshed) stats.refreshedMetadata++;
    } catch (err) {
      error("retry", `metadata fetch retry failed for ${row.animeId}:${row.source}`, err);
      stats.errors++;
    }
  }
  if (pending.length + pendingEpisodeFetches.length + pendingMetadataFetches.length > 0) log("retry", "pending retry completed", stats);
  return stats;
}
