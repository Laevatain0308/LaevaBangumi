import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;

test("anime service responsibilities are available from focused service modules", async () => {
  const detailService = await import("../src/services/detailService.js");
  const playService = await import("../src/services/playService.js");
  const searchService = await import("../src/services/searchService.js");
  const calendarService = await import("../src/services/calendarService.js");
  const updateService = await import("../src/services/updateService.js");
  const episodeRefreshService = await import("../src/services/episodeRefreshService.js");
  const metadataRefreshService = await import("../src/services/metadataRefreshService.js");
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
  assert.equal(typeof metadataRefreshService.refreshSubjectMetadata, "function");
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

test("documented fixture files exist for external payload contracts", () => {
  for (const file of [
    "test/fixtures/bangumi-subject-detail.json",
    "test/fixtures/bangumi-calendar.json",
    "test/fixtures/resource-detail-ffzy.json",
  ]) {
    assert.equal(existsSync(join(projectRoot, file)), true, `${file} should exist`);
  }
});

test("repository responsibilities are split into documented modules", async () => {
  const tagRepository = await import("../src/repositories/tagRepository.js");
  const episodeRepository = await import("../src/repositories/episodeRepository.js");
  const syncRepository = await import("../src/repositories/syncRepository.js");

  assert.equal(typeof tagRepository.listSubjectTags, "function");
  assert.equal(typeof episodeRepository.findEpisodeRawVideoUrl, "function");
  assert.equal(typeof syncRepository.markResourceSyncStarted, "function");
  assert.equal(typeof syncRepository.markResourceSyncFailed, "function");
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
    "metadataRefreshService.js",
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

test("background discovery queues metadata refresh instead of fetching subject detail inline", async () => {
  for (const file of ["searchService.js", "resourceMatchService.js"]) {
    const source = await readFile(join(projectRoot, "src/services", file), "utf8");
    assert.match(source, /enqueueMetadataRefresh/, `${file} should enqueue metadata refreshes`);
    assert.doesNotMatch(source, /enrichFromSubject/, `${file} should not synchronously fetch Bangumi subject detail`);
  }
});

test("resource service runtime naming uses sourceAid instead of cstationId", async () => {
  for (const file of [
    "episodeRefreshService.js",
    "manualMatches.js",
    "prewarmService.js",
    "resourceMatchService.js",
    "../scripts/prewarm-anime.js",
  ]) {
    const source = await readFile(join(projectRoot, "src/services", file), "utf8");
    assert.doesNotMatch(source, /cstationId|matchedCsName/, `${file} should use sourceAid/resource names`);
  }
});

test("legacy domains do not link to the new Bangumi metadata domain", async () => {
  for (const file of [
    "src/repositories/subjectRepository.js",
    "src/repositories/tagRepository.js",
    "src/repositories/resourceRepository.js",
    "src/services/subjectSyncService.js",
    "src/services/resourceMatchService.js",
    "src/services/episodeRefreshService.js",
    "src/services/searchService.js",
    "src/services/detailService.js",
    "src/services/calendarService.js",
  ]) {
    const source = await readFile(join(projectRoot, file), "utf8");
    assert.doesNotMatch(source, /from ["'][^"']*\/bangumi\//, file);
    assert.equal(source.includes("bangumi_subjects"), false, file);
  }
});

test("new Bangumi metadata modules do not import legacy domain repositories or services", async () => {
  const bangumiRoot = join(projectRoot, "src/bangumi");
  const files = (await readdir(bangumiRoot)).filter((file) => file.endsWith(".js"));
  for (const file of files) {
    const source = await readFile(join(bangumiRoot, file), "utf8");
    assert.doesNotMatch(source, /\.\.\/repositories\//, file);
    assert.doesNotMatch(source, /\.\.\/services\//, file);
    assert.doesNotMatch(
      source,
      /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:subjects|subject_aliases|subject_tags|anime_other)\b/i,
      file,
    );
  }
});
