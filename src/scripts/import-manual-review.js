import { initDb } from "../db/index.js";
import { getBoolArg, getStringArg, parseCliArgs } from "../lib/cliArgs.js";
import { DEFAULT_REVIEW_PATH, importManualReview } from "../services/manualMatches.js";

initDb();

const args = parseCliArgs();
const input = getStringArg(args, "input", args.positionals[0] || DEFAULT_REVIEW_PATH);
const refreshEpisodes = getBoolArg(args, "refresh-episodes", true);
const dryRun = getBoolArg(args, "dry-run", false);

importManualReview(input, { refreshEpisodes, dryRun })
  .then((stats) => {
    console.log(`manual review ${dryRun ? "validated" : "imported"}: ${stats.filePath} (${stats.updated}/${stats.rows} rows)`);
    console.log(
      `matched=${stats.matched} wait_airing=${stats.waitAiring} no_resource=${stats.noResource} skipped=${stats.skipped} refreshed=${stats.refreshed} dry_run=${stats.dryRun}`
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
