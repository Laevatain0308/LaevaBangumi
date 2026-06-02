import { initDb } from "../db/index.js";
import { getBoolArg, getStringArg, parseCliArgs } from "../lib/cliArgs.js";
import { DEFAULT_REVIEW_PATH, exportManualReview } from "../services/manualMatches.js";

initDb();

const args = parseCliArgs();
const output = getStringArg(args, "output", args.positionals[0] || DEFAULT_REVIEW_PATH);
const source = getStringArg(args, "source", null);
const includeNoResource = getBoolArg(args, "include-no-resource", false);

exportManualReview(output, { source, includeNoResource })
  .then((stats) => {
    console.log(`manual review exported: ${stats.filePath} (${stats.rows} rows)`);
    console.log(`animeSources=${stats.animeSources} undecided=${stats.undecided} includeNoResource=${includeNoResource}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
