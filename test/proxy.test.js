import test from "node:test";
import assert from "node:assert/strict";
import { getDispatcher, getProxyStatus, resetProxy, setProxy } from "../src/lib/proxy.js";

test.afterEach(() => {
  delete process.env.BANGUMI_PROXY_URL;
  resetProxy();
});

test("getDispatcher returns null when BANGUMI_PROXY_URL is not configured", () => {
  delete process.env.BANGUMI_PROXY_URL;
  resetProxy();

  assert.equal(getDispatcher(), null);
});

test("getDispatcher ignores generic proxy environment variables", () => {
  delete process.env.BANGUMI_PROXY_URL;
  process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
  resetProxy();

  assert.equal(getDispatcher(), null);
});

test("setProxy can configure and clear a process-local dispatcher", () => {
  setProxy("http://127.0.0.1:7897");
  assert.ok(getDispatcher());

  setProxy("");
  assert.equal(getDispatcher(), null);
});

test("getProxyStatus reports masked Bangumi proxy configuration", () => {
  setProxy("http://user:secret@127.0.0.1:7897");

  assert.deepEqual(getProxyStatus(), {
    enabled: true,
    url: "http://user:***@127.0.0.1:7897/",
  });

  setProxy("");
  assert.deepEqual(getProxyStatus(), { enabled: false, url: null });
});
