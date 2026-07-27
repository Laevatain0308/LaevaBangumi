import test from "node:test";
import assert from "node:assert/strict";
import { createScheduleService } from "../src/mappings/scheduleService.js";

const NOW = new Date("2026-07-25T04:00:00.000Z");

function subject(overrides = {}) {
  return {
    bangumiId: 1,
    airDate: "2026-08-01",
    detailCompleted: true,
    ...overrides,
  };
}

function createFixture({
  subjects = [subject()],
  sourceKeys = ["ffzy"],
  initialized = true,
  mappings = [],
  due = [],
  matchResult = { status: "unmatched", reason: "no_resource" },
  matchError = null,
} = {}) {
  const schedules = new Map(due.map((row) => [`${row.bangumiId}:${row.sourceKey}`, { ...row }]));
  const calls = [];
  const repository = {
    findSubjectForMatching(bangumiId) {
      return subjects.find((item) => item.bangumiId === bangumiId) ?? null;
    },
    listSubjectsForMatching() { return subjects; },
    findMapping({ bangumiId, sourceKey }) {
      return mappings.find((row) => row.bangumiId === bangumiId && row.sourceKey === sourceKey) ?? null;
    },
    isSourceInitialized() { return initialized; },
    upsertSchedule(row) {
      calls.push(["upsert", row]);
      schedules.set(`${row.bangumiId}:${row.sourceKey}`, { ...row });
    },
    deleteSchedule(row) {
      calls.push(["delete", row]);
      return schedules.delete(`${row.bangumiId}:${row.sourceKey}`) ? 1 : 0;
    },
    listDueSchedules({ sourceKey = null, today }) {
      calls.push(["due", { sourceKey, today }]);
      return [...schedules.values()].filter((row) => sourceKey == null || row.sourceKey === sourceKey);
    },
  };
  function matchSubject(input) {
    calls.push(["match", input]);
    if (matchError) throw matchError;
    return matchResult;
  }
  const service = createScheduleService({
    repository,
    matchSubject,
    sourceKeys,
    clock: () => NOW,
  });
  return { service, calls, schedules };
}

test("reconcileSubject creates one-shot schedules only for complete future dates", () => {
  const future = createFixture();
  assert.deepEqual(future.service.reconcileSubject({ bangumiId: 1 }), {
    bangumiId: 1,
    sources: [{ sourceKey: "ffzy", status: "scheduled", eligibleOn: "2026-08-01" }],
  });
  assert.deepEqual([...future.schedules.values()], [{
    bangumiId: 1,
    sourceKey: "ffzy",
    eligibleOn: "2026-08-01",
  }]);

  for (const airDate of ["2026-07", "2026", null]) {
    const unknown = createFixture({ subjects: [subject({ airDate })] });
    assert.deepEqual(unknown.service.reconcileSubject({ bangumiId: 1 }).sources, [
      { sourceKey: "ffzy", status: "unknown" },
    ]);
    assert.equal(unknown.calls.some(([kind]) => kind === "match"), false);
    assert.equal(unknown.schedules.size, 0);
  }
});

test("reconcileSubject requires completed details and clears schedules for existing mappings", () => {
  const incomplete = createFixture({
    subjects: [subject({ detailCompleted: false })],
    due: [{ bangumiId: 1, sourceKey: "ffzy", eligibleOn: "2026-07-25" }],
  });
  assert.deepEqual(incomplete.service.reconcileSubject({ bangumiId: 1 }).sources, [
    { sourceKey: "ffzy", status: "detail_incomplete" },
  ]);
  assert.equal(incomplete.schedules.size, 0);
  assert.equal(incomplete.calls.some(([kind]) => kind === "match"), false);

  const mapped = createFixture({
    mappings: [{ bangumiId: 1, sourceKey: "ffzy" }],
    due: [{ bangumiId: 1, sourceKey: "ffzy", eligibleOn: "2026-07-25" }],
  });
  assert.deepEqual(mapped.service.reconcileSubject({ bangumiId: 1 }).sources, [
    { sourceKey: "ffzy", status: "skipped", reason: "already_mapped" },
  ]);
  assert.equal(mapped.schedules.size, 0);
});

test("aired complete and partial dates trigger a local match only after source initialization", () => {
  for (const airDate of ["2026-07-25", "2025-12", "2025"]) {
    const fixture = createFixture({ subjects: [subject({ airDate })] });
    assert.deepEqual(fixture.service.reconcileSubject({ bangumiId: 1 }).sources, [
      { sourceKey: "ffzy", status: "unmatched", reason: "no_resource" },
    ]);
    assert.deepEqual(fixture.calls.find(([kind]) => kind === "match"), [
      "match",
      { bangumiId: 1, sourceKey: "ffzy" },
    ]);
  }

  const uninitialized = createFixture({
    subjects: [subject({ airDate: "2025" })],
    initialized: false,
  });
  assert.deepEqual(uninitialized.service.reconcileSubject({ bangumiId: 1 }).sources, [
    { sourceKey: "ffzy", status: "deferred", reason: "source_uninitialized" },
  ]);
  assert.equal(uninitialized.calls.some(([kind]) => kind === "match"), false);
});

test("runDue retains deferred and failed schedules but consumes completed local attempts", () => {
  const row = { bangumiId: 1, sourceKey: "ffzy", eligibleOn: "2026-07-25" };
  const deferred = createFixture({
    subjects: [subject({ airDate: "2026-07-25" })],
    initialized: false,
    due: [row],
  });
  assert.deepEqual(deferred.service.runDue(), {
    processed: 1,
    results: [{ ...row, status: "deferred", reason: "source_uninitialized" }],
  });
  assert.deepEqual(deferred.calls[0], ["due", { sourceKey: null, today: "2026-07-25" }]);
  assert.equal(deferred.schedules.size, 1);

  const attempted = createFixture({
    subjects: [subject({ airDate: "2026-07-25" })],
    due: [row],
  });
  assert.equal(attempted.service.runDue().results[0].status, "unmatched");
  assert.equal(attempted.schedules.size, 0);

  const failed = createFixture({
    subjects: [subject({ airDate: "2026-07-25" })],
    due: [row],
    matchError: new Error("database unavailable"),
  });
  assert.deepEqual(failed.service.runDue().results, [{
    ...row,
    status: "failed",
    error: "database unavailable",
  }]);
  assert.equal(failed.schedules.size, 1);
});

test("reconcileSource rechecks every known subject for one initialized source", () => {
  const fixture = createFixture({
    subjects: [
      subject({ bangumiId: 2, airDate: "2025" }),
      subject({ bangumiId: 1, airDate: "2026-08-01" }),
    ],
  });
  assert.deepEqual(fixture.service.reconcileSource({ sourceKey: "ffzy" }), {
    sourceKey: "ffzy",
    subjects: [
      { bangumiId: 1, status: "scheduled", eligibleOn: "2026-08-01" },
      { bangumiId: 2, status: "unmatched", reason: "no_resource" },
    ],
  });
});
