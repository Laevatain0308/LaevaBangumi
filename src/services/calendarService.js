import { sql } from "drizzle-orm";
import { db, sqlite } from "../db/index.js";
import * as bangumi from "./bangumi.js";
import { listSubjectTags } from "../repositories/subjectRepository.js";
import { formatSubjectSearchDto } from "../dto/subjectDto.js";
import { proxyCover } from "./animeShared.js";
import { upsertAnime, enrichFromSubject } from "./subjectSyncService.js";
import {
  enqueueEpisodeRefresh,
  ensureMappingForAnime,
  getEnabledSourceKeys,
} from "./resourceMatchService.js";
import { debug, error, log, warn } from "../lib/logger.js";

function clearStaleCalendarEntries(activeAnimeIds) {
  if (activeAnimeIds.size === 0) {
    warn("calendar", "skip stale calendar cleanup because active anime set is empty");
    return 0;
  }

  const before = sqlite.prepare("SELECT changes() AS changes").get().changes;
  sqlite.prepare(`
    UPDATE subjects
    SET calendar_weekday = NULL,
        calendar_synced_at = NULL,
        updated_at = datetime('now')
    WHERE calendar_weekday IS NOT NULL
      AND bangumi_id NOT IN (${[...activeAnimeIds].map(() => "?").join(", ")})
  `).run(...activeAnimeIds);
  const after = sqlite.prepare("SELECT changes() AS changes").get().changes;
  return after ?? before ?? 0;
}

function groupByWeekday(list, epMap) {
  const weekdayNames = [
    { en: "Mon", cn: "星期一", ja: "月曜日", id: 1 },
    { en: "Tue", cn: "星期二", ja: "火曜日", id: 2 },
    { en: "Wed", cn: "星期三", ja: "水曜日", id: 3 },
    { en: "Thu", cn: "星期四", ja: "木曜日", id: 4 },
    { en: "Fri", cn: "星期五", ja: "金曜日", id: 5 },
    { en: "Sat", cn: "星期六", ja: "土曜日", id: 6 },
    { en: "Sun", cn: "星期日", ja: "日曜日", id: 7 },
  ];

  return weekdayNames.map((wd) => {
    const items = list
      .filter((a) => a.calendarWeekday === wd.id)
      .map((a) => {
        const ep = epMap[a.id];
        return {
          ...formatSubjectSearchDto(a, {
            coverUrl: proxyCover(a.id, a.coverUrl, a.hasCover),
            tags: listSubjectTags(a.id),
          }),
          latestEp: ep?.latestEp ?? null,
          lastUpdated: ep?.lastUpdated ?? null,
          airDate: a.airDate,
        };
      });
    return { weekday: wd, items };
  });
}

export async function syncCalendar({ enqueueEpisodes = true, matchSources = true, calendar: calendarOverride = null } = {}) {
  log("calendar", "sync started", { enqueueEpisodes, matchSources });
  const calendar = calendarOverride ?? await bangumi.getCalendar();
  const stats = { upserted: 0, mapped: 0, queuedEpisodes: 0, staleCleared: 0, errors: 0 };
  const activeAnimeIds = new Set();

  for (const day of calendar) {
    log("calendar", "sync weekday started", { weekday: day.weekday?.id, total: day.items?.length ?? 0 });
    for (const item of day.items) {
      try {
        const a = await upsertAnime(item, day.weekday?.id);
        if (!a) continue;
        sqlite.prepare(`
          UPDATE subjects
          SET calendar_synced_at = datetime('now'),
              calendar_weekday = ?,
              updated_at = datetime('now')
          WHERE bangumi_id = ?
        `).run(day.weekday?.id ?? null, item.id);
        activeAnimeIds.add(item.id);
        stats.upserted++;

        if (!a.detailFetchedAt) {
          try {
            await enrichFromSubject(item.id, day.weekday?.id);
          } catch (err) {
            error("calendar", `enrich failed for ${item.id}`, err);
          }
        }

        if (matchSources) {
          for (const source of getEnabledSourceKeys()) {
            const mapping = await ensureMappingForAnime(item.id, { source });
            if (mapping.matched) {
              stats.mapped++;
            }
            if (enqueueEpisodes && mapping.matched) {
              if (enqueueEpisodeRefresh(item.id, { source })) {
                stats.queuedEpisodes++;
              }
            } else if (enqueueEpisodes && !mapping.matched) {
              debug("calendar", "skip episode refresh without mapping", { animeId: item.id, source, reason: mapping.reason });
            }
          }
        }
      } catch (err) {
        error("calendar", `sync item failed for ${item.id}`, err);
        stats.errors++;
      }
    }
    log("calendar", "sync weekday completed", { weekday: day.weekday?.id, stats });
  }

  if (stats.errors === 0) {
    stats.staleCleared = clearStaleCalendarEntries(activeAnimeIds);
  } else {
    warn("calendar", "skip stale calendar cleanup because sync had errors", { errors: stats.errors });
  }
  log("calendar", "sync completed", stats);
  return stats;
}

export async function getCalendarView() {
  const all = db.all(sql`
    SELECT
      bangumi_id AS id,
      bangumi_id,
      name,
      name_cn,
      name_cn AS nameCn,
      summary,
      cover_url AS coverUrl,
      cover_url,
      has_cover AS hasCover,
      has_cover,
      rating_score AS ratingScore,
      rating_score,
      rating_rank,
      rating_total,
      rating_distribution_json,
      eps,
      total_episodes AS totalEpisodes,
      total_episodes,
      air_date AS airDate,
      air_date,
      air_weekday,
      platform,
      COALESCE(calendar_weekday, air_weekday) AS calendarWeekday
    FROM subjects
  `);
  if (all.length === 0) {
    return { data: [], freshness: "empty", error: "暂无数据，请等待首次同步完成" };
  }

  const epStats = db.all(sql`
    SELECT bangumi_id AS id, ep_index AS latestEp, updated_at AS lastUpdated
    FROM episodes e1
    WHERE updated_at = (
      SELECT MAX(updated_at)
      FROM episodes e2
      WHERE e2.bangumi_id = e1.bangumi_id
    )
  `);
  const epMap = {};
  for (const s of epStats) {
    epMap[s.id] = { latestEp: s.latestEp, lastUpdated: s.lastUpdated };
  }

  return { data: groupByWeekday(all, epMap), freshness: "cache" };
}
