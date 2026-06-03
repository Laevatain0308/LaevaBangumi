import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;

test("anime service responsibilities are available from focused service modules", async () => {
  const detailService = await import("../src/services/detailService.js");
  const playService = await import("../src/services/playService.js");
  const searchService = await import("../src/services/searchService.js");
  const calendarService = await import("../src/services/calendarService.js");
  const updateService = await import("../src/services/updateService.js");
  const episodeRefreshService = await import("../src/services/episodeRefreshService.js");
  const retryService = await import("../src/services/retryService.js");
  const errorDto = await import("../src/dto/errorDto.js");
  const calendarNormalizer = await import("../src/normalizers/bangumiCalendarNormalizer.js");

  assert.equal(typeof detailService.getAnimeDetail, "function");
  assert.equal(typeof playService.getPlayUrl, "function");
  assert.equal(typeof searchService.searchAnime, "function");
  assert.equal(typeof searchService.searchAnimeByTag, "function");
  assert.equal(typeof searchService.enrichFromBangumiSearch, "function");
  assert.equal(typeof calendarService.getCalendarView, "function");
  assert.equal(typeof updateService.getUpdates, "function");
  assert.equal(typeof episodeRefreshService.refreshEpisodesForAnime, "function");
  assert.equal(typeof retryService.retryPending, "function");
  assert.equal(typeof errorDto.errorEnvelope, "function");
  assert.equal(typeof calendarNormalizer.normalizeBangumiCalendar, "function");
});

test("external source clients live outside service modules", async () => {
  const bangumiClient = await import("../src/clients/bangumiClient.js");
  const resourceClient = await import("../src/clients/resourceClient.js");
  const ffzyClient = await import("../src/clients/resourceSources/ffzyClient.js");

  assert.equal(typeof bangumiClient.getCalendar, "function");
  assert.equal(typeof bangumiClient.searchSubjects, "function");
  assert.equal(typeof bangumiClient.getSubject, "function");
  assert.equal(typeof resourceClient.fetchById, "function");
  assert.equal(typeof resourceClient.fetchCatalog, "function");
  assert.equal(typeof ffzyClient.parseEpisodes, "function");
});

test("legacy source service facade modules are removed", () => {
  assert.equal(existsSync(join(projectRoot, "src/services/bangumi.js")), false);
  assert.equal(existsSync(join(projectRoot, "src/services/cstation.js")), false);
});

test("service modules do not perform direct database access", async () => {
  const serviceFiles = [
    "animeShared.js",
    "calendarService.js",
    "catalog.js",
    "detailService.js",
    "episodeRefreshService.js",
    "manualMatches.js",
    "playService.js",
    "prewarmService.js",
    "resourceMatchService.js",
    "resourceStateService.js",
    "retryService.js",
    "searchService.js",
    "subjectSyncService.js",
    "updateService.js",
  ];

  for (const file of serviceFiles) {
    const source = await readFile(join(projectRoot, "src/services", file), "utf8");
    assert.equal(source.includes("sqlite.prepare"), false, `${file} should use repositories instead of sqlite.prepare`);
    assert.equal(/\bdb\.(all|select|insert|update|delete)\b/.test(source), false, `${file} should use repositories instead of db.*`);
  }
});
