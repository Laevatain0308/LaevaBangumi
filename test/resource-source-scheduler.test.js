import test from "node:test";
import assert from "node:assert/strict";
import {
  RESOURCE_SOURCE_SYNC_CRON_EXPRESSION,
  createResourceSourceScheduler,
} from "../src/resourceSources/scheduler.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createCron() {
  const calls = [];
  return {
    calls,
    schedule(expression, handler) {
      calls.push({ expression, handler });
      return { stop() {} };
    },
  };
}

function createScheduler(sources, cron = createCron()) {
  const logs = [];
  const errors = [];
  return {
    cron,
    logs,
    errors,
    scheduler: createResourceSourceScheduler({
      registry: { list: () => sources },
      cron,
      logger: {
        log(scope, message, meta) { logs.push({ scope, message, meta }); },
        error(scope, message, meta) { errors.push({ scope, message, meta }); },
      },
    }),
  };
}

test("scheduler registers resource updates every six hours", () => {
  const fixture = createScheduler([]);
  const tasks = fixture.scheduler.start();
  assert.equal(RESOURCE_SOURCE_SYNC_CRON_EXPRESSION, "0 */6 * * *");
  assert.equal(fixture.cron.calls.length, 1);
  assert.equal(fixture.cron.calls[0].expression, "0 */6 * * *");
  assert.equal(tasks.length, 1);
});

test("one source failure does not block the remaining registry", async () => {
  const calls = [];
  const fixture = createScheduler([
    {
      sourceKey: "broken",
      async update() { calls.push("broken"); throw new Error("offline"); },
      async initialize() {},
    },
    {
      sourceKey: "healthy",
      async update() { calls.push("healthy"); return { savedItems: 2 }; },
      async initialize() {},
    },
  ]);
  const result = await fixture.scheduler.runUpdates("test");
  assert.deepEqual(calls, ["broken", "healthy"]);
  assert.deepEqual(result.map(({ sourceKey, status }) => ({ sourceKey, status })), [
    { sourceKey: "broken", status: "rejected" },
    { sourceKey: "healthy", status: "fulfilled" },
  ]);
  assert.equal(fixture.errors.length, 1);
});

test("initialize and update share a per-source mutual exclusion lock", async () => {
  const gate = deferred();
  let initializeCalls = 0;
  let updateCalls = 0;
  const source = {
    sourceKey: "ffzy",
    async initialize() { initializeCalls += 1; return gate.promise; },
    async update() { updateCalls += 1; return { operation: "update" }; },
  };
  const fixture = createScheduler([source]);

  const running = fixture.scheduler.runInitializations("manual");
  await Promise.resolve();
  const skipped = await fixture.scheduler.runUpdates("test");
  assert.deepEqual(skipped, [{
    sourceKey: "ffzy",
    status: "skipped",
    reason: "source_running",
  }]);
  assert.equal(initializeCalls, 1);
  assert.equal(updateCalls, 0);

  gate.resolve({ operation: "initialize" });
  await running;
  const recovered = await fixture.scheduler.runUpdates("test");
  assert.equal(recovered[0].status, "fulfilled");
  assert.equal(updateCalls, 1);
});

test("a rejected operation releases the source lock", async () => {
  let calls = 0;
  const source = {
    sourceKey: "ffzy",
    async initialize() {},
    async update() {
      calls += 1;
      if (calls === 1) throw new Error("first failure");
      return { operation: "update" };
    },
  };
  const fixture = createScheduler([source]);
  assert.equal((await fixture.scheduler.runUpdates("test"))[0].status, "rejected");
  assert.equal((await fixture.scheduler.runUpdates("test"))[0].status, "fulfilled");
});

test("scheduled callback delegates to registry updates", async () => {
  let updates = 0;
  const fixture = createScheduler([{
    sourceKey: "ffzy",
    async initialize() {},
    async update() { updates += 1; },
  }]);
  fixture.scheduler.start();
  await fixture.cron.calls[0].handler();
  assert.equal(updates, 1);
});
