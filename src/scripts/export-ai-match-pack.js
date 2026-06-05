import { initDb } from "../db/index.js";
import { getBoolArg, getIntArg, getStringArg, parseCliArgs } from "../lib/cliArgs.js";
import { exportAiMatchPack } from "../services/aiMatchPackService.js";

initDb();

const args = parseCliArgs();
const output = getStringArg(args, "output", args.positionals[0] || "data/manual/ai-match-pack");
const source = getStringArg(args, "source", null);
const candidateLimit = getIntArg(args, "candidate-limit", 20);
const includeMapped = getBoolArg(args, "include-mapped", false);

exportAiMatchPack(output, { source, candidateLimit, includeMapped })
  .then((stats) => {
    console.log(`AI match pack exported: ${stats.outputDir}`);
    console.log(`cases=${stats.cases} resource_items=${stats.resourceItems} existing_mappings=${stats.existingMappings}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

