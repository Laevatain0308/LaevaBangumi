import test from "node:test";
import assert from "node:assert/strict";
import * as mediaTypes from "../src/lib/mediaTypes.js";

test("media type helpers accept only anime", () => {
  assert.equal(mediaTypes.DEFAULT_MEDIA_TYPE, "anime");
  assert.deepEqual(mediaTypes.MEDIA_TYPES, ["anime"]);
  assert.equal(mediaTypes.assertMediaType(undefined), "anime");
  assert.equal(mediaTypes.assertMediaType(""), "anime");
  assert.equal(mediaTypes.assertMediaType("anime"), "anime");
  assert.equal(mediaTypes.assertMediaType(" anime "), "anime");
  assert.throws(() => mediaTypes.assertMediaType("tv"), /unsupported media type: tv/);
  assert.throws(() => mediaTypes.assertMediaType("movie"), /unsupported media type: movie/);
  assert.throws(() => mediaTypes.assertMediaType("variety"), /unsupported media type: variety/);
  assert.throws(() => mediaTypes.assertMediaType("book"), /unsupported media type: book/);
});

test("non-anime Bangumi media mappings are retired", () => {
  assert.equal(mediaTypes.mediaTypeForBangumiPlatform, undefined);
  assert.equal(mediaTypes.mediaTypeForBangumiSubject, undefined);
  assert.equal(mediaTypes.BANGUMI_PLATFORM_MEDIA_TYPES, undefined);
  assert.equal(mediaTypes.BANGUMI_SUBJECT_TYPE_BY_MEDIA_TYPE, undefined);
});
