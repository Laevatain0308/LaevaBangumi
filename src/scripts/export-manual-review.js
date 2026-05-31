import { initDb } from "../db/index.js";
import { DEFAULT_REVIEW_PATH, exportManualReview } from "../services/manualMatches.js";

initDb();

const output = process.argv[2] || DEFAULT_REVIEW_PATH;
const source = process.env.MANUAL_REVIEW_SOURCE || null;

exportManualReview(output, { source })
  .then((stats) => {
    console.log(`manual review exported: ${stats.filePath} (${stats.rows} rows)`);
    console.log(`animeSources=${stats.animeSources} undecided=${stats.undecided}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
