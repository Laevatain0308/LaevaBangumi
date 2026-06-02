import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getBoolArg, getIntArg, getNumberArg, getStringArg, parseCliArgs } from "../src/lib/cliArgs.js";

test("parseCliArgs parses named options and positional arguments", () => {
  const args = parseCliArgs([
    "output.csv",
    "--source",
    "ffzy",
    "--limit=20",
    "--include-no-resource",
    "--no-relaxed-year-fallback",
  ]);

  assert.deepEqual(args.positionals, ["output.csv"]);
  assert.equal(getStringArg(args, "source"), "ffzy");
  assert.equal(getIntArg(args, "limit", 5), 20);
  assert.equal(getBoolArg(args, "include-no-resource"), true);
  assert.equal(getBoolArg(args, "relaxed-year-fallback", true), false);
});

test("parseCliArgs supports explicit boolean and numeric values", () => {
  const args = parseCliArgs([
    "--refresh-episodes=false",
    "--min-score",
    "0.35",
    "--anime-id",
    "400602",
  ]);

  assert.equal(getBoolArg(args, "refresh-episodes", true), false);
  assert.equal(getNumberArg(args, "min-score", 0.25), 0.35);
  assert.equal(getIntArg(args, "anime-id"), 400602);
});

test("package scripts expose prewarm and remove analyze unmatched", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.scripts["prewarm:anime"], "node src/scripts/prewarm-anime.js");
  assert.equal("analyze:unmatched" in pkg.scripts, false);
});
