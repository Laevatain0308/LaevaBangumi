import pLimit from "p-limit";
import {
  BANGUMI_DETAIL_REFRESH_BATCH_SIZE,
  BANGUMI_DETAIL_REFRESH_CONCURRENCY,
  BANGUMI_REQUEST_START_INTERVAL_MS,
} from "./config.js";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBangumiDetailRefreshService({
  metadataService,
  repository,
  clock = () => new Date(),
  sleep = defaultSleep,
  monotonicNow = () => performance.now(),
  logger = {},
}) {
  const writeLog = logger.log ?? (() => {});
  const writeError = logger.error ?? (() => {});
  let nextStartAt = null;
  let startGate = Promise.resolve();

  function waitForStartSlot() {
    const scheduled = startGate.then(async () => {
      const now = monotonicNow();
      if (nextStartAt === null) nextStartAt = now;
      const waitMs = Math.max(0, nextStartAt - now);
      if (waitMs > 0) await sleep(waitMs);
      const startedAt = monotonicNow();
      nextStartAt = Math.max(nextStartAt, startedAt) + BANGUMI_REQUEST_START_INTERVAL_MS;
    });
    startGate = scheduled.catch(() => {});
    return scheduled;
  }

  async function refreshOne(row) {
    await waitForStartSlot();
    try {
      await metadataService.refreshDetail(row.bangumiId);
      return { succeeded: true, settled: true };
    } catch (error) {
      writeError("bangumi-detail-refresh", "subject refresh failed", {
        bangumiId: row.bangumiId,
        message: error.message ?? String(error),
      });
      return { succeeded: false, settled: error.refreshStateRecorded === true };
    }
  }

  async function runDueBatch() {
    const attemptedAt = clock().toISOString();
    const due = repository.listDueRefreshIds({
      now: attemptedAt,
      limit: BANGUMI_DETAIL_REFRESH_BATCH_SIZE,
    });
    nextStartAt = null;
    startGate = Promise.resolve();
    const limit = pLimit(BANGUMI_DETAIL_REFRESH_CONCURRENCY);
    const results = await Promise.all(due.map((row) => limit(() => refreshOne(row))));
    const succeeded = results.filter((result) => result.succeeded).length;
    const settled = results.filter((result) => result.settled).length;
    const result = { due: due.length, succeeded, failed: due.length - succeeded, settled };
    writeLog("bangumi-detail-refresh", "batch completed", result);
    return result;
  }

  return { runDueBatch };
}
