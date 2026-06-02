import { initDb } from "../db/index.js";
import { getBoolArg, getStringArg, parseCliArgs } from "../lib/cliArgs.js";
import { DEFAULT_MAPPED_REVIEW_PATH, importMappedReview } from "../services/manualMatches.js";

initDb();

const args = parseCliArgs();
const input = getStringArg(args, "input", args.positionals[0] || DEFAULT_MAPPED_REVIEW_PATH);
const refreshEpisodes = getBoolArg(args, "refresh-episodes", true);

importMappedReview(input, { refreshEpisodes })
  .then((stats) => {
    console.log(`mapped review imported: ${stats.filePath} (${stats.updated}/${stats.rows} rows)`);
    console.log(
      `matched=${stats.matched} deleted=${stats.deleted} wait_airing=${stats.waitAiring} no_resource=${stats.noResource} skipped=${stats.skipped} refreshed=${stats.refreshed}`
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
