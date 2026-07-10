import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createBangumiRepository } from "../src/bangumi/repository.js";
import { createBangumiCalendarService } from "../src/bangumi/calendarService.js";

const NOW = "2026-07-10T00:00:00.000Z";
const LATER = "2026-07-11T00:00:00.000Z";

function anime(id, extra = {}) {
  return {
    id,
    type: 2,
    name: `Anime ${id}`,
    name_cn: `动画 ${id}`,
    rating: { score: 7 + id / 10, total: id * 10, count: { 7: id } },
    ...extra,
  };
}

function calendarPayload() {
  return [
    {
      weekday: { id: 1, en: "Mon", cn: "星期一", ja: "月曜日" },
      items: [
        anime(1, { air_weekday: 2 }),
        { id: 11, type: 6, name: "Person" },
        { id: 12, type: "2", name: "String Type" },
      ],
    },
    {
      weekday: { id: 3, en: "Wed", cn: "星期三", ja: "水曜日" },
      items: [anime(2), { id: 13, type: 2 }],
    },
  ];
}

function setup(t, { getCalendar = async () => calendarPayload(), now = NOW } = {}) {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const repository = createBangumiRepository(sqlite);
  const logs = [];
  const service = createBangumiCalendarService({
    client: { getCalendar },
    repository,
    clock: () => new Date(now),
    logger: {
      log(scope, message, meta) { logs.push({ level: "log", scope, message, meta }); },
      error(scope, message, meta) { logs.push({ level: "error", scope, message, meta }); },
    },
  });
  return { repository, service, logs };
}

test("syncs valid anime summaries and atomically replaces membership", async (t) => {
  const { repository, service } = setup(t);
  const result = await service.sync();

  assert.deepEqual(result, { received: 5, persisted: 2, filtered: 1, rejected: 2, members: 2 });
  assert.deepEqual(
    repository.listCalendarSubjects().map((row) => [row.subject.bangumiId, row.weekday]),
    [[1, 1], [2, 3]],
  );
  assert.equal(repository.findById(1).subject.airWeekday, 2);
  assert.equal(repository.findById(2).subject.airWeekday, 3);
  assert.equal(repository.findById(11), null);
  assert.equal(repository.findById(12), null);
  assert.equal(repository.findById(13), null);
  assert.equal(repository.hasCompletedDetail(1), false);
});

test("a later successful sync removes stale membership but keeps metadata", async (t) => {
  const context = setup(t);
  await context.service.sync();
  const later = createBangumiCalendarService({
    client: { getCalendar: async () => [{ weekday: { id: 5 }, items: [anime(2)] }] },
    repository: context.repository,
    clock: () => new Date(LATER),
  });
  await later.sync();

  assert.deepEqual(
    context.repository.listCalendarSubjects().map((row) => [row.subject.bangumiId, row.weekday]),
    [[2, 5]],
  );
  assert.ok(context.repository.findById(1));
});

test("a failed calendar request preserves the previous snapshot", async (t) => {
  const context = setup(t);
  await context.service.sync();
  const previous = context.repository.listCalendarSubjects();
  const failing = createBangumiCalendarService({
    client: { getCalendar: async () => { throw new Error("calendar unavailable"); } },
    repository: context.repository,
    clock: () => new Date(LATER),
  });

  await assert.rejects(() => failing.sync(), /calendar unavailable/);
  assert.deepEqual(context.repository.listCalendarSubjects(), previous);
  assert.deepEqual(context.repository.findCalendarSyncState(), {
    lastSucceededAt: NOW,
    lastAttemptedAt: LATER,
    consecutiveFailures: 1,
    lastError: "calendar unavailable",
  });
});

test("an invalid calendar container preserves the previous snapshot", async (t) => {
  const context = setup(t);
  await context.service.sync();
  const previous = context.repository.listCalendarSubjects();
  const invalid = createBangumiCalendarService({
    client: { getCalendar: async () => [{ weekday: { id: 8 }, items: [] }] },
    repository: context.repository,
    clock: () => new Date(LATER),
  });

  await assert.rejects(() => invalid.sync(), (error) => error.path === "$[0].weekday.id");
  assert.deepEqual(context.repository.listCalendarSubjects(), previous);
  assert.equal(context.repository.findCalendarSyncState().consecutiveFailures, 1);
});

test("a calendar with no valid anime preserves the previous snapshot", async (t) => {
  const context = setup(t);
  await context.service.sync();
  const previous = context.repository.listCalendarSubjects();
  const empty = createBangumiCalendarService({
    client: {
      getCalendar: async () => [{
        weekday: { id: 1 },
        items: [{ id: 2, type: 6, name: "Person" }, { id: 3, type: "2", name: "String Type" }],
      }],
    },
    repository: context.repository,
    clock: () => new Date(LATER),
  });

  await assert.rejects(() => empty.sync(), (error) => error.code === "incomplete_calendar");
  assert.deepEqual(context.repository.listCalendarSubjects(), previous);
  assert.equal(context.repository.findCalendarSyncState().consecutiveFailures, 1);
});

test("staleness is based on the last successful sync", async (t) => {
  const context = setup(t);
  assert.equal(context.service.isStale(new Date(NOW)), true);
  await context.service.sync();
  assert.equal(context.service.isStale(new Date("2026-07-10T23:59:59.999Z")), false);
  assert.equal(context.service.isStale(new Date("2026-07-11T00:00:00.000Z")), true);
});
