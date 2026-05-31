import { initDb } from "../db/index.js";
import { DEFAULT_REVIEW_PATH, importManualReview } from "../services/manualMatches.js";

initDb();

const input = process.argv[2] || DEFAULT_REVIEW_PATH;
const refreshEpisodes = process.env.REFRESH_EPISODES !== "0";

importManualReview(input, { refreshEpisodes })
  .then((stats) => {
    console.log(`manual review imported: ${stats.filePath} (${stats.updated}/${stats.rows} rows)`);
    console.log(
      `matched=${stats.matched} wait_airing=${stats.waitAiring} no_resource=${stats.noResource} skipped=${stats.skipped} refreshed=${stats.refreshed}`
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
