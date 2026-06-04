import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { runSyncUserCommand } from "../src/scripts/sync-user.js";
import { authenticateBearerToken } from "../src/services/syncTokenService.js";

function cleanupSyncFixtures() {
  sqlite.exec(`
    DELETE FROM sync_invites WHERE label LIKE 'private-sync-admin-%';
    DELETE FROM sync_users WHERE display_name LIKE 'private-sync-admin-%';
  `);
}

test.beforeEach(() => {
  initDb();
  cleanupSyncFixtures();
});

test.afterEach(() => {
  cleanupSyncFixtures();
});

test("sync-user command creates users, tokens, and revokes tokens", () => {
  const userResult = runSyncUserCommand(["create-user", "--name", "private-sync-admin-Alice"]);
  assert.equal(userResult.user.displayName, "private-sync-admin-Alice");

  const tokenResult = runSyncUserCommand([
    "create-token",
    "--user-id",
    String(userResult.user.userId),
    "--label",
    "phone",
  ]);
  assert.equal(tokenResult.rawToken.startsWith("lbst_"), true);
  assert.equal(authenticateBearerToken(`Bearer ${tokenResult.rawToken}`).user.userId, userResult.user.userId);

  const revokeResult = runSyncUserCommand([
    "revoke-token",
    "--token-id",
    String(tokenResult.tokenId),
  ]);
  assert.equal(revokeResult.revokedTokenId, tokenResult.tokenId);
  assert.equal(authenticateBearerToken(`Bearer ${tokenResult.rawToken}`), null);
});

test("sync-user command creates invites for self-service registration", () => {
  const inviteResult = runSyncUserCommand([
    "create-invite",
    "--label",
    "private-sync-admin-friend",
    "--max-uses",
    "2",
    "--expires-at",
    "2099-01-01T00:00:00.000Z",
  ]);

  assert.equal(inviteResult.rawInviteCode.startsWith("lbsi_"), true);
  assert.equal(inviteResult.inviteId > 0, true);

  const row = sqlite
    .prepare("SELECT invite_hash, label, max_uses, expires_at FROM sync_invites WHERE invite_id = ?")
    .get(inviteResult.inviteId);
  assert.equal(row.label, "private-sync-admin-friend");
  assert.equal(row.max_uses, 2);
  assert.equal(row.expires_at, "2099-01-01T00:00:00.000Z");
  assert.notEqual(row.invite_hash, inviteResult.rawInviteCode);
});
