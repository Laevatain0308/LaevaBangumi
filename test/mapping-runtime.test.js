import test from "node:test";
import assert from "node:assert/strict";
import {
  createMappingRuntime,
} from "../src/mappings/mappingRuntime.js";
import {
  AUTO_MATCH_SCHEDULE_CRON,
  AUTO_MATCH_TIMEZONE,
} from "../src/mappings/config.js";

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

function createFixture({ initialized = true, matchFailureId = null } = {}) {
  const calls = [];
  const errors = [];
  const cron = createCron();
  const repository = {
    isSourceInitialized(sourceKey) {
      calls.push(["initialized", sourceKey]);
      return initialized;
    },
  };
  const autoMatcher = {
    matchSourceItem(input) {
      calls.push(["matchSourceItem", input]);
      if (input.sourceItemId === matchFailureId) throw new Error("match failed");
      return { status: "unmatched" };
    },
  };
  const scheduleService = {
    reconcileSubject(input) {
      calls.push(["reconcileSubject", input]);
      return { bangumiId: input.bangumiId, sources: [] };
    },
    reconcileSource(input) {
      calls.push(["reconcileSource", input]);
      return { sourceKey: input.sourceKey, subjects: [] };
    },
    runDue(input = {}) {
      calls.push(["runDue", input]);
      return { processed: 0, results: [] };
    },
  };
  const runtime = createMappingRuntime({
    sourceKeys: ["ffzy"],
    cron,
    repository,
    mappingService: {},
    autoMatcher,
    scheduleService,
    logger: { error(scope, message, meta) { errors.push({ scope, message, meta }); } },
  });
  return { runtime, cron, calls, errors };
}

test("Bangumi events reconcile each unique valid subject", async () => {
  const { runtime, calls } = createFixture();
  await runtime.onSubjectsPersisted([2, 1, 2, 0, "3", null]);
  await runtime.onDetailPersisted(4);
  assert.deepEqual(calls, [
    ["reconcileSubject", { bangumiId: 2 }],
    ["reconcileSubject", { bangumiId: 1 }],
    ["reconcileSubject", { bangumiId: 4 }],
  ]);
});

test("resource events reconcile initialization and reverse-match changed updates", async () => {
  const { runtime, calls } = createFixture({ matchFailureId: "broken" });
  assert.deepEqual(await runtime.onSourceSynchronized({
    sourceKey: "ffzy",
    operation: "initialize",
    changedItemIds: [],
  }), { sourceKey: "ffzy", operation: "initialize", processed: 1, failed: 0 });
  assert.deepEqual(await runtime.onSourceSynchronized({
    sourceKey: "ffzy",
    operation: "update",
    changedItemIds: ["200", "100", "200", "broken"],
  }), { sourceKey: "ffzy", operation: "update", processed: 3, failed: 1 });
  assert.deepEqual(calls, [
    ["reconcileSource", { sourceKey: "ffzy" }],
    ["matchSourceItem", { sourceKey: "ffzy", sourceItemId: "200" }],
    ["matchSourceItem", { sourceKey: "ffzy", sourceItemId: "100" }],
    ["matchSourceItem", { sourceKey: "ffzy", sourceItemId: "broken" }],
  ]);
});

test("startup drains due schedules and reconciles already initialized sources", async () => {
  const initialized = createFixture();
  assert.deepEqual(await initialized.runtime.startup(), {
    due: { processed: 0, results: [] },
    initializedSources: ["ffzy"],
  });
  assert.deepEqual(initialized.calls, [
    ["runDue", {}],
    ["initialized", "ffzy"],
    ["reconcileSource", { sourceKey: "ffzy" }],
  ]);

  const fresh = createFixture({ initialized: false });
  assert.deepEqual((await fresh.runtime.startup()).initializedSources, []);
  assert.equal(fresh.calls.some(([name]) => name === "reconcileSource"), false);
});

test("daily schedule drains due rows in the Shanghai timezone", async () => {
  const { runtime, cron, calls } = createFixture();
  const tasks = runtime.start();
  assert.equal(tasks.length, 1);
  assert.deepEqual(cron.calls.map(({ expression, options }) => ({ expression, ...options })), [{
    expression: AUTO_MATCH_SCHEDULE_CRON,
    timezone: AUTO_MATCH_TIMEZONE,
  }]);
  await cron.calls[0].handler();
  assert.deepEqual(calls, [["runDue", {}]]);
});
