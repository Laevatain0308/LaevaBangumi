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

test("sync-user command disables users and revokes active tokens", () => {
  const userResult = runSyncUserCommand([
    "create-user",
    "--name",
    "private-sync-admin-Disabled",
  ]);
  const activeToken = runSyncUserCommand([
    "create-token",
    "--user-id",
    String(userResult.user.userId),
    "--label",
    "active",
  ]);

  assert.equal(
    authenticateBearerToken(`Bearer ${activeToken.rawToken}`).user.userId,
    userResult.user.userId,
  );

  const disabled = runSyncUserCommand([
    "disable-user",
    "--user-id",
    String(userResult.user.userId),
  ]);

  assert.equal(disabled.disabledUserId, userResult.user.userId);
  assert.equal(disabled.revokedTokenCount, 1);
  assert.equal(authenticateBearerToken(`Bearer ${activeToken.rawToken}`), null);

  const row = sqlite
    .prepare("SELECT disabled_at FROM sync_users WHERE user_id = ?")
    .get(userResult.user.userId);
  assert.equal(typeof row.disabled_at, "string");
});

test("sync-user command deletes users and cascades private sync data", () => {
  const userResult = runSyncUserCommand([
    "create-user",
    "--name",
    "private-sync-admin-Deleted",
  ]);
  const userId = userResult.user.userId;
  runSyncUserCommand([
    "create-token",
    "--user-id",
    String(userId),
    "--label",
    "deleted",
  ]);
  seedSyncData(userId);

  const deleted = runSyncUserCommand([
    "delete-user",
    "--user-id",
    String(userId),
  ]);

  assert.equal(deleted.deletedUserId, userId);
  assert.equal(deleted.deleted, true);

  for (const table of [
    "sync_users",
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
    const row = sqlite
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`)
      .get(userId);
    assert.equal(row.count, 0, `${table} should be empty for deleted user`);
  }
});

function seedSyncData(userId) {
  sqlite
    .prepare(
      `
      INSERT INTO sync_devices (
        user_id, device_id, device_name, platform, app_version
      ) VALUES (?, 'device-a', 'Phone', 'ios', '1.0.0')
    `,
    )
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO sync_events (
        user_id, event_id, device_id, seq, domain, op, entity_key, bangumi_id,
        updated_at_ms, version, payload_json
      ) VALUES (?, 'device-a:1', 'device-a', 1, 'watch', 'watch.upsertProgress',
        'LaevaBangumi1', 1, 1000, '0000001000:device-a:000001',
        '{"entityKey":"LaevaBangumi1"}')
    `,
    )
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO watch_history_items (
        user_id, entity_key, bangumi_id, adapter_name, last_watch_episode,
        last_watch_time_ms, last_src, last_watch_episode_name,
        bangumi_item_json, item_version
      ) VALUES (?, 'LaevaBangumi1', 1, 'LaevaBangumi', 1, 1000,
        'https://example.invalid/1', 'EP1', '{"id":1}',
        '0000001000:device-a:000001')
    `,
    )
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO watch_progress (
        user_id, entity_key, episode, road, progress_ms, progress_version
      ) VALUES (?, 'LaevaBangumi1', 1, 0, 12000,
        '0000001000:device-a:000001')
    `,
    )
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO watch_deleted_items (user_id, entity_key, deleted_version)
      VALUES (?, 'LaevaBangumi2', '0000001000:device-a:000002')
    `,
    )
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO watch_clear_state (user_id, clear_version)
      VALUES (?, '0000001000:device-a:000003')
    `,
    )
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO collection_items (
        user_id, bangumi_id, type, collected_at_ms, updated_at_ms,
        bangumi_item_json, item_version
      ) VALUES (?, 1, 1, 900, 1000, '{"id":1}',
        '0000001000:device-a:000001')
    `,
    )
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO collection_deleted_items (
        user_id, bangumi_id, deleted_version
      ) VALUES (?, 2, '0000001000:device-a:000002')
    `,
    )
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO collection_clear_state (user_id, clear_version)
      VALUES (?, '0000001000:device-a:000003')
    `,
    )
    .run(userId);
}
