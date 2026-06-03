import test from "node:test";
import assert from "node:assert/strict";
import { fetchJson, searchSubjects } from "../src/clients/bangumiClient.js";

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

test("searchSubjects fetches bounded paged results with the largest useful page size", async () => {
  const requests = [];
  const result = await searchSubjects("测试", {
    retryDelaysMs: [],
    fetchImpl: async (url, opts) => {
      const parsed = new URL(url);
      requests.push({
        limit: parsed.searchParams.get("limit"),
        offset: parsed.searchParams.get("offset"),
        body: JSON.parse(opts.body),
      });
      const offset = Number.parseInt(parsed.searchParams.get("offset"), 10);
      const data = Array.from({ length: offset === 0 ? 50 : 30 }, (_, i) => ({ id: offset + i + 1 }));
      return okJson({ data, total: 80, limit: 50, offset });
    },
  });

  assert.deepEqual(result.data.map((item) => item.id), Array.from({ length: 80 }, (_, i) => i + 1));
  assert.equal(result.total, 80);
  assert.deepEqual(requests.map(({ limit, offset }) => ({ limit, offset })), [
    { limit: "50", offset: "0" },
    { limit: "50", offset: "50" },
  ]);
  assert.equal(requests[0].body.keyword, "测试");
  assert.deepEqual(requests[0].body.filter.type, [2]);
});

test("searchSubjects shrinks page size when caller asks for fewer results", async () => {
  const requestedLimits = [];
  const result = await searchSubjects("测试", {
    maxResults: 3,
    retryDelaysMs: [],
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requestedLimits.push(parsed.searchParams.get("limit"));
      return okJson({
        data: [{ id: 1 }, { id: 2 }, { id: 3 }],
        total: 80,
        limit: 3,
        offset: 0,
      });
    },
  });

  assert.deepEqual(result.data.map((item) => item.id), [1, 2, 3]);
  assert.deepEqual(requestedLimits, ["3"]);
});

test("prewarmAnime passes query limit down to Bangumi search", async () => {
  const { prewarmAnime } = await import("../src/services/prewarmService.js");
  const searchCalls = [];
  const stats = await prewarmAnime({
    query: "测试",
    sourceKeys: [],
    refreshEpisodes: false,
    limit: 3,
  }, {
    searchSubjects: async (keyword, options) => {
      searchCalls.push({ keyword, options });
      return {
        data: [
          { id: 1001, name: "one" },
          { id: 1002, name: "two" },
          { id: 1003, name: "three" },
          { id: 1004, name: "four" },
        ],
      };
    },
    upsertSubject: async (subject) => ({ id: subject.id, name: subject.name }),
    enrichSubject: async (id) => ({ id, name: `subject-${id}` }),
    ensureMapping: async () => ({ matched: false }),
    refreshEpisodes: async () => false,
  });

  assert.deepEqual(searchCalls, [{ keyword: "测试", options: { maxResults: 3 } }]);
  assert.equal(stats.upserted, 3);
  assert.equal(stats.requested, 3);
  assert.equal(stats.processed, 3);
});
