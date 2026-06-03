import * as cstation from "./cstation.js";
import { buildCoverProxyUrl } from "../lib/coverProxyUrl.js";
import { normalizeCoverUrl } from "../normalizers/bangumiSubjectNormalizer.js";

export const DETAIL_FRESH_MS = 12 * 60 * 60 * 1000;
export const DETAIL_SHORT_TIMEOUT_MS = 3500;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const RETRY_DELAYS = [10, 20, 40, 80, 160];
export const MAX_RETRIES = RETRY_DELAYS.length;
export const AUTO_MATCH_SCORE = 0.8;
export const DEFAULT_MAPPING_RETRY_BATCH_LIMIT = 20;
export const DEFAULT_EPISODE_FETCH_RETRY_BATCH_LIMIT = 30;
export const MANUAL_MATCH_BLOCKING_STATUSES = new Set(["wait_airing", "no_resource", "source_already_mapped"]);
export const MANUAL_NO_DATA_STATUSES = new Set(["no_resource", "source_already_mapped"]);

export function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function fromNow(minutes) {
  const d = new Date(Date.now() + minutes * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function isFresh(timestamp, windowMs) {
  if (!timestamp) return false;
  return (Date.now() - new Date(timestamp).getTime()) < windowMs;
}

export function parseTimestamp(value) {
  return cstation.parseLastTime(value);
}

export function normalizeTimestamp(value) {
  const ms = parseTimestamp(value);
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

export function parseUpdateNow(value) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return Date.parse(`${value}T23:59:59+08:00`);
  }
  return parseTimestamp(value);
}

export function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

export function compactRow(row) {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
}

export function proxyCover(id, coverUrl, hasCover) {
  const normalizedCoverUrl = normalizeCoverUrl(coverUrl);
  const externalProxyUrl = buildCoverProxyUrl({ id, sourceUrl: normalizedCoverUrl });
  if (externalProxyUrl) return externalProxyUrl;
  if (hasCover) return `/anime/api/cover?id=${id}`;
  return normalizedCoverUrl;
}

export function retryStateRowToFacade(row) {
  return {
    animeId: row.bangumi_id,
    source: row.source,
    retryCount: row.retry_count,
    retryAt: row.retry_at,
    updatedAt: row.updated_at,
  };
}

export function applyBatchLimit(rows, limit) {
  if (limit == null) return { rows, limited: false, total: rows.length };
  const parsed = parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return { rows, limited: false, total: rows.length };
  return {
    rows: rows.slice(0, parsed),
    limited: rows.length > parsed,
    total: rows.length,
  };
}

export function aggregateResourceStatus(sourceStatuses) {
  if (sourceStatuses.some((row) => row.status === "ready")) return "ready";
  if (sourceStatuses.some((row) => row.status === "fetching")) return "fetching";
  if (sourceStatuses.some((row) => row.status === "matching")) return "matching";
  if (sourceStatuses.some((row) => row.status === "retrying")) return "retrying";
  if (sourceStatuses.some((row) => row.status === "wait_airing")) return "wait_airing";
  if (sourceStatuses.some((row) => row.status === "no_data")) return "no_data";
  return "no_data";
}
