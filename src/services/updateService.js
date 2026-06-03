import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { listSubjectTags } from "../repositories/subjectRepository.js";
import { formatSubjectSearchDto } from "../dto/subjectDto.js";
import {
  DAY_MS,
  normalizeTimestamp,
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
  const rows = db.all(sql`
    SELECT
      s.bangumi_id AS id,
      s.bangumi_id,
      s.name,
      s.name_cn AS nameCn,
      s.name_cn,
      s.summary,
      s.cover_url AS coverUrl,
      s.cover_url,
      s.has_cover AS hasCover,
      s.has_cover,
      s.air_date,
      s.air_weekday,
      s.platform,
      s.eps,
      s.total_episodes,
      s.rating_score,
      s.rating_rank,
      s.rating_total,
      s.rating_distribution_json,
      rm.source,
      rm.source_aid AS sourceAid,
      rm.source_ep_start AS sourceEpStart,
      rm.source_ep_end AS sourceEpEnd,
      rm.display_ep_offset AS displayEpOffset,
      ri.latest_text AS sourceUpdatedAt,
      MAX(e.ep_index) AS latestEp,
      MAX(e.updated_at) AS episodeUpdatedAt
    FROM resource_mappings rm
    JOIN subjects s ON s.bangumi_id = rm.bangumi_id
    JOIN resource_items ri ON ri.source = rm.source AND ri.source_aid = rm.source_aid
    LEFT JOIN episodes e
      ON e.bangumi_id = rm.bangumi_id
      AND e.source = rm.source
      AND e.source_aid = rm.source_aid
    GROUP BY rm.bangumi_id, rm.source, rm.source_aid
  `);

  const latestByAnime = new Map();
  for (const row of rows) {
    if (!enabledSourcesSet.has(row.source)) continue;
    const sourceUpdatedMs = parseTimestamp(row.sourceUpdatedAt);
    if (sourceUpdatedMs == null || sourceUpdatedMs < cutoffMs || sourceUpdatedMs > nowMs) continue;

    const isClosedRange = row.sourceEpEnd != null;
    if (isClosedRange) continue;
    const hasEpisodeChange = row.latestEp != null;

    const sourceUpdate = {
      source: row.source,
      sourceAid: row.sourceAid,
      updatedAt: normalizeTimestamp(row.sourceUpdatedAt),
      latestEp: row.latestEp ?? null,
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
          coverUrl: proxyCover(row.id, row.coverUrl, row.hasCover),
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
