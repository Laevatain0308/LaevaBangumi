import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const entrypoint = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const searchService = readFileSync(new URL("../src/services/searchService.js", import.meta.url), "utf8");

test("application entrypoint loads the production resource-source registry and scheduler", () => {
  assert.match(entrypoint, /loadResourceSourceRegistry/);
  assert.match(entrypoint, /resource-sources\.json/);
  assert.match(entrypoint, /createResourceSourceScheduler/);
  assert.match(entrypoint, /db:\s*sqlite/);
  assert.match(entrypoint, /resourceScheduler\.start\(\)/);
});

test("manual --sync is the only resource-source initialization path", () => {
  assert.match(entrypoint, /process\.argv\.includes\("--sync"\)/);
  assert.match(entrypoint, /resourceScheduler\.runInitializations\("manual"\)/);
  assert.doesNotMatch(entrypoint, /database empty/i);
  assert.doesNotMatch(entrypoint, /subjects\.bangumiId/);
});

test("production entrypoint no longer wires the legacy FFZY resource pipeline", () => {
  for (const symbol of [
    "syncCatalogCategory",
    "enqueueEpisodeRefreshesBySourceIds",
    "batchMatch",
    "retryPending",
    "getEnabledSources",
    "getCategoryConfigs",
    "createTaskCoordinator",
    "RETRY_CRON_EXPRESSION",
    "registerAnimeJobs",
  ]) {
    assert.equal(entrypoint.includes(symbol), false, `${symbol} must not be wired by src/index.js`);
  }
});

test("background Bangumi search no longer triggers legacy FFZY matching or episode refresh", () => {
  assert.doesNotMatch(searchService, /resourceMatchService/);
  assert.doesNotMatch(searchService, /ensureMappingForAnime/);
  assert.doesNotMatch(searchService, /enqueueEpisodeRefresh/);
  assert.doesNotMatch(searchService, /getEnabledSourceKeys/);
});

test("independent Bangumi metadata scheduler and server startup remain wired", () => {
  assert.match(entrypoint, /createProductionBangumiScheduler/);
  assert.match(entrypoint, /bangumiScheduler\.start\(\)/);
  assert.match(entrypoint, /bangumiScheduler\.startup\(\)/);
  assert.match(entrypoint, /createServer/);
  assert.match(entrypoint, /app\.listen/);
});
