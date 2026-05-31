import { initDb } from "../db/index.js";
import { DEFAULT_MAPPED_REVIEW_PATH, importMappedReview } from "../services/manualMatches.js";

initDb();

const input = process.argv[2] || DEFAULT_MAPPED_REVIEW_PATH;
const refreshEpisodes = process.env.REFRESH_EPISODES !== "0";

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
