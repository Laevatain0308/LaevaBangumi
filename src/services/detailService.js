import {
  findSubjectById,
  listSubjectAliases,
} from "../repositories/subjectRepository.js";
import { listSubjectTags } from "../repositories/tagRepository.js";
import {
  listEpisodeChannelRowsForSubject,
} from "../repositories/episodeRepository.js";
import { formatSubjectDetailDto } from "../dto/subjectDto.js";
import { formatDetailEpisodeDto } from "../dto/resourceDto.js";
import {
  DETAIL_FRESH_MS,
  DETAIL_SHORT_TIMEOUT_MS,
  aggregateResourceStatus,
  isFresh,
  proxyCover,
} from "./animeShared.js";
import { refreshSubjectMetadata } from "./metadataRefreshService.js";
import { enabledSourceSet, resourceSourceStatuses } from "./resourceMatchService.js";
import { error } from "../lib/logger.js";

export function collectEpisodeChannels(id) {
  const enabledSources = enabledSourceSet();
  const rows = listEpisodeChannelRowsForSubject(id)
    .filter((row) => enabledSources.has(row.source));

  const channels = new Map();
  for (const row of rows) {
    const key = `${row.source}:${row.source_aid}`;
    if (!channels.has(key)) {
      channels.set(key, {
        id: key,
        name: row.source_label || row.source,
        source: row.source,
        sourceAid: row.source_aid,
        resourceTitle: row.resource_title,
        episodes: [],
      });
    }
    channels.get(key).episodes.push({
      ...formatDetailEpisodeDto({
        subjectId: id,
        channelIndex: channels.size,
        episode: row,
      }),
    });
  }

  return [...channels.values()];
}

function getCachedAnimeDetail(id) {
  const subject = findSubjectById(id);
  if (!subject) return null;
  const channels = collectEpisodeChannels(id);
  const sourceStatuses = resourceSourceStatuses(id);
  return {
    data: formatSubjectDetailDto({
      subject,
      coverUrl: proxyCover(subject.bangumi_id, subject.cover_url, subject.has_cover),
      tags: listSubjectTags(id),
      aliases: listSubjectAliases(id),
      channels,
    }),
    freshness: isFresh(subject.metadata_fetched_at, DETAIL_FRESH_MS) ? "cache" : "stale",
    resourceStatus: aggregateResourceStatus(sourceStatuses),
    resourceSources: sourceStatuses,
  };
}

export async function getAnimeDetail(id) {
  const normalized = getCachedAnimeDetail(id);
  if (normalized) return normalized;

  try {
    await refreshSubjectMetadata(id, { timeoutMs: DETAIL_SHORT_TIMEOUT_MS });
  } catch (err) {
    error("detail", `initial subject fetch failed for ${id}`, err);
    return null;
  }

  return getCachedAnimeDetail(id);
}
