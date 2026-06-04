import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import {
  authenticateBearerToken,
  createSyncInvite,
  createSyncLogin,
  createSyncToken,
  createSyncUser,
  loginSyncUser,
  registerSyncUserWithInvite,
  revokeSyncToken,
} from "../src/services/syncTokenService.js";

function cleanupSyncFixtures() {
  sqlite.exec(`
    DELETE FROM sync_invites WHERE label LIKE 'private-sync-auth-%';
    DELETE FROM sync_users WHERE display_name LIKE 'private-sync-auth-%';
  `);
}

test.beforeEach(() => {
  initDb();
  cleanupSyncFixtures();
});

test.afterEach(() => {
  cleanupSyncFixtures();
});

test("initDb creates private sync tables", () => {
  const tableNames = new Set(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );

  for (const table of [
    "sync_users",
    "sync_credentials",
    "sync_invites",
    "sync_tokens",
    "sync_devices",
    "sync_events",
    "watch_history_items",
    "watch_progress",
    "watch_deleted_items",
    "watch_clear_state",
    "collection_items",
    "collection_deleted_items",
    "collection_clear_state",
  ]) {
    assert.equal(tableNames.has(table), true, `${table} table should exist`);
  }
});

test("createSyncToken returns a raw token once and stores only a hash", () => {
  const user = createSyncUser("private-sync-auth-Alice");
  const token = createSyncToken({ userId: user.userId, label: "phone" });

  assert.equal(token.rawToken.startsWith("lbst_"), true);
  assert.equal(token.tokenId > 0, true);

  const row = sqlite
    .prepare("SELECT token_hash, label FROM sync_tokens WHERE token_id = ?")
    .get(token.tokenId);
  assert.equal(row.label, "phone");
  assert.notEqual(row.token_hash, token.rawToken);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test("authenticateBearerToken accepts active tokens and updates last_used_at", () => {
  const user = createSyncUser("private-sync-auth-Alice");
  const token = createSyncToken({ userId: user.userId, label: "laptop" });

  const auth = authenticateBearerToken(`Bearer ${token.rawToken}`);

  assert.equal(auth.user.userId, user.userId);
  assert.equal(auth.user.displayName, "private-sync-auth-Alice");
  assert.equal(auth.token.tokenId, token.tokenId);

  const row = sqlite
    .prepare("SELECT last_used_at FROM sync_tokens WHERE token_id = ?")
    .get(token.tokenId);
  assert.equal(typeof row.last_used_at, "string");
});

test("authenticateBearerToken rejects missing, revoked, and disabled tokens", () => {
  assert.equal(authenticateBearerToken(null), null);
  assert.equal(authenticateBearerToken("Bearer missing"), null);

  const user = createSyncUser("private-sync-auth-Alice");
  const revoked = createSyncToken({ userId: user.userId, label: "old" });
  revokeSyncToken(revoked.tokenId);
  assert.equal(authenticateBearerToken(`Bearer ${revoked.rawToken}`), null);

  const disabled = createSyncToken({ userId: user.userId, label: "disabled" });
  sqlite
    .prepare(
      "UPDATE sync_users SET disabled_at = datetime('now') WHERE user_id = ?",
    )
    .run(user.userId);
  assert.equal(authenticateBearerToken(`Bearer ${disabled.rawToken}`), null);
});

test("createSyncLogin authenticates a password and issues device tokens", () => {
  const user = createSyncUser("private-sync-auth-Login");
  createSyncLogin({
    userId: user.userId,
    loginName: "private-sync-auth-alice",
    password: "correct horse battery staple",
  });

  const login = loginSyncUser({
    loginName: "private-sync-auth-alice",
    password: "correct horse battery staple",
    deviceId: "device-a",
    deviceName: "Phone",
    platform: "ios",
    appVersion: "1.0.0",
  });

  assert.equal(login.user.userId, user.userId);
  assert.equal(login.user.displayName, "private-sync-auth-Login");
  assert.equal(login.rawToken.startsWith("lbst_"), true);
  assert.equal(login.deviceId, "device-a");

  const auth = authenticateBearerToken(`Bearer ${login.rawToken}`);
  assert.equal(auth.user.userId, user.userId);

  assert.equal(
    loginSyncUser({
      loginName: "private-sync-auth-alice",
      password: "wrong",
      deviceId: "device-b",
    }),
    null,
  );
});

test("createSyncLogin rejects oversized credentials before storing hashes", () => {
  const user = createSyncUser("private-sync-auth-Limits");

  assert.throws(
    () =>
      createSyncLogin({
        userId: user.userId,
        loginName: "x".repeat(65),
        password: "password-password",
      }),
    /loginName is too long/,
  );
  assert.throws(
    () =>
      createSyncLogin({
        userId: user.userId,
        loginName: "private-sync-auth-limits",
        password: "x".repeat(257),
      }),
    /password must be between/,
  );
  assert.equal(
    loginSyncUser({
      loginName: "private-sync-auth-limits",
      password: "x".repeat(257),
      deviceId: "device-a",
    }),
    null,
  );
});

test("registerSyncUserWithInvite consumes an invite and creates a login", () => {
  const invite = createSyncInvite({
    label: "private-sync-auth-friend",
    maxUses: 1,
  });

  const registered = registerSyncUserWithInvite({
    loginName: "private-sync-auth-bob",
    displayName: "private-sync-auth-Bob",
    password: "password-password",
    inviteCode: invite.rawInviteCode,
    deviceId: "device-a",
    deviceName: "Laptop",
  });

  assert.equal(registered.user.displayName, "private-sync-auth-Bob");
  assert.equal(registered.rawToken.startsWith("lbst_"), true);
  assert.equal(registered.deviceId, "device-a");

  assert.equal(
    registerSyncUserWithInvite({
      loginName: "private-sync-auth-charlie",
      displayName: "private-sync-auth-Charlie",
      password: "password-password",
      inviteCode: invite.rawInviteCode,
      deviceId: "device-b",
    }),
    null,
  );
});

test("registerSyncUserWithInvite rejects expired invites", () => {
  const invite = createSyncInvite({
    label: "private-sync-auth-expired",
    maxUses: 1,
    expiresAt: "2000-01-01T00:00:00.000Z",
  });

  const registered = registerSyncUserWithInvite({
    loginName: "private-sync-auth-expired-user",
    displayName: "private-sync-auth-Expired",
    password: "password-password",
    inviteCode: invite.rawInviteCode,
    deviceId: "device-a",
  });

  assert.equal(registered, null);
});
