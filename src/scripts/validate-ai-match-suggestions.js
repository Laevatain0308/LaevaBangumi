import { getStringArg, parseCliArgs } from "../lib/cliArgs.js";
import { validateAiMatchSuggestions } from "../services/aiMatchSuggestionValidator.js";

const args = parseCliArgs();
const packDir = getStringArg(args, "pack-dir", args.positionals[0] || "data/manual/ai-match-pack");
const suggestionsFile = getStringArg(args, "suggestions", null);
const outputDir = getStringArg(args, "output", null);

validateAiMatchSuggestions({ packDir, suggestionsFile, outputDir })
  .then((stats) => {
    console.log(`AI suggestions validated: ${stats.outputDir}`);
    console.log(`suggestions=${stats.suggestions} accepted=${stats.accepted} ambiguous=${stats.ambiguous} skipped=${stats.skipped}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

