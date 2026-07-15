function nowIso(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapAccount(row) {
  if (!row) return null;
  return {
    accountId: Number(row.account_id),
    username: row.username,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    passwordChangedAt: row.password_changed_at,
  };
}

function mapPublicAccount(row) {
  if (!row) return null;
  return {
    accountId: Number(row.account_id),
    username: row.username,
    createdAt: row.created_at,
    passwordChangedAt: row.password_changed_at,
  };
}

function mapDevice(row) {
  return {
    deviceId: row.device_id,
    deviceName: row.device_name,
    platform: row.platform,
    appVersion: row.app_version,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function createAccountRepository({ sqlite, clock = () => new Date() }) {
  const insertAccount = sqlite.prepare(`
    INSERT INTO accounts (username, password_hash, created_at, password_changed_at)
    VALUES (?, ?, ?, ?)
  `);
  const selectAccountByUsername = sqlite.prepare(`
    SELECT account_id, username, password_hash, created_at, password_changed_at
    FROM accounts
    WHERE username = ?
  `);
  const updatePassword = sqlite.prepare(`
    UPDATE accounts
    SET password_hash = ?, password_changed_at = ?
    WHERE username = ?
    RETURNING account_id, username, created_at, password_changed_at
  `);
  const revokeAccountTokens = sqlite.prepare(`
    UPDATE account_tokens
    SET revoked_at = ?
    WHERE account_id = ? AND revoked_at IS NULL
  `);
  const removeAccount = sqlite.prepare(`
    DELETE FROM accounts
    WHERE username = ?
    RETURNING account_id, username, created_at, password_changed_at
  `);
  const selectAccounts = sqlite.prepare(`
    SELECT
      a.username,
      a.created_at,
      a.password_changed_at,
      COUNT(d.device_id) AS device_count
    FROM accounts a
    LEFT JOIN account_devices d ON d.account_id = a.account_id
    GROUP BY a.account_id
    ORDER BY a.username ASC
  `);
  const upsertDevice = sqlite.prepare(`
    INSERT INTO account_devices (
      account_id, device_id, device_name, platform, app_version, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, device_id) DO UPDATE SET
      device_name = excluded.device_name,
      platform = excluded.platform,
      app_version = excluded.app_version,
      last_seen_at = excluded.last_seen_at
  `);
  const revokeDeviceToken = sqlite.prepare(`
    UPDATE account_tokens
    SET revoked_at = ?
    WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL
  `);
  const insertToken = sqlite.prepare(`
    INSERT INTO account_tokens (account_id, device_id, token_hash, created_at, last_used_at, revoked_at)
    VALUES (?, ?, ?, ?, NULL, NULL)
  `);
  const selectActiveToken = sqlite.prepare(`
    SELECT
      a.account_id,
      a.username,
      t.token_id,
      d.device_id,
      d.device_name,
      d.platform,
      d.app_version,
      d.first_seen_at,
      d.last_seen_at
    FROM account_tokens t
    JOIN accounts a ON a.account_id = t.account_id
    JOIN account_devices d
      ON d.account_id = t.account_id AND d.device_id = t.device_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL
  `);
  const updateTokenUse = sqlite.prepare(`
    UPDATE account_tokens
    SET last_used_at = ?
    WHERE token_id = ? AND revoked_at IS NULL
  `);
  const revokeTokenById = sqlite.prepare(`
    UPDATE account_tokens
    SET revoked_at = ?
    WHERE token_id = ? AND revoked_at IS NULL
  `);
  const selectDevices = sqlite.prepare(`
    SELECT device_id, device_name, platform, app_version, first_seen_at, last_seen_at
    FROM account_devices
    WHERE account_id = ?
    ORDER BY device_id ASC
  `);

  function transaction(callback) {
    return sqlite.transaction(callback)();
  }

  function createAccount({ username, passwordHash }) {
    const now = nowIso(clock);
    const result = insertAccount.run(username, passwordHash, now, now);
    return mapPublicAccount(selectAccountByUsername.get(username));
  }

  function findAccountByUsername(username) {
    return mapAccount(selectAccountByUsername.get(username));
  }

  function replacePasswordAndRevokeTokens({ username, passwordHash }) {
    const now = nowIso(clock);
    const account = mapPublicAccount(updatePassword.get(passwordHash, now, username));
    if (!account) return null;
    const result = revokeAccountTokens.run(now, account.accountId);
    return { account, revokedTokenCount: result.changes };
  }

  function deleteAccount(username) {
    return mapPublicAccount(removeAccount.get(username));
  }

  function listAccounts() {
    return selectAccounts.all().map((row) => ({
      username: row.username,
      createdAt: row.created_at,
      passwordChangedAt: row.password_changed_at,
      deviceCount: Number(row.device_count),
    }));
  }

  function rotateDeviceToken({ accountId, device, tokenHash }) {
    const now = nowIso(clock);
    upsertDevice.run(
      accountId,
      device.deviceId,
      device.deviceName,
      device.platform,
      device.appVersion,
      now,
      now,
    );
    revokeDeviceToken.run(now, accountId, device.deviceId);
    const result = insertToken.run(accountId, device.deviceId, tokenHash, now);
    return { tokenId: Number(result.lastInsertRowid) };
  }

  function findActiveToken(tokenHash) {
    const row = selectActiveToken.get(tokenHash);
    if (!row) return null;
    return {
      accountId: Number(row.account_id),
      username: row.username,
      tokenId: Number(row.token_id),
      device: mapDevice(row),
    };
  }

  function touchToken(tokenId) {
    return updateTokenUse.run(nowIso(clock), tokenId).changes > 0;
  }

  function revokeToken(tokenId) {
    return revokeTokenById.run(nowIso(clock), tokenId).changes > 0;
  }

  function listDevices(accountId) {
    return selectDevices.all(accountId).map(mapDevice);
  }

  return {
    transaction,
    createAccount,
    findAccountByUsername,
    replacePasswordAndRevokeTokens,
    deleteAccount,
    listAccounts,
    rotateDeviceToken,
    findActiveToken,
    touchToken,
    revokeToken,
    listDevices,
  };
}
