import cronModule from "node-cron";
import { createBangumiMetadataClient } from "./client.js";
import { createBangumiRepository } from "./repository.js";
import { createBangumiMetadataService } from "./metadataService.js";
import { createBangumiCalendarService } from "./calendarService.js";
import { createBangumiDetailRefreshService } from "./detailRefreshService.js";
import {
  BANGUMI_CALENDAR_SYNC_CRON,
  BANGUMI_DETAIL_REFRESH_CRON,
  BANGUMI_SCHEDULER_TIMEZONE,
} from "./config.js";

export function createBangumiScheduler({
  cron,
  detailRefresher,
  calendarService,
  logger = {},
}) {
  const writeLog = logger.log ?? (() => {});
  const writeError = logger.error ?? (() => {});
  let detailRunning = false;
  let calendarRunning = false;

  async function runDetails(trigger = "manual") {
    if (detailRunning) return { started: false, skipped: true, reason: "detail_refresh_running" };
    detailRunning = true;
    try {
      const result = await detailRefresher.runDueBatch();
      writeLog("bangumi-detail-refresh", "run completed", { trigger, ...result });
      return { started: true, skipped: false, result };
    } finally {
      detailRunning = false;
    }
  }

  async function runCalendar(trigger = "manual") {
    if (calendarRunning) return { started: false, skipped: true, reason: "calendar_sync_running" };
    calendarRunning = true;
    try {
      const result = await calendarService.sync();
      writeLog("bangumi-calendar", "run completed", { trigger, ...result });
      return { started: true, skipped: false, result };
    } finally {
      calendarRunning = false;
    }
  }

  async function startup() {
    const details = await runDetails("startup");
    const calendar = calendarService.isStale()
      ? await runCalendar("startup")
      : { started: false, skipped: true, reason: "calendar_fresh" };
    return { details, calendar };
  }

  function guarded(run, scope) {
    return async () => {
      try {
        await run("cron");
      } catch (error) {
        writeError(scope, "scheduled run failed", error);
      }
    };
  }

  function start() {
    return [
      cron.schedule(
        BANGUMI_DETAIL_REFRESH_CRON,
        guarded(runDetails, "bangumi-detail-refresh"),
        { timezone: BANGUMI_SCHEDULER_TIMEZONE },
      ),
      cron.schedule(
        BANGUMI_CALENDAR_SYNC_CRON,
        guarded(runCalendar, "bangumi-calendar"),
        { timezone: BANGUMI_SCHEDULER_TIMEZONE },
      ),
    ];
  }

  return {
    start,
    startup,
    runDetails,
    runCalendar,
    state: () => ({ detailRunning, calendarRunning }),
  };
}

export function createProductionBangumiScheduler({ sqlite, cron = cronModule, logger = {} }) {
  const repository = createBangumiRepository(sqlite);
  const client = createBangumiMetadataClient();
  const metadataService = createBangumiMetadataService({ client, repository });
  const calendarService = createBangumiCalendarService({ client, repository, logger });
  const detailRefresher = createBangumiDetailRefreshService({ metadataService, repository, logger });
  return createBangumiScheduler({ cron, detailRefresher, calendarService, logger });
}
