import { normalizeSubject } from "./normalizer.js";
import { validateAnimeSubject } from "./validation.js";
import { BANGUMI_DETAIL_REFRESH_INTERVAL_MS } from "./config.js";

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function createBangumiMetadataService({
  client,
  repository,
  clock = () => new Date(),
  logger = {},
}) {
  const writeLog = logger.log ?? (() => {});
  const writeError = logger.error ?? (() => {});

  async function searchAndPersist(keyword, options = {}) {
    const result = await client.search(keyword, options);
    const items = Array.isArray(result?.data) ? result.data : [];
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

    if (valid.length > 0) repository.mergeSearchResults(valid, { now: iso(clock()) });
    return { received: items.length, persisted: valid.length, rejected };
  }

  async function fetchAndReplaceDetail(bangumiId) {
    writeLog("bangumi-metadata", "detail fetch started", { bangumiId });
    try {
      const response = await client.getSubject(bangumiId);
      validateAnimeSubject(response, { expectedId: bangumiId });
      const nowDate = clock();
      const now = iso(nowDate);
      const nextRefreshAt = new Date(new Date(now).getTime() + BANGUMI_DETAIL_REFRESH_INTERVAL_MS).toISOString();
      const result = repository.replaceDetail(normalizeSubject(response), { now, nextRefreshAt });
      writeLog("bangumi-metadata", "detail fetch completed", { bangumiId, nextRefreshAt });
      return result;
    } catch (error) {
      writeError("bangumi-metadata", "detail fetch failed", {
        bangumiId,
        path: error.path ?? null,
        message: error.message ?? String(error),
      });
      throw error;
    }
  }

  async function getDetail(bangumiId) {
    if (repository.hasCompletedDetail(bangumiId)) return repository.findById(bangumiId);
    return fetchAndReplaceDetail(bangumiId);
  }

  return {
    searchAndPersist,
    getDetail,
    refreshDetail: fetchAndReplaceDetail,
  };
}
