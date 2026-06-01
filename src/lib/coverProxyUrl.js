import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function hmacPayload(id, encodedUrl) {
  return `${id}:${encodedUrl}`;
}

export function encodeCoverSource(sourceUrl) {
  return Buffer.from(String(sourceUrl), "utf8").toString("base64url");
}

export function decodeCoverSource(encodedUrl) {
  return Buffer.from(String(encodedUrl), "base64url").toString("utf8");
}

export function coverUrlHash(sourceUrl) {
  return createHash("sha256").update(String(sourceUrl)).digest("hex").slice(0, 12);
}

export function signCoverProxyUrl({ id, encodedUrl, secret }) {
  return createHmac("sha256", secret)
    .update(hmacPayload(id, encodedUrl))
    .digest("base64url");
}

export function verifyCoverProxySignature({ id, encodedUrl, signature, secret }) {
  if (!id || !encodedUrl || !signature || !secret) return false;
  const expected = signCoverProxyUrl({ id, encodedUrl, secret });
  const actualBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function buildCoverProxyUrl({
  id,
  sourceUrl,
  baseUrl = process.env.COVER_PROXY_BASE,
  secret = process.env.COVER_PROXY_SECRET,
} = {}) {
  if (!id || !sourceUrl || !baseUrl || !secret) return null;
  const encodedUrl = encodeCoverSource(sourceUrl);
  const signature = signCoverProxyUrl({ id, encodedUrl, secret });
  return `${trimSlash(baseUrl)}/cover/${id}-${coverUrlHash(sourceUrl)}.jpg?u=${encodedUrl}&sig=${signature}`;
}
