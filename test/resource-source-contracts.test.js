import test from "node:test";
import assert from "node:assert/strict";
import {
  validateExecutionSummary,
  validateLocalResourceItem,
  validateResourceDetail,
  validateResourceEpisode,
  validateResourceItem,
} from "../src/resourceSources/contracts.js";

const item = {
  sourceKey: "fixture",
  sourceItemId: "item-1",
  title: "Fixture title",
  aliases: ["Alias A", "Alias A", " Alias B "],
  year: "2026",
  sourceUpdatedAt: "2026-07-12 01:00:00",
};

test("resource item keeps only shared fields and normalizes aliases", () => {
  assert.deepEqual(validateResourceItem(item, { sourceKey: "fixture" }), {
    ...item,
    aliases: ["Alias A", "Alias B"],
  });
  assert.throws(
    () => validateResourceItem({ ...item, coverUrl: "https://example.invalid/cover.jpg" }, { sourceKey: "fixture" }),
    /exactly.*sourceKey.*sourceItemId/i,
  );
  assert.throws(
    () => validateResourceItem({ ...item, sourceKey: "other" }, { sourceKey: "fixture" }),
    /sourceKey.*fixture/i,
  );
});

test("resource item drops blank aliases before deduplication", () => {
  assert.deepEqual(validateResourceItem({
    ...item,
    aliases: ["", "   ", "Alias A", " Alias A "],
  }, { sourceKey: "fixture" }).aliases, ["Alias A"]);
});

test("resource episode separates its positive logical index from its display title", () => {
  assert.deepEqual(validateResourceEpisode({
    episodeIndex: 1,
    title: "HD中字",
    videoUrl: "https://example.invalid/movie.m3u8",
  }), {
    episodeIndex: 1,
    title: "HD中字",
    videoUrl: "https://example.invalid/movie.m3u8",
  });
  assert.throws(() => validateResourceEpisode({
    episodeIndex: 0,
    title: "第00集",
    videoUrl: "https://example.invalid/0.m3u8",
  }), /episodeIndex.*positive integer/i);
});

test("resource detail rejects duplicate logical episode indexes", () => {
  assert.throws(() => validateResourceDetail({
    ...item,
    aliases: [],
    episodes: [
      { episodeIndex: 1, title: "第01集", videoUrl: "https://example.invalid/1-a.m3u8" },
      { episodeIndex: 1, title: "正片", videoUrl: "https://example.invalid/1-b.m3u8" },
    ],
  }, { sourceKey: "fixture" }), /duplicate episodeIndex 1/i);
});

test("resource episode collections reject duplicate logical indexes", async () => {
  const { validateResourceEpisodes } = await import("../src/resourceSources/contracts.js");
  assert.throws(() => validateResourceEpisodes([
    { episodeIndex: 1, title: "第01集", videoUrl: "https://example.invalid/1-a.m3u8" },
    { episodeIndex: 1, title: "正片", videoUrl: "https://example.invalid/1-b.m3u8" },
  ]), /duplicate episodeIndex 1/i);
});

test("local resource item adds only local observation timestamps", () => {
  assert.deepEqual(validateLocalResourceItem({
    ...item,
    aliases: [],
    firstSeenAt: "2026-07-01 00:00:00",
    lastFetchedAt: "2026-07-12 01:00:01",
  }, { sourceKey: "fixture" }), {
    ...item,
    aliases: [],
    firstSeenAt: "2026-07-01 00:00:00",
    lastFetchedAt: "2026-07-12 01:00:01",
  });
});

test("execution summary matches the source and lifecycle operation", () => {
  const summary = {
    sourceKey: "fixture",
    operation: "update",
    startedAt: "2026-07-12 01:00:00",
    finishedAt: "2026-07-12 01:00:05",
    fetchedItems: 2,
    savedItems: 2,
    fetchedEpisodes: 4,
    savedEpisodes: 4,
    failedItems: 0,
    changedItemIds: ["200", "100", "200"],
  };
  const normalized = validateExecutionSummary(summary, {
    sourceKey: "fixture",
    operation: "update",
  });
  assert.deepEqual(normalized, { ...summary, changedItemIds: ["100", "200"] });
  assert.equal(Object.isFrozen(normalized.changedItemIds), true);
  assert.throws(() => validateExecutionSummary({ ...summary, operation: "initialize" }, {
    sourceKey: "fixture",
    operation: "update",
  }), /operation.*update/i);
  assert.throws(() => validateExecutionSummary({ ...summary, failedItems: -1 }, {
    sourceKey: "fixture",
    operation: "update",
  }), /failedItems.*non-negative integer/i);
  assert.throws(() => validateExecutionSummary({ ...summary, operation: "bogus" }, {
    sourceKey: "fixture",
    operation: "bogus",
  }), /operation.*initialize.*update/i);
  assert.throws(() => validateExecutionSummary({ ...summary, changedItemIds: ["100", " "] }, {
    sourceKey: "fixture",
    operation: "update",
  }), /changedItemIds\[1\].*non-empty string/i);
});
