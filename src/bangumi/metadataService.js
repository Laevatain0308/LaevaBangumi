import { normalizeSubject } from "./normalizer.js";
import { validateAnimeSubject } from "./validation.js";
import {
  BANGUMI_DETAIL_REFRESH_INTERVAL_MS,
  BANGUMI_DETAIL_RETRY_DELAYS_MS,
} from "./config.js";

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function createBangumiMetadataService({
  client,
  repository,
  ensureMetadata = () => ({ ensuredIds: [], newlyDueIds: [], dueIds: [] }),
  onSubjectsPersisted = () => {},
  onDetailPersisted = () => {},
  clock = () => new Date(),
  logger = {},
}) {
  const writeLog = logger.log ?? (() => {});
  const writeError = logger.error ?? (() => {});
  const activeDetails = new Map();

  function notifyMapping(callback, value, message) {
    try {
      const result = callback(value);
      if (result && typeof result.then === "function") {
        result.catch((error) => {
          writeError("bangumi-mapping-notify", message, {
            message: error.message ?? String(error),
          });
        });
      }
    } catch (error) {
      writeError("bangumi-mapping-notify", message, {
        message: error.message ?? String(error),
      });
    }
  }

  function ensurePersistedMetadata(ids, scope) {
    try {
      ensureMetadata(ids);
    } catch (error) {
      writeError("bangumi-metadata", `${scope} ensure failed`, {
        message: error.message ?? String(error),
      });
    }
  }

  function persistSearchResults(items) {
    const valid = [];
    let rejected = 0;

    for (const item of items) {
      try {
        validateAnimeSubject(item);
        valid.push(normalizeSubject(item));
      } catch (error) {
        rejected += 1;
        writeError("bangumi-metadata", "search item rejected", {
          id: item?.id ?? null,
          path: error.path ?? null,
          message: error.message ?? String(error),
        });
      }
    }

    if (valid.length > 0) {
      repository.mergeSearchResults(valid, { now: iso(clock()) });
      const ids = valid.map(({ subject }) => subject.bangumiId);
      notifyMapping(onSubjectsPersisted, ids, "subjects persisted callback failed");
      ensurePersistedMetadata(ids, "search metadata");
    }
    return { received: items.length, persisted: valid.length, rejected };
  }

  async function searchAndPersist(keyword, options = {}) {
    const result = await client.search(keyword, options);
    const items = Array.isArray(result?.data) ? result.data : [];
    return persistSearchResults(items);
  }

  async function refreshDetailAttempt(bangumiId) {
    writeLog("bangumi-metadata", "detail fetch started", { bangumiId });
    try {
      const response = await client.getSubject(bangumiId);
      validateAnimeSubject(response, { expectedId: bangumiId });
      const nowDate = clock();
      const now = iso(nowDate);
      const nextRefreshAt = new Date(new Date(now).getTime() + BANGUMI_DETAIL_REFRESH_INTERVAL_MS).toISOString();
      const result = repository.replaceDetail(normalizeSubject(response), { now, nextRefreshAt });
      notifyMapping(onDetailPersisted, bangumiId, "detail persisted callback failed");
      writeLog("bangumi-metadata", "detail fetch completed", { bangumiId, nextRefreshAt });
      return result;
    } catch (error) {
      writeError("bangumi-metadata", "detail fetch failed", {
        bangumiId,
        path: error.path ?? null,
        message: error.message ?? String(error),
      });
      const now = iso(clock());
      const state = repository.findRefreshState(bangumiId);
      const failureIndex = Math.min(
        state?.consecutiveFailures ?? 0,
        BANGUMI_DETAIL_RETRY_DELAYS_MS.length - 1,
      );
      let refreshStateRecorded = false;
      try {
        repository.recordDetailRefreshFailure({
          bangumiId,
          now,
          nextRefreshAt: new Date(
            Date.parse(now) + BANGUMI_DETAIL_RETRY_DELAYS_MS[failureIndex],
          ).toISOString(),
          error: error.message ?? String(error),
        });
        refreshStateRecorded = true;
      } catch (stateError) {
        writeError("bangumi-metadata", "detail failure state write failed", {
          bangumiId,
          message: stateError.message ?? String(stateError),
        });
      }
      throw new DetailRefreshError(error, { refreshStateRecorded });
    }
  }

  function refreshDetail(bangumiId) {
    const active = activeDetails.get(bangumiId);
    if (active) return active;
    let promise;
    promise = refreshDetailAttempt(bangumiId).finally(() => {
      if (activeDetails.get(bangumiId) === promise) activeDetails.delete(bangumiId);
    });
    activeDetails.set(bangumiId, promise);
    return promise;
  }

  async function getDetail(bangumiId) {
    const now = iso(clock());
    const local = repository.findById(bangumiId);
    const state = repository.findRefreshState(bangumiId);
    const due = !state || state.nextRefreshAt <= now;

    if (state?.lastSucceededAt) {
      if (due) ensurePersistedMetadata([bangumiId], "detail");
      return local;
    }
    if (!due) return local;

    const ensured = ensureMetadata([bangumiId]);
    if (!ensured?.dueIds?.includes(bangumiId)) return local;
    return refreshDetail(bangumiId);
  }

  return {
    searchAndPersist,
    persistSearchResults,
    getDetail,
    refreshDetail,
  };
}

export class DetailRefreshError extends Error {
  constructor(cause, { refreshStateRecorded }) {
    super(cause.message ?? String(cause), { cause });
    this.name = "DetailRefreshError";
    if (cause.code !== undefined) this.code = cause.code;
    if (cause.path !== undefined) this.path = cause.path;
    this.refreshStateRecorded = refreshStateRecorded;
  }
}
