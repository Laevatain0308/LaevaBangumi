import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { parseAirDate } from "../lib/airDate.js";
import { createMappingRepository } from "../mappings/mappingRepository.js";
import { createAutoMatcher } from "../mappings/autoMatcher.js";

const THRESHOLDS = Object.freeze([0.75, 0.80, 0.85, 0.90]);

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
  return value;
}

export function parseAnalyzerArgs(argv) {
  let dbPath = null;
  let sourceKey = "ffzy";
  let today = null;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--db") dbPath = requireValue(argv, index++, option);
    else if (option === "--source") sourceKey = requireValue(argv, index++, option);
    else if (option === "--today") today = requireValue(argv, index++, option);
    else throw new TypeError(`unknown option: ${option}`);
  }
  if (!dbPath) throw new TypeError("--db is required");
  if (!sourceKey.trim()) throw new TypeError("--source must be a non-empty string");
  if (today != null) {
    const parsed = parseAirDate(today);
    if (!parsed || parsed.precision !== "day") throw new TypeError("--today must be YYYY-MM-DD");
  }
  return { dbPath, sourceKey: sourceKey.trim(), today };
}

function simulatedMatcher(repository, threshold, clock) {
  const virtualBySubject = new Map();
  const virtualSources = new Set();
  const subjectKey = ({ bangumiId, sourceKey }) => `${bangumiId}:${sourceKey}`;
  const sourceKey = ({ sourceKey: source, sourceItemId }) => `${source}:${sourceItemId}`;
  const facts = {
    ...repository,
    findMapping(input) {
      return virtualBySubject.get(subjectKey(input)) ?? repository.findMapping(input);
    },
    hasSourceItemMapping(input) {
      return virtualSources.has(sourceKey(input)) || repository.hasSourceItemMapping(input);
    },
  };
  const mappingService = {
    createAutomaticMapping(input) {
      if (facts.findMapping(input)) return { status: "skipped", reason: "bangumi_mapped" };
      if (facts.hasSourceItemMapping(input)) return { status: "skipped", reason: "source_item_mapped" };
      const mapping = { ...input, sourceEpisodeStart: null, sourceEpisodeEnd: null };
      virtualBySubject.set(subjectKey(input), mapping);
      virtualSources.add(sourceKey(input));
      return { status: "created" };
    },
  };
  return createAutoMatcher({
    repository: facts,
    mappingService,
    clock,
    minNameScore: threshold,
  });
}

function analyzerClock(today) {
  return today == null ? () => new Date() : () => new Date(`${today}T04:00:00.000Z`);
}

export function analyzeMappingThresholds({
  dbPath,
  sourceKey = "ffzy",
  today = null,
  writeLine = (line) => console.log(line),
} = {}) {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const repository = createMappingRepository({ sqlite });
    const subjects = repository.listSubjectsForMatching();
    const completed = subjects.filter(({ detailCompleted }) => detailCompleted);
    if (completed.length === 0) writeLine("warning=completed Bangumi detail count is zero");
    const report = THRESHOLDS.map((threshold) => {
      const matcher = simulatedMatcher(repository, threshold, analyzerClock(today));
      let mapped = 0;
      for (const { bangumiId } of completed) {
        if (matcher.matchSubject({ bangumiId, sourceKey }).status === "mapped") mapped += 1;
      }
      const row = { threshold, mapped };
      writeLine(`threshold=${threshold.toFixed(2)} mapped=${mapped}`);
      return row;
    });
    return report;
  } finally {
    sqlite.close();
  }
}

function main() {
  const options = parseAnalyzerArgs(process.argv.slice(2));
  analyzeMappingThresholds(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message ?? String(error));
    process.exitCode = 1;
  }
}
