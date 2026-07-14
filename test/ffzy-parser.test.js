import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseCatalogXml,
  parseDetailXml,
} from "../src/resourceSources/ffzy/ffzyParser.js";

const catalogXml = await readFile(new URL("./fixtures/ffzy/catalog.xml", import.meta.url), "utf8");
const detailXml = await readFile(new URL("./fixtures/ffzy/detail.xml", import.meta.url), "utf8");
const options = { sourceKey: "ffzy", allowedCategoryIds: ["29", "30", "31"] };

test("catalog parser returns strict pagination and filters non-anime categories", () => {
  const result = parseCatalogXml(catalogXml, options);
  assert.deepEqual({
    page: result.page,
    pageCount: result.pageCount,
    recordCount: result.recordCount,
  }, { page: 2, pageCount: 3, recordCount: 42 });
  assert.deepEqual(result.items, [{
    sourceKey: "ffzy",
    sourceItemId: "98509",
    title: "魔法少女奈叶EXCEEDS",
    aliases: [],
    year: null,
    sourceUpdatedAt: "2026-07-11T17:16:35.000Z",
  }]);
});

test("detail parser normalizes aliases and public metadata only", () => {
  const result = parseDetailXml(detailXml, options);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    sourceKey: "ffzy",
    sourceItemId: "98509",
    title: "魔法少女奈叶EXCEEDS",
    aliases: ["Nanoha", "奈叶"],
    year: "2026",
    sourceUpdatedAt: "2026-07-11T17:16:35.000Z",
    episodes: [
      { episodeIndex: 1, title: "第09集", videoUrl: "https://example.invalid/first.m3u8" },
      { episodeIndex: 2, title: "Special$Part", videoUrl: "https://example.invalid/second.m3u8" },
    ],
  });
  assert.equal(Object.hasOwn(result.items[0], "type"), false);
});

test("episode indexes always follow source order instead of parsing labels", () => {
  const detail = parseDetailXml(detailXml, options).items[0];
  assert.deepEqual(detail.episodes.map((episode) => episode.episodeIndex), [1, 2]);
  assert.equal(detail.episodes[0].title, "第09集");
});

test("parser rejects malformed list metadata", () => {
  assert.throws(
    () => parseCatalogXml("<rss><list page='1'><video /></list></rss>", options),
    /pagecount/i,
  );
  assert.throws(() => parseDetailXml("<rss />", options), /list/i);
});

test("parser rejects invalid FFZY local timestamps", () => {
  const invalid = detailXml.replace("2026-07-12 01:16:35", "not-a-time");
  assert.throws(() => parseDetailXml(invalid, options), /timestamp/i);
});
