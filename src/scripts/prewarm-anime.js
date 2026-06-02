import { initDb } from "../db/index.js";
import { getBoolArg, getIntArg, getStringArg, parseCliArgs } from "../lib/cliArgs.js";
import { prewarmAnime } from "../services/anime.js";

initDb();

const args = parseCliArgs();
const ids = getStringArg(args, "id", getStringArg(args, "ids", ""));
const query = getStringArg(args, "query", getStringArg(args, "q", ""));
const source = getStringArg(args, "source", getStringArg(args, "sources", null));
const mappedOnly = getBoolArg(args, "mapped-only", false);
const refreshEpisodes = getBoolArg(args, "refresh-episodes", true);
const limit = getIntArg(args, "limit", null);

if (!ids && !query) {
  console.error("prewarm:anime requires --id/--ids or --query");
  process.exit(1);
}

prewarmAnime({
  ids,
  query,
  sourceKeys: source,
  mappedOnly,
  refreshEpisodes,
  limit,
})
  .then((stats) => {
    console.log(
      `anime prewarm completed: requested=${stats.requested} upserted=${stats.upserted} processed=${stats.processed} matched=${stats.matched} refreshed=${stats.refreshed} skipped=${stats.skipped} errors=${stats.errors}`
    );
    for (const item of stats.items) {
      const sourceSummary = item.sources
        .map((sourceItem) => {
          const aid = sourceItem.cstationId ? `#${sourceItem.cstationId}` : "";
          const ep = sourceItem.epCount != null ? ` eps=${sourceItem.epCount}` : "";
          const reason = sourceItem.reason ? ` reason=${sourceItem.reason}` : "";
          return `${sourceItem.source}:${sourceItem.mapping}/${sourceItem.episodes}${aid}${ep}${reason}`;
        })
        .join(" ");
      console.log(`${item.animeId}\t${item.metadata}\t${item.title || ""}\t${sourceSummary}`);
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
