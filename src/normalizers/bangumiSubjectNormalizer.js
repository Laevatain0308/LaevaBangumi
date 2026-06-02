import { collectBangumiTitles } from "../lib/matcher.js";

function defaultNow() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function resolveNow(clock) {
  return typeof clock === "function" ? clock() : clock;
}

function isBlank(value) {
  return typeof value === "string" && value.trim() === "";
}

function knownOrSkip(value, detailFetched) {
  if (value === undefined) return detailFetched ? null : undefined;
  if (value === null) return detailFetched ? null : undefined;
  if (isBlank(value)) return detailFetched ? null : undefined;
  return value;
}

function compactRow(row) {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
}

export function normalizeCoverUrl(url) {
  if (!url) return null;
  return String(url)
    .replace(/^http:\/\//, "https://")
    .replace("/r/400/pic/cover/", "/pic/cover/");
}

function coverFromItem(item) {
  return normalizeCoverUrl((item.images && (item.images.large || item.images.common)) || item.image || null);
}

function infoboxValue(infobox, keys) {
  if (!Array.isArray(infobox)) return undefined;
  const wanted = Array.isArray(keys) ? keys : [keys];
  const item = infobox.find((box) => wanted.includes(box.key));
  if (!item) return undefined;
  if (Array.isArray(item.value)) return item.value.map((v) => v.v || v.value || v).filter(Boolean).join(" / ");
  return item.value;
}

export function normalizeDateValue(value) {
  if (!value) return value;
  const text = String(value).trim();
  const cn = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (cn) return `${cn[1]}-${cn[2].padStart(2, "0")}-${cn[3].padStart(2, "0")}`;
  const cnMonth = text.match(/^(\d{4})年(\d{1,2})月$/);
  if (cnMonth) return `${cnMonth[1]}-${cnMonth[2].padStart(2, "0")}`;
  const cnYear = text.match(/^(\d{4})年$/);
  if (cnYear) return cnYear[1];
  return text;
}

function dateFromItem(item) {
  return normalizeDateValue(item.date ?? item.air_date ?? infoboxValue(item.infobox, "放送开始"));
}

function intFromItem(value) {
  if (value == null || value === "") return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function positiveIntFromItem(value) {
  const parsed = intFromItem(value);
  return parsed && parsed > 0 ? parsed : undefined;
}

function rankFromItem(item) {
  return positiveIntFromItem(item.rating?.rank ?? item.rank);
}

function epsFromItem(item) {
  return positiveIntFromItem(item.eps) ?? positiveIntFromItem(infoboxValue(item.infobox, "话数"));
}

function totalEpisodesFromItem(item) {
  return positiveIntFromItem(item.total_episodes) ?? epsFromItem(item);
}

function weekdayFromDate(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function tagName(tag) {
  return typeof tag === "string" ? tag : tag.name;
}

function tagsFromItem(item, detailFetched) {
  if (Array.isArray(item.meta_tags)) return JSON.stringify(item.meta_tags);
  if (Array.isArray(item.tags)) return JSON.stringify(item.tags.map(tagName).filter(Boolean).slice(0, 8));
  return detailFetched ? "[]" : undefined;
}

function aliasesFromItem(item, detailFetched) {
  const titles = collectBangumiTitles(item).filter((title) => title !== item.name && title !== item.name_cn);
  if (titles.length > 0) return JSON.stringify(titles);
  return detailFetched ? "[]" : undefined;
}

function ratingDistributionFromItem(item) {
  const count = item.rating?.count;
  if (!count || typeof count !== "object") return [];
  return Array.from({ length: 10 }, (_, index) => Number(count[String(index + 1)] ?? count[index + 1] ?? 0));
}

function ratingTotalFromItem(item) {
  const total = item.rating?.total ?? item.rating?.votes ?? item.votes;
  const parsed = intFromItem(total);
  return parsed === undefined ? undefined : parsed;
}

function normalizedTagsFromItem(item, detailFetched) {
  if (!Array.isArray(item.tags)) return detailFetched ? [] : undefined;
  return item.tags
    .map((tag) => {
      if (typeof tag === "string") return { name: tag, count: 0, totalCount: 0 };
      return {
        name: tag.name,
        count: intFromItem(tag.count) ?? 0,
        totalCount: intFromItem(tag.total_count ?? tag.totalCount) ?? intFromItem(tag.count) ?? 0,
      };
    })
    .filter((tag) => tag.name)
    .slice(0, 24);
}

function normalizedAliasesFromItem(item, detailFetched) {
  const aliases = collectBangumiTitles(item).filter((title) => title !== item.name && title !== item.name_cn);
  if (aliases.length > 0) return aliases;
  return detailFetched ? [] : undefined;
}

export function normalizeBangumiSubject(item, weekday, { detailFetched = false, now = defaultNow } = {}) {
  const timestamp = resolveNow(now);
  const airDate = dateFromItem(item);
  const coverUrl = coverFromItem(item);
  const ratingDistribution = ratingDistributionFromItem(item);

  return {
    subject: compactRow({
      bangumi_id: item.id,
      type: intFromItem(item.type) ?? 2,
      name: item.name || item.name_cn || `#${item.id}`,
      name_cn: knownOrSkip(item.name_cn, detailFetched),
      summary: knownOrSkip(item.summary, detailFetched),
      air_date: knownOrSkip(airDate, detailFetched),
      air_weekday: knownOrSkip(item.air_weekday ?? weekdayFromDate(airDate), detailFetched),
      calendar_weekday: weekday,
      eps: knownOrSkip(epsFromItem(item), detailFetched),
      total_episodes: knownOrSkip(totalEpisodesFromItem(item), detailFetched),
      platform: knownOrSkip(item.platform, detailFetched),
      cover_url: knownOrSkip(coverUrl, detailFetched),
      rating_score: knownOrSkip(item.rating?.score, detailFetched),
      rating_rank: knownOrSkip(rankFromItem(item), detailFetched),
      rating_total: knownOrSkip(ratingTotalFromItem(item), detailFetched),
      rating_distribution_json: ratingDistribution.length > 0
        ? JSON.stringify(ratingDistribution)
        : (detailFetched ? "[]" : undefined),
      metadata_fetched_at: detailFetched ? timestamp : undefined,
      rating_fetched_at: item.rating ? timestamp : undefined,
      updated_at: timestamp,
    }),
    aliases: normalizedAliasesFromItem(item, detailFetched),
    tags: normalizedTagsFromItem(item, detailFetched),
    legacyAnime: compactRow({
      id: item.id,
      name: item.name,
      nameCn: knownOrSkip(item.name_cn, detailFetched),
      summary: knownOrSkip(item.summary, detailFetched),
      airDate: knownOrSkip(airDate, detailFetched),
      airWeekday: knownOrSkip(item.air_weekday ?? weekdayFromDate(airDate), detailFetched),
      eps: knownOrSkip(epsFromItem(item), detailFetched),
      totalEpisodes: knownOrSkip(totalEpisodesFromItem(item), detailFetched),
      platform: knownOrSkip(item.platform, detailFetched),
      coverUrl: knownOrSkip(coverUrl, detailFetched),
      ratingScore: knownOrSkip(item.rating?.score, detailFetched),
      rank: knownOrSkip(rankFromItem(item), detailFetched),
      tags: tagsFromItem(item, detailFetched),
      aliases: aliasesFromItem(item, detailFetched),
      calendarWeekday: weekday,
      detailFetchedAt: detailFetched ? timestamp : undefined,
      updatedAt: timestamp,
    }),
  };
}
