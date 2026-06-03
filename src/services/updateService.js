import { listSubjectTags } from "../repositories/tagRepository.js";
import { listUpdateCandidateRows } from "../repositories/resourceRepository.js";
import { formatSubjectSearchDto } from "../dto/subjectDto.js";
import {
  DAY_MS,
  parseTimestamp,
  parseUpdateNow,
  proxyCover,
} from "./animeShared.js";
import { getEnabledSourceKeys } from "./resourceMatchService.js";

export async function getUpdates({ days = 7, limit = 60, today: todayOption = null } = {}) {
  const windowMs = Math.max(1, days) * DAY_MS;
  const nowMs = parseUpdateNow(todayOption) ?? Date.now();
  const cutoffMs = nowMs - windowMs;
  const enabledSources = getEnabledSourceKeys();
  const enabledSourcesSet = new Set(enabledSources);
  const sourceOrder = new Map(enabledSources.map((source, index) => [source, index]));
  const rows = listUpdateCandidateRows();

  const latestByAnime = new Map();
  for (const row of rows) {
    if (!enabledSourcesSet.has(row.source)) continue;
    const sourceUpdatedMs = parseTimestamp(row.sourceUpdatedAt);
    if (sourceUpdatedMs == null || sourceUpdatedMs < cutoffMs || sourceUpdatedMs > nowMs) continue;

    const seasonalMappingCount = row.seasonalMappingCount ?? 0;
    const sourceEpStart = row.sourceEpStart ?? 0;
    const maxSeasonalSourceEpStart = row.maxSeasonalSourceEpStart ?? sourceEpStart;
    if (seasonalMappingCount > 1 && sourceEpStart < maxSeasonalSourceEpStart) continue;

    const hasEpisodeChange = row.latestEp != null;

    const sourceUpdate = {
      source: row.source,
      sourceAid: row.sourceAid,
      updatedAt: new Date(sourceUpdatedMs).toISOString(),
      latestEp: row.latestEp ?? null,
      latestSourceEpIndex: row.latestSourceEpIndex ?? null,
      sourceEpStart: row.sourceEpStart ?? null,
      sourceEpEnd: row.sourceEpEnd ?? null,
      displayEpOffset: row.displayEpOffset ?? 0,
      hasEpisodeChange,
    };
    const existing = latestByAnime.get(row.id);
    const existingMs = parseTimestamp(existing?.updatedAt);
    const sourceRank = sourceOrder.get(row.source) ?? Number.MAX_SAFE_INTEGER;
    const existingRank = sourceOrder.get(existing?.source) ?? Number.MAX_SAFE_INTEGER;

    const shouldReplace =
      !existing ||
      sourceUpdatedMs > existingMs ||
      (sourceUpdatedMs === existingMs && sourceRank < existingRank);

    if (shouldReplace) {
      const sourceUpdates = existing?.sourceUpdates ? [...existing.sourceUpdates, sourceUpdate] : [sourceUpdate];
      latestByAnime.set(row.id, {
        ...formatSubjectSearchDto(row, {
          coverUrl: proxyCover(row.id, row.coverUrl),
          tags: listSubjectTags(row.id),
        }),
        latestEp: row.latestEp ?? null,
        updatedAt: sourceUpdate.updatedAt,
        source: row.source,
        sourceAid: row.sourceAid,
        sourceUpdates,
      });
    } else {
      existing.sourceUpdates.push(sourceUpdate);
    }
  }

  const data = [...latestByAnime.values()]
    .map((row) => {
      const sourceUpdates = row.sourceUpdates.sort((a, b) => {
        const timeCmp = (parseTimestamp(b.updatedAt) ?? 0) - (parseTimestamp(a.updatedAt) ?? 0);
        if (timeCmp !== 0) return timeCmp;
        return (sourceOrder.get(a.source) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(b.source) ?? Number.MAX_SAFE_INTEGER);
      });
      const primary = sourceUpdates[0];
      const { sourceUpdates: _sourceUpdates, ...publicRow } = row;
      return {
        ...publicRow,
        latestEp: primary?.latestEp ?? null,
        latestEpisode: primary?.hasEpisodeChange && primary?.latestEp
          ? `更新至第${String(primary.latestEp).padStart(2, "0")}集`
          : "资源有更新",
        updatedAt: primary?.updatedAt ?? row.updatedAt,
        source: primary?.source ?? row.source,
        sourceAid: primary?.sourceAid ?? row.sourceAid,
      };
    })
    .sort((a, b) => {
      const timeCmp = (parseTimestamp(b.updatedAt) ?? 0) - (parseTimestamp(a.updatedAt) ?? 0);
      if (timeCmp !== 0) return timeCmp;
      return a.id - b.id;
    })
    .slice(0, Math.max(1, limit));

  return { data, freshness: data.length > 0 ? "cache" : "empty" };
}
