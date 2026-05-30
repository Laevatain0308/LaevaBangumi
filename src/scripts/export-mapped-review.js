import { initDb } from "../db/index.js";
import { DEFAULT_MAPPED_REVIEW_PATH, exportMappedReview } from "../services/manualMatches.js";

function intEnv(name, fallback = null) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
}

initDb();

const output = process.argv[2] || DEFAULT_MAPPED_REVIEW_PATH;
const source = process.env.MAPPED_REVIEW_SOURCE || null;
const animeId = intEnv("MAPPED_REVIEW_ANIME_ID");
const sourceAid = intEnv("MAPPED_REVIEW_SOURCE_AID");
const query = process.env.MAPPED_REVIEW_QUERY || "";
const rangedOnly = boolEnv("MAPPED_REVIEW_RANGED_ONLY");
const multiMappedOnly = boolEnv("MAPPED_REVIEW_MULTI_MAPPED_ONLY");
const limit = intEnv("MAPPED_REVIEW_LIMIT");

exportMappedReview(output, { source, animeId, sourceAid, query, rangedOnly, multiMappedOnly, limit })
  .then((stats) => {
    console.log(`mapped review exported: ${stats.filePath} (${stats.rows} rows)`);
    console.log(`mappings=${stats.mappings} ranged=${stats.ranged} multiMapped=${stats.multiMapped}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
