import * as bangumi from "../clients/bangumiClient.js";
import { error, log, warn } from "../lib/logger.js";
import {
  enrichFromSubject,
  findAnimeFacadeById,
  upsertAnime,
} from "./subjectSyncService.js";
import {
  ensureMappingForAnime,
  getEnabledSourceKeys,
  getMap,
  refreshEpisodesForAnime,
} from "./resourceMatchService.js";

function normalizeIdList(ids) {
  if (ids == null || ids === "") return [];
  const raw = Array.isArray(ids) ? ids : String(ids).split(",");
  return [...new Set(raw
    .flatMap((value) => String(value).split(","))
    .map((value) => parseInt(String(value).trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0))];
}

function normalizeSourceKeys(sourceKeys) {
  if (sourceKeys == null || sourceKeys === "") return null;
  const raw = Array.isArray(sourceKeys) ? sourceKeys : String(sourceKeys).split(",");
  const keys = raw
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return keys.length > 0 ? [...new Set(keys)] : null;
}

function normalizeLimit(limit) {
  if (limit == null || limit === "") return null;
  const parsed = parseInt(limit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function animeTitle(a) {
  return a?.nameCn || a?.name || "";
}

export async function prewarmAnime({
  ids = [],
  query = null,
  sourceKeys = null,
  mappedOnly = false,
  refreshEpisodes = true,
  limit = null,
} = {}, deps = {}) {
  const searchSubjects = deps.searchSubjects ?? bangumi.searchSubjects;
  const enrichSubject = deps.enrichSubject ?? enrichFromSubject;
  const ensureMapping = deps.ensureMapping ?? ensureMappingForAnime;
  const refreshEpisodeList = deps.refreshEpisodes ?? refreshEpisodesForAnime;
  const upsertSubject = deps.upsertSubject ?? upsertAnime;
  const normalizedSources = getEnabledSourceKeys(normalizeSourceKeys(sourceKeys));
  const rowLimit = normalizeLimit(limit);
  const targets = new Map();

  for (const id of normalizeIdList(ids)) {
    targets.set(id, { id, row: null });
  }

  const keyword = String(query || "").trim();
  const stats = {
    requested: 0,
    upserted: 0,
    processed: 0,
    matched: 0,
    refreshed: 0,
    skipped: 0,
    errors: 0,
    items: [],
  };

  if (keyword) {
    log("prewarm", "bangumi search started", { keyword, limit: rowLimit });
    const searchResult = await searchSubjects(keyword);
    const subjects = (searchResult?.data || []).slice(0, rowLimit ?? undefined);
    for (const subject of subjects) {
      const row = await upsertSubject(subject);
      if (!row) continue;
      stats.upserted++;
      targets.set(row.id, { id: row.id, row });
    }
  }

  stats.requested = targets.size;

  for (const target of targets.values()) {
    const item = {
      animeId: target.id,
      title: animeTitle(target.row),
      metadata: "pending",
      sources: [],
    };
    stats.items.push(item);

    let animeRow = target.row;
    try {
      const enriched = await enrichSubject(target.id);
      if (enriched) {
        animeRow = enriched;
        item.metadata = "enriched";
      } else if (animeRow) {
        item.metadata = "cached";
      } else {
        animeRow = findAnimeFacadeById(target.id);
        item.metadata = animeRow ? "cached" : "missing";
      }
    } catch (err) {
      animeRow = animeRow ?? findAnimeFacadeById(target.id);
      item.metadata = animeRow ? "cached" : "failed";
      item.error = err.message;
      if (!animeRow) {
        stats.errors++;
        error("prewarm", `metadata fetch failed for ${target.id}`, err);
        continue;
      }
      warn("prewarm", "metadata fetch failed, using local cache", { animeId: target.id, message: err.message });
    }

    if (!animeRow) {
      stats.errors++;
      continue;
    }

    item.title = animeTitle(animeRow);
    stats.processed++;

    for (const source of normalizedSources) {
      const sourceItem = {
        source,
        mapping: "pending",
        episodes: "skipped",
      };
      item.sources.push(sourceItem);

      try {
        const existing = getMap(animeRow.id, source);
        if (mappedOnly && !existing) {
          stats.skipped++;
          sourceItem.mapping = "skipped";
          sourceItem.reason = "not-mapped";
          continue;
        }

        const mapping = existing
          ? { animeId: animeRow.id, matched: true, cstationId: existing.cstationId, reason: "already-mapped" }
          : await ensureMapping(animeRow.id, { source });

        sourceItem.mapping = mapping.matched ? "matched" : "skipped";
        sourceItem.reason = mapping.reason || "";
        if (mapping.cstationId) sourceItem.cstationId = mapping.cstationId;

        if (!mapping.matched) {
          stats.skipped++;
          continue;
        }

        stats.matched++;
        if (!refreshEpisodes) {
          sourceItem.episodes = "skipped";
          sourceItem.episodeReason = "refresh-disabled";
          continue;
        }

        const refresh = await refreshEpisodeList(animeRow.id, { source });
        sourceItem.episodes = refresh.refreshed ? "refreshed" : "skipped";
        sourceItem.episodeReason = refresh.reason || "";
        if (refresh.cstationId) sourceItem.cstationId = refresh.cstationId;
        if (refresh.epCount != null) sourceItem.epCount = refresh.epCount;
        if (refresh.refreshed) {
          stats.refreshed++;
        } else {
          stats.skipped++;
        }
      } catch (err) {
        stats.errors++;
        sourceItem.mapping = sourceItem.mapping === "pending" ? "failed" : sourceItem.mapping;
        sourceItem.episodes = "failed";
        sourceItem.reason = err.message;
        error("prewarm", `source processing failed for ${animeRow.id}:${source}`, err);
      }
    }
  }

  log("prewarm", "completed", {
    requested: stats.requested,
    upserted: stats.upserted,
    processed: stats.processed,
    matched: stats.matched,
    refreshed: stats.refreshed,
    skipped: stats.skipped,
    errors: stats.errors,
  });
  return stats;
}
