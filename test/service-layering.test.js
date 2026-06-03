import test from "node:test";
import assert from "node:assert/strict";

test("anime service responsibilities are available from focused service modules", async () => {
  const detailService = await import("../src/services/detailService.js");
  const searchService = await import("../src/services/searchService.js");
  const calendarService = await import("../src/services/calendarService.js");
  const updateService = await import("../src/services/updateService.js");
  const episodeRefreshService = await import("../src/services/episodeRefreshService.js");
  const retryService = await import("../src/services/retryService.js");

  assert.equal(typeof detailService.getAnimeDetail, "function");
  assert.equal(typeof detailService.getPlayUrl, "function");
  assert.equal(typeof searchService.searchAnime, "function");
  assert.equal(typeof searchService.searchAnimeByTag, "function");
  assert.equal(typeof searchService.enrichFromBangumiSearch, "function");
  assert.equal(typeof calendarService.getCalendarView, "function");
  assert.equal(typeof updateService.getUpdates, "function");
  assert.equal(typeof episodeRefreshService.refreshEpisodesForAnime, "function");
  assert.equal(typeof retryService.retryPending, "function");
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
