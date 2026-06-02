import { initDb } from "../db/index.js";
import { getBoolArg, getIntArg, getStringArg, parseCliArgs } from "../lib/cliArgs.js";
import { DEFAULT_MAPPED_REVIEW_PATH, exportMappedReview } from "../services/manualMatches.js";

initDb();

const args = parseCliArgs();
const output = getStringArg(args, "output", args.positionals[0] || DEFAULT_MAPPED_REVIEW_PATH);
const source = getStringArg(args, "source", null);
const animeId = getIntArg(args, "anime-id");
const sourceAid = getIntArg(args, "source-aid");
const query = getStringArg(args, "query", "");
const rangedOnly = getBoolArg(args, "ranged-only", false);
const multiMappedOnly = getBoolArg(args, "multi-mapped-only", false);
const limit = getIntArg(args, "limit");

exportMappedReview(output, { source, animeId, sourceAid, query, rangedOnly, multiMappedOnly, limit })
  .then((stats) => {
    console.log(`mapped review exported: ${stats.filePath} (${stats.rows} rows)`);
    console.log(`mappings=${stats.mappings} ranged=${stats.ranged} multiMapped=${stats.multiMapped}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
