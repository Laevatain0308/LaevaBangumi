import { db, sqlite } from "../db/index.js";
import { animeOther, ANIME_PLATFORMS } from "../db/schema.js";
import * as bangumi from "./bangumi.js";
import { downloadCover } from "../lib/cover.js";
import { collectBangumiTitles } from "../lib/matcher.js";
import { normalizeBangumiSubject, normalizeCoverUrl } from "../normalizers/bangumiSubjectNormalizer.js";
import {
  findSubjectById,
  listSubjectAliases,
  upsertSubjectMetadata as writeSubjectMetadata,
} from "../repositories/subjectRepository.js";
import { deleteResourceRowsForSubject } from "../repositories/resourceRepository.js";
import { compactRow, now, safeJson } from "./animeShared.js";
import { debug, log } from "../lib/logger.js";

export { normalizeCoverUrl };

export function subjectRowToAnimeFacade(row) {
  if (!row) return null;
  return {
    id: row.bangumi_id,
    name: row.name,
    nameCn: row.name_cn,
    aliases: JSON.stringify(listSubjectAliases(row.bangumi_id)),
    platform: row.platform,
    airDate: row.air_date,
    airWeekday: row.air_weekday,
    calendarWeekday: row.calendar_weekday,
    eps: row.eps,
    totalEpisodes: row.total_episodes,
    summary: row.summary,
    coverUrl: row.cover_url,
    hasCover: row.has_cover,
    ratingScore: row.rating_score,
    rank: row.rating_rank,
    detailFetchedAt: row.metadata_fetched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findAnimeFacadeById(id) {
  return subjectRowToAnimeFacade(findSubjectById(id));
}

export function listAnimeFacades({ ids = null } = {}) {
  const params = [];
  let where = "";
  if (ids) {
    const normalizedIds = [...ids].map((id) => parseInt(id, 10)).filter(Boolean);
    if (normalizedIds.length === 0) return [];
    where = `WHERE bangumi_id IN (${normalizedIds.map(() => "?").join(", ")})`;
    params.push(...normalizedIds);
  }
  return sqlite.prepare(`
    SELECT * FROM subjects
    ${where}
    ORDER BY bangumi_id
  `).all(...params).map(subjectRowToAnimeFacade);
}

export function animeRowToBangumiLike(a) {
  return {
    id: a.id,
    name: a.name,
    name_cn: a.nameCn,
    aliases: safeJson(a.aliases, []),
    air_date: a.airDate,
    air_weekday: a.airWeekday,
    eps: a.eps,
    total_episodes: a.totalEpisodes,
    platform: a.platform,
  };
}

export function titleNamesForAnime(a) {
  return collectBangumiTitles(animeRowToBangumiLike(a));
}

function deleteAnimeDependencies(animeId) {
  deleteResourceRowsForSubject({ bangumiId: animeId });
  sqlite.prepare("DELETE FROM subjects WHERE bangumi_id = ?").run(animeId);
}

export function ensureSubjectFromAnime(animeId) {
  return !!findSubjectById(animeId);
}

export async function upsertAnime(item, weekday = undefined, options = {}) {
  const platform = item.platform || null;
  const normalized = normalizeBangumiSubject(item, weekday, { ...options, now });

  if (platform && !ANIME_PLATFORMS.has(platform)) {
    log("anime", "skip non-anime subject", { id: item.id, name: item.name, platform });
    deleteAnimeDependencies(item.id);
    db.insert(animeOther)
      .values(compactRow({
        id: item.id,
        name: item.name,
        nameCn: normalized.subject.name_cn,
        summary: normalized.subject.summary,
        platform,
        coverUrl: normalized.subject.cover_url,
        tags: normalized.tags === undefined ? undefined : JSON.stringify(normalized.tags.map((tag) => tag.name)),
        aliases: normalized.aliases === undefined ? undefined : JSON.stringify(normalized.aliases),
      }))
      .onConflictDoNothing()
      .run();
    return null;
  }

  writeSubjectMetadata(normalized);
  debug("anime", "upserted subject", { id: item.id, title: item.name_cn || item.name, detailFetched: !!options.detailFetched });

  const coverUrl = normalized.subject.cover_url;
  if (coverUrl) {
    downloadCover(item.id, coverUrl).then((ok) => {
      if (ok) {
        sqlite.prepare("UPDATE subjects SET has_cover = 1 WHERE bangumi_id = ?").run(item.id);
      }
    }).catch(() => {});
  }

  return findAnimeFacadeById(item.id);
}

export async function enrichFromSubject(itemOrId, weekday = undefined, options = {}) {
  const id = typeof itemOrId === "object" ? itemOrId.id : itemOrId;
  log("bangumi", "fetch subject detail", { id, timeoutMs: options.timeoutMs });
  const subject = await bangumi.getSubject(id, { timeoutMs: options.timeoutMs });
  if (!subject) return null;
  return upsertAnime(subject, weekday, { detailFetched: true });
}
