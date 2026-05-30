import { error as defaultError, log as defaultLog } from "../lib/logger.js";

export const SYNC_CRON_EXPRESSION = "0 */6 * * *";
export const RETRY_CRON_EXPRESSION = "7,22,37,52 * * * *";

function nowIso() {
  return new Date().toISOString();
}

function scopeFor({ initial, trigger }) {
  if (initial || trigger === "init") return "init";
  if (trigger === "retry") return "retry";
  return "cron";
}

function elapsedSince(startMs) {
  return Date.now() - startMs;
}

export function createTaskCoordinator({ runSync, retryPending, logger = {} }) {
  if (typeof runSync !== "function") throw new Error("createTaskCoordinator requires runSync");
  if (typeof retryPending !== "function") throw new Error("createTaskCoordinator requires retryPending");

  const writeLog = logger.log ?? defaultLog;
  const writeError = logger.error ?? defaultError;
  let syncRunning = false;
  let syncStartedAt = null;
  let retryRunning = false;
  let retryStartedAt = null;

  async function runSyncOnce({ initial = false, trigger = "cron" } = {}) {
    const scope = scopeFor({ initial, trigger });
    if (syncRunning) {
      writeLog(scope, "sync skipped because previous sync is still running", { trigger, initial, syncStartedAt });
      return { started: false, skipped: true, reason: "sync_running", syncStartedAt };
    }

    syncRunning = true;
    syncStartedAt = nowIso();
    const startedMs = Date.now();
    writeLog(scope, "sync started", { trigger, initial, syncStartedAt });

    try {
      const stats = await runSync({ initial, trigger });
      const durationMs = elapsedSince(startedMs);
      writeLog(scope, "sync completed", { trigger, initial, durationMs, stats });
      return { started: true, skipped: false, stats, durationMs };
    } catch (err) {
      writeError(scope, "sync failed", err);
      throw err;
    } finally {
      syncRunning = false;
      syncStartedAt = null;
    }
  }

  async function runRetryOnce({ trigger = "retry" } = {}) {
    if (syncRunning) {
      writeLog("retry", "retry skipped because sync is running", { trigger, syncStartedAt });
      return { started: false, skipped: true, reason: "sync_running", syncStartedAt };
    }
    if (retryRunning) {
      writeLog("retry", "retry skipped because previous retry is still running", { trigger, retryStartedAt });
      return { started: false, skipped: true, reason: "retry_running", retryStartedAt };
    }

    retryRunning = true;
    retryStartedAt = nowIso();
    const startedMs = Date.now();
    writeLog("retry", "retry started", { trigger, retryStartedAt });

    try {
      const stats = await retryPending();
      const durationMs = elapsedSince(startedMs);
      writeLog("retry", "retry completed", { trigger, durationMs, stats });
      return { started: true, skipped: false, stats, durationMs };
    } catch (err) {
      writeError("retry", "retry failed", err);
      throw err;
    } finally {
      retryRunning = false;
      retryStartedAt = null;
    }
  }

  function state() {
    return { syncRunning, syncStartedAt, retryRunning, retryStartedAt };
  }

  return { runSyncOnce, runRetryOnce, state };
}
