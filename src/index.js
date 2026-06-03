import cron from "node-cron";
import { initDb } from "./db/index.js";
import { db } from "./db/index.js";
import { subjects } from "./db/schema.js";
import { createServer } from "./server.js";
import { syncCalendar, retryPending, enrichFromBangumiSearch, registerAnimeJobs, batchMatch, enqueueEpisodeRefreshesBySourceIds } from "./services/anime.js";
import { onSearchFlush } from "./services/queue.js";
import { syncCatalogCategory } from "./services/catalog.js";
import { createTaskCoordinator, RETRY_CRON_EXPRESSION, SYNC_CRON_EXPRESSION } from "./services/scheduler.js";
import { getCategoryConfigs, getEnabledSources } from "./lib/cstationConfig.js";
import { getProxyStatus } from "./lib/proxy.js";
import { log, error } from "./lib/logger.js";

const PORT = parseInt(process.env.PORT, 10) || 3002;

initDb();
log("boot", "database initialized");
log("boot", "Bangumi proxy status", getProxyStatus());

// 队列回调：异步搜索由队列驱动
registerAnimeJobs();
onSearchFlush(enrichFromBangumiSearch);

const app = createServer();
app.listen(PORT, () => {
  log("boot", "server started", { url: `http://localhost:${PORT}` });
});

async function runSync({ initial = false } = {}) {
  const totals = {
    catalogCategories: 0,
    changedCatalogItems: 0,
    queuedEpisodeRefreshes: 0,
    calendar: null,
    matched: null,
  };

  for (const source of getEnabledSources()) {
    for (const category of getCategoryConfigs(source.key)) {
      const stats = await syncCatalogCategory({
        source: source.key,
        t: category.tid,
        incremental: !initial,
        hydrateDetails: !initial,
      });
      const queued = enqueueEpisodeRefreshesBySourceIds(stats.changedIds || [], { source: source.key });
      totals.catalogCategories += 1;
      totals.changedCatalogItems += stats.changedIds?.length || 0;
      totals.queuedEpisodeRefreshes += queued;
      log(initial ? "init" : "cron", "catalog category completed", { ...stats, categoryName: category.name, queuedEpisodeRefreshes: queued });
    }
  }
  const stats = await syncCalendar();
  totals.calendar = stats;
  log(initial ? "init" : "cron", "calendar completed", stats);
  const m = await batchMatch();
  totals.matched = m;
  log(initial ? "init" : "cron", "batch match completed", m);
  return totals;
}

const coordinator = createTaskCoordinator({ runSync, retryPending });

// 定时任务：每 6 小时同步
cron.schedule(SYNC_CRON_EXPRESSION, async () => {
  try {
    await coordinator.runSyncOnce({ trigger: "cron" });
  } catch (err) {
    error("cron", "scheduled sync failed", err);
  }
});

cron.schedule(RETRY_CRON_EXPRESSION, async () => {
  try {
    await coordinator.runRetryOnce({ trigger: "retry" });
  } catch (err) {
    error("retry", "scheduled retry failed", err);
  }
});

if (process.argv.includes("--sync")) {
  log("init", "manual initial sync started");
  coordinator.runSyncOnce({ initial: true, trigger: "init" }).catch((err) => error("init", "manual initial sync failed", err));
} else {
  const hasAnime = db.select({ id: subjects.bangumiId }).from(subjects).limit(1).get();
  if (!hasAnime) {
    log("init", "database empty, background initial sync started");
    coordinator.runSyncOnce({ initial: true, trigger: "init" }).catch((err) => error("init", "background initial sync failed", err));
  }
}
