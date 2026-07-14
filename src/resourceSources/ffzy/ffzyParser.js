import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "video" || name === "dd",
});

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`FFZY ${label} must be a positive integer`);
  }
  return parsed;
}

function parsePage(xml) {
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (cause) {
    throw new TypeError("FFZY XML is invalid", { cause });
  }
  const list = parsed?.rss?.list;
  if (list == null || typeof list !== "object") {
    throw new TypeError("FFZY XML requires an rss list");
  }
  return {
    list,
    page: requirePositiveInteger(list["@_page"], "page"),
    pageCount: requirePositiveInteger(list["@_pagecount"], "pagecount"),
    recordCount: Number.isInteger(Number(list["@_recordcount"]))
      ? Number(list["@_recordcount"])
      : 0,
  };
}

function parseShanghaiTimestamp(value) {
  if (value == null || String(value).trim() === "") return null;
  const match = String(value).trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) throw new TypeError(`FFZY timestamp is invalid: ${value}`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(localAsUtc);
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
    || check.getUTCHours() !== hour
    || check.getUTCMinutes() !== minute
    || check.getUTCSeconds() !== second
  ) {
    throw new TypeError(`FFZY timestamp is invalid: ${value}`);
  }
  return new Date(localAsUtc - (8 * 60 * 60 * 1000)).toISOString();
}

function allowedVideo(video, allowedCategoryIds) {
  return allowedCategoryIds.has(String(video?.tid ?? ""));
}

function commonItem(video, sourceKey) {
  const sourceItemId = String(video?.id ?? "").trim();
  const title = String(video?.name ?? "").trim();
  if (!sourceItemId) throw new TypeError("FFZY video id must be non-empty");
  if (!title) throw new TypeError(`FFZY video ${sourceItemId} name must be non-empty`);
  return {
    sourceKey,
    sourceItemId,
    title,
    aliases: [],
    year: video?.year == null || String(video.year).trim() === ""
      ? null
      : String(video.year).trim(),
    sourceUpdatedAt: parseShanghaiTimestamp(video?.last),
  };
}

function parseAliases(value, title) {
  if (value == null) return [];
  return [...new Set(String(value)
    .split(/[,，/]/)
    .map((alias) => alias.trim())
    .filter((alias) => alias && alias !== title))];
}

export function parseEpisodes(dl, mediaFlag = "ffm3u8") {
  const playlists = Array.isArray(dl?.dd) ? dl.dd : dl?.dd == null ? [] : [dl.dd];
  const entries = [];
  for (const playlist of playlists) {
    if (playlist?.["@_flag"] !== mediaFlag) continue;
    for (const part of String(playlist?.["#text"] ?? "").split("#")) {
      const separator = part.lastIndexOf("$");
      if (separator < 0) continue;
      const title = part.slice(0, separator).trim();
      const videoUrl = part.slice(separator + 1).trim();
      if (!title || !videoUrl) continue;
      entries.push({ title, videoUrl });
    }
  }
  return entries.map((episode, index) => ({ episodeIndex: index + 1, ...episode }));
}

function optionsFor({ sourceKey = "ffzy", allowedCategoryIds = ["29", "30", "31"] } = {}) {
  return { sourceKey, allowedCategoryIds: new Set(allowedCategoryIds.map(String)) };
}

export function parseCatalogXml(xml, options = {}) {
  const { sourceKey, allowedCategoryIds } = optionsFor(options);
  const { list, page, pageCount, recordCount } = parsePage(xml);
  const videos = Array.isArray(list.video) ? list.video : list.video == null ? [] : [list.video];
  return {
    page,
    pageCount,
    recordCount,
    items: videos
      .filter((video) => allowedVideo(video, allowedCategoryIds))
      .map((video) => commonItem(video, sourceKey)),
  };
}

export function parseDetailXml(xml, options = {}) {
  const { sourceKey, allowedCategoryIds } = optionsFor(options);
  const { list, page, pageCount, recordCount } = parsePage(xml);
  const videos = Array.isArray(list.video) ? list.video : list.video == null ? [] : [list.video];
  return {
    page,
    pageCount,
    recordCount,
    items: videos
      .filter((video) => allowedVideo(video, allowedCategoryIds))
      .map((video) => {
        const item = commonItem(video, sourceKey);
        return {
          ...item,
          aliases: parseAliases(video.subname, item.title),
          episodes: parseEpisodes(video.dl),
        };
      }),
  };
}
