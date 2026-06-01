import test from "node:test";
import assert from "node:assert/strict";
import { signCoverUrl, verifyCoverSignature } from "../src/signature.js";

test("verifyCoverSignature accepts matching signatures", () => {
  const params = { id: 123, encodedUrl: "aHR0cHM6Ly9sYWluLmJnbS50di9hLmpwZw", secret: "secret" };
  const signature = signCoverUrl(params);

  assert.equal(verifyCoverSignature({ ...params, signature }), true);
});

test("verifyCoverSignature rejects tampered inputs", () => {
  const params = { id: 123, encodedUrl: "aHR0cHM6Ly9sYWluLmJnbS50di9hLmpwZw", secret: "secret" };
  const signature = signCoverUrl(params);

  assert.equal(verifyCoverSignature({ ...params, id: 124, signature }), false);
  assert.equal(verifyCoverSignature({ ...params, secret: "wrong", signature }), false);
});
