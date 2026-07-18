import test from "node:test";
import assert from "node:assert/strict";
import { createBangumiRepository } from "../src/bangumi/repository.js";
import { createMetadataEnsureService } from "../src/bangumi/metadataEnsureService.js";
import { createTestDatabase } from "./helpers/testDatabase.js";

const NOW = "2026-07-10T00:00:00.000Z";

function createContext(t) {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const repository = createBangumiRepository(sqlite);
  let wakeCount = 0;
  const service = createMetadataEnsureService({
    repository,
    clock: () => new Date(NOW),
    wake() {
      wakeCount += 1;
    },
  });
  return { repository, service, wakeCount: () => wakeCount };
}

test("filters, sorts, and deduplicates IDs before ensuring them", (t) => {
  const { repository, service, wakeCount } = createContext(t);

  assert.deepEqual(service.ensure([3, 3, 2, 0, -1, 2.5, "4", null]), {
    ensuredIds: [2, 3],
    newlyDueIds: [2, 3],
    dueIds: [2, 3],
  });
  assert.deepEqual(repository.listDueRefreshIds({ now: NOW, limit: 100 }), [
    { bangumiId: 2, consecutiveFailures: 0 },
    { bangumiId: 3, consecutiveFailures: 0 },
  ]);
  assert.equal(wakeCount(), 1);
});

test("returns an empty result without waking when no valid IDs remain", (t) => {
  const { service, wakeCount } = createContext(t);

  assert.deepEqual(service.ensure([0, -1, 1.5, "2"]), {
    ensuredIds: [],
    newlyDueIds: [],
    dueIds: [],
  });
  assert.equal(wakeCount(), 0);
});

test("wakes for an already-due row without inserting or rewriting it", (t) => {
  const { repository, service, wakeCount } = createContext(t);
  repository.ensureRefreshIds([5], { now: NOW });
  const before = repository.findRefreshState(5);

  assert.deepEqual(service.ensure([5]), {
    ensuredIds: [5],
    newlyDueIds: [],
    dueIds: [5],
  });
  assert.deepEqual(repository.findRefreshState(5), before);
  assert.equal(wakeCount(), 1);
});
