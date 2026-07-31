export const DEFAULT_MEDIA_TYPE = "anime";

export const MEDIA_TYPES = Object.freeze(["anime"]);

export function assertMediaType(value, fallback = DEFAULT_MEDIA_TYPE) {
  const mediaType = value == null || value === "" ? fallback : String(value).trim();
  if (MEDIA_TYPES.includes(mediaType)) return mediaType;
  throw new Error(`unsupported media type: ${value}`);
}
