import test from "node:test";
import assert from "node:assert/strict";
import {
  HOUR_MS,
  BANGUMI_DETAIL_REFRESH_BATCH_SIZE,
  BANGUMI_DETAIL_REFRESH_CONCURRENCY,
  BANGUMI_REQUEST_START_INTERVAL_MS,
  BANGUMI_DETAIL_RETRY_DELAYS_MS,
} from "../src/bangumi/config.js";
import { createBangumiDetailRefreshService } from "../src/bangumi/detailRefreshService.js";

const NOW = "2026-07-10T00:00:00.000Z";

test("exports fixed detail refresh configuration", () => {
  assert.equal(BANGUMI_DETAIL_REFRESH_BATCH_SIZE, 100);
  assert.equal(BANGUMI_DETAIL_REFRESH_CONCURRENCY, 2);
  assert.equal(BANGUMI_REQUEST_START_INTERVAL_MS, 500);
  assert.deepEqual(BANGUMI_DETAIL_RETRY_DELAYS_MS, [6 * HOUR_MS, 24 * HOUR_MS, 72 * HOUR_MS]);
});

test("refreshes only due completed subjects in due-time order", async () => {
  const calls = [];
  const listCalls = [];
  const refresher = createBangumiDetailRefreshService({
    repository: {
      listDueRefreshIds(options) {
        listCalls.push(options);
        return [{ bangumiId: 2, consecutiveFailures: 0 }, { bangumiId: 1, consecutiveFailures: 0 }];
      },
      recordDetailRefreshFailure() {
        throw new Error("unexpected failure write");
      },
    },
    metadataService: {
      async refreshDetail(id) { calls.push(id); },
    },
    clock: () => new Date(NOW),
    sleep: async () => {},
    monotonicNow: (() => {
      let value = 0;
      return () => { value += 500; return value; };
    })(),
  });

  const result = await refresher.runDueBatch();
  assert.deepEqual(listCalls, [{ now: NOW, limit: 100 }]);
  assert.deepEqual(calls, [2, 1]);
  assert.deepEqual(result, { due: 2, succeeded: 2, failed: 0, settled: 2 });
});

test("spaces request starts by 500ms while allowing at most two active requests", async () => {
  let virtualNow = 0;
  let active = 0;
  let peakActive = 0;
  const starts = [];
  const releases = [];
  const refresher = createBangumiDetailRefreshService({
    repository: {
      listDueRefreshIds: () => [1, 2, 3].map((bangumiId) => ({ bangumiId, consecutiveFailures: 0 })),
      recordDetailRefreshFailure() {},
    },
    metadataService: {
      async refreshDetail() {
        starts.push(virtualNow);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => releases.push(resolve));
        active -= 1;
      },
    },
    clock: () => new Date(NOW),
    monotonicNow: () => virtualNow,
    sleep: async (ms) => { virtualNow += ms; },
  });

  const run = refresher.runDueBatch();
  while (releases.length < 2) await Promise.resolve();
  releases.shift()();
  while (releases.length < 2) await Promise.resolve();
  releases.shift()();
  releases.shift()();
  await run;

  assert.deepEqual(starts, [0, 500, 1000]);
  assert.equal(peakActive, 2);
});

for (const previousFailures of [0, 1, 2, 9]) {
  test(`counts a failure recorded by metadata service after ${previousFailures} previous failures`, async () => {
    const refresher = createBangumiDetailRefreshService({
      repository: {
        listDueRefreshIds: () => [{ bangumiId: 1, consecutiveFailures: previousFailures }],
      },
      metadataService: {
        async refreshDetail() {
          throw Object.assign(new Error("Bangumi unavailable"), { refreshStateRecorded: true });
        },
      },
      clock: () => new Date(NOW),
      sleep: async () => {},
      monotonicNow: () => 0,
    });

    const result = await refresher.runDueBatch();
    assert.deepEqual(result, { due: 1, succeeded: 0, failed: 1, settled: 1 });
  });
}

test("reports no progress when failure state writes fail", async () => {
  const attempted = [];
  const refresher = createBangumiDetailRefreshService({
    repository: {
      listDueRefreshIds: () => [1, 2].map((bangumiId) => ({ bangumiId, consecutiveFailures: 0 })),
    },
    metadataService: {
      async refreshDetail(id) {
        attempted.push(id);
        throw Object.assign(new Error("Bangumi unavailable"), { refreshStateRecorded: false });
      },
    },
    clock: () => new Date(NOW),
    sleep: async () => {},
    monotonicNow: (() => {
      let value = 0;
      return () => { value += 500; return value; };
    })(),
  });

  const result = await refresher.runDueBatch();
  assert.deepEqual(attempted, [1, 2]);
  assert.deepEqual(result, { due: 2, succeeded: 0, failed: 2, settled: 0 });
});
