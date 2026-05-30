import { initDb } from "../db/index.js";
import { DEFAULT_REVIEW_PATH, exportManualReview } from "../services/manualMatches.js";

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? value : fallback;
}

function intEnv(name, fallback) {
  const value = parseInt(process.env[name] || String(fallback), 10);
  return Number.isNaN(value) ? fallback : value;
}

initDb();

const output = process.argv[2] || DEFAULT_REVIEW_PATH;
const source = process.env.MANUAL_REVIEW_SOURCE || null;
const limit = intEnv("MANUAL_REVIEW_LIMIT", 5);
const minScore = numberEnv("MANUAL_REVIEW_MIN_SCORE", 0.25);

exportManualReview(output, { source, limit, minScore })
  .then((stats) => {
    console.log(`manual review exported: ${stats.filePath} (${stats.rows} rows)`);
    console.log(
      `animeSources=${stats.animeSources} undecided=${stats.undecided} withSuggestions=${stats.withSuggestions} withoutSuggestions=${stats.withoutSuggestions}`
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
