import cron from "node-cron";
import { initDb, sqlite } from "./db/index.js";
import { createServer } from "./server.js";
import { enqueueSearch, onSearchFlush } from "./bangumi/searchQueue.js";
import { getProxyStatus } from "./lib/proxy.js";
import { log, warn, error } from "./lib/logger.js";
import { createBangumiRuntime } from "./runtime/bangumiRuntime.js";
import { createAccountSyncRuntime } from "./runtime/accountSyncRuntime.js";
import { loadResourceSourceRegistry } from "./resourceSources/pluginRegistry.js";
import { createResourceSourceScheduler } from "./resourceSources/scheduler.js";
import { createMappingRuntime } from "./mappings/mappingRuntime.js";
import { createPublicApiRuntime } from "./runtime/publicApiRuntime.js";

const PORT = parseInt(process.env.PORT, 10) || 3002;

initDb();
log("boot", "database initialized");
log("boot", "Bangumi proxy status", getProxyStatus());

const resourceSourceRegistry = await loadResourceSourceRegistry({
  manifestPath: new URL("../config/resource-sources.json", import.meta.url),
  db: sqlite,
  logger: { log, warn, error },
});
const sourceKeys = resourceSourceRegistry.list().map(({ sourceKey }) => sourceKey);
const mappingRuntime = createMappingRuntime({
  sqlite,
  sourceKeys,
  cron,
  logger: { log, error },
});
const resourceScheduler = createResourceSourceScheduler({
  registry: resourceSourceRegistry,
  cron,
  logger: { log, error },
  onSynchronized: mappingRuntime.onSourceSynchronized,
});
resourceScheduler.start();
mappingRuntime.start();
mappingRuntime.startup().catch((err) => {
  error("anime-resource-mapping", "startup reconciliation failed", err);
});

const bangumiRuntime = createBangumiRuntime({
  sqlite,
  cron,
  logger: { log, error },
  onSubjectsPersisted: mappingRuntime.onSubjectsPersisted,
  onDetailPersisted: mappingRuntime.onDetailPersisted,
});
bangumiRuntime.scheduler.start();
bangumiRuntime.scheduler.startup().catch((err) => error("bangumi", "startup sync failed", err));

onSearchFlush((keyword, options) => (
  bangumiRuntime.metadataService.searchAndPersist(keyword, options)
));

const publicApiRuntime = createPublicApiRuntime({
  sqlite,
  resourceSourceRegistry,
  metadataEnsureService: bangumiRuntime.metadataEnsureService,
  logger: { log, error },
});

const accountSyncRuntime = createAccountSyncRuntime({
  sqlite,
  metadataEnsureService: bangumiRuntime.metadataEnsureService,
  logger: { log, error },
});
const app = createServer({
  publicApiRuntime,
  accountSyncRuntime,
  enqueueRemoteSearch: enqueueSearch,
  logger: { log, error },
});
app.listen(PORT, () => {
  log("boot", "server started", { url: `http://localhost:${PORT}` });
});

if (process.argv.includes("--sync")) {
  log("resource-source", "manual full initialization started");
  resourceScheduler.runInitializations("manual").catch((err) => {
    error("resource-source", "manual full initialization failed", err);
  });
}
