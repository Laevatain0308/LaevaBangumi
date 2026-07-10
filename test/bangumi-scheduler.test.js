import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createBangumiScheduler,
  createProductionBangumiScheduler,
} from "../src/bangumi/scheduler.js";
import { createTestDatabase } from "./helpers/testDatabase.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createCron() {
  const calls = [];
  return {
    calls,
    schedule(expression, handler, options) {
      calls.push({ expression, handler, options });
      return { stop() {} };
    },
  };
}

test("registers fixed cron jobs in Asia/Shanghai", () => {
  const cron = createCron();
  const scheduler = createBangumiScheduler({
    cron,
    detailRefresher: { runDueBatch: async () => ({ due: 0, succeeded: 0, failed: 0 }) },
    calendarService: { isStale: () => false, sync: async () => ({ members: 0 }) },
  });

  const tasks = scheduler.start();
  assert.equal(tasks.length, 2);
  assert.deepEqual(cron.calls.map(({ expression, options }) => ({ expression, ...options })), [
    { expression: "17 * * * *", timezone: "Asia/Shanghai" },
    { expression: "15 4 * * *", timezone: "Asia/Shanghai" },
  ]);
});

test("startup always scans due details and syncs only a stale calendar", async () => {
  let detailRuns = 0;
  let calendarRuns = 0;
  const scheduler = createBangumiScheduler({
    cron: createCron(),
    detailRefresher: { runDueBatch: async () => { detailRuns += 1; return { due: 0 }; } },
    calendarService: {
      isStale: () => true,
      sync: async () => { calendarRuns += 1; return { members: 1 }; },
    },
  });

  const result = await scheduler.startup();
  assert.equal(detailRuns, 1);
  assert.equal(calendarRuns, 1);
  assert.equal(result.details.started, true);
  assert.equal(result.calendar.started, true);
});

test("startup skips a fresh calendar", async () => {
  let calendarRuns = 0;
  const scheduler = createBangumiScheduler({
    cron: createCron(),
    detailRefresher: { runDueBatch: async () => ({ due: 0 }) },
    calendarService: {
      isStale: () => false,
      sync: async () => { calendarRuns += 1; },
    },
  });

  const result = await scheduler.startup();
  assert.equal(calendarRuns, 0);
  assert.deepEqual(result.calendar, { started: false, skipped: true, reason: "calendar_fresh" });
});

test("skips overlap independently for detail and calendar jobs", async () => {
  const detailGate = deferred();
  let detailRuns = 0;
  let calendarRuns = 0;
  const scheduler = createBangumiScheduler({
    cron: createCron(),
    detailRefresher: {
      async runDueBatch() {
        detailRuns += 1;
        await detailGate.promise;
        return { due: 1 };
      },
    },
    calendarService: {
      isStale: () => true,
      async sync() { calendarRuns += 1; return { members: 1 }; },
    },
  });

  const first = scheduler.runDetails("test");
  await Promise.resolve();
  const second = await scheduler.runDetails("test");
  const calendar = await scheduler.runCalendar("test");

  assert.deepEqual(second, { started: false, skipped: true, reason: "detail_refresh_running" });
  assert.equal(calendar.started, true);
  assert.equal(detailRuns, 1);
  assert.equal(calendarRuns, 1);
  assert.deepEqual(scheduler.state(), { detailRunning: true, calendarRunning: false });

  detailGate.resolve();
  await first;
  assert.deepEqual(scheduler.state(), { detailRunning: false, calendarRunning: false });
});

test("cron callbacks catch failures and release locks", async () => {
  const cron = createCron();
  const errors = [];
  const scheduler = createBangumiScheduler({
    cron,
    detailRefresher: { runDueBatch: async () => { throw new Error("detail failed"); } },
    calendarService: { isStale: () => true, sync: async () => { throw new Error("calendar failed"); } },
    logger: { error(scope, message, error) { errors.push({ scope, message, error: error.message }); } },
  });
  scheduler.start();

  await cron.calls[0].handler();
  await cron.calls[1].handler();
  assert.equal(errors.length, 2);
  assert.deepEqual(scheduler.state(), { detailRunning: false, calendarRunning: false });
});

test("production scheduler constructs against a metadata-only database", (t) => {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const scheduler = createProductionBangumiScheduler({ sqlite, cron: createCron() });
  assert.equal(typeof scheduler.start, "function");
  assert.equal(typeof scheduler.startup, "function");
});

test("application entrypoint imports the SQLite connection used by the scheduler", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(source, /import \{[^}]*sqlite[^}]*\} from "\.\/db\/index\.js";/);
});
