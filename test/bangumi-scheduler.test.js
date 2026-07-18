import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBangumiScheduler } from "../src/bangumi/scheduler.js";
import { createBangumiRuntime } from "../src/runtime/bangumiRuntime.js";
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
    metadataWorker: { drain: async () => ({ due: 0, succeeded: 0, failed: 0, settled: 0 }), state: () => ({ running: false }) },
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
    metadataWorker: { drain: async () => { detailRuns += 1; return { due: 0 }; }, state: () => ({ running: false }) },
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
    metadataWorker: { drain: async () => ({ due: 0 }), state: () => ({ running: false }) },
    calendarService: {
      isStale: () => false,
      sync: async () => { calendarRuns += 1; },
    },
  });

  const result = await scheduler.startup();
  assert.equal(calendarRuns, 0);
  assert.deepEqual(result.calendar, { started: false, skipped: true, reason: "calendar_fresh" });
});

test("startup still attempts a stale calendar when detail refresh fails", async () => {
  let calendarRuns = 0;
  const scheduler = createBangumiScheduler({
    cron: createCron(),
    metadataWorker: { drain: async () => { throw new Error("detail startup failed"); }, state: () => ({ running: false }) },
    calendarService: {
      isStale: () => true,
      sync: async () => { calendarRuns += 1; return { members: 1 }; },
    },
  });

  await assert.rejects(() => scheduler.startup(), /detail startup failed/);
  assert.equal(calendarRuns, 1);
  assert.deepEqual(scheduler.state(), { detailRunning: false, calendarRunning: false });
});

test("delegates overlapping detail triggers to the shared metadata worker", async () => {
  const detailGate = deferred();
  let drainCalls = 0;
  let calendarRuns = 0;
  const scheduler = createBangumiScheduler({
    cron: createCron(),
    metadataWorker: {
      drain() {
        drainCalls += 1;
        return detailGate.promise;
      },
      state: () => ({ running: true }),
    },
    calendarService: {
      isStale: () => true,
      async sync() { calendarRuns += 1; return { members: 1 }; },
    },
  });

  const first = scheduler.runDetails("test");
  await Promise.resolve();
  const second = scheduler.runDetails("test");
  const calendar = await scheduler.runCalendar("test");

  assert.equal(calendar.started, true);
  assert.equal(drainCalls, 2);
  assert.equal(calendarRuns, 1);
  assert.deepEqual(scheduler.state(), { detailRunning: true, calendarRunning: false });

  detailGate.resolve({ due: 1, succeeded: 1, failed: 0, settled: 1 });
  assert.equal((await first).result.due, 1);
  assert.equal((await second).result.due, 1);
});

test("cron callbacks catch failures and release locks", async () => {
  const cron = createCron();
  const errors = [];
  const scheduler = createBangumiScheduler({
    cron,
    metadataWorker: { drain: async () => { throw new Error("detail failed"); }, state: () => ({ running: false }) },
    calendarService: { isStale: () => true, sync: async () => { throw new Error("calendar failed"); } },
    logger: { error(scope, message, error) { errors.push({ scope, message, error: error.message }); } },
  });
  scheduler.start();

  await cron.calls[0].handler();
  await cron.calls[1].handler();
  assert.equal(errors.length, 2);
  assert.deepEqual(scheduler.state(), { detailRunning: false, calendarRunning: false });
});

test("production runtime composes one shared ensure worker and scheduler", async (t) => {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const cron = createCron();
  let detailCalls = 0;
  const runtime = createBangumiRuntime({
    sqlite,
    cron,
    clock: () => new Date("2026-07-10T00:00:00.000Z"),
    client: {
      async getSubject(id) {
        detailCalls += 1;
        return { id, type: 2, name: `Anime ${id}` };
      },
      async getCalendar() {
        return [{ weekday: { id: 1 }, items: [{ id: 2, type: 2, name: "Anime 2" }] }];
      },
      async search() { return { data: [] }; },
    },
  });

  assert.equal(typeof runtime.scheduler.start, "function");
  assert.equal(typeof runtime.scheduler.startup, "function");
  assert.equal(runtime.scheduler.state().detailRunning, false);
  const result = runtime.metadataEnsureService.ensure([1]);
  assert.deepEqual(result.dueIds, [1]);
  await runtime.metadataWorker.drain();
  assert.equal(detailCalls, 1);
  assert.equal(runtime.repository.hasCompletedDetail(1), true);
});

test("application entrypoint imports the SQLite connection used by the scheduler", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(source, /import \{[^}]*sqlite[^}]*\} from "\.\/db\/index\.js";/);
});
