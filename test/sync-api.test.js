import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.js";
import { createAccountSyncRuntime } from "../src/runtime/accountSyncRuntime.js";
import { createTestDatabase } from "./helpers/testDatabase.js";

const NOW = "2026-07-16T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

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
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function setup(t) {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const logs = [];
  const runtime = createAccountSyncRuntime({
    sqlite,
    metadataEnsureService: { ensure() {} },
    clock: () => new Date(NOW),
    logger: { error(...args) { logs.push(args); } },
  });
  runtime.accountService.addAccount({ username: "alice", password: "password-password" });
  const login = runtime.accountService.login({
    username: "alice",
    password: "password-password",
    deviceId: "device-a",
  });
  const server = createServer({ accountSyncRuntime: runtime }).listen(0);
  t.after(() => server.close());
  return { sqlite, runtime, server, token: login.token, logs };
}

function watchEvent(overrides = {}) {
  return {
    eventId: "device-a:1",
    deviceId: "device-a",
    seq: 1,
    domain: "watch",
    op: "watch.upsertProgress",
    updatedAt: NOW_MS,
    bangumiId: 123,
    payload: {
      episode: 1,
      lastWatchEpisode: 1,
      road: 0,
      progressMs: 1000,
      lastWatchTime: NOW_MS,
      lastWatchEpisodeName: "Episode 1",
    },
    ...overrides,
  };
}

test("authenticated merge returns a current local snapshot", async (t) => {
  const { server, token } = setup(t);
  const response = await request(server, {
    method: "POST",
    path: "/api/sync/merge",
    token,
    body: { events: [watchEvent()] },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.acceptedEventIds, ["device-a:1"]);
  assert.deepEqual(response.body.data.duplicateEventIds, []);
  assert.equal(response.body.data.snapshot.watch.records[0].bangumiId, 123);
  assert.equal(response.body.data.snapshot.watch.records[0].subject, null);
});

test("authenticated snapshot reads normalized local state", async (t) => {
  const { server, token } = setup(t);
  await request(server, {
    method: "POST",
    path: "/api/sync/merge",
    token,
    body: { events: [watchEvent()] },
  });

  const response = await request(server, { path: "/api/sync/snapshot", token });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.generatedAt, NOW_MS);
  assert.equal(response.body.data.watch.records[0].bangumiId, 123);
});

for (const [name, event, errorCode] of [
  ["device mismatch", watchEvent({ deviceId: "other-device" }), "device_mismatch"],
  ["clock skew", watchEvent({ updatedAt: NOW_MS + 24 * 60 * 60 * 1000 + 1 }), "clock_skew"],
  ["invalid event", watchEvent({ bangumiId: 0 }), "invalid_sync_event"],
]) {
  test(`${name} maps to ${errorCode}`, async (t) => {
    const { server, token } = setup(t);
    const response = await request(server, {
      method: "POST",
      path: "/api/sync/merge",
      token,
      body: { events: [event] },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.meta.error, errorCode);
  });
}

test("merge accepts only a body whose sole key is events", async (t) => {
  const { server, token } = setup(t);
  for (const body of [
    [],
    {},
    { events: [], deviceId: "device-a" },
    { events: [], clientSeq: 1 },
  ]) {
    const response = await request(server, {
      method: "POST",
      path: "/api/sync/merge",
      token,
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.meta.error, "invalid_sync_event");
  }
});

test("database failure returns a generic 500 and rolls back the ledger", async (t) => {
  const { sqlite, server, token } = setup(t);
  sqlite.exec(`
    CREATE TRIGGER fail_api_watch_insert
    BEFORE INSERT ON watch_records
    BEGIN
      SELECT RAISE(ABORT, 'secret SQL trigger failure with password and lbat_token');
    END;
  `);
  const event = watchEvent();
  const response = await request(server, {
    method: "POST",
    path: "/api/sync/merge",
    token,
    body: { events: [event] },
  });

  assert.equal(response.status, 500);
  assert.equal(response.body.meta.error, "server_error");
  assert.deepEqual(response.body.meta.warnings, ["Internal server error"]);
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /secret SQL|trigger failure|password|lbat_|device-a:1/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sync_events").get().count, 0);
});
