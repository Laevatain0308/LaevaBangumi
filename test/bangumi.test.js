import test from "node:test";
import assert from "node:assert/strict";
import { fetchJson } from "../src/clients/bangumiClient.js";

function okJson(value) {
  return {
    ok: true,
    json: async () => value,
  };
}

test("fetchJson retries transient network errors and returns the eventual response", async () => {
  let attempts = 0;
  const result = await fetchJson("https://api.bgm.tv/calendar", {
    retryDelaysMs: [0, 0],
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
      }
      return okJson({ ok: true });
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 3);
});

test("fetchJson does not retry HTTP errors", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      fetchJson("https://api.bgm.tv/calendar", {
        retryDelaysMs: [0, 0],
        fetchImpl: async () => {
          attempts += 1;
          return {
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
          };
        },
      }),
    /Bangumi HTTP 500: Internal Server Error/,
  );

  assert.equal(attempts, 1);
});

test("fetchJson does not retry non-network fetch errors", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      fetchJson("https://api.bgm.tv/calendar", {
        retryDelaysMs: [0, 0],
        fetchImpl: async () => {
          attempts += 1;
          throw new Error("request setup failed");
        },
      }),
    /Bangumi fetch failed .* after 1 attempts/,
  );

  assert.equal(attempts, 1);
});

test("fetchJson stops after two retries for network errors", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      fetchJson("https://api.bgm.tv/calendar", {
        retryDelaysMs: [0, 0],
        fetchImpl: async () => {
          attempts += 1;
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
        },
      }),
    /Bangumi fetch failed .* after 3 attempts/,
  );

  assert.equal(attempts, 3);
});
