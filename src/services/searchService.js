import * as bangumi from "../clients/bangumiClient.js";
import {
  searchSubjectsByKeyword,
  searchSubjectsByTag,
} from "../repositories/subjectRepository.js";
import { listSubjectTags } from "../repositories/tagRepository.js";
import { formatSubjectSearchDto } from "../dto/subjectDto.js";
import { proxyCover } from "./animeShared.js";
import { upsertAnime } from "./subjectSyncService.js";
import { enqueueMetadataRefresh } from "./metadataRefreshService.js";
import { ensureMappingForAnime, enqueueEpisodeRefresh, getEnabledSourceKeys } from "./resourceMatchService.js";
import { log, error } from "../lib/logger.js";

function formatSubjectSearchRow(row) {
  return formatSubjectSearchDto(row, {
      coverUrl: proxyCover(row.bangumi_id, row.cover_url),
    tags: listSubjectTags(row.bangumi_id),
  });
}

export async function searchAnime(keyword) {
  if (keyword && typeof keyword === "object") {
    if (keyword.tag) return searchAnimeByTag(keyword.tag);
    keyword = keyword.q || "";
  }
  const normalized = searchSubjectsByKeyword(keyword);
  return {
    data: normalized.map(formatSubjectSearchRow),
    freshness: "cache",
  };
}

export async function searchAnimeByTag(tag) {
  return {
    data: searchSubjectsByTag(tag).map(formatSubjectSearchRow),
    freshness: "cache",
  };
}

export async function enrichFromBangumiSearch(keyword) {
  log("search", "bangumi search started", { keyword });
  let subjects;
  try {
    const bgResult = await bangumi.searchSubjects(keyword);
    subjects = bgResult?.data || [];
  } catch (err) {
    error("search", "bangumi search failed", err);
    return { upserted: 0, queuedMetadata: 0, matched: 0, queuedEpisodes: 0, errors: 1 };
  }

  const stats = { upserted: 0, queuedMetadata: 0, matched: 0, queuedEpisodes: 0, errors: 0 };
  log("search", "bangumi search returned", { keyword, total: subjects.length });
  for (const item of subjects) {
    try {
      const a = await upsertAnime(item);
      if (!a) continue;
      stats.upserted++;

      if (!a.detailFetchedAt && enqueueMetadataRefresh(item.id)) stats.queuedMetadata++;

      for (const source of getEnabledSourceKeys()) {
        const mapping = await ensureMappingForAnime(item.id, { source });
        if (mapping.matched) {
          stats.matched++;
          if (enqueueEpisodeRefresh(item.id, { source })) {
            stats.queuedEpisodes++;
          }
        }
      }
    } catch (err) {
      error("search", `search item failed for ${item.id}`, err);
      stats.errors++;
    }
  }
  log("search", "bangumi search processing completed", { keyword, ...stats });
  return stats;
}
