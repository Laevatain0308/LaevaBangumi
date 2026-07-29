import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMediaType,
  mediaTypeForBangumiPlatform,
  mediaTypeForBangumiSubject,
} from "../src/lib/mediaTypes.js";

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
