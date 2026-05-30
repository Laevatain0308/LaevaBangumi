import test from "node:test";
import assert from "node:assert/strict";
import {
  createTaskCoordinator,
  RETRY_CRON_EXPRESSION,
  SYNC_CRON_EXPRESSION,
} from "../src/services/scheduler.js";

function createLogger() {
  const entries = [];
  return {
    entries,
    log(scope, message, meta) {
      entries.push({ level: "log", scope, message, meta });
    },
    error(scope, message, meta) {
      entries.push({ level: "error", scope, message, meta });
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("cron expressions keep retry away from the sync minute", () => {
  assert.equal(SYNC_CRON_EXPRESSION, "0 */6 * * *");
  assert.equal(RETRY_CRON_EXPRESSION, "7,22,37,52 * * * *");
});

test("runSyncOnce skips overlapping sync attempts", async () => {
  const logger = createLogger();
  const gate = deferred();
  let calls = 0;
  const coordinator = createTaskCoordinator({
    runSync: async () => {
      calls += 1;
      await gate.promise;
      return { ok: true };
    },
    retryPending: async () => ({ retried: 0 }),
    logger,
  });

  const first = coordinator.runSyncOnce({ trigger: "test" });
  await Promise.resolve();
  const second = await coordinator.runSyncOnce({ trigger: "test" });

  assert.equal(second.skipped, true);
  assert.equal(second.reason, "sync_running");
  assert.equal(calls, 1);

  gate.resolve();
  const firstResult = await first;
  assert.equal(firstResult.started, true);
  assert.equal(firstResult.skipped, false);
});

test("runRetryOnce skips while sync is running", async () => {
  const logger = createLogger();
  const gate = deferred();
  let retryCalls = 0;
  const coordinator = createTaskCoordinator({
    runSync: async () => {
      await gate.promise;
    },
    retryPending: async () => {
      retryCalls += 1;
      return { retried: 1 };
    },
    logger,
  });

  const sync = coordinator.runSyncOnce({ trigger: "test" });
  await Promise.resolve();
  const retry = await coordinator.runRetryOnce({ trigger: "test" });

  assert.equal(retry.skipped, true);
  assert.equal(retry.reason, "sync_running");
  assert.equal(retryCalls, 0);

  gate.resolve();
  await sync;
});

test("runRetryOnce runs after sync completes", async () => {
  const logger = createLogger();
  let retryCalls = 0;
  const coordinator = createTaskCoordinator({
    runSync: async () => ({ synced: true }),
    retryPending: async () => {
      retryCalls += 1;
      return { retried: 2 };
    },
    logger,
  });

  await coordinator.runSyncOnce({ trigger: "test" });
  const retry = await coordinator.runRetryOnce({ trigger: "test" });

  assert.equal(retry.started, true);
  assert.equal(retry.skipped, false);
  assert.deepEqual(retry.stats, { retried: 2 });
  assert.equal(retryCalls, 1);
});
