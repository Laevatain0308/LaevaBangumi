import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMediaType,
  mediaTypeForBangumiPlatform,
  mediaTypeForBangumiSubject,
} from "../src/lib/mediaTypes.js";
import { getCategoryConfigs } from "../src/lib/cstationConfig.js";

test("ffzy category config covers anime tv movie and variety media types", () => {
  const categories = getCategoryConfigs("ffzy");
  const byType = new Map();
  for (const category of categories) {
    if (!byType.has(category.mediaType)) byType.set(category.mediaType, []);
    byType.get(category.mediaType).push(category.tid);
  }

  assert.deepEqual(byType.get("anime").sort(), ["29", "30", "31"]);
  assert.deepEqual(byType.get("tv").sort(), ["13", "14", "15", "16", "20", "21", "22", "23", "24"]);
  assert.deepEqual(byType.get("movie").sort(), ["10", "11", "12", "4", "6", "7", "8", "9"]);
  assert.deepEqual(byType.get("variety").sort(), ["25", "26", "27", "28"]);
});

test("media type helpers reject unsupported public media types", () => {
  assert.equal(assertMediaType(undefined), "anime");
  assert.equal(assertMediaType("tv"), "tv");
  assert.throws(() => assertMediaType("book"), /unsupported media type/);
});

test("Bangumi media type mapping uses sampled platform values without changing platform", () => {
  assert.equal(mediaTypeForBangumiPlatform("华语剧"), "tv");
  assert.equal(mediaTypeForBangumiPlatform("欧美剧"), "tv");
  assert.equal(mediaTypeForBangumiPlatform("日剧"), "tv");
  assert.equal(mediaTypeForBangumiPlatform("电视剧"), "tv");
  assert.equal(mediaTypeForBangumiPlatform("电影"), "movie");
  assert.equal(mediaTypeForBangumiPlatform("综艺"), "variety");
  assert.equal(mediaTypeForBangumiSubject({ type: 2, platform: "TV" }), "anime");
  assert.equal(mediaTypeForBangumiSubject({ type: 6, platform: "欧美剧" }), "tv");
  assert.equal(mediaTypeForBangumiSubject({ type: 6, platform: "电影" }), "movie");
  assert.equal(mediaTypeForBangumiSubject({ type: 6, platform: "综艺" }), "variety");
  assert.equal(mediaTypeForBangumiSubject({ type: 6, platform: "其他" }), null);
  assert.equal(mediaTypeForBangumiSubject({ type: 6, platform: "演出" }), null);
  assert.equal(mediaTypeForBangumiSubject({ type: 6, platform: "未采样平台" }), null);
});
