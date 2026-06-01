import test from "node:test";
import assert from "node:assert/strict";
import { safeCachePath } from "../src/cache.js";

test("safeCachePath keeps cache files inside the cache root", () => {
  assert.equal(safeCachePath("400602-abc.jpg", "/tmp/covers"), "/tmp/covers/400602-abc.jpg");
  assert.equal(safeCachePath("../secret", "/tmp/covers"), null);
  assert.equal(safeCachePath("", "/tmp/covers"), null);
});
