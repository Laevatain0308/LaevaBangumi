import test from "node:test";
import assert from "node:assert/strict";

test("anime service responsibilities are available from focused service modules", async () => {
  const detailService = await import("../src/services/detailService.js");
  const searchService = await import("../src/services/searchService.js");
  const calendarService = await import("../src/services/calendarService.js");
  const updateService = await import("../src/services/updateService.js");

  assert.equal(typeof detailService.getAnimeDetail, "function");
  assert.equal(typeof detailService.getPlayUrl, "function");
  assert.equal(typeof searchService.searchAnime, "function");
  assert.equal(typeof searchService.searchAnimeByTag, "function");
  assert.equal(typeof searchService.enrichFromBangumiSearch, "function");
  assert.equal(typeof calendarService.getCalendarView, "function");
  assert.equal(typeof updateService.getUpdates, "function");
});
