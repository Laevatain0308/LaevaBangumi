import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

const DECISIONS = new Set(["match", "wait_airing", "no_resource", "ambiguous"]);
const CONFIDENCES = new Set(["low", "medium", "high"]);

async function readJsonl(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`${filePath}:${index + 1}: invalid JSON (${err.message})`);
      }
    });
}

function csvEscape(value) {
  if (value == null) return "";
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows, columns) {
  return `${[columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\n")}\n`;
}

function normalizeDecision(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function optionalPositiveInt(value, field, errors) {
  if (value == null || value === "") return null;
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${field} must be a positive integer when provided`);
    return null;
  }
  return value;
}

function optionalNonNegativeInt(value, field, errors) {
  if (value == null || value === "") return 0;
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${field} must be a non-negative integer when provided`);
    return 0;
  }
  return value;
}

function indexCases(cases) {
  const byCaseId = new Map();
  const byAnimeSource = new Map();
  const byAnimeId = new Map();
  for (const item of cases) {
    byCaseId.set(item.caseId, item);
    byAnimeSource.set(`${item.anime.id}:${item.source}`, item);
    const group = byAnimeId.get(item.anime.id) || [];
    group.push(item);
    byAnimeId.set(item.anime.id, group);
  }
  return { byCaseId, byAnimeSource, byAnimeId };
}

function resolveMatchCase(normalized, casesIndex, index) {
  if (normalized.caseId) {
    const matchCase = casesIndex.byCaseId.get(normalized.caseId);
    if (!matchCase) throw new Error(`suggestion ${index + 1}: caseId ${normalized.caseId} is not present in exported cases`);
    if (matchCase.anime.id !== normalized.animeId) {
      throw new Error(`suggestion ${index + 1}: caseId ${normalized.caseId} does not match animeId ${normalized.animeId}`);
    }
    return matchCase;
  }
  if (normalized.source) {
    const matchCase = casesIndex.byAnimeSource.get(`${normalized.animeId}:${normalized.source}`);
    if (!matchCase) {
      throw new Error(`suggestion ${index + 1}: animeId ${normalized.animeId} with source ${normalized.source} is not present in exported cases`);
    }
    return matchCase;
  }
  const matches = casesIndex.byAnimeId.get(normalized.animeId) || [];
  if (matches.length === 0) {
    throw new Error(`suggestion ${index + 1}: animeId ${normalized.animeId} is not present in exported cases`);
  }
  if (matches.length > 1) {
    throw new Error(`suggestion ${index + 1}: animeId ${normalized.animeId} appears in multiple exported cases; include caseId or source`);
  }
  return matches[0];
}

function validateSuggestionShape(row, index) {
  const errors = [];
  const decision = normalizeDecision(row.decision);
  if (!DECISIONS.has(decision)) errors.push(`decision must be one of ${[...DECISIONS].join(", ")}`);
  if (row.confidence != null && row.confidence !== "" && !CONFIDENCES.has(String(row.confidence))) {
    errors.push("confidence must be low, medium, or high when provided");
  }
  if (decision === "match" && !row.confidence) errors.push("confidence is required for match");
  if (DECISIONS.has(decision) && !String(row.reason || "").trim()) errors.push("reason is required");
  const caseId = row.caseId == null || row.caseId === "" ? null : String(row.caseId).trim();
  const source = row.source == null || row.source === "" ? null : String(row.source).trim();
  const animeId = row.animeId;
  if (!Number.isInteger(animeId) || animeId <= 0) errors.push("animeId must be a positive integer");
  const sourceAid = optionalPositiveInt(row.sourceAid, "sourceAid", errors);
  const sourceEpStart = optionalPositiveInt(row.sourceEpStart, "sourceEpStart", errors);
  const sourceEpEnd = optionalPositiveInt(row.sourceEpEnd, "sourceEpEnd", errors);
  const displayEpOffset = optionalNonNegativeInt(row.displayEpOffset, "displayEpOffset", errors);
  if (sourceEpStart != null && sourceEpEnd != null && sourceEpEnd < sourceEpStart) {
    errors.push("sourceEpEnd must be greater than or equal to sourceEpStart");
  }
  if (errors.length > 0) {
    throw new Error(`suggestion ${index + 1}: ${errors.join("; ")}`);
  }
  return { caseId, source, animeId, decision, sourceAid, sourceEpStart, sourceEpEnd, displayEpOffset };
}

function manualRowForSuggestion({ suggestion, normalized, matchCase, candidate }) {
  const noteParts = [
    suggestion.confidence ? `ai_confidence=${suggestion.confidence}` : null,
    suggestion.reason || null,
  ].filter(Boolean);
  return {
    anime_id: normalized.animeId,
    bg_title: matchCase.anime.nameCn || matchCase.anime.name,
    source: matchCase.source,
    unmatched_reason: matchCase.currentState.status,
    decision: normalized.decision === "ambiguous" ? "" : normalized.decision,
    source_aid: normalized.decision === "match" ? normalized.sourceAid : "",
    source_ep_start: normalized.sourceEpStart ?? "",
    source_ep_end: normalized.sourceEpEnd ?? "",
    display_ep_offset: normalized.displayEpOffset ?? 0,
    bg_aliases: JSON.stringify([
      matchCase.anime.nameCn,
      matchCase.anime.name,
      ...(matchCase.anime.aliases || []),
    ].filter(Boolean)),
    air_date: matchCase.anime.airDate || "",
    reviewer_note: [
      ...noteParts,
      candidate ? `candidate=${candidate.title}` : null,
    ].filter(Boolean).join("; "),
  };
}

function validateCandidateUse(normalized, matchCase, index) {
  if (normalized.decision !== "match") return null;
  if (!normalized.sourceAid) throw new Error(`suggestion ${index + 1}: sourceAid is required for match`);
  const candidate = matchCase.candidates.find((item) => item.sourceAid === normalized.sourceAid);
  if (!candidate) {
    throw new Error(`suggestion ${index + 1}: sourceAid ${normalized.sourceAid} is not present in exported candidates for anime ${normalized.animeId}`);
  }
  if (candidate.owners?.length > 0 && normalized.sourceEpStart == null) {
    throw new Error(`suggestion ${index + 1}: shared sourceAid ${normalized.sourceAid} requires sourceEpStart`);
  }
  return candidate;
}

function mappingFromOwner(owner, source, sourceAid) {
  return {
    animeId: owner.animeId,
    source,
    sourceAid,
    sourceEpStart: owner.sourceEpStart,
    sourceEpEnd: owner.sourceEpEnd,
  };
}

function mappingFromSuggestion(normalized, matchCase) {
  return {
    animeId: normalized.animeId,
    source: matchCase.source,
    sourceAid: normalized.sourceAid,
    sourceEpStart: normalized.sourceEpStart,
    sourceEpEnd: normalized.sourceEpEnd,
  };
}

function mappingIdentity(row) {
  const animeId = Number.isFinite(Number(row.animeId)) ? Number(row.animeId) : row.animeId;
  return `${animeId}:${row.source}`;
}

function sourceAidIdentity(row) {
  return `${row.source}:${row.sourceAid}`;
}

function addProjectedMapping(groups, row) {
  const sourceAidKey = sourceAidIdentity(row);
  const group = groups.get(sourceAidKey) || new Map();
  group.set(mappingIdentity(row), row);
  groups.set(sourceAidKey, group);
}

function projectedSharedGroups(matchActions) {
  const groups = new Map();
  const suggestionsByMapping = new Map();
  for (const action of matchActions) {
    const row = mappingFromSuggestion(action.normalized, action.matchCase);
    suggestionsByMapping.set(mappingIdentity(row), row);
  }

  for (const action of matchActions) {
    for (const owner of action.candidate.owners || []) {
      const row = mappingFromOwner(owner, action.matchCase.source, action.candidate.sourceAid);
      if (suggestionsByMapping.has(mappingIdentity(row))) continue;
      addProjectedMapping(groups, row);
    }
  }

  for (const row of suggestionsByMapping.values()) {
    addProjectedMapping(groups, row);
  }

  return groups;
}

function validateSharedRangeGroup(key, group, errors) {
  if (group.length <= 1) return;
  const groupErrors = [];
  for (const row of group) {
    if (row.sourceEpStart == null) groupErrors.push(`shared source ${key}: mapping ${row.animeId}:${row.source} must include sourceEpStart`);
    if (row.sourceEpStart != null && row.sourceEpEnd != null && row.sourceEpEnd < row.sourceEpStart) {
      groupErrors.push(`shared source ${key}: mapping ${row.animeId}:${row.source} sourceEpEnd must be greater than or equal to sourceEpStart`);
    }
  }
  if (groupErrors.length === 0) {
    const sorted = [...group].sort((a, b) => a.sourceEpStart - b.sourceEpStart || a.animeId - b.animeId);
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      if (i < sorted.length - 1 && row.sourceEpEnd == null) {
        groupErrors.push(`shared source ${key}: non-final shared range must include sourceEpEnd for mapping ${row.animeId}:${row.source}`);
      }
      if (i > 0) {
        const previous = sorted[i - 1];
        if (previous.sourceEpEnd != null && previous.sourceEpEnd >= row.sourceEpStart) {
          groupErrors.push(`shared source ${key}: shared ranges must not overlap (${previous.animeId}:${previous.source} and ${row.animeId}:${row.source})`);
        }
      }
    }
  }
  errors.push(...groupErrors);
}

function validateProjectedSharedRanges(matchActions) {
  const errors = [];
  for (const [key, group] of projectedSharedGroups(matchActions).entries()) {
    validateSharedRangeGroup(key, [...group.values()], errors);
  }
  if (errors.length > 0) {
    throw new Error(`AI suggestion range validation failed:\n${errors.join("\n")}`);
  }
}

export async function validateAiMatchSuggestions({
  packDir,
  suggestionsFile = null,
  outputDir = null,
} = {}) {
  if (!packDir) throw new Error("validateAiMatchSuggestions requires packDir");
  const actualSuggestionsFile = suggestionsFile || join(packDir, "suggestions.jsonl");
  const actualOutputDir = outputDir || packDir;
  const cases = await readJsonl(join(packDir, "cases.jsonl"));
  const suggestions = await readJsonl(actualSuggestionsFile);
  const casesIndex = indexCases(cases);
  const acceptedRows = [];
  const matchActions = [];
  const seenCaseIds = new Set();
  const report = {
    suggestions: suggestions.length,
    accepted: 0,
    ambiguous: 0,
    skipped: 0,
    rows: [],
  };

  for (let index = 0; index < suggestions.length; index++) {
    const suggestion = suggestions[index];
    const normalized = validateSuggestionShape(suggestion, index);
    const matchCase = resolveMatchCase(normalized, casesIndex, index);
    if (seenCaseIds.has(matchCase.caseId)) {
      throw new Error(`suggestion ${index + 1}: duplicate suggestion for case ${matchCase.caseId}`);
    }
    seenCaseIds.add(matchCase.caseId);
    if (normalized.decision === "ambiguous") {
      report.ambiguous++;
      report.rows.push({ animeId: normalized.animeId, decision: "ambiguous", accepted: false, reason: suggestion.reason || null });
      continue;
    }
    const candidate = validateCandidateUse(normalized, matchCase, index);
    if (normalized.decision === "match") {
      matchActions.push({ normalized, matchCase, candidate, index });
    }
    acceptedRows.push(manualRowForSuggestion({ suggestion, normalized, matchCase, candidate }));
    report.accepted++;
    report.rows.push({ animeId: normalized.animeId, decision: normalized.decision, accepted: true, sourceAid: normalized.sourceAid || null });
  }

  validateProjectedSharedRanges(matchActions);

  await mkdir(actualOutputDir, { recursive: true });
  await Promise.all([
    writeFile(join(actualOutputDir, "manual_review.csv"), toCsv(acceptedRows, MANUAL_REVIEW_COLUMNS), "utf8"),
    writeFile(join(actualOutputDir, "validation_report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  ]);

  return {
    outputDir: actualOutputDir,
    suggestions: suggestions.length,
    accepted: report.accepted,
    ambiguous: report.ambiguous,
    skipped: report.skipped,
  };
}
