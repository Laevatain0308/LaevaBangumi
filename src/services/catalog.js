import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { cstationCatalog, sourceSyncState } from "../db/schema.js";
import * as cstation from "./cstation.js";
import { log, error } from "../lib/logger.js";

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export async function saveCatalog(catalog, { source } = {}) {
  if (!source) throw new Error("saveCatalog requires source");
  let count = 0;
  for (const item of catalog) {
    try {
      const values = {
        source,
        id: item.id,
        name: item.name,
        subname: item.subname || null,
        year: item.year || null,
        last: item.last || null,
        category: item.category || null,
        detailFetchedAt: item.detailFetchedAt || null,
      };
      const set = {
        name: item.name,
        year: item.year || null,
      };
      if (item.last) set.last = item.last;
      if (item.category) set.category = item.category;
      if (item.subname) set.subname = item.subname;
      if (item.detailFetchedAt) set.detailFetchedAt = item.detailFetchedAt;

      db.insert(cstationCatalog)
        .values(values)
        .onConflictDoUpdate({
          target: [cstationCatalog.source, cstationCatalog.id],
          set,
        })
        .run();
      count++;
    } catch (err) {
      error("catalog", "save catalog item failed", { id: item.id, name: item.name, message: err.message });
    }
  }
  return count;
}

export async function syncCatalogCategory({ source, t, incremental = true, hydrateDetails = true } = {}) {
  if (!source) throw new Error("syncCatalogCategory requires source");
  if (!t) throw new Error("syncCatalogCategory requires t");
  log("catalog", "category sync started", { source, category: t, incremental, hydrateDetails });
  const state = db.select()
    .from(sourceSyncState)
    .where(and(eq(sourceSyncState.source, source), eq(sourceSyncState.category, t)))
    .get();

  const shouldIncremental = incremental && state?.lastSeenAt;
  const result = shouldIncremental
    ? await cstation.fetchCatalogIncremental({ source, t, sinceLastSeenAt: state.lastSeenAt })
    : { catalog: await cstation.fetchCatalog({ source, t }), maxLast: null, completed: true, pagesRead: null, pagecount: null };

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
  if (maxLast) upsertSyncState(source, t, maxLast);

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

function upsertSyncState(source, category, lastSeenAt) {
  db.insert(sourceSyncState)
    .values({ source, category, lastSeenAt, lastSuccessAt: now(), updatedAt: now() })
    .onConflictDoUpdate({
      target: [sourceSyncState.source, sourceSyncState.category],
      set: { lastSeenAt, lastSuccessAt: now(), updatedAt: now() },
    })
    .run();
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
