import { initDb } from "../db/index.js";
import { DEFAULT_REVIEW_PATH, exportManualReview } from "../services/manualMatches.js";

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
}

initDb();

const output = process.argv[2] || DEFAULT_REVIEW_PATH;
const source = process.env.MANUAL_REVIEW_SOURCE || null;
const includeNoResource = boolEnv("MANUAL_REVIEW_INCLUDE_NO_RESOURCE");

exportManualReview(output, { source, includeNoResource })
  .then((stats) => {
    console.log(`manual review exported: ${stats.filePath} (${stats.rows} rows)`);
    console.log(`animeSources=${stats.animeSources} undecided=${stats.undecided} includeNoResource=${includeNoResource}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
