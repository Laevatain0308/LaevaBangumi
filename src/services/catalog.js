import * as cstation from "../clients/resourceClient.js";
import { log, error } from "../lib/logger.js";
import { upsertResourceItem, upsertResourceSource } from "../repositories/resourceRepository.js";
import { getSourceConfig } from "../lib/cstationConfig.js";
import {
  findResourceSyncState,
  markResourceSyncFailed,
  markResourceSyncStarted,
  markResourceSyncSucceeded,
} from "../repositories/syncRepository.js";
import { normalizeResourceItem } from "../normalizers/resourceItemNormalizer.js";

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function resolveSourceConfig(source, explicitConfig) {
  if (explicitConfig) return explicitConfig;
  try {
    return getSourceConfig(source);
  } catch {
    return {
      key: source,
      name: source,
      enabled: true,
      apiEndpoint: null,
      priority: 100,
    };
  }
}

export async function saveCatalog(catalog, { source } = {}) {
  if (!source) throw new Error("saveCatalog requires source");
  let count = 0;
  for (const item of catalog) {
    try {
      const normalized = normalizeResourceItem(item, { source });
      upsertResourceItem(normalized);
      count++;
    } catch (err) {
      error("catalog", "save catalog item failed", {
        id: item.id ?? item.sourceAid,
        name: item.name ?? item.title,
        message: err.message,
      });
    }
  }
  return count;
}

export async function syncCatalogCategory({
  source,
  t,
  incremental = true,
  hydrateDetails = true,
  fetchCatalog = cstation.fetchCatalog,
  fetchCatalogIncremental = cstation.fetchCatalogIncremental,
  sourceConfig = null,
} = {}) {
  if (!source) throw new Error("syncCatalogCategory requires source");
  if (!t) throw new Error("syncCatalogCategory requires t");
  const normalizedSourceConfig = resolveSourceConfig(source, sourceConfig);
  upsertResourceSource({
    source,
    name: normalizedSourceConfig.name,
    enabled: normalizedSourceConfig.enabled !== false ? 1 : 0,
    baseUrl: normalizedSourceConfig.apiEndpoint,
    priority: normalizedSourceConfig.priority ?? 100,
  });
  log("catalog", "category sync started", { source, category: t, incremental, hydrateDetails });
  const startedAt = markResourceSyncStarted({ source, scope: t });
  const state = findResourceSyncState({ source, scope: t });

  try {
    const shouldIncremental = incremental && state?.lastSeenAt;
    const result = shouldIncremental
      ? await fetchCatalogIncremental({ source, t, sinceLastSeenAt: state.lastSeenAt })
      : { catalog: await fetchCatalog({ source, t }), maxLast: null, completed: true, pagesRead: null, pagecount: null };

    const catalog = result.catalog || [];
    const saved = await saveCatalog(catalog, { source });
    log("catalog", "category page data saved", {
      source,
      category: t,
      mode: shouldIncremental ? "incremental" : "full",
      fetched: catalog.length,
      saved,
      pagesRead: result.pagesRead,
      pagecount: result.pagecount,
    });

    let hydrated = 0;
    if (hydrateDetails && shouldIncremental && catalog.length > 0) {
      hydrated = await hydrateCatalogDetails(catalog.map((item) => item.id), { source });
    }

    const maxLast = result.maxLast || maxLastFromCatalog(catalog) || state?.lastSeenAt || null;
    markResourceSyncSucceeded({ source, scope: t, lastSeenAt: maxLast, lastStartedAt: startedAt });

    const stats = {
      source,
      category: t,
      mode: shouldIncremental ? "incremental" : "full",
      fetched: catalog.length,
      saved,
      hydrated,
      changedIds: catalog.map((item) => item.id).filter(Boolean),
      pagesRead: result.pagesRead,
      pagecount: result.pagecount,
      lastSeenAt: maxLast,
    };
    log("catalog", "category sync completed", stats);
    return stats;
  } catch (err) {
    markResourceSyncFailed({ source, scope: t, error: err, lastStartedAt: startedAt });
    throw err;
  }
}

export async function hydrateCatalogDetails(ids, { source } = {}) {
  if (!source) throw new Error("hydrateCatalogDetails requires source");
  const uniqueIds = [...new Set(ids.map((id) => parseInt(id, 10)).filter(Boolean))];
  let count = 0;
  if (uniqueIds.length > 0) log("catalog", "hydrate details started", { source, total: uniqueIds.length });

  for (let i = 0; i < uniqueIds.length; i += 20) {
    const batch = uniqueIds.slice(i, i + 20);
    log("catalog", "hydrate detail batch", { source, offset: i, size: batch.length });
    const details = await cstation.fetchByIds(batch, { source });
    if (details.length === 0) continue;

    const nowTs = now();
    await saveCatalog(details.map((detail) => ({
      id: detail.id,
      name: detail.name,
      subname: detail.subname || null,
      year: detail.year || null,
      last: detail.last || null,
      detailFetchedAt: nowTs,
    })), { source });
    count += details.length;
  }

  if (uniqueIds.length > 0) log("catalog", "hydrate details completed", { source, requested: uniqueIds.length, hydrated: count });
  return count;
}

function maxLastFromCatalog(catalog) {
  let best = null;
  for (const item of catalog) {
    const itemMs = cstation.parseLastTime(item.last);
    const bestMs = cstation.parseLastTime(best);
    if (itemMs != null && (bestMs == null || itemMs > bestMs)) best = item.last;
  }
  return best;
}
