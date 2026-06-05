import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getEnabledSources } from "../lib/cstationConfig.js";
import { recallResourceCandidates } from "../lib/resourceCandidateRecall.js";
import {
  listManualResourceStates,
  listResourceItems,
  listResourceItemsForSource,
  listResourceMappings,
  listRetryStatesByKind,
} from "../repositories/resourceRepository.js";
import { listEpisodeStatsForMapping } from "../repositories/episodeRepository.js";
import { listManualReviewSubjectRows } from "../repositories/subjectRepository.js";

const MANUAL_REVIEW_COLUMNS = [
  "anime_id",
  "bg_title",
  "source",
  "unmatched_reason",
  "decision",
  "source_aid",
  "source_ep_start",
  "source_ep_end",
  "display_ep_offset",
  "bg_aliases",
  "air_date",
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
  "matched_subject_title",
  "matched_resource_title",
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
  return new Date().toISOString();
}

function parseAliases(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeSubject(row) {
  return {
    id: row.bangumi_id,
    name: row.name,
    nameCn: row.name_cn,
    aliases: parseAliases(row.aliases),
    airDate: row.air_date,
    eps: row.eps,
    totalEpisodes: row.total_episodes,
    platform: row.platform,
  };
}

function normalizeResourceItem(row) {
  return {
    source: row.source,
    sourceAid: row.source_aid,
    title: row.title,
    subtitle: row.subtitle,
    category: row.category,
    year: row.year,
    latestText: row.latest_text,
    detailFetchedAt: row.detail_fetched_at,
  };
}

function normalizeMapping(row) {
  return {
    animeId: row.bangumi_id,
    source: row.source,
    sourceAid: row.source_aid,
    sourceEpStart: row.source_ep_start,
    sourceEpEnd: row.source_ep_end,
    displayEpOffset: row.display_ep_offset,
    score: row.score,
    matchedSubjectTitle: row.matched_subject_title,
    matchedResourceTitle: row.matched_resource_title,
    matchedAt: row.matched_at,
  };
}

function normalizeManual(row) {
  return {
    animeId: row.bangumi_id,
    source: row.source,
    status: row.status,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

function normalizeRetry(row) {
  return {
    animeId: row.bangumi_id,
    source: row.source,
    retryCount: row.retry_count,
    retryAt: row.retry_at,
    updatedAt: row.updated_at,
  };
}

function sourceKeysForExport(source) {
  return source ? [source] : getEnabledSources().map((item) => item.key);
}

function mappingKey(animeId, source) {
  return `${animeId}:${source}`;
}

function candidateKey(source, sourceAid) {
  return `${source}:${sourceAid}`;
}

function episodeStatsForMapping(mapping) {
  const rows = listEpisodeStatsForMapping({
    bangumiId: mapping.animeId,
    source: mapping.source,
    sourceAid: mapping.sourceAid,
  });
  const sourceIndexes = rows
    .map((row) => row.source_ep_index ?? row.sourceEpIndex ?? row.ep_index ?? row.epIndex)
    .filter((value) => Number.isFinite(value));
  const epIndexes = rows
    .map((row) => row.ep_index ?? row.epIndex)
    .filter((value) => Number.isFinite(value));
  return {
    source: mapping.source,
    sourceAid: mapping.sourceAid,
    bangumiId: mapping.animeId,
    episodeCount: rows.length,
    epMin: epIndexes.length > 0 ? Math.min(...epIndexes) : null,
    epMax: epIndexes.length > 0 ? Math.max(...epIndexes) : null,
    sourceEpMin: sourceIndexes.length > 0 ? Math.min(...sourceIndexes) : null,
    sourceEpMax: sourceIndexes.length > 0 ? Math.max(...sourceIndexes) : null,
  };
}

function ownersForCandidate(candidate, mappingsBySourceAid, subjectsById) {
  return (mappingsBySourceAid.get(candidate.sourceAid) || []).map((mapping) => ({
    animeId: mapping.animeId,
    title: subjectsById.get(mapping.animeId)?.nameCn || subjectsById.get(mapping.animeId)?.name || mapping.matchedSubjectTitle,
    sourceEpStart: mapping.sourceEpStart,
    sourceEpEnd: mapping.sourceEpEnd,
    displayEpOffset: mapping.displayEpOffset,
    matchedSubjectTitle: mapping.matchedSubjectTitle,
    matchedResourceTitle: mapping.matchedResourceTitle,
  }));
}

function enrichedCandidate(candidate, source, mappingsBySourceAid, statsByCandidate, subjectsById) {
  return {
    ...candidate,
    source,
    owners: ownersForCandidate(candidate, mappingsBySourceAid, subjectsById),
    episodeStats: statsByCandidate.get(candidateKey(source, candidate.sourceAid)) || {
      source,
      sourceAid: candidate.sourceAid,
      episodeCount: 0,
      epMin: null,
      epMax: null,
      sourceEpMin: null,
      sourceEpMax: null,
    },
  };
}

function currentStateFor(subject, source, mappingsByAnimeSource, manualByAnimeSource, retryByAnimeSource) {
  const mapping = mappingsByAnimeSource.get(mappingKey(subject.id, source));
  const manual = manualByAnimeSource.get(mappingKey(subject.id, source));
  const retry = retryByAnimeSource.get(mappingKey(subject.id, source));
  if (mapping) {
    const ranged = mapping.sourceEpStart != null || mapping.sourceEpEnd != null || (mapping.displayEpOffset ?? 0) > 0;
    return { status: ranged ? "mapped_ranged" : "mapped", mapping, manual: manual || null, retry: retry || null };
  }
  if (manual) return { status: manual.status, note: manual.note, manual, retry: retry || null };
  if ((retry?.retryCount ?? 0) >= 5) return { status: "max_retries", retry };
  return { status: "unmapped", retry: retry || null };
}

function shouldExportCase(state, { includeMapped }) {
  if (includeMapped) return true;
  return ["unmapped", "max_retries", "source_already_mapped", "no_resource", "wait_airing", "mapped_range_incomplete"].includes(state.status);
}

function mappingHasIncompleteSharedRange(mapping, mappingsBySourceAid) {
  if (!mapping) return false;
  const group = mappingsBySourceAid.get(mapping.sourceAid) || [];
  if (group.length <= 1) return false;
  const sorted = [...group].sort((a, b) => (a.sourceEpStart ?? Number.MAX_SAFE_INTEGER) - (b.sourceEpStart ?? Number.MAX_SAFE_INTEGER));
  const index = sorted.findIndex((row) => row.animeId === mapping.animeId && row.source === mapping.source);
  if (mapping.sourceEpStart == null) return true;
  if (index !== -1 && index < sorted.length - 1 && mapping.sourceEpEnd == null) return true;
  return false;
}

function buildCasesForSource({
  source,
  subjects,
  resourceItems,
  mappings,
  mappingsByAnimeSource,
  manualByAnimeSource,
  retryByAnimeSource,
  statsByCandidate,
  subjectsById,
  candidateLimit,
  includeMapped,
}) {
  const mappingsBySourceAid = new Map();
  for (const mapping of mappings.filter((row) => row.source === source)) {
    const rows = mappingsBySourceAid.get(mapping.sourceAid) || [];
    rows.push(mapping);
    mappingsBySourceAid.set(mapping.sourceAid, rows);
  }

  const cases = [];
  for (const subject of subjects) {
    const state = currentStateFor(subject, source, mappingsByAnimeSource, manualByAnimeSource, retryByAnimeSource);
    if (mappingHasIncompleteSharedRange(state.mapping, mappingsBySourceAid)) {
      state.status = "mapped_range_incomplete";
    }
    if (!shouldExportCase(state, { includeMapped })) continue;
    const candidates = recallResourceCandidates(subject, resourceItems, { limit: candidateLimit })
      .map((candidate) => enrichedCandidate(candidate, source, mappingsBySourceAid, statsByCandidate, subjectsById));
    if (candidates.length === 0 && state.status === "unmapped") continue;
    cases.push({
      caseId: `${subject.id}:${source}`,
      source,
      anime: subject,
      currentState: state,
      candidates,
    });
  }
  return cases;
}

export function buildAiMatchPack({ source = null, candidateLimit = 20, includeMapped = false } = {}) {
  const sourceKeys = sourceKeysForExport(source);
  const subjects = listManualReviewSubjectRows().map(normalizeSubject);
  const subjectsById = new Map(subjects.map((row) => [row.id, row]));
  const mappings = listResourceMappings({ sourceKeys }).map(normalizeMapping);
  const manualStates = listManualResourceStates({ sourceKeys }).map(normalizeManual);
  const retries = listRetryStatesByKind("mapping", { sourceKeys }).map(normalizeRetry);
  const mappingsByAnimeSource = new Map(mappings.map((row) => [mappingKey(row.animeId, row.source), row]));
  const manualByAnimeSource = new Map(manualStates.map((row) => [mappingKey(row.animeId, row.source), row]));
  const retryByAnimeSource = new Map(retries.map((row) => [mappingKey(row.animeId, row.source), row]));
  const stats = mappings.map(episodeStatsForMapping);
  const statsByCandidate = new Map();
  for (const row of stats) {
    const key = candidateKey(row.source, row.sourceAid);
    const existing = statsByCandidate.get(key);
    if (!existing) {
      statsByCandidate.set(key, { ...row, bangumiId: undefined });
    } else {
      existing.episodeCount += row.episodeCount;
      existing.sourceEpMin = existing.sourceEpMin == null ? row.sourceEpMin : Math.min(existing.sourceEpMin, row.sourceEpMin ?? existing.sourceEpMin);
      existing.sourceEpMax = existing.sourceEpMax == null ? row.sourceEpMax : Math.max(existing.sourceEpMax, row.sourceEpMax ?? existing.sourceEpMax);
      existing.epMin = existing.epMin == null ? row.epMin : Math.min(existing.epMin, row.epMin ?? existing.epMin);
      existing.epMax = existing.epMax == null ? row.epMax : Math.max(existing.epMax, row.epMax ?? existing.epMax);
    }
  }

  const resourceItems = sourceKeys.flatMap((sourceKey) => listResourceItemsForSource(sourceKey).map(normalizeResourceItem));
  const cases = sourceKeys.flatMap((sourceKey) => buildCasesForSource({
    source: sourceKey,
    subjects,
    resourceItems: resourceItems.filter((item) => item.source === sourceKey),
    mappings,
    mappingsByAnimeSource,
    manualByAnimeSource,
    retryByAnimeSource,
    statsByCandidate,
    subjectsById,
    candidateLimit,
    includeMapped,
  }));

  return {
    manifest: {
      generatedAt: now(),
      version: 1,
      sourceKeys,
      candidateLimit,
      includeMapped,
      cases: cases.length,
      resourceItems: resourceItems.length,
      existingMappings: mappings.length,
    },
    cases,
    resourceItems,
    existingMappings: mappings,
    episodeStats: stats,
    importSchema: {
      manualReviewColumns: MANUAL_REVIEW_COLUMNS,
      mappedReviewColumns: MAPPED_REVIEW_COLUMNS,
      suggestionJsonlFields: [
        "caseId",
        "animeId",
        "source",
        "decision",
        "sourceAid",
        "sourceEpStart",
        "sourceEpEnd",
        "displayEpOffset",
        "confidence",
        "reason",
      ],
      allowedDecisions: ["match", "wait_airing", "no_resource", "ambiguous"],
    },
  };
}

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

function readmeForAi() {
  return [
    "# LaevaBangumi AI Match Pack",
    "",
    "Use `cases.jsonl` as the only decision input. Do not invent source_aid values.",
    "Every match decision must choose a sourceAid from that case's candidates array.",
    "When a candidate has owners, shared use requires non-overlapping source_ep_start/source_ep_end ranges.",
    "Leave uncertain cases as ambiguous; do not force matches to improve coverage.",
    "Return suggestions as JSONL matching `import_schema.json`.",
    "",
  ].join("\n");
}

export async function exportAiMatchPack(outputDir, options = {}) {
  if (!outputDir) throw new Error("exportAiMatchPack requires outputDir");
  const pack = buildAiMatchPack(options);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "manifest.json"), `${JSON.stringify(pack.manifest, null, 2)}\n`, "utf8"),
    writeFile(join(outputDir, "cases.jsonl"), jsonl(pack.cases), "utf8"),
    writeFile(join(outputDir, "resource_items.jsonl"), jsonl(pack.resourceItems), "utf8"),
    writeFile(join(outputDir, "existing_mappings.jsonl"), jsonl(pack.existingMappings), "utf8"),
    writeFile(join(outputDir, "episode_stats.jsonl"), jsonl(pack.episodeStats), "utf8"),
    writeFile(join(outputDir, "import_schema.json"), `${JSON.stringify(pack.importSchema, null, 2)}\n`, "utf8"),
    writeFile(join(outputDir, "README-for-ai.md"), readmeForAi(), "utf8"),
  ]);
  return {
    outputDir,
    cases: pack.cases.length,
    resourceItems: pack.resourceItems.length,
    existingMappings: pack.existingMappings.length,
  };
}
