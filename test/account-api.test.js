import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.js";
import { createAccountAuthMiddleware } from "../src/routes/accountAuth.js";
import { createAccountSyncRuntime } from "../src/runtime/accountSyncRuntime.js";
import { createTestDatabase } from "./helpers/testDatabase.js";

const NOW = "2026-07-16T00:00:00.000Z";

function request(server, { method = "GET", path, token, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port: server.address().port,
      method,
      path,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode,
        body: text && res.headers["content-type"]?.includes("application/json")
          ? JSON.parse(text)
          : text,
      }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function setup(t) {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const runtime = createAccountSyncRuntime({
    sqlite,
    metadataEnsureService: { ensure() {} },
    clock: () => new Date(NOW),
  });
  runtime.accountService.addAccount({
    username: "alice",
    password: "password-password",
  });
  const server = createServer({ accountSyncRuntime: runtime }).listen(0);
  t.after(() => server.close());
  return { runtime, server };
}

async function login(server, deviceId = "phone") {
  return request(server, {
    method: "POST",
    path: "/api/account/login",
    body: {
      username: "alice",
      password: "password-password",
      deviceId,
      deviceName: deviceId === "phone" ? "Alice Phone" : "Alice Laptop",
      platform: deviceId === "phone" ? "android" : "linux",
      appVersion: "1.0.0",
    },
  });
}

test("login returns the account, bound device, and raw token", async (t) => {
  const { server } = setup(t);
  const response = await login(server);

  assert.equal(response.status, 200);
  assert.equal(response.body.data.account.username, "alice");
  assert.equal(response.body.data.deviceId, "phone");
  assert.match(response.body.data.token, /^lbat_/);
  assert.deepEqual(Object.keys(response.body.data).sort(), ["account", "deviceId", "token"]);
});

test("login validates exact fields before calling the account service", async (t) => {
  let loginCalls = 0;
  const accountService = {
    login() { loginCalls += 1; throw new Error("must not run"); },
    authenticate() { return null; },
  };
  const authenticate = createAccountAuthMiddleware({ accountService });
  const server = createServer({
    accountSyncRuntime: {
      accountService,
      authenticate,
      syncMergeService: { merge() {} },
      syncSnapshotService: { build() {} },
    },
  }).listen(0);
  t.after(() => server.close());

  for (const body of [
    { username: "alice", password: "short", deviceId: "phone" },
    { username: 123, password: "password-password", deviceId: "phone" },
    { username: "   ", password: "password-password", deviceId: "phone" },
    { username: "a".repeat(65), password: "password-password", deviceId: "phone" },
    { username: "alice", password: "password-password", deviceId: "" },
    { username: "alice", password: "password-password", deviceId: "phone", unexpected: true },
  ]) {
    const response = await request(server, { method: "POST", path: "/api/account/login", body });
    assert.equal(response.status, 400);
    assert.equal(response.body.meta.error, "invalid_query");
  }
  assert.equal(loginCalls, 0);
});

test("login rejects usernames that exceed the limit after normalization", async (t) => {
  const { server } = setup(t);
  const response = await request(server, {
    method: "POST",
    path: "/api/account/login",
    body: {
      username: "\u0130".repeat(64),
      password: "password-password",
      deviceId: "phone",
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.meta.error, "invalid_query");
});

test("bad username or password returns one invalid-credentials response", async (t) => {
  const { server } = setup(t);
  for (const body of [
    { username: "alice", password: "wrong-password", deviceId: "phone" },
    { username: "missing", password: "wrong-password", deviceId: "phone" },
  ]) {
    const response = await request(server, { method: "POST", path: "/api/account/login", body });
    assert.equal(response.status, 401);
    assert.equal(response.body.meta.error, "invalid_credentials");
  }
});

test("status exposes devices without password or token secrets", async (t) => {
  const { server } = setup(t);
  const phone = await login(server, "phone");
  await login(server, "laptop");

  const response = await request(server, {
    path: "/api/account/status",
    token: phone.body.data.token,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.username, "alice");
  assert.equal(response.body.data.currentDevice.deviceId, "phone");
  assert.deepEqual(response.body.data.devices.map(({ deviceId }) => deviceId), ["laptop", "phone"]);
  const serialized = JSON.stringify(response.body.data);
  assert.doesNotMatch(serialized, /password|scrypt\$|lbat_|tokenHash/i);
});

test("logout revokes only the current token", async (t) => {
  const { server } = setup(t);
  const phone = await login(server, "phone");
  const laptop = await login(server, "laptop");

  const logout = await request(server, {
    method: "POST",
    path: "/api/account/logout",
    token: phone.body.data.token,
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.body.data, { revoked: true });
  assert.equal((await request(server, {
    path: "/api/account/status",
    token: phone.body.data.token,
  })).status, 401);
  assert.equal((await request(server, {
    path: "/api/account/status",
    token: laptop.body.data.token,
  })).status, 200);
});

test("protected routes reject missing and malformed bearer tokens", async (t) => {
  const { server } = setup(t);
  for (const token of [undefined, "wrong", "lbat_missing"] ) {
    const response = await request(server, { path: "/api/account/status", token });
    assert.equal(response.status, 401);
    assert.equal(response.body.meta.error, "unauthorized");
  }
});

test("legacy sync endpoints are not mounted", async (t) => {
  const { server } = setup(t);
  for (const [method, path] of [
    ["POST", "/api/sync/register"],
    ["POST", "/api/sync/login"],
    ["POST", "/api/sync/logout"],
    ["GET", "/api/sync/status"],
    ["POST", "/api/sync/register-device"],
    ["POST", "/api/sync/clear"],
  ]) {
    assert.equal((await request(server, { method, path, body: {} })).status, 404, path);
  }
});

test("unknown account endpoints are not hidden behind authentication", async (t) => {
  const { server } = setup(t);
  for (const [method, path] of [
    ["POST", "/api/account/register"],
    ["POST", "/api/account/set-password"],
    ["GET", "/api/account/devices"],
  ]) {
    assert.equal((await request(server, { method, path, body: {} })).status, 404, path);
  }
});

test("account and sync routes use the same authentication middleware once per request", async (t) => {
  let authenticateCalls = 0;
  const auth = {
    accountId: 1,
    username: "alice",
    tokenId: 2,
    device: { deviceId: "phone" },
  };
  const accountService = {
    authenticate() { authenticateCalls += 1; return auth; },
    status() { return { username: "alice", currentDevice: auth.device, devices: [auth.device] }; },
    logout() { return true; },
  };
  const authenticate = createAccountAuthMiddleware({ accountService });
  const runtime = {
    accountService,
    authenticate,
    syncMergeService: { merge: () => ({ acceptedEventIds: [], duplicateEventIds: [] }) },
    syncSnapshotService: { build: () => ({ watch: {}, collection: {} }) },
  };
  const server = createServer({ accountSyncRuntime: runtime }).listen(0);
  t.after(() => server.close());

  const requests = [
    request(server, { path: "/api/account/status", token: "lbat_test" }),
    request(server, { method: "POST", path: "/api/account/logout", token: "lbat_test" }),
    request(server, { method: "POST", path: "/api/sync/merge", token: "lbat_test", body: { events: [] } }),
    request(server, { path: "/api/sync/snapshot", token: "lbat_test" }),
  ];
  const responses = await Promise.all(requests);
  assert.ok(responses.every(({ status }) => status === 200));
  assert.equal(authenticateCalls, 4);
});
