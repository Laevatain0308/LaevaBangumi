import { getEnabledSources } from "../lib/cstationConfig.js";
import {
  deleteManualResourceStateByStatus,
  deleteRetryState,
  findManualResourceState,
  upsertManualResourceState,
  upsertRetryState,
} from "../repositories/resourceRepository.js";

const BANGUMI_BUSINESS_TIME_ZONE = "Asia/Shanghai";
const bangumiDatePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BANGUMI_BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function normalizeDateParts(value) {
  if (!value) return null;
  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return {
      precision: "day",
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
  }
  match = text.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    return {
      precision: "month",
      year: Number(match[1]),
      month: Number(match[2]),
      day: null,
    };
  }
  match = text.match(/^(\d{4})$/);
  if (match) {
    return {
      precision: "year",
      year: Number(match[1]),
      month: null,
      day: null,
    };
  }
  return null;
}

function resolveNow(now = new Date()) {
  return typeof now === "function" ? now() : now;
}

function nowParts(now = new Date()) {
  const resolved = resolveNow(now);
  const date = resolved instanceof Date ? resolved : new Date(resolved);
  const parts = Object.fromEntries(
    bangumiDatePartsFormatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function compareAirDate(dateParts, currentParts) {
  if (!dateParts) return "unknown";
  if (dateParts.precision === "day") {
    if (currentParts.year < dateParts.year) return "future";
    if (currentParts.year > dateParts.year) return "started";
    if (currentParts.month < dateParts.month) return "future";
    if (currentParts.month > dateParts.month) return "started";
    if (currentParts.day < dateParts.day) return "future";
    return "started";
  }
  if (dateParts.precision === "month") {
    if (currentParts.year < dateParts.year) return "future";
    if (currentParts.year > dateParts.year) return "started";
    if (currentParts.month < dateParts.month) return "future";
    return "started";
  }
  if (dateParts.precision === "year") {
    if (currentParts.year < dateParts.year) return "future";
    return "started";
  }
  return "unknown";
}

function waitAiringNote(subject) {
  const airDate = subject?.air_date ?? subject?.airDate ?? null;
  return airDate ? `等待开播：${airDate}` : "等待开播";
}

function clearRetryState(bangumiId, source) {
  upsertRetryState({ bangumiId, source, kind: "mapping", retryCount: 0, retryAt: null });
  deleteRetryState({ bangumiId, source, kind: "episode_fetch" });
}

function syncSingleSourceState({ bangumiId, source, status, note }) {
  const existing = findManualResourceState({ bangumiId, source });
  if (status === "started") {
    if (existing?.status !== "wait_airing") return { action: "ignored" };
    deleteManualResourceStateByStatus({ bangumiId, source, status: "wait_airing" });
    clearRetryState(bangumiId, source);
    return { action: "cleared" };
  }
  if (status === "future") {
    if (existing && existing.status !== "wait_airing") return { action: "ignored" };
    if (existing?.status === "wait_airing") return { action: "ignored" };
    upsertManualResourceState({ bangumiId, source, status: "wait_airing", note });
    return { action: "written" };
  }
  return { action: "ignored" };
}

export function syncWaitAiringStateForAnime(subject, { sourceKeys = null, now = new Date() } = {}) {
  if (!subject?.bangumi_id && !subject?.id) return { written: 0, cleared: 0, skipped: 0 };
  const bangumiId = subject.bangumi_id ?? subject.id;
  const airDate = subject.air_date ?? subject.airDate ?? null;
  const dateParts = normalizeDateParts(airDate);
  const currentParts = nowParts(now);
  const status = compareAirDate(dateParts, currentParts);
  const sources = sourceKeys ?? getEnabledSources().map((source) => source.key);
  const note = waitAiringNote(subject);

  let written = 0;
  let cleared = 0;
  let skipped = 0;

  for (const source of sources) {
    const existing = findManualResourceState({ bangumiId, source });
    const result = syncSingleSourceState({ bangumiId, source, status, note });
    if (result.action === "written") {
      written += 1;
    } else if (result.action === "cleared") {
      cleared += 1;
    } else if (!existing) {
      skipped += 1;
    }
  }

  return { written, cleared, skipped, status };
}
