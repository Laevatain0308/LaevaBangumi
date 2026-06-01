import { createHmac, timingSafeEqual } from "node:crypto";

function payload(id, encodedUrl) {
  return `${id}:${encodedUrl}`;
}

export function decodeCoverSource(encodedUrl) {
  return Buffer.from(String(encodedUrl), "base64url").toString("utf8");
}

export function signCoverUrl({ id, encodedUrl, secret }) {
  return createHmac("sha256", secret)
    .update(payload(id, encodedUrl))
    .digest("base64url");
}

export function verifyCoverSignature({ id, encodedUrl, signature, secret }) {
  if (!id || !encodedUrl || !signature || !secret) return false;
  const expected = signCoverUrl({ id, encodedUrl, secret });
  const actualBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
