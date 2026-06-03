import { XMLParser } from "fast-xml-parser";
import { log, warn } from "../lib/logger.js";
import { getCategoryIds, getEnabledSources, getSourceConfig } from "../lib/cstationConfig.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "video" || name === "dd",
});

/** 从原始 dd 数据提取 m3u8 */
export function parseEpisodes(dl, { mediaFlag = "ffm3u8" } = {}) {
  if (!dl || !dl.dd) return [];

  const ddList = Array.isArray(dl.dd) ? dl.dd : [dl.dd];
  const episodes = [];

  for (const dd of ddList) {
    if (dd["@_flag"] !== mediaFlag) continue;
    const raw = String(dd["#text"] || "");
    const entries = raw.split("#")
      .map(parsePlayEntry)
      .filter(Boolean);
    const usedIndexes = new Set([
      ...episodes.map((ep) => ep.epIndex),
      ...entries.map((entry) => entry.explicitIndex).filter((value) => value != null),
    ]);
    let nextFallbackIndex = 1;

    for (const entry of entries) {
      const epIndex = entry.explicitIndex ?? nextAvailableIndex(usedIndexes, nextFallbackIndex);
      usedIndexes.add(epIndex);
      nextFallbackIndex = epIndex + 1;
      episodes.push({ epIndex, epName: entry.label, videoUrl: entry.url });
    }
  }

  return episodes;
}

function parsePlayEntry(part) {
  const sep = part.lastIndexOf("$");
  if (sep === -1) return null;
  const label = part.slice(0, sep).trim();
  const url = part.slice(sep + 1).trim();
  if (!url) return null;
  return { label, url, explicitIndex: extractEpIndex(label) };
}

function nextAvailableIndex(usedIndexes, start) {
  let index = Math.max(1, start);
  while (usedIndexes.has(index)) index++;
  return index;
}

function extractEpIndex(label) {
  const text = String(label || "").trim();
  const patterns = [
    /第\s*0*(\d+)\s*(?:集|话|話|回|期|章|幕)/i,
    /(?:^|[\s._-])(?:ep|episode|e)\s*0*(\d+)(?:$|[\s._-])/i,
    /^0*(\d+)\s*(?:集|话|話|回|期|章|幕)$/i,
    /^0*(\d+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/** 搜索并根据 XML raw 提取完整信息（按分类依次尝试，命中即停） */
export async function searchAndParse(keyword, { page = 1, source } = {}) {
  const sourceConfig = getSourceConfig(source);
  for (const t of getCategoryIds(source)) {
    const params = new URLSearchParams({
      ac: "detail", wd: keyword, t, pg: String(page),
    });
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), sourceConfig.timeoutMs);
      const res = await fetch(`${sourceConfig.apiEndpoint}?${params}`, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = xmlParser.parse(xml);
      const result = parseFullResponse(parsed, sourceConfig);
      if (result.videos.length > 0) return result;
    } catch {
      continue;
    }
  }
  return { videos: [], pagecount: 1 };
}

function parseFullResponse(parsed, sourceConfig) {
  const list = parsed?.rss?.list;
  if (!list) return { videos: [], pagecount: 1 };

  const raw = list.video || [];
  const pagecount = parseInt(list["@_pagecount"], 10) || 1;

  const videos = raw.map((v) => {
    const episodes = parseEpisodes(v.dl || {}, { mediaFlag: sourceConfig.mediaFlag });
    return {
      id: parseInt(v.id, 10),
      name: v.name || "",
      subname: v.subname || "",
      type: v.type || "",
      pic: v.pic || "",
      lang: v.lang || "",
      area: v.area || "",
      year: v.year || "",
      note: v.note || "",
      last: v.last || "",
      actor: v.actor || "",
      director: v.director || "",
      des: v.des || "",
      sourceName: sourceConfig.key,
      episodes,
      epCount: episodes.length,
    };
  });

  return { videos, pagecount };
}

/** 按采集站 ID 获取完整剧集信息 */
export async function fetchById(id, { source } = {}) {
  const sourceConfig = getSourceConfig(source);
  log("cstation", "fetch detail by id", { source, id });
  const params = new URLSearchParams({ ac: "detail", ids: String(id) });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), sourceConfig.timeoutMs);
  try {
    const res = await fetch(`${sourceConfig.apiEndpoint}?${params}`, { signal: ac.signal });
    if (!res.ok) return null;
    const parsed = xmlParser.parse(await res.text());
    const videos = parseFullResponse(parsed, sourceConfig).videos;
    return videos.find((v) => v.id === id) || null;
  } catch (err) {
    warn("cstation", "fetch detail by id failed", { source, id, message: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 批量按采集站 ID 获取详情。FFZY 支持 ids 逗号分隔；失败时返回空数组。 */
export async function fetchByIds(ids, { source } = {}) {
  const sourceConfig = getSourceConfig(source);
  const cleanIds = [...new Set(ids.map((id) => parseInt(id, 10)).filter(Boolean))];
  if (cleanIds.length === 0) return [];

  log("cstation", "fetch detail by ids", { source, total: cleanIds.length });
  const params = new URLSearchParams({ ac: "detail", ids: cleanIds.join(",") });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), sourceConfig.timeoutMs);
  try {
    const res = await fetch(`${sourceConfig.apiEndpoint}?${params}`, { signal: ac.signal });
    if (!res.ok) return [];
    const parsed = xmlParser.parse(await res.text());
    return parseFullResponse(parsed, sourceConfig).videos;
  } catch (err) {
    warn("cstation", "fetch detail by ids failed", { source, total: cleanIds.length, message: err.message });
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ── 目录拉取 ────────────────────────────────────────────

async function fetchPage(ac, t, pg, sourceConfig) {
  const params = new URLSearchParams({ ac, t, pg: String(pg) });
  const acCtrl = new AbortController();
  const timer = setTimeout(() => acCtrl.abort(), sourceConfig.catalogTimeoutMs);
  try {
    const res = await fetch(`${sourceConfig.apiEndpoint}?${params}`, { signal: acCtrl.signal });
    if (!res.ok) return null;
    return xmlParser.parse(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCatalog({ t, source } = {}) {
  const sourceConfig = getSourceConfig(source);
  log("cstation", "fetch full catalog started", { source, category: t });
  const catalog = [];
  let parsed = await fetchPage("list", t, 1, sourceConfig);
  if (!parsed) return catalog;

  const list = parsed?.rss?.list;
  const pagecount = parseInt(list?.["@_pagecount"], 10) || 1;
  log("cstation", "fetch full catalog pagecount", { source, category: t, pagecount });
  addPageItems(catalog, list, t);

  for (let pg = 2; pg <= pagecount; pg++) {
    parsed = await fetchPage("list", t, pg, sourceConfig);
    if (parsed) addPageItems(catalog, parsed.rss?.list, t);
    if (pg % 10 === 0) {
      log("cstation", "fetch full catalog progress", { source, category: t, page: pg, pagecount, items: catalog.length });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  log("cstation", "fetch full catalog completed", { source, category: t, pagecount, items: catalog.length });
  return catalog;
}

/**
 * 基于采集站 last 倒序分页的增量目录拉取。
 * sinceLastSeenAt 为空时退化为全量拉取；overlapMs 用于容忍同秒/轻微乱序。
 */
export async function fetchCatalogIncremental({ t, source, sinceLastSeenAt = null, overlapMs = 5 * 60 * 1000 } = {}) {
  const sourceConfig = getSourceConfig(source);
  log("cstation", "fetch incremental catalog started", { source, category: t, sinceLastSeenAt });
  const catalog = [];
  let maxLast = sinceLastSeenAt || null;
  let completed = false;

  let parsed = await fetchPage("list", t, 1, sourceConfig);
  if (!parsed) return { catalog, maxLast, completed: true, pagesRead: 0, pagecount: 0 };

  const firstList = parsed?.rss?.list;
  const pagecount = parseInt(firstList?.["@_pagecount"], 10) || 1;
  log("cstation", "fetch incremental catalog pagecount", { source, category: t, pagecount });

  for (let pg = 1; pg <= pagecount; pg++) {
    const list = pg === 1 ? firstList : (await fetchPage("list", t, pg, sourceConfig))?.rss?.list;
    if (!list) continue;

    const pageItems = parseCatalogItems(list, t);
    for (const item of pageItems) {
      if (isNewerLast(item.last, maxLast)) maxLast = item.last;
      if (isOlderThanWatermark(item.last, sinceLastSeenAt, overlapMs)) {
        completed = true;
        break;
      }
      catalog.push(item);
    }

    if (completed) {
      log("cstation", "fetch incremental catalog completed", { source, category: t, pagesRead: pg, pagecount, items: catalog.length, maxLast });
      return { catalog, maxLast, completed: true, pagesRead: pg, pagecount };
    }
    if (pg % 10 === 0) {
      log("cstation", "fetch incremental catalog progress", { source, category: t, page: pg, pagecount, items: catalog.length });
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  log("cstation", "fetch incremental catalog completed", { source, category: t, pagesRead: pagecount, pagecount, items: catalog.length, maxLast });
  return { catalog, maxLast, completed: true, pagesRead: pagecount, pagecount };
}

function addPageItems(catalog, list, category) {
  catalog.push(...parseCatalogItems(list, category));
}

function parseCatalogItems(list, category) {
  if (!list?.video) return [];
  return list.video.map((v) => ({
    id: parseInt(v.id, 10),
    name: v.name || "",
    subname: v.subname || null,
    year: v.year || null,
    last: v.last || null,
    category,
  }));
}

export function parseLastTime(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace("T", " ");
  const ms = Date.parse(normalized.includes("Z") ? normalized : `${normalized.replace(" ", "T")}+08:00`);
  return Number.isNaN(ms) ? null : ms;
}

function isNewerLast(candidate, current) {
  const c = parseLastTime(candidate);
  const cur = parseLastTime(current);
  if (c == null) return false;
  if (cur == null) return true;
  return c > cur;
}

function isOlderThanWatermark(last, watermark, overlapMs) {
  const itemMs = parseLastTime(last);
  const watermarkMs = parseLastTime(watermark);
  if (itemMs == null || watermarkMs == null) return false;
  return itemMs < watermarkMs - overlapMs;
}

export function sourceKeys() {
  return getEnabledSources().map((source) => source.key);
}
