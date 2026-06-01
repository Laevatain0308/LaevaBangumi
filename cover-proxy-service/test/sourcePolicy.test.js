import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedCoverSource } from "../src/sourcePolicy.js";

test("isAllowedCoverSource allows configured HTTPS hosts", () => {
  assert.equal(isAllowedCoverSource("https://lain.bgm.tv/pic/cover/l/a.jpg", ["lain.bgm.tv"]), true);
  assert.equal(isAllowedCoverSource("https://sub.lain.bgm.tv/pic/cover/l/a.jpg", ["lain.bgm.tv"]), true);
});

test("isAllowedCoverSource rejects non-HTTPS and untrusted hosts", () => {
  assert.equal(isAllowedCoverSource("http://lain.bgm.tv/pic/cover/l/a.jpg", ["lain.bgm.tv"]), false);
  assert.equal(isAllowedCoverSource("https://evil.example/pic/cover/l/a.jpg", ["lain.bgm.tv"]), false);
  assert.equal(isAllowedCoverSource("not-a-url", ["lain.bgm.tv"]), false);
});
