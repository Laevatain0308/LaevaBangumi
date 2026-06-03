import * as bangumi from "../clients/bangumiClient.js";
import {
  deleteRetryState,
  findRetryState,
  upsertRetryState,
} from "../repositories/resourceRepository.js";
import { enqueueJob, registerJob } from "./queue.js";
import {
  fromNow,
  MAX_RETRIES,
  RETRY_DELAYS,
} from "./animeShared.js";
import { upsertAnime } from "./subjectSyncService.js";
import { error, log } from "../lib/logger.js";

export const METADATA_RETRY_SOURCE = "bangumi";

export function scheduleMetadataFetchRetry(animeId, source = METADATA_RETRY_SOURCE, count = 1, lastError = null) {
  const retryCount = Math.min(Math.max(count, 1), MAX_RETRIES);
  const idx = Math.min(retryCount - 1, RETRY_DELAYS.length - 1);
  upsertRetryState({
    bangumiId: animeId,
    source,
    kind: "metadata_fetch",
    retryCount,
    retryAt: fromNow(RETRY_DELAYS[idx]),
    lastError,
  });
}

function clearMetadataFetchRetry(animeId, source = METADATA_RETRY_SOURCE) {
  deleteRetryState({ bangumiId: animeId, source, kind: "metadata_fetch" });
}

export async function refreshSubjectMetadata(animeId, {
  source = METADATA_RETRY_SOURCE,
  weekday = undefined,
  fetchSubject = bangumi.getSubject,
  timeoutMs = undefined,
} = {}) {
  log("metadata", "subject metadata refresh started", { animeId, source });
  let subject;
  try {
    subject = await fetchSubject(animeId, timeoutMs == null ? {} : { timeoutMs });
  } catch (err) {
    const retry = findRetryState({ bangumiId: animeId, source, kind: "metadata_fetch" });
    scheduleMetadataFetchRetry(animeId, source, (retry?.retry_count ?? 0) + 1, err.message);
    error("metadata", `subject metadata refresh failed for ${animeId}`, err);
    return { animeId, refreshed: false, reason: "fetch-failed", error: err.message };
  }

  if (!subject) {
    const retry = findRetryState({ bangumiId: animeId, source, kind: "metadata_fetch" });
    scheduleMetadataFetchRetry(animeId, source, (retry?.retry_count ?? 0) + 1, "empty subject response");
    return { animeId, refreshed: false, reason: "not-found" };
  }

  await upsertAnime(subject, weekday, { detailFetched: true });
  clearMetadataFetchRetry(animeId, source);
  log("metadata", "subject metadata refresh completed", { animeId, source });
  return { animeId, refreshed: true };
}

export function registerMetadataRefreshJob({
  register = registerJob,
  refreshSubjectMetadata: refreshFn = refreshSubjectMetadata,
} = {}) {
  register("refresh-subject-metadata", async ({ animeId, id, source = METADATA_RETRY_SOURCE, weekday = undefined }) => {
    await refreshFn(animeId ?? id, { source, weekday });
  });
}

export function enqueueMetadataRefresh(animeId, { source = METADATA_RETRY_SOURCE, weekday = undefined } = {}) {
  return enqueueJob(
    "refresh-subject-metadata",
    { animeId, source, weekday },
    { key: `refresh-subject-metadata:${source}:${animeId}` },
  );
}
