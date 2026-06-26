export const DEFAULT_MEDIA_TYPE = "anime";

export const MEDIA_TYPES = Object.freeze(["anime", "tv", "movie", "variety"]);

export const BANGUMI_SUBJECT_TYPE_BY_MEDIA_TYPE = Object.freeze({
  anime: 2,
  tv: 6,
  movie: 6,
  variety: 6,
});

export const BANGUMI_PLATFORM_MEDIA_TYPES = Object.freeze({
  // Values in this map must come from actual Bangumi API platform responses.
  "华语剧": "tv",
  "欧美剧": "tv",
  "日剧": "tv",
  "电视剧": "tv",
  "电影": "movie",
  "综艺": "variety",
});

export function assertMediaType(value, fallback = DEFAULT_MEDIA_TYPE) {
  const mediaType = value == null || value === "" ? fallback : String(value).trim();
  if (MEDIA_TYPES.includes(mediaType)) return mediaType;
  throw new Error(`unsupported media type: ${value}`);
}

export function mediaTypeForBangumiPlatform(platform) {
  return BANGUMI_PLATFORM_MEDIA_TYPES[String(platform || "").trim()] ?? null;
}

export function mediaTypeForBangumiSubject(subject) {
  if (subject?.type === 2) return "anime";
  if (subject?.type === 6) return mediaTypeForBangumiPlatform(subject.platform);
  return null;
}
