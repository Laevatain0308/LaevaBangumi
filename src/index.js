import cron from "node-cron";
import { initDb, sqlite } from "./db/index.js";
import { createServer } from "./server.js";
import { enrichFromBangumiSearch, registerMetadataRefreshJob } from "./services/anime.js";
import { onSearchFlush } from "./services/queue.js";
import { getProxyStatus } from "./lib/proxy.js";
import { log, warn, error } from "./lib/logger.js";
import { createBangumiRuntime } from "./runtime/bangumiRuntime.js";
import { createAccountSyncRuntime } from "./runtime/accountSyncRuntime.js";
import { loadResourceSourceRegistry } from "./resourceSources/pluginRegistry.js";
import { createResourceSourceScheduler } from "./resourceSources/scheduler.js";

const PORT = parseInt(process.env.PORT, 10) || 3002;

initDb();
log("boot", "database initialized");
log("boot", "Bangumi proxy status", getProxyStatus());

const resourceSourceRegistry = await loadResourceSourceRegistry({
  manifestPath: new URL("../config/resource-sources.json", import.meta.url),
  db: sqlite,
  logger: { log, warn, error },
});
const resourceScheduler = createResourceSourceScheduler({
  registry: resourceSourceRegistry,
  cron,
  logger: { log, error },
});
resourceScheduler.start();

const bangumiRuntime = createBangumiRuntime({ sqlite, cron, logger: { log, error } });
bangumiRuntime.scheduler.start();
bangumiRuntime.scheduler.startup().catch((err) => error("bangumi", "startup sync failed", err));

// 队列回调：异步搜索由队列驱动
registerMetadataRefreshJob();
onSearchFlush((keyword, options) => enrichFromBangumiSearch(keyword, {
  ...options,
  metadataService: bangumiRuntime.metadataService,
}));

const accountSyncRuntime = createAccountSyncRuntime({
  sqlite,
  metadataEnsureService: bangumiRuntime.metadataEnsureService,
  logger: { log, error },
});
const app = createServer({
  accountSyncRuntime,
  ensureMetadata: bangumiRuntime.metadataEnsureService.ensure,
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
