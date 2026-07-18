import cronModule from "node-cron";
import { createBangumiMetadataClient } from "../bangumi/client.js";
import { createBangumiRepository } from "../bangumi/repository.js";
import { createMetadataEnsureService } from "../bangumi/metadataEnsureService.js";
import { createBangumiMetadataService } from "../bangumi/metadataService.js";
import { createBangumiCalendarService } from "../bangumi/calendarService.js";
import { createBangumiDetailRefreshService } from "../bangumi/detailRefreshService.js";
import { createMetadataRefreshWorker } from "../bangumi/metadataRefreshWorker.js";
import { createBangumiScheduler } from "../bangumi/scheduler.js";

export function createBangumiRuntime({
  sqlite,
  cron = cronModule,
  logger = {},
  clock = () => new Date(),
  client = createBangumiMetadataClient(),
}) {
  const writeError = logger.error ?? (() => {});
  const repository = createBangumiRepository(sqlite);
  let metadataWorker;
  const metadataEnsureService = createMetadataEnsureService({
    repository,
    clock,
    wake() {
      metadataWorker?.wake().catch((error) => {
        writeError("bangumi-detail-refresh", "background drain failed", {
          message: error.message ?? String(error),
        });
      });
    },
  });
  const metadataService = createBangumiMetadataService({
    client,
    repository,
    ensureMetadata: metadataEnsureService.ensure,
    clock,
    logger,
  });
  const calendarService = createBangumiCalendarService({
    client,
    repository,
    ensureMetadata: metadataEnsureService.ensure,
    clock,
    logger,
  });
  const detailRefresher = createBangumiDetailRefreshService({
    metadataService,
    repository,
    clock,
    logger,
  });
  metadataWorker = createMetadataRefreshWorker({ detailRefresher });
  const scheduler = createBangumiScheduler({
    cron,
    metadataWorker,
    calendarService,
    logger,
  });

  return {
    repository,
    metadataEnsureService,
    metadataService,
    calendarService,
    detailRefresher,
    metadataWorker,
    scheduler,
  };
}
