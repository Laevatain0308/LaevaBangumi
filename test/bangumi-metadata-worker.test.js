import test from "node:test";
import assert from "node:assert/strict";
import { createMetadataRefreshWorker } from "../src/bangumi/metadataRefreshWorker.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("coalesces wakes and drains full batches until a short batch", async () => {
  const batchResults = [
    { due: 100, succeeded: 100, failed: 0, settled: 100 },
    { due: 2, succeeded: 2, failed: 0, settled: 2 },
  ];
  let calls = 0;
  const worker = createMetadataRefreshWorker({
    detailRefresher: {
      async runDueBatch() {
        return batchResults[calls++];
      },
    },
  });

  const first = worker.wake();
  const second = worker.wake();
  assert.equal(first, second);
  assert.deepEqual(worker.state(), { running: true, wakeRequested: true });
  assert.deepEqual(await first, batchResults[1]);
  assert.equal(calls, 2);
  assert.deepEqual(worker.state(), { running: false, wakeRequested: false });
});

test("a wake during a final short batch requests one more non-overlapping scan", async () => {
  const firstBatch = deferred();
  let active = 0;
  let peakActive = 0;
  let calls = 0;
  const worker = createMetadataRefreshWorker({
    detailRefresher: {
      async runDueBatch() {
        calls += 1;
        active += 1;
        peakActive = Math.max(peakActive, active);
        const result = calls === 1
          ? await firstBatch.promise
          : { due: 0, succeeded: 0, failed: 0, settled: 0 };
        active -= 1;
        return result;
      },
    },
  });

  const first = worker.drain();
  await Promise.resolve();
  const second = worker.wake();
  assert.equal(first, second);
  firstBatch.resolve({ due: 2, succeeded: 2, failed: 0, settled: 2 });

  assert.deepEqual(await first, { due: 0, succeeded: 0, failed: 0, settled: 0 });
  assert.equal(calls, 2);
  assert.equal(peakActive, 1);
});

test("stops a full no-progress batch instead of spinning", async () => {
  let calls = 0;
  const worker = createMetadataRefreshWorker({
    detailRefresher: {
      async runDueBatch() {
        calls += 1;
        return { due: 100, succeeded: 0, failed: 100, settled: 0 };
      },
    },
  });

  assert.deepEqual(await worker.drain(), {
    due: 100,
    succeeded: 0,
    failed: 100,
    settled: 0,
  });
  assert.equal(calls, 1);
});

test("releases the single flight after a batch rejects", async () => {
  let calls = 0;
  const worker = createMetadataRefreshWorker({
    detailRefresher: {
      async runDueBatch() {
        calls += 1;
        if (calls === 1) throw new Error("batch failed");
        return { due: 0, succeeded: 0, failed: 0, settled: 0 };
      },
    },
  });

  await assert.rejects(() => worker.drain(), /batch failed/);
  assert.deepEqual(worker.state(), { running: false, wakeRequested: false });
  await worker.drain();
  assert.equal(calls, 2);
});
