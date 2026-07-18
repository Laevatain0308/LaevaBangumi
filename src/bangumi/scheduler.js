import {
  BANGUMI_CALENDAR_SYNC_CRON,
  BANGUMI_DETAIL_REFRESH_CRON,
  BANGUMI_SCHEDULER_TIMEZONE,
} from "./config.js";

export function createBangumiScheduler({
  cron,
  metadataWorker,
  calendarService,
  logger = {},
}) {
  const writeLog = logger.log ?? (() => {});
  const writeError = logger.error ?? (() => {});
  let calendarRunning = false;

  async function runDetails(trigger = "manual") {
    const result = await metadataWorker.drain();
    writeLog("bangumi-detail-refresh", "run completed", { trigger, ...result });
    return { started: true, skipped: false, result };
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
    const detailPromise = runDetails("startup");
    const calendarPromise = calendarService.isStale()
      ? runCalendar("startup")
      : Promise.resolve({ started: false, skipped: true, reason: "calendar_fresh" });
    const [details, calendar] = await Promise.allSettled([detailPromise, calendarPromise]);
    if (details.status === "rejected") throw details.reason;
    if (calendar.status === "rejected") throw calendar.reason;
    return { details: details.value, calendar: calendar.value };
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
    state: () => ({ detailRunning: metadataWorker.state().running, calendarRunning }),
  };
}
