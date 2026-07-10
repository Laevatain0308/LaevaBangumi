import pLimit from "p-limit";
import {
  BANGUMI_DETAIL_REFRESH_BATCH_SIZE,
  BANGUMI_DETAIL_REFRESH_CONCURRENCY,
  BANGUMI_DETAIL_RETRY_DELAYS_MS,
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

  async function refreshOne(row, attemptedAt) {
    await waitForStartSlot();
    try {
      await metadataService.refreshDetail(row.bangumiId);
      return true;
    } catch (error) {
      const delayIndex = Math.min(row.consecutiveFailures, BANGUMI_DETAIL_RETRY_DELAYS_MS.length - 1);
      try {
        repository.recordDetailRefreshFailure({
          bangumiId: row.bangumiId,
          now: attemptedAt,
          nextRefreshAt: new Date(Date.parse(attemptedAt) + BANGUMI_DETAIL_RETRY_DELAYS_MS[delayIndex]).toISOString(),
          error: error.message ?? String(error),
        });
      } catch (stateError) {
        writeError("bangumi-detail-refresh", "failure state write failed", {
          bangumiId: row.bangumiId,
          message: stateError.message ?? String(stateError),
        });
      }
      writeError("bangumi-detail-refresh", "subject refresh failed", {
        bangumiId: row.bangumiId,
        message: error.message ?? String(error),
      });
      return false;
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
    const results = await Promise.all(due.map((row) => limit(() => refreshOne(row, attemptedAt))));
    const succeeded = results.filter(Boolean).length;
    const result = { due: due.length, succeeded, failed: due.length - succeeded };
    writeLog("bangumi-detail-refresh", "batch completed", result);
    return result;
  }

  return { runDueBatch };
}
