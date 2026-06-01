import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCoverProxyUrl,
  coverUrlHash,
  encodeCoverSource,
  verifyCoverProxySignature,
} from "../src/lib/coverProxyUrl.js";
import { normalizeCoverUrl } from "../src/services/anime.js";

const SECRET = "test-cover-secret";
const SOURCE_URL = "https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg";

test("buildCoverProxyUrl returns null when proxy config is incomplete", () => {
  assert.equal(buildCoverProxyUrl({ id: 400602, sourceUrl: SOURCE_URL, baseUrl: "", secret: SECRET }), null);
  assert.equal(buildCoverProxyUrl({ id: 400602, sourceUrl: SOURCE_URL, baseUrl: "https://img.example.test", secret: "" }), null);
  assert.equal(buildCoverProxyUrl({ id: 400602, sourceUrl: "", baseUrl: "https://img.example.test", secret: SECRET }), null);
});

test("buildCoverProxyUrl creates a signed external cover URL", () => {
  const url = buildCoverProxyUrl({
    id: 400602,
    sourceUrl: SOURCE_URL,
    baseUrl: "https://img.example.test",
    secret: SECRET,
  });

  assert.ok(url);
  const parsed = new URL(url);
  const encoded = parsed.searchParams.get("u");
  const sig = parsed.searchParams.get("sig");

  assert.equal(parsed.origin, "https://img.example.test");
  assert.equal(parsed.pathname, `/cover/400602-${coverUrlHash(SOURCE_URL)}.jpg`);
  assert.equal(encoded, encodeCoverSource(SOURCE_URL));
  assert.ok(verifyCoverProxySignature({ id: 400602, encodedUrl: encoded, signature: sig, secret: SECRET }));
});

test("verifyCoverProxySignature rejects tampered cover input", () => {
  const encoded = encodeCoverSource(SOURCE_URL);
  const url = buildCoverProxyUrl({
    id: 400602,
    sourceUrl: SOURCE_URL,
    baseUrl: "https://img.example.test",
    secret: SECRET,
  });
  const sig = new URL(url).searchParams.get("sig");

  assert.equal(verifyCoverProxySignature({ id: 400603, encodedUrl: encoded, signature: sig, secret: SECRET }), false);
  assert.equal(verifyCoverProxySignature({ id: 400602, encodedUrl: encoded, signature: sig, secret: "wrong" }), false);
});

test("normalizeCoverUrl upgrades Bangumi cover URLs to HTTPS", () => {
  assert.equal(
    normalizeCoverUrl("http://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg"),
    "https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg"
  );
  assert.equal(
    normalizeCoverUrl("http://lain.bgm.tv/r/400/pic/cover/l/13/c5/400602_ZI8Y9.jpg"),
    "https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg"
  );
});
