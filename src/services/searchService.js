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
import { log, error } from "../lib/logger.js";
import { assertMediaType, mediaTypeForBangumiSubject } from "../lib/mediaTypes.js";

function formatSubjectSearchRow(row) {
  return formatSubjectSearchDto(row, {
      coverUrl: proxyCover(row.bangumi_id, row.cover_url),
    tags: listSubjectTags(row.bangumi_id),
  });
}

export async function searchAnime(keyword, { mediaType = "anime" } = {}) {
  if (keyword && typeof keyword === "object") {
    mediaType = keyword.mediaType ?? keyword.type ?? mediaType;
    if (keyword.tag) return searchAnimeByTag(keyword.tag, { mediaType });
    keyword = keyword.q || "";
  }
  const normalizedMediaType = assertMediaType(mediaType);
  const normalized = searchSubjectsByKeyword(keyword, { mediaType: normalizedMediaType });
  return {
    data: normalized.map(formatSubjectSearchRow),
    freshness: "cache",
  };
}

export async function searchAnimeByTag(tag, { mediaType = "anime" } = {}) {
  const normalizedMediaType = assertMediaType(mediaType);
  return {
    data: searchSubjectsByTag(tag, { mediaType: normalizedMediaType }).map(formatSubjectSearchRow),
    freshness: "cache",
  };
}

export async function enrichFromBangumiSearch(keyword, {
  mediaType = "anime",
  metadataService,
  searchSubjects = bangumi.searchSubjects,
} = {}) {
  const normalizedMediaType = assertMediaType(mediaType);
  log("search", "bangumi search started", { keyword, mediaType: normalizedMediaType });
  let subjects;
  try {
    const bgResult = await searchSubjects(keyword, { mediaType: normalizedMediaType });
    subjects = (bgResult?.data || [])
      .filter((item) => mediaTypeForBangumiSubject(item) === normalizedMediaType);
  } catch (err) {
    error("search", "bangumi search failed", err);
    return { upserted: 0, queuedMetadata: 0, matched: 0, queuedEpisodes: 0, errors: 1 };
  }

  const stats = { upserted: 0, queuedMetadata: 0, matched: 0, queuedEpisodes: 0, errors: 0 };
  log("search", "bangumi search returned", { keyword, total: subjects.length });
  for (const item of subjects) {
    try {
      const a = await upsertAnime(item, undefined, { mediaType: normalizedMediaType });
      if (!a) continue;
      stats.upserted++;

      if (!a.detailFetchedAt && enqueueMetadataRefresh(item.id)) stats.queuedMetadata++;

    } catch (err) {
      error("search", `search item failed for ${item.id}`, err);
      stats.errors++;
    }
  }
  try {
    metadataService?.persistSearchResults(subjects);
  } catch (err) {
    error("search", "Bangumi metadata persistence failed", err);
    stats.errors++;
  }
  log("search", "bangumi search processing completed", { keyword, ...stats });
  return stats;
}
