import test from "node:test";
import assert from "node:assert/strict";
import { parseEpisodes } from "../src/services/cstation.js";
import { initDb, sqlite } from "../src/db/index.js";
import { saveCatalog } from "../src/services/catalog.js";

test("parseEpisodes keeps explicit source episode indexes", () => {
  const episodes = parseEpisodes({
    dd: {
      "@_flag": "ffm3u8",
      "#text": "第1156集$https://example.invalid/1156.m3u8#第1157集$https://example.invalid/1157.m3u8",
    },
  });

  assert.deepEqual(episodes, [
    {
      epIndex: 1156,
      epName: "第1156集",
      videoUrl: "https://example.invalid/1156.m3u8",
    },
    {
      epIndex: 1157,
      epName: "第1157集",
      videoUrl: "https://example.invalid/1157.m3u8",
    },
  ]);
});

test("parseEpisodes assigns an episode index to movie labels without numbers", () => {
  const episodes = parseEpisodes({
    dd: {
      "@_flag": "ffm3u8",
      "#text": "HD中字$https://vip.ffzy-plays.com/20260122/49681_ff47908a/index.m3u8",
    },
  });

  assert.deepEqual(episodes, [
    {
      epIndex: 1,
      epName: "HD中字",
      videoUrl: "https://vip.ffzy-plays.com/20260122/49681_ff47908a/index.m3u8",
    },
  ]);
});

test("parseEpisodes keeps movie labels as episode names and avoids explicit index collisions", () => {
  const episodes = parseEpisodes({
    dd: {
      "@_flag": "ffm3u8",
      "#text": "HD中字$https://example.invalid/movie.m3u8#第01集$https://example.invalid/1.m3u8",
    },
  });

  assert.deepEqual(episodes, [
    {
      epIndex: 2,
      epName: "HD中字",
      videoUrl: "https://example.invalid/movie.m3u8",
    },
    {
      epIndex: 1,
      epName: "第01集",
      videoUrl: "https://example.invalid/1.m3u8",
    },
  ]);
});

test("saveCatalog persists resource items in normalized storage", async () => {
  initDb();
  sqlite.exec(`
    DELETE FROM resource_items WHERE source = 'test_cstation';
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('test_cstation', '测试资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
  `);

  const saved = await saveCatalog([{
    id: 1001,
    name: "资源标题",
    subname: "别名 A / Alias A",
    year: "2026",
    last: "2026-06-03 01:00:00",
    category: "anime",
    detailFetchedAt: "2026-06-03 01:01:00",
  }], { source: "test_cstation" });

  assert.equal(saved, 1);
  const row = sqlite.prepare(`
    SELECT * FROM resource_items
    WHERE source = 'test_cstation' AND source_aid = 1001
  `).get();
  assert.equal(row.title, "资源标题");
  assert.equal(row.subtitle, "别名 A / Alias A");
  assert.equal(row.year, "2026");
  assert.equal(row.latest_text, "2026-06-03 01:00:00");
  assert.equal(row.category, "anime");
  assert.equal(row.detail_fetched_at, "2026-06-03 01:01:00");
});

test("saveCatalog accepts already normalized resource items", async () => {
  initDb();
  sqlite.exec(`
    DELETE FROM resource_items WHERE source = 'test_cstation_normalized';
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('test_cstation_normalized', '测试资源', 1)
    ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
  `);

  const saved = await saveCatalog([{
    source: "test_cstation_normalized",
    sourceAid: 1002,
    title: "规范化标题",
    subtitle: "规范化副标题",
    category: "OVA",
    year: "2026",
    latestText: "第02集",
    detailFetchedAt: "2026-06-03 02:01:00",
  }], { source: "test_cstation_normalized" });

  assert.equal(saved, 1);
  assert.deepEqual(sqlite.prepare(`
    SELECT source_aid, title, subtitle, category, year, latest_text, detail_fetched_at
    FROM resource_items
    WHERE source = 'test_cstation_normalized' AND source_aid = 1002
  `).get(), {
    source_aid: 1002,
    title: "规范化标题",
    subtitle: "规范化副标题",
    category: "OVA",
    year: "2026",
    latest_text: "第02集",
    detail_fetched_at: "2026-06-03 02:01:00",
  });
  assert.equal(sqlite.prepare(`
    SELECT title FROM resource_items
    WHERE source = 'test_cstation_normalized' AND source_aid = 1002
  `).get().title, "规范化标题");
});
