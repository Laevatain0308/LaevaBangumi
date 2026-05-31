import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "../db/index.js";
import { anime, bangumiCstationMap, cstationCatalog, episodeFetchRetryState, episodes, manualMatchState, matchRetryState } from "../db/schema.js";
import * as bangumi from "./bangumi.js";
import { refreshEpisodesForAnime } from "./anime.js";
import { getEnabledSources } from "../lib/cstationConfig.js";
import { collectBangumiTitles, rankMatches } from "../lib/matcher.js";
import { log } from "../lib/logger.js";

export const DEFAULT_ANALYSIS_PATH = "data/manual/unmatched_report.csv";
export const DEFAULT_REVIEW_PATH = "data/manual/manual_review.csv";
export const DEFAULT_MAPPED_REVIEW_PATH = "data/manual/mapped_review.csv";

const MAX_RETRIES = 5;
const MANUAL_BLOCKED_STATUSES = new Set(["wait_airing", "no_resource", "source_already_mapped"]);

const ANALYSIS_COLUMNS = [
  "source",
  "anime_id",
  "bg_title",
  "bg_aliases",
  "air_date",
  "classification",
  "top_score",
  "candidate_scope",
  "candidate_rank",
  "candidate_source_aid",
  "source_aid",
  "candidate_score",
  "source_title",
  "source_subname",
  "source_year",
  "matched_bg_name",
  "matched_source_name",
  "confidence",
  "reason",
  "status",
  "reviewer_note",
];

const REVIEW_BASE_COLUMNS = [
  "anime_id",
  "bg_title",
  "source",
  "match_score",
  "unmatched_reason",
  "decision",
  "source_aid",
  "source_ep_start",
  "source_ep_end",
  "display_ep_offset",
  "bg_aliases",
  "air_date",
  "match_confidence",
  "suggestion_count",
  "suggestion_scope",
  "reviewer_note",
];

const MAPPED_REVIEW_COLUMNS = [
  "anime_id",
  "bg_title",
  "source",
  "decision",
  "source_aid",
  "source_title",
  "source_ep_start",
  "source_ep_end",
  "display_ep_offset",
  "match_score",
  "matched_bg_name",
  "matched_source_name",
  "matched_at",
  "episode_count",
  "source_ep_min",
  "source_ep_max",
  "source_subname",
  "source_year",
  "air_date",
  "bg_aliases",
  "reviewer_note",
];

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function animeTitles(a) {
  return collectBangumiTitles({
    name: a.name,
    name_cn: a.nameCn,
    aliases: safeJson(a.aliases, []),
  });
}

function allAnimeRows() {
  return db.select().from(anime).all();
}

function sourcesForReview(source) {
  return source ? [source] : getEnabledSources().map((item) => item.key);
}

function mappedAnimeIdsForSource(source) {
  return new Set(
    db.select({ animeId: bangumiCstationMap.animeId })
      .from(bangumiCstationMap)
      .where(eq(bangumiCstationMap.source, source))
      .all()
      .map((row) => row.animeId)
  );
}

function retryStateByAnimeIdForSource(source) {
  return new Map(
    db.select()
      .from(matchRetryState)
      .where(eq(matchRetryState.source, source))
      .all()
      .map((row) => [row.animeId, row])
  );
}

function manualStateByAnimeIdForSource(source) {
  return new Map(
    db.select()
      .from(manualMatchState)
      .where(eq(manualMatchState.source, source))
      .all()
      .map((row) => [row.animeId, row])
  );
}

function manualBlockedAutoMatchStateByAnimeIdForSource(source) {
  return new Map(
    db.select()
      .from(manualMatchState)
      .where(eq(manualMatchState.source, source))
      .all()
      .filter((row) => MANUAL_BLOCKED_STATUSES.has(row.status))
      .map((row) => [row.animeId, row])
  );
}

function filterCatalogByYear(catalog, year) {
  return catalog.filter((item) => {
    if (!year || !item.year) return true;
    const catalogYear = parseInt(item.year, 10);
    return Number.isNaN(catalogYear) || Math.abs(year - catalogYear) <= 1;
  });
}

function normalizedReviewLimit(limit) {
  const parsed = parseInt(limit, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 5;
  return Math.min(parsed, 20);
}

function normalizedRowLimit(limit) {
  if (limit == null || limit === "") return null;
  const parsed = parseInt(limit, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
}

function reviewColumns(limit) {
  const columns = [...REVIEW_BASE_COLUMNS];
  for (let i = 1; i <= limit; i++) {
    columns.push(
      `suggestion_${i}_source_aid`,
      `suggestion_${i}_score`,
      `suggestion_${i}_title`,
      `suggestion_${i}_subname`,
      `suggestion_${i}_year`,
      `suggestion_${i}_matched_bg_name`,
      `suggestion_${i}_matched_source_name`
    );
  }
  return columns;
}

function unmatchedReasonForRetry(retry) {
  if (!retry) return "no_mapping";
  if ((retry.retryCount ?? 0) >= MAX_RETRIES) return "max_retries";
  if (retry.retryAt && retry.retryAt > now()) return "retry_wait";
  return "retry_pending";
}

function unmatchedReasonForState(manual, retry) {
  if (manual?.status === "wait_airing") return "wait_airing";
  if (manual?.status === "no_resource") return "no_resource";
  if (manual?.status === "source_already_mapped") return "source_already_mapped";
  return unmatchedReasonForRetry(retry);
}

function rankReviewSuggestions(a, catalog, { limit, minScore, relaxedYearFallback }) {
  const names = animeTitles(a);
  const year = bangumi.extractYear(a.airDate);
  const filteredCatalog = filterCatalogByYear(catalog, year);
  let suggestions = rankMatches(names, year, filteredCatalog, { limit, minScore });
  let scope = year ? "year-filtered" : "all-years";

  if (suggestions.length === 0 && relaxedYearFallback && year) {
    suggestions = rankMatches(names, null, catalog, { limit, minScore });
    scope = suggestions.length > 0 ? "relaxed-year" : "none";
  } else if (suggestions.length === 0) {
    scope = "none";
  }

  return { suggestions, scope };
}

function reviewRowForAnime(a, source, unmatchedReason, ranked, limit, manualState = null) {
  const top = ranked.suggestions[0] || null;
  const keepReasonWithoutSuggestion = MANUAL_BLOCKED_STATUSES.has(unmatchedReason);
  const row = {
    anime_id: a.id,
    bg_title: a.nameCn || a.name,
    match_score: top ? Number(top.score).toFixed(4) : "",
    unmatched_reason: top || keepReasonWithoutSuggestion ? unmatchedReason : "no_candidate",
    decision: "",
    source_aid: top?.video?.id || "",
    source_ep_start: "",
    source_ep_end: "",
    display_ep_offset: "",
    source,
    bg_aliases: JSON.stringify(animeTitles(a)),
    air_date: a.airDate || "",
    match_confidence: top?.confidence || "",
    suggestion_count: ranked.suggestions.length,
    suggestion_scope: ranked.scope,
    reviewer_note: manualState?.note || "",
  };

  for (let i = 0; i < limit; i++) {
    const suggestion = ranked.suggestions[i] || null;
    const rank = i + 1;
    row[`suggestion_${rank}_source_aid`] = suggestion?.video?.id || "";
    row[`suggestion_${rank}_score`] = suggestion ? Number(suggestion.score).toFixed(4) : "";
    row[`suggestion_${rank}_title`] = suggestion?.video?.name || "";
    row[`suggestion_${rank}_subname`] = suggestion?.video?.subname || "";
    row[`suggestion_${rank}_year`] = suggestion?.video?.year || "";
    row[`suggestion_${rank}_matched_bg_name`] = suggestion?.matchedName || "";
    row[`suggestion_${rank}_matched_source_name`] = suggestion?.matchedSourceName || "";
  }

  return row;
}

export function analyzeUnmappedMappings({
  source = null,
  limit = 5,
  minScore = 0.25,
  relaxedYearFallback = true,
} = {}) {
  const normalizedLimit = normalizedReviewLimit(limit);
  const sources = sourcesForReview(source);
  const rows = [];
  const stats = {
    animeSources: 0,
    undecided: 0,
    withSuggestions: 0,
    withoutSuggestions: 0,
  };

  for (const sourceKey of sources) {
    const mapped = mappedAnimeIdsForSource(sourceKey);
    const retryByAnimeId = retryStateByAnimeIdForSource(sourceKey);
    const manualByAnimeId = manualBlockedAutoMatchStateByAnimeIdForSource(sourceKey);
    const catalog = db.select().from(cstationCatalog).where(eq(cstationCatalog.source, sourceKey)).all();
    const unmapped = allAnimeRows().filter((a) => !mapped.has(a.id));

    for (const a of unmapped) {
      const ranked = rankReviewSuggestions(a, catalog, { limit: normalizedLimit, minScore, relaxedYearFallback });
      const manual = manualByAnimeId.get(a.id);
      const unmatchedReason = unmatchedReasonForState(manual, retryByAnimeId.get(a.id));
      stats.animeSources++;
      stats.undecided++;
      if (ranked.suggestions.length > 0) stats.withSuggestions++;
      else stats.withoutSuggestions++;
      rows.push(reviewRowForAnime(a, sourceKey, unmatchedReason, ranked, normalizedLimit, manual));
    }
  }

  return { rows, stats };
}

export async function exportManualReview(filePath = DEFAULT_REVIEW_PATH, options = {}) {
  const result = analyzeUnmappedMappings(options);
  const limit = normalizedReviewLimit(options.limit);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, toCsv(result.rows, reviewColumns(limit)), "utf8");
  const stats = { filePath, rows: result.rows.length, ...result.stats };
  log("manual-match", "manual review exported", stats);
  return stats;
}

function parseFilterInt(value) {
  if (value == null || value === "") return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
}

function enabled(value) {
  if (value === true) return true;
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

function episodeStatsForMapping(mapping) {
  const rows = db.select()
    .from(episodes)
    .where(and(eq(episodes.animeId, mapping.animeId), eq(episodes.sourceName, mapping.source)))
    .all();
  const sourceIndexes = rows
    .map((row) => row.sourceEpIndex ?? row.epIndex)
    .filter((value) => Number.isFinite(value));
  return {
    episodeCount: rows.length,
    sourceEpMin: sourceIndexes.length > 0 ? Math.min(...sourceIndexes) : "",
    sourceEpMax: sourceIndexes.length > 0 ? Math.max(...sourceIndexes) : "",
  };
}

function mappingKey(row) {
  return `${row.source}:${row.cstationId}`;
}

function mappedRowForReview(mapping, animeRow, sourceItem, episodeStats) {
  return {
    anime_id: mapping.animeId,
    bg_title: animeRow?.nameCn || animeRow?.name || mapping.matchedBgName || "",
    source: mapping.source,
    decision: "",
    source_aid: mapping.cstationId,
    source_title: sourceItem?.name || mapping.matchedCsName || "",
    source_ep_start: mapping.sourceEpStart ?? "",
    source_ep_end: mapping.sourceEpEnd ?? "",
    display_ep_offset: mapping.displayEpOffset ?? 0,
    match_score: mapping.score == null ? "" : Number(mapping.score).toFixed(4),
    matched_bg_name: mapping.matchedBgName || "",
    matched_source_name: mapping.matchedCsName || "",
    matched_at: mapping.matchedAt || "",
    episode_count: episodeStats.episodeCount,
    source_ep_min: episodeStats.sourceEpMin,
    source_ep_max: episodeStats.sourceEpMax,
    source_subname: sourceItem?.subname || "",
    source_year: sourceItem?.year || "",
    air_date: animeRow?.airDate || "",
    bg_aliases: animeRow ? JSON.stringify(animeTitles(animeRow)) : "",
    reviewer_note: "",
  };
}

function rowMatchesQuery(row, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  return [
    row.bg_title,
    row.bg_aliases,
    row.source_title,
    row.source_subname,
    row.matched_bg_name,
    row.matched_source_name,
  ].some((value) => String(value || "").toLowerCase().includes(q));
}

export function analyzeMappedMappings({
  source = null,
  animeId = null,
  sourceAid = null,
  query = "",
  rangedOnly = false,
  multiMappedOnly = false,
  limit = null,
} = {}) {
  const sources = sourcesForReview(source);
  const animeFilter = parseFilterInt(animeId);
  const sourceAidFilter = parseFilterInt(sourceAid);
  const rowLimit = normalizedRowLimit(limit);
  const ranged = enabled(rangedOnly);
  const multiMapped = enabled(multiMappedOnly);
  const animeById = new Map(allAnimeRows().map((row) => [row.id, row]));
  const catalogByKey = new Map(
    db.select()
      .from(cstationCatalog)
      .all()
      .map((row) => [`${row.source}:${row.id}`, row])
  );
  const mappings = db.select()
    .from(bangumiCstationMap)
    .all()
    .filter((row) => sources.includes(row.source));
  const mappedCounts = new Map();
  for (const row of mappings) {
    const key = mappingKey(row);
    mappedCounts.set(key, (mappedCounts.get(key) || 0) + 1);
  }

  const rows = [];
  const stats = {
    mappings: 0,
    ranged: 0,
    multiMapped: 0,
    rows: 0,
  };

  for (const mapping of mappings) {
    if (animeFilter && mapping.animeId !== animeFilter) continue;
    if (sourceAidFilter && mapping.cstationId !== sourceAidFilter) continue;
    const hasRange = mapping.sourceEpStart != null || mapping.sourceEpEnd != null || (mapping.displayEpOffset ?? 0) > 0;
    const isMultiMapped = (mappedCounts.get(mappingKey(mapping)) || 0) > 1;
    if (ranged && !hasRange) continue;
    if (multiMapped && !isMultiMapped) continue;

    const row = mappedRowForReview(
      mapping,
      animeById.get(mapping.animeId),
      catalogByKey.get(`${mapping.source}:${mapping.cstationId}`),
      episodeStatsForMapping(mapping)
    );
    if (!rowMatchesQuery(row, query)) continue;

    stats.mappings++;
    if (hasRange) stats.ranged++;
    if (isMultiMapped) stats.multiMapped++;
    rows.push(row);
    if (rowLimit && rows.length >= rowLimit) break;
  }

  stats.rows = rows.length;
  return { rows, stats };
}

export async function exportMappedReview(filePath = DEFAULT_MAPPED_REVIEW_PATH, options = {}) {
  const result = analyzeMappedMappings(options);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, toCsv(result.rows, MAPPED_REVIEW_COLUMNS), "utf8");
  const stats = { filePath, ...result.stats };
  log("manual-match", "mapped review exported", stats);
  return stats;
}

export function analyzeUnmatched({
  source = null,
  limit = 5,
  minScore = 0.25,
  reviewScore = 0.45,
  autoScore = 0.8,
  relaxedYearFallback = true,
} = {}) {
  const sources = sourcesForReview(source);
  const rows = [];
  const stats = {
    animeSources: 0,
    autoCandidate: 0,
    review: 0,
    weak: 0,
    noCandidate: 0,
  };

  for (const sourceKey of sources) {
    const mapped = mappedAnimeIdsForSource(sourceKey);
    const catalog = db.select().from(cstationCatalog).where(eq(cstationCatalog.source, sourceKey)).all();
    const unmatched = allAnimeRows().filter((a) => !mapped.has(a.id));

    for (const a of unmatched) {
      stats.animeSources++;
      const analysis = analyzeAnimeSource(a, sourceKey, catalog, { limit, minScore, reviewScore, autoScore, relaxedYearFallback });
      stats[analysis.classification]++;
      rows.push(...analysis.rows);
    }
  }

  return { rows, stats };
}

function analyzeAnimeSource(a, source, catalog, { limit, minScore, reviewScore, autoScore, relaxedYearFallback }) {
  const names = animeTitles(a);
  const year = bangumi.extractYear(a.airDate);
  const filteredCatalog = filterCatalogByYear(catalog, year);
  let ranked = rankMatches(names, year, filteredCatalog, { limit, minScore });
  let candidateScope = year ? "year-filtered" : "all-years";

  if (ranked.length === 0 && relaxedYearFallback && year) {
    ranked = rankMatches(names, null, catalog, { limit, minScore });
    candidateScope = "relaxed-year";
  }

  const top = ranked[0] || null;
  const classification = classifyCandidate(top?.score, { minScore, reviewScore, autoScore });
  const base = {
    source,
    anime_id: a.id,
    bg_title: a.nameCn || a.name,
    bg_aliases: JSON.stringify(names),
    air_date: a.airDate,
    classification,
    top_score: top ? Number(top.score).toFixed(4) : "",
    candidate_scope: top ? candidateScope : "none",
    reason: reasonForClassification(classification, top, { minScore, reviewScore, autoScore }),
    status: "",
    reviewer_note: "",
  };

  if (ranked.length === 0) return { classification, rows: [base] };

  return {
    classification,
    rows: ranked.map((candidate, index) => ({
      ...base,
      candidate_rank: index + 1,
      candidate_source_aid: candidate.video.id,
      source_aid: candidate.video.id,
      candidate_score: Number(candidate.score).toFixed(4),
      source_title: candidate.video.name,
      source_subname: candidate.video.subname || "",
      source_year: candidate.video.year || "",
      matched_bg_name: candidate.matchedName,
      matched_source_name: candidate.matchedSourceName,
      confidence: candidate.confidence,
    })),
  };
}

function classifyCandidate(score, { reviewScore, autoScore }) {
  if (score == null) return "noCandidate";
  if (score >= autoScore) return "autoCandidate";
  if (score >= reviewScore) return "review";
  return "weak";
}

function reasonForClassification(classification, top, { minScore, reviewScore, autoScore }) {
  if (classification === "autoCandidate") return `top score >= ${autoScore}; inspect why it was not mapped`;
  if (classification === "review") return `top score >= ${reviewScore}; manual review recommended`;
  if (classification === "weak") return `top score >= ${minScore} but < ${reviewScore}; weak local candidate`;
  return `no local catalog candidate >= ${minScore}`;
}

export async function exportUnmatchedReport(filePath = DEFAULT_ANALYSIS_PATH, options = {}) {
  const result = analyzeUnmatched(options);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, toCsv(result.rows, ANALYSIS_COLUMNS), "utf8");
  const stats = { filePath, rows: result.rows.length, ...result.stats };
  log("manual-match", "unmatched report exported", stats);
  return stats;
}

function parseSourceAid(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
}

function parseOptionalPositiveInt(value, field, line, errors) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || String(parsed) !== raw) {
    errors.push(`line ${line}: ${field} must be a positive integer when provided`);
    return null;
  }
  return parsed;
}

function parseDisplayEpOffset(value, line, errors) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || String(parsed) !== raw) {
    errors.push(`line ${line}: display_ep_offset must be a non-negative integer when provided`);
    return 0;
  }
  return parsed;
}

function parseEpisodeRange(row, line, errors) {
  const sourceEpStart = parseOptionalPositiveInt(row.source_ep_start, "source_ep_start", line, errors);
  const sourceEpEnd = parseOptionalPositiveInt(row.source_ep_end, "source_ep_end", line, errors);
  const displayEpOffset = parseDisplayEpOffset(row.display_ep_offset, line, errors);
  if (sourceEpStart != null && sourceEpEnd != null && sourceEpEnd < sourceEpStart) {
    errors.push(`line ${line}: source_ep_end must be greater than or equal to source_ep_start`);
  }
  return { sourceEpStart, sourceEpEnd, displayEpOffset };
}

function normalizeDecision(decision) {
  const value = String(decision || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!value) return "";
  if (["match", "matched", "yes", "y", "true", "confirmed", "confirm", "accepted", "有匹配", "匹配", "确认"].includes(value)) return "match";
  if (["wait_airing", "wait", "waiting", "future", "待播出", "等待播出", "未播出"].includes(value)) return "wait_airing";
  if (["no_resource", "no_match", "none", "missing", "unavailable", "无资源", "无匹配", "没有资源", "无"].includes(value)) return "no_resource";
  return "invalid";
}

function normalizeMappedDecision(decision) {
  const value = String(decision || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!value) return "";
  if (["match", "matched", "update", "updated", "change", "modify", "yes", "y", "true", "confirmed", "confirm", "accepted", "有匹配", "匹配", "确认", "更新"].includes(value)) return "update";
  if (["delete", "remove", "unlink", "unmap", "删除", "移除", "取消映射"].includes(value)) return "delete";
  if (["wait_airing", "wait", "waiting", "future", "待播出", "等待播出", "未播出"].includes(value)) return "wait_airing";
  if (["no_resource", "no_match", "none", "missing", "unavailable", "无资源", "无匹配", "没有资源", "无"].includes(value)) return "no_resource";
  return "invalid";
}

function findCatalogItem(source, sourceAid) {
  return db.select()
    .from(cstationCatalog)
    .where(and(eq(cstationCatalog.source, source), eq(cstationCatalog.id, sourceAid)))
    .get();
}

function scoreFromReviewRow(row) {
  const score = Number(row.match_score || row.suggestion_1_score || row.score || row.candidate_score || "");
  return Number.isFinite(score) ? score : null;
}

function clearRetryState(animeId, source) {
  db.insert(matchRetryState)
    .values({ animeId, source, retryCount: 0, retryAt: null, updatedAt: now() })
    .onConflictDoUpdate({
      target: [matchRetryState.animeId, matchRetryState.source],
      set: { retryCount: 0, retryAt: null, updatedAt: now() },
    })
    .run();
}

function clearEpisodeFetchRetryState(animeId, source) {
  db.delete(episodeFetchRetryState)
    .where(and(eq(episodeFetchRetryState.animeId, animeId), eq(episodeFetchRetryState.source, source)))
    .run();
}

function blockAutoRetry(animeId, source) {
  db.insert(matchRetryState)
    .values({ animeId, source, retryCount: MAX_RETRIES, retryAt: null, updatedAt: now() })
    .onConflictDoUpdate({
      target: [matchRetryState.animeId, matchRetryState.source],
      set: { retryCount: MAX_RETRIES, retryAt: null, updatedAt: now() },
    })
    .run();
}

function clearManualMatchState(animeId, source) {
  db.delete(manualMatchState)
    .where(and(eq(manualMatchState.animeId, animeId), eq(manualMatchState.source, source)))
    .run();
}

function markWaitAiring(animeId, source, note) {
  db.insert(manualMatchState)
    .values({ animeId, source, status: "wait_airing", note, updatedAt: now() })
    .onConflictDoUpdate({
      target: [manualMatchState.animeId, manualMatchState.source],
      set: { status: "wait_airing", note, updatedAt: now() },
    })
    .run();
  clearRetryState(animeId, source);
  clearEpisodeFetchRetryState(animeId, source);
}

function markNoResource(animeId, source, note) {
  db.insert(manualMatchState)
    .values({ animeId, source, status: "no_resource", note, updatedAt: now() })
    .onConflictDoUpdate({
      target: [manualMatchState.animeId, manualMatchState.source],
      set: { status: "no_resource", note, updatedAt: now() },
    })
    .run();
  blockAutoRetry(animeId, source);
  clearEpisodeFetchRetryState(animeId, source);
}

function deleteMappingArtifacts(animeId, source) {
  db.delete(episodes)
    .where(and(eq(episodes.animeId, animeId), eq(episodes.sourceName, source)))
    .run();
  db.delete(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, animeId), eq(bangumiCstationMap.source, source)))
    .run();
  clearEpisodeFetchRetryState(animeId, source);
}

function applyManualMapping({ row, animeRow, source, sourceItem, sourceAid, episodeRange }) {
  deleteMappingArtifacts(animeRow.id, source);

  db.insert(bangumiCstationMap)
    .values({
      animeId: animeRow.id,
      source,
      cstationId: sourceAid,
      sourceEpStart: episodeRange.sourceEpStart,
      sourceEpEnd: episodeRange.sourceEpEnd,
      displayEpOffset: episodeRange.displayEpOffset,
      score: scoreFromReviewRow(row),
      matchedBgName: animeRow.nameCn || animeRow.name,
      matchedCsName: sourceItem.name,
      matchedAt: now(),
    })
    .onConflictDoUpdate({
      target: [bangumiCstationMap.animeId, bangumiCstationMap.source],
      set: {
        cstationId: sourceAid,
        sourceEpStart: episodeRange.sourceEpStart,
        sourceEpEnd: episodeRange.sourceEpEnd,
        displayEpOffset: episodeRange.displayEpOffset,
        score: scoreFromReviewRow(row),
        matchedBgName: animeRow.nameCn || animeRow.name,
        matchedCsName: sourceItem.name,
        matchedAt: now(),
      },
    })
    .run();

  clearRetryState(animeRow.id, source);
  clearEpisodeFetchRetryState(animeRow.id, source);
  clearManualMatchState(animeRow.id, source);
}

function existingMapping(animeId, source) {
  return db.select()
    .from(bangumiCstationMap)
    .where(and(eq(bangumiCstationMap.animeId, animeId), eq(bangumiCstationMap.source, source)))
    .get();
}

export async function importManualReview(filePath = DEFAULT_REVIEW_PATH, { refreshEpisodes = true } = {}) {
  const raw = await readFile(filePath, "utf8");
  const rows = parseCsv(raw);
  const stats = { filePath, rows: rows.length, updated: 0, matched: 0, waitAiring: 0, noResource: 0, refreshed: 0, skipped: 0 };
  const errors = [];
  const actions = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const line = index + 2;
    const decision = normalizeDecision(row.decision);
    if (!decision) {
      stats.skipped++;
      continue;
    }
    const animeId = parseInt(row.anime_id, 10);
    const source = String(row.source || "").trim();
    const note = row.reviewer_note || null;
    if (decision === "invalid") {
      errors.push(`line ${line}: unsupported decision "${row.decision}". Leave it blank, use match, wait_airing, or no_resource.`);
      continue;
    }
    if (!animeId) {
      errors.push(`line ${line}: anime_id is required`);
      continue;
    }
    if (!source) {
      errors.push(`line ${line}: source is required`);
      continue;
    }
    const animeRow = db.select().from(anime).where(eq(anime.id, animeId)).get();
    if (!animeRow) {
      errors.push(`line ${line}: anime_id ${animeId} does not exist`);
      continue;
    }

    if (decision === "wait_airing") {
      actions.push({ type: "wait_airing", animeId, source, note });
      continue;
    }
    if (decision === "no_resource") {
      actions.push({ type: "no_resource", animeId, source, note });
      continue;
    }

    const sourceAid = parseSourceAid(row.source_aid);
    if (!sourceAid) {
      errors.push(`line ${line}: source_aid is required when decision=match`);
      continue;
    }
    const sourceItem = findCatalogItem(source, sourceAid);
    if (!sourceItem) {
      errors.push(`line ${line}: source_aid ${sourceAid} does not exist in ${source} catalog`);
      continue;
    }
    const episodeRange = parseEpisodeRange(row, line, errors);

    actions.push({ type: "match", row, animeRow, source, sourceItem, sourceAid, episodeRange });
  }

  if (errors.length > 0) throw new Error(`manual review import failed:\n${errors.join("\n")}`);

  const applyActions = sqlite.transaction((items) => {
    for (const action of items) {
      if (action.type === "wait_airing") {
        markWaitAiring(action.animeId, action.source, action.note);
        stats.updated++;
        stats.waitAiring++;
        continue;
      }

      if (action.type === "no_resource") {
        markNoResource(action.animeId, action.source, action.note);
        stats.updated++;
        stats.noResource++;
        continue;
      }

      if (action.type === "match") {
        applyManualMapping(action);
        stats.updated++;
        stats.matched++;
      }
    }
  });

  applyActions(actions);

  for (const action of actions) {
    if (action.type === "wait_airing") {
      continue;
    }

    if (action.type === "no_resource") {
      continue;
    }

    if (action.type === "match") {
      if (refreshEpisodes) {
        const result = await refreshEpisodesForAnime(action.animeRow.id, { source: action.source });
        if (result.refreshed) stats.refreshed++;
      }
    }
  }

  log("manual-match", "manual review imported", stats);
  return stats;
}

function applyMappedDelete(animeId, source) {
  deleteMappingArtifacts(animeId, source);
  clearManualMatchState(animeId, source);
  blockAutoRetry(animeId, source);
}

function applyMappedWaitAiring(animeId, source, note) {
  deleteMappingArtifacts(animeId, source);
  markWaitAiring(animeId, source, note);
}

function applyMappedNoResource(animeId, source, note) {
  deleteMappingArtifacts(animeId, source);
  markNoResource(animeId, source, note);
}

export async function importMappedReview(filePath = DEFAULT_MAPPED_REVIEW_PATH, { refreshEpisodes = true } = {}) {
  const raw = await readFile(filePath, "utf8");
  const rows = parseCsv(raw);
  const stats = { filePath, rows: rows.length, updated: 0, matched: 0, deleted: 0, waitAiring: 0, noResource: 0, refreshed: 0, skipped: 0 };
  const errors = [];
  const actions = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const line = index + 2;
    const decision = normalizeMappedDecision(row.decision);
    if (!decision) {
      stats.skipped++;
      continue;
    }

    const animeId = parseInt(row.anime_id, 10);
    const source = String(row.source || "").trim();
    const note = row.reviewer_note || null;
    if (decision === "invalid") {
      errors.push(`line ${line}: unsupported decision "${row.decision}". Leave it blank, use update, delete, wait_airing, or no_resource.`);
      continue;
    }
    if (!animeId) {
      errors.push(`line ${line}: anime_id is required`);
      continue;
    }
    if (!source) {
      errors.push(`line ${line}: source is required`);
      continue;
    }

    const animeRow = db.select().from(anime).where(eq(anime.id, animeId)).get();
    if (!animeRow) {
      errors.push(`line ${line}: anime_id ${animeId} does not exist`);
      continue;
    }
    const mapping = existingMapping(animeId, source);
    if (!mapping) {
      errors.push(`line ${line}: mapping ${animeId}:${source} does not exist`);
      continue;
    }

    if (decision === "delete") {
      actions.push({ type: "delete", animeId, source });
      continue;
    }
    if (decision === "wait_airing") {
      actions.push({ type: "wait_airing", animeId, source, note });
      continue;
    }
    if (decision === "no_resource") {
      actions.push({ type: "no_resource", animeId, source, note });
      continue;
    }

    const sourceAid = parseSourceAid(row.source_aid);
    if (!sourceAid) {
      errors.push(`line ${line}: source_aid is required when decision=update`);
      continue;
    }
    const sourceItem = findCatalogItem(source, sourceAid);
    if (!sourceItem) {
      errors.push(`line ${line}: source_aid ${sourceAid} does not exist in ${source} catalog`);
      continue;
    }
    const episodeRange = parseEpisodeRange(row, line, errors);
    actions.push({ type: "update", row, animeRow, source, sourceItem, sourceAid, episodeRange });
  }

  if (errors.length > 0) throw new Error(`mapped review import failed:\n${errors.join("\n")}`);

  const applyActions = sqlite.transaction((items) => {
    for (const action of items) {
      if (action.type === "delete") {
        applyMappedDelete(action.animeId, action.source);
        stats.updated++;
        stats.deleted++;
        continue;
      }

      if (action.type === "wait_airing") {
        applyMappedWaitAiring(action.animeId, action.source, action.note);
        stats.updated++;
        stats.waitAiring++;
        continue;
      }

      if (action.type === "no_resource") {
        applyMappedNoResource(action.animeId, action.source, action.note);
        stats.updated++;
        stats.noResource++;
        continue;
      }

      if (action.type === "update") {
        applyManualMapping(action);
        stats.updated++;
        stats.matched++;
      }
    }
  });

  applyActions(actions);

  for (const action of actions) {
    if (action.type === "delete") {
      continue;
    }

    if (action.type === "wait_airing") {
      continue;
    }

    if (action.type === "no_resource") {
      continue;
    }

    if (action.type === "update") {
      if (refreshEpisodes) {
        const result = await refreshEpisodesForAnime(action.animeRow.id, { source: action.source });
        if (result.refreshed) stats.refreshed++;
      }
    }
  }

  log("manual-match", "mapped review imported", stats);
  return stats;
}

function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => csvEscape(row[col])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function parseCsv(raw) {
  const rows = [];
  const records = [];
  let field = "";
  let record = [];
  let quoted = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"' && raw[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n") {
      record.push(field);
      records.push(record);
      field = "";
      record = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const header = records.shift() || [];
  for (const rec of records) {
    if (rec.every((value) => value === "")) continue;
    rows.push(Object.fromEntries(header.map((key, i) => [key, rec[i] ?? ""])));
  }
  return rows;
}
