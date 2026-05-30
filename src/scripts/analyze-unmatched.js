import { initDb } from "../db/index.js";
import { DEFAULT_ANALYSIS_PATH, exportUnmatchedReport } from "../services/manualMatches.js";

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? value : fallback;
}

function intEnv(name, fallback) {
  const value = parseInt(process.env[name] || String(fallback), 10);
  return Number.isNaN(value) ? fallback : value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

initDb();

const output = process.argv[2] || DEFAULT_ANALYSIS_PATH;
const source = process.env.UNMATCHED_REPORT_SOURCE || null;
const limit = intEnv("UNMATCHED_REPORT_LIMIT", 5);
const minScore = numberEnv("UNMATCHED_REPORT_MIN_SCORE", 0.25);
const reviewScore = numberEnv("UNMATCHED_REPORT_REVIEW_SCORE", 0.45);
const autoScore = numberEnv("UNMATCHED_REPORT_AUTO_SCORE", 0.8);
const relaxedYearFallback = boolEnv("UNMATCHED_REPORT_RELAXED_YEAR", true);

exportUnmatchedReport(output, {
  source,
  limit,
  minScore,
  reviewScore,
  autoScore,
  relaxedYearFallback,
})
  .then((stats) => {
    console.log(`unmatched report exported: ${stats.filePath} (${stats.rows} rows)`);
    console.log(
      `animeSources=${stats.animeSources} autoCandidate=${stats.autoCandidate} review=${stats.review} weak=${stats.weak} noCandidate=${stats.noCandidate}`
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
