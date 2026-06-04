import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.js";
import { initDb, sqlite } from "../src/db/index.js";
import { clearPrivateSyncRateLimiter } from "../src/routes/privateSyncRoutes.js";
import {
  createSyncInvite,
  createSyncLogin,
  createSyncToken,
  createSyncUser,
} from "../src/services/syncTokenService.js";

function cleanupSyncFixtures() {
  sqlite.exec(`
    DELETE FROM sync_invites WHERE label LIKE 'private-sync-api-%';
    DELETE FROM sync_users WHERE display_name LIKE 'private-sync-api-%';
  `);
}

function requestJson(
  server,
  { method = "GET", path, token = null, body = null },
) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body == null ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body == null
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function seedToken() {
  const user = createSyncUser("private-sync-api-Alice");
  const token = createSyncToken({ userId: user.userId, label: "test" });
  return { user, rawToken: token.rawToken };
}

function watchEvent() {
  return {
    eventId: "device-a:1",
    deviceId: "device-a",
    seq: 1,
    domain: "watch",
    op: "watch.upsertProgress",
    updatedAt: 1000,
    entityKey: "LaevaBangumi1",
    bangumiId: 1,
    payload: {
      entityKey: "LaevaBangumi1",
      adapterName: "LaevaBangumi",
      bangumiId: 1,
      bangumiItem: {
        id: 1,
        type: 2,
        name: "subject 1",
        nameCn: "条目 1",
        images: {},
        tags: [],
        alias: [],
      },
      episode: 1,
      road: 0,
      progressMs: 12000,
      lastSrc: "https://example.invalid/1",
      lastWatchEpisodeName: "EP1",
    },
  };
}

test.beforeEach(() => {
  initDb();
  cleanupSyncFixtures();
  clearPrivateSyncRateLimiter();
});

test.afterEach(() => {
  cleanupSyncFixtures();
  clearPrivateSyncRateLimiter();
});

test("sync status rejects missing token", async () => {
  const server = createServer().listen(0);
  try {
    const response = await requestJson(server, { path: "/api/sync/status" });
    assert.equal(response.status, 401);
    assert.equal(response.body.meta.error, "unauthorized");
  } finally {
    server.close();
  }
});

test("sync register creates a login from an invite and returns a device token", async () => {
  const invite = createSyncInvite({
    label: "private-sync-api-friend",
    maxUses: 1,
  });
  const server = createServer().listen(0);
  try {
    const response = await requestJson(server, {
      method: "POST",
      path: "/api/sync/register",
      body: {
        loginName: "private-sync-api-bob",
        displayName: "private-sync-api-Bob",
        password: "password-password",
        inviteCode: invite.rawInviteCode,
        deviceId: "device-a",
        deviceName: "Laptop",
        platform: "macos",
        appVersion: "1.0.0",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.displayName, "private-sync-api-Bob");
    assert.equal(response.body.data.deviceId, "device-a");
    assert.equal(response.body.data.token.startsWith("lbst_"), true);

    const status = await requestJson(server, {
      path: "/api/sync/status",
      token: response.body.data.token,
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.data.user.displayName, "private-sync-api-Bob");

    const reusedInvite = await requestJson(server, {
      method: "POST",
      path: "/api/sync/register",
      body: {
        loginName: "private-sync-api-charlie",
        displayName: "private-sync-api-Charlie",
        password: "password-password",
        inviteCode: invite.rawInviteCode,
        deviceId: "device-b",
      },
    });
    assert.equal(reusedInvite.status, 401);
    assert.equal(reusedInvite.body.meta.error, "invalid_invite");
  } finally {
    server.close();
  }
});

test("sync login authenticates a password and returns a device token", async () => {
  const user = createSyncUser("private-sync-api-Login");
  createSyncLogin({
    userId: user.userId,
    loginName: "private-sync-api-alice",
    password: "correct horse battery staple",
  });
  const server = createServer().listen(0);
  try {
    const response = await requestJson(server, {
      method: "POST",
      path: "/api/sync/login",
      body: {
        loginName: "private-sync-api-alice",
        password: "correct horse battery staple",
        deviceId: "device-a",
        deviceName: "Phone",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.displayName, "private-sync-api-Login");
    assert.equal(response.body.data.deviceId, "device-a");
    assert.equal(response.body.data.token.startsWith("lbst_"), true);

    const rejected = await requestJson(server, {
      method: "POST",
      path: "/api/sync/login",
      body: {
        loginName: "private-sync-api-alice",
        password: "wrong-password",
        deviceId: "device-b",
      },
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.meta.error, "invalid_credentials");
  } finally {
    server.close();
  }
});

test("sync login rate limits repeated failures", async () => {
  const user = createSyncUser("private-sync-api-RateLimit");
  createSyncLogin({
    userId: user.userId,
    loginName: "private-sync-api-rate-limit",
    password: "correct horse battery staple",
  });
  const server = createServer().listen(0);
  try {
    let response;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      response = await requestJson(server, {
        method: "POST",
        path: "/api/sync/login",
        body: {
          loginName: "private-sync-api-rate-limit",
          password: "wrong-password",
          deviceId: "device-a",
        },
      });
    }
    assert.equal(response.status, 401);

    const limited = await requestJson(server, {
      method: "POST",
      path: "/api/sync/login",
      body: {
        loginName: "private-sync-api-rate-limit",
        password: "wrong-password",
        deviceId: "device-a",
      },
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.meta.error, "rate_limited");
  } finally {
    server.close();
  }
});

test("sync auth endpoints reject overly long fields before hashing", async () => {
  const server = createServer().listen(0);
  try {
    const response = await requestJson(server, {
      method: "POST",
      path: "/api/sync/login",
      body: {
        loginName: "private-sync-api-long",
        password: "x".repeat(2048),
        deviceId: "device-a",
      },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.meta.error, "invalid_query");
  } finally {
    server.close();
  }
});

test("sync logout revokes the current token", async () => {
  const { rawToken } = seedToken();
  const server = createServer().listen(0);
  try {
    const logout = await requestJson(server, {
      method: "POST",
      path: "/api/sync/logout",
      token: rawToken,
      body: {},
    });
    assert.equal(logout.status, 200);
    assert.equal(logout.body.data.revoked, true);

    const status = await requestJson(server, {
      path: "/api/sync/status",
      token: rawToken,
    });
    assert.equal(status.status, 401);
    assert.equal(status.body.meta.error, "unauthorized");
  } finally {
    server.close();
  }
});

test("sync status returns the authenticated user and counts", async () => {
  const { rawToken } = seedToken();
  const server = createServer().listen(0);
  try {
    const response = await requestJson(server, {
      path: "/api/sync/status",
      token: rawToken,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.displayName, "private-sync-api-Alice");
    assert.equal(response.body.data.watchHistoryCount, 0);
    assert.equal(response.body.data.collectionCount, 0);
  } finally {
    server.close();
  }
});

test("register-device is idempotent", async () => {
  const { rawToken, user } = seedToken();
  const server = createServer().listen(0);
  try {
    for (const deviceName of ["Mac", "MacBook"]) {
      const response = await requestJson(server, {
        method: "POST",
        path: "/api/sync/register-device",
        token: rawToken,
        body: {
          deviceId: "device-a",
          deviceName,
          platform: "macos",
          appVersion: "1.0.0",
        },
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.deviceId, "device-a");
    }
    const devices = sqlite
      .prepare("SELECT device_name FROM sync_devices WHERE user_id = ?")
      .all(user.userId);
    assert.deepEqual(
      devices.map((row) => row.device_name),
      ["MacBook"],
    );
  } finally {
    server.close();
  }
});

test("merge accepts events and returns a snapshot", async () => {
  const { rawToken } = seedToken();
  const server = createServer().listen(0);
  try {
    const response = await requestJson(server, {
      method: "POST",
      path: "/api/sync/merge",
      token: rawToken,
      body: {
        deviceId: "device-a",
        clientSeq: 1,
        events: [watchEvent()],
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.acceptedEventIds, ["device-a:1"]);
    assert.equal(
      response.body.data.snapshot.watch.histories[0].lastWatchEpisode,
      1,
    );

    const duplicate = await requestJson(server, {
      method: "POST",
      path: "/api/sync/merge",
      token: rawToken,
      body: {
        deviceId: "device-a",
        clientSeq: 1,
        events: [watchEvent()],
      },
    });
    assert.deepEqual(duplicate.body.data.ignoredDuplicateEventIds, [
      "device-a:1",
    ]);
  } finally {
    server.close();
  }
});

test("clear removes only requested sync domains", async () => {
  const { rawToken } = seedToken();
  const server = createServer().listen(0);
  try {
    const merged = await requestJson(server, {
      method: "POST",
      path: "/api/sync/merge",
      token: rawToken,
      body: {
        deviceId: "device-a",
        clientSeq: 1,
        events: [
          watchEvent(),
          {
            eventId: "device-a:2",
            deviceId: "device-a",
            seq: 2,
            domain: "collection",
            op: "collection.upsert",
            updatedAt: 2000,
            bangumiId: 1,
            payload: {
              bangumiId: 1,
              type: 1,
              bangumiItem: watchEvent().payload.bangumiItem,
              collectedAt: 2000,
            },
          },
        ],
      },
    });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.data.snapshot.watch.histories.length, 1);
    assert.equal(merged.body.data.snapshot.collection.items.length, 1);

    const clearWatch = await requestJson(server, {
      method: "POST",
      path: "/api/sync/clear",
      token: rawToken,
      body: { watch: true, collection: false },
    });
    assert.equal(clearWatch.status, 200);
    assert.equal(clearWatch.body.data.snapshot.watch.histories.length, 0);
    assert.equal(clearWatch.body.data.snapshot.collection.items.length, 1);

    const clearCollection = await requestJson(server, {
      method: "POST",
      path: "/api/sync/clear",
      token: rawToken,
      body: { collection: true },
    });
    assert.equal(clearCollection.status, 200);
    assert.equal(clearCollection.body.data.snapshot.watch.histories.length, 0);
    assert.equal(clearCollection.body.data.snapshot.collection.items.length, 0);
  } finally {
    server.close();
  }
});
