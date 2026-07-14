import { ResourceSource } from "../ResourceSource.js";
import { createFFZYClient } from "./ffzyClient.js";
import { parseCatalogXml, parseDetailXml } from "./ffzyParser.js";
import { createFFZYRepository } from "./ffzyRepository.js";

const CATEGORY_IDS = Object.freeze(["29", "30", "31"]);
const DETAIL_BATCH_SIZE = 20;
const DETAIL_CONCURRENCY = 2;
const BATCH_START_INTERVAL_MS = 500;
const MISSING_ITEM_RETRY_MS = 5_000;
const REQUEST_RETRY_DELAYS_MS = Object.freeze([5_000, 30_000]);
const INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000;

function maxTimestamp(current, candidate) {
  if (candidate == null) return current;
  if (current == null) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function summary(sourceKey, operation, startedAt, finishedAt, stats = {}) {
  return {
    sourceKey,
    operation,
    startedAt,
    finishedAt,
    fetchedItems: stats.fetchedItems ?? 0,
    savedItems: stats.savedItems ?? 0,
    fetchedEpisodes: stats.fetchedEpisodes ?? 0,
    savedEpisodes: stats.savedEpisodes ?? 0,
    failedItems: stats.failedItems ?? 0,
  };
}

export default class FFZYSource extends ResourceSource {
  static get sourceKey() {
    return "ffzy";
  }

  constructor({
    db,
    logger,
    client = null,
    repository = null,
    clock = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = {}) {
    super({ db, logger });
    this.client = client ?? createFFZYClient();
    this.repository = repository ?? createFFZYRepository({ sqlite: db, clock });
    this.clock = clock;
    this.sleep = sleep;
    this.random = random;
  }

  #now() {
    const value = this.clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  #jitter() {
    return Math.floor(this.random() * 501);
  }

  async #withRequestRetry(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!error?.retryable || attempt >= REQUEST_RETRY_DELAYS_MS.length) throw error;
        await this.sleep(REQUEST_RETRY_DELAYS_MS[attempt] + this.#jitter());
      }
    }
  }

  async #fetchCatalog() {
    const byId = new Map();
    let watermarkAt = null;
    for (const categoryId of CATEGORY_IDS) {
      let page = 1;
      let pageCount = 1;
      do {
        const xml = await this.client.fetchCatalogXml({ categoryId, page });
        const parsed = parseCatalogXml(xml, {
          sourceKey: this.sourceKey,
          allowedCategoryIds: CATEGORY_IDS,
        });
        if (parsed.page !== page) {
          throw new TypeError(`FFZY catalog returned page ${parsed.page} while page ${page} was requested`);
        }
        pageCount = parsed.pageCount;
        for (const item of parsed.items) {
          const existing = byId.get(item.sourceItemId);
          if (
            !existing
            || Date.parse(item.sourceUpdatedAt ?? 0) > Date.parse(existing.sourceUpdatedAt ?? 0)
          ) {
            byId.set(item.sourceItemId, item);
          }
          watermarkAt = maxTimestamp(watermarkAt, item.sourceUpdatedAt);
        }
        page += 1;
      } while (page <= pageCount);
    }
    return { items: [...byId.values()], watermarkAt };
  }

  async #fetchIncrementalCatalog(watermarkAt) {
    const cutoffMs = Date.parse(watermarkAt) - INCREMENTAL_OVERLAP_MS;
    const byId = new Map();
    let nextWatermarkAt = watermarkAt;
    for (const categoryId of CATEGORY_IDS) {
      let page = 1;
      let pageCount = 1;
      let crossedCutoff = false;
      do {
        const xml = await this.client.fetchCatalogXml({ categoryId, page });
        const parsed = parseCatalogXml(xml, {
          sourceKey: this.sourceKey,
          allowedCategoryIds: CATEGORY_IDS,
        });
        if (parsed.page !== page) {
          throw new TypeError(`FFZY catalog returned page ${parsed.page} while page ${page} was requested`);
        }
        pageCount = parsed.pageCount;
        for (const item of parsed.items) {
          const updatedMs = Date.parse(item.sourceUpdatedAt);
          if (Number.isFinite(updatedMs) && updatedMs < cutoffMs) {
            crossedCutoff = true;
            break;
          }
          const existing = byId.get(item.sourceItemId);
          if (
            !existing
            || Date.parse(item.sourceUpdatedAt ?? 0) > Date.parse(existing.sourceUpdatedAt ?? 0)
          ) {
            byId.set(item.sourceItemId, item);
          }
          nextWatermarkAt = maxTimestamp(nextWatermarkAt, item.sourceUpdatedAt);
        }
        page += 1;
      } while (!crossedCutoff && page <= pageCount);
    }
    return { items: [...byId.values()], watermarkAt: nextWatermarkAt };
  }

  #stopForDatabaseFailure(run, error) {
    run.stopped = true;
    run.databaseError ??= error;
  }

  #recordRemoteFailure(run, sourceItemId, error) {
    try {
      this.repository.recordDetailFailure(sourceItemId, error);
      run.failedItems += 1;
    } catch (databaseError) {
      this.#stopForDatabaseFailure(run, databaseError);
      throw databaseError;
    }
  }

  #saveFetchedDetail(run, detail) {
    if (run.stopped) return;
    try {
      const savedEpisodes = this.repository.saveDetail(detail);
      run.fetchedEpisodes += detail.episodes.length;
      run.savedEpisodes += savedEpisodes;
    } catch (databaseError) {
      this.#stopForDatabaseFailure(run, databaseError);
      throw databaseError;
    }
  }

  async #fetchParsedDetails(sourceItemIds) {
    const xml = await this.#withRequestRetry(
      () => this.client.fetchDetailXml(sourceItemIds),
    );
    return parseDetailXml(xml, {
      sourceKey: this.sourceKey,
      allowedCategoryIds: CATEGORY_IDS,
    }).items;
  }

  async #fetchSingleDetail(sourceItemId) {
    const details = await this.#fetchParsedDetails([sourceItemId]);
    const detail = details.find((item) => item.sourceItemId === sourceItemId);
    if (!detail) throw new Error(`FFZY detail response omitted ${sourceItemId}`);
    return detail;
  }

  async #hydrateBatch(run, sourceItemIds) {
    if (run.stopped) return;
    let details;
    try {
      details = await this.#fetchParsedDetails(sourceItemIds);
    } catch (error) {
      for (const sourceItemId of sourceItemIds) {
        if (run.stopped) break;
        this.#recordRemoteFailure(run, sourceItemId, error);
      }
      return;
    }
    if (run.stopped) return;

    const byId = new Map(details.map((detail) => [detail.sourceItemId, detail]));
    for (const sourceItemId of sourceItemIds) {
      if (run.stopped) return;
      let detail = byId.get(sourceItemId);
      if (!detail) {
        await this.sleep(MISSING_ITEM_RETRY_MS + this.#jitter());
        if (run.stopped) return;
        try {
          detail = await this.#fetchSingleDetail(sourceItemId);
        } catch (error) {
          this.#recordRemoteFailure(run, sourceItemId, error);
          continue;
        }
      }
      this.#saveFetchedDetail(run, detail);
    }
  }

  async #hydrateDetails(sourceItemIds) {
    const run = {
      stopped: false,
      databaseError: null,
      fetchedEpisodes: 0,
      savedEpisodes: 0,
      failedItems: 0,
    };
    const batches = [];
    for (let index = 0; index < sourceItemIds.length; index += DETAIL_BATCH_SIZE) {
      batches.push(sourceItemIds.slice(index, index + DETAIL_BATCH_SIZE));
    }

    let batchIndex = 0;
    while (batchIndex < batches.length && !run.stopped) {
      const wave = [];
      for (let slot = 0; slot < DETAIL_CONCURRENCY && batchIndex < batches.length; slot += 1) {
        if (batchIndex > 0) await this.sleep(BATCH_START_INTERVAL_MS);
        if (run.stopped) break;
        const batch = batches[batchIndex];
        batchIndex += 1;
        wave.push(this.#hydrateBatch(run, batch).then(
          () => ({ error: null }),
          (error) => ({ error }),
        ));
      }
      const results = await Promise.all(wave);
      const failure = results.find((result) => result.error)?.error;
      if (failure) throw failure;
    }
    if (run.databaseError) throw run.databaseError;
    return run;
  }

  async _initialize() {
    const operation = "initialize";
    const startedAt = this.#now();
    try {
      this.repository.markRunning(operation);
      const catalog = await this.#fetchCatalog();
      const savedItems = this.repository.saveCatalogItems(catalog.items);
      const hydration = await this.#hydrateDetails(
        catalog.items.map((item) => item.sourceItemId),
      );
      this.repository.markSuccess(operation, {
        initialized: true,
        watermarkAt: catalog.watermarkAt,
      });
      return summary(this.sourceKey, operation, startedAt, this.#now(), {
        fetchedItems: catalog.items.length,
        savedItems,
        fetchedEpisodes: hydration.fetchedEpisodes,
        savedEpisodes: hydration.savedEpisodes,
        failedItems: hydration.failedItems,
      });
    } catch (error) {
      try {
        this.repository.markFailed(operation, error);
      } catch (markError) {
        throw new AggregateError([error, markError], "FFZY initialization and failure state write failed");
      }
      throw error;
    }
  }

  async _update() {
    const operation = "update";
    const startedAt = this.#now();
    const state = this.repository.getSyncState();
    if (!state.initialized) {
      this.repository.markSkipped(operation, "full initialization required");
      return summary(this.sourceKey, operation, startedAt, this.#now());
    }

    try {
      this.repository.markRunning(operation);
      const dueIds = this.repository.listDueDetailFailures()
        .map((failure) => failure.sourceItemId);
      const dueHydration = await this.#hydrateDetails(dueIds);

      const catalog = await this.#fetchIncrementalCatalog(state.watermarkAt);
      const changedIds = this.repository.listChangedItemIds(catalog.items);
      const failureIds = new Set(this.repository.listDetailFailureIds());
      const catalogIds = new Set(catalog.items.map((item) => item.sourceItemId));
      const hydrationIds = [...new Set([
        ...changedIds,
        ...[...failureIds].filter((sourceItemId) => catalogIds.has(sourceItemId)),
      ])];
      const savedItems = this.repository.saveCatalogItems(catalog.items);
      const catalogHydration = await this.#hydrateDetails(hydrationIds);

      this.repository.markSuccess(operation, { watermarkAt: catalog.watermarkAt });
      return summary(this.sourceKey, operation, startedAt, this.#now(), {
        fetchedItems: catalog.items.length,
        savedItems,
        fetchedEpisodes: dueHydration.fetchedEpisodes + catalogHydration.fetchedEpisodes,
        savedEpisodes: dueHydration.savedEpisodes + catalogHydration.savedEpisodes,
        failedItems: dueHydration.failedItems + catalogHydration.failedItems,
      });
    } catch (error) {
      try {
        this.repository.markFailed(operation, error);
      } catch (markError) {
        throw new AggregateError([error, markError], "FFZY update and failure state write failed");
      }
      throw error;
    }
  }

  async _fetchDetail(sourceItemId) {
    return this.#fetchSingleDetail(sourceItemId);
  }

  async _saveCatalogItems(items) {
    return this.repository.saveCatalogItems(items);
  }

  async _saveDetail(detail) {
    return this.repository.saveDetail(detail);
  }

  async _searchItems(keyword) {
    return this.repository.searchItems(keyword);
  }

  async _getItem(sourceItemId) {
    return this.repository.getItem(sourceItemId);
  }

  async _getEpisodes(sourceItemId) {
    return this.repository.getEpisodes(sourceItemId);
  }

  async _getEpisode(sourceItemId, episodeIndex) {
    return this.repository.getEpisode(sourceItemId, episodeIndex);
  }
}
