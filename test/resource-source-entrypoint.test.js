import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const entrypoint = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

test("application entrypoint loads the production resource-source registry and scheduler", () => {
  assert.match(entrypoint, /loadResourceSourceRegistry/);
  assert.match(entrypoint, /resource-sources\.json/);
  assert.match(entrypoint, /createResourceSourceScheduler/);
  assert.match(entrypoint, /db:\s*sqlite/);
  assert.match(entrypoint, /resourceScheduler\.start\(\)/);
});

test("application entrypoint wires mapping events after discovering source keys", () => {
  assert.match(entrypoint, /createMappingRuntime/);
  assert.match(entrypoint, /resourceSourceRegistry\.list\(\)\.map/);
  assert.match(entrypoint, /onSynchronized:\s*mappingRuntime\.onSourceSynchronized/);
  assert.match(entrypoint, /onSubjectsPersisted:\s*mappingRuntime\.onSubjectsPersisted/);
  assert.match(entrypoint, /onDetailPersisted:\s*mappingRuntime\.onDetailPersisted/);
  assert.match(entrypoint, /mappingRuntime\.start\(\)/);
  assert.match(entrypoint, /mappingRuntime\.startup\(\)/);
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
  assert.match(entrypoint, /bangumiRuntime\.metadataService\.searchAndPersist/);
  assert.match(entrypoint, /bangumi\/searchQueue\.js/);
  assert.doesNotMatch(entrypoint, /services\/(anime|searchService|queue)\.js/);
});

test("independent Bangumi metadata scheduler and server startup remain wired", () => {
  assert.match(entrypoint, /createBangumiRuntime/);
  assert.match(entrypoint, /bangumiRuntime\.scheduler\.start\(\)/);
  assert.match(entrypoint, /bangumiRuntime\.scheduler\.startup\(\)/);
  assert.match(entrypoint, /createPublicApiRuntime/);
  assert.match(entrypoint, /publicApiRuntime/);
  assert.match(entrypoint, /createServer/);
  assert.match(entrypoint, /app\.listen/);
});

test("entrypoint composes the new account sync runtime from the shared metadata ensure service", () => {
  assert.match(entrypoint, /createAccountSyncRuntime/);
  assert.match(entrypoint, /metadataEnsureService:\s*bangumiRuntime\.metadataEnsureService/);
  assert.doesNotMatch(entrypoint, /privateSyncRoutes|syncTokenService|privateSyncMergeService/);
});
