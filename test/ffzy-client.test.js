import test from "node:test";
import assert from "node:assert/strict";
import {
  FFZYRequestError,
  createFFZYClient,
} from "../src/resourceSources/ffzy/ffzyClient.js";

test("catalog request uses the FFZY list query exactly once", async () => {
  const calls = [];
  const client = createFFZYClient({
    endpoint: "https://example.invalid/api.php",
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return { ok: true, status: 200, text: async () => "<rss />" };
    },
  });

  assert.equal(await client.fetchCatalogXml({ categoryId: "30", page: 3 }), "<rss />");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get("ac"), "list");
  assert.equal(calls[0].url.searchParams.get("t"), "30");
  assert.equal(calls[0].url.searchParams.get("pg"), "3");
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test("detail request sends opaque IDs without numeric conversion", async () => {
  let requestedUrl;
  const client = createFFZYClient({
    endpoint: "https://example.invalid/api.php",
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return { ok: true, status: 200, text: async () => "detail" };
    },
  });

  assert.equal(await client.fetchDetailXml(["item-001", "98509"]), "detail");
  assert.equal(requestedUrl.searchParams.get("ac"), "detail");
  assert.equal(requestedUrl.searchParams.get("ids"), "item-001,98509");
});

test("client classifies retryable and permanent HTTP responses", async () => {
  for (const [status, retryable] of [[408, true], [429, true], [500, true], [503, true], [404, false]]) {
    const client = createFFZYClient({
      fetchImpl: async () => ({ ok: false, status, text: async () => "" }),
    });
    await assert.rejects(() => client.fetchDetailXml(["1"]), (error) => {
      assert.equal(error instanceof FFZYRequestError, true);
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      return true;
    });
  }
});

test("network errors and abort timeouts are retryable", async () => {
  const networkClient = createFFZYClient({
    fetchImpl: async () => { throw new Error("connection reset"); },
  });
  await assert.rejects(() => networkClient.fetchCatalogXml({ categoryId: "30", page: 1 }), (error) => {
    assert.equal(error.retryable, true);
    assert.match(error.message, /connection reset/i);
    return true;
  });

  let timeoutCallback;
  const timeoutClient = createFFZYClient({
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      timeoutCallback();
    }),
    setTimeoutImpl(callback) {
      timeoutCallback = callback;
      return 1;
    },
    clearTimeoutImpl() {},
  });
  await assert.rejects(() => timeoutClient.fetchCatalogXml({ categoryId: "30", page: 1 }), (error) => {
    assert.equal(error.retryable, true);
    assert.equal(error.timedOut, true);
    return true;
  });
});

test("invalid request arguments fail before fetch", async () => {
  let calls = 0;
  const client = createFFZYClient({ fetchImpl: async () => { calls += 1; } });
  await assert.rejects(() => client.fetchCatalogXml({ categoryId: "", page: 1 }), /categoryId/i);
  await assert.rejects(() => client.fetchCatalogXml({ categoryId: "30", page: 0 }), /page/i);
  await assert.rejects(() => client.fetchDetailXml([]), /source item IDs/i);
  assert.equal(calls, 0);
});
