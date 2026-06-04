import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { sqlite } from "../db/index.js";

const TOKEN_PREFIX = "lbst_";
const INVITE_PREFIX = "lbsi_";
const PASSWORD_HASH_PREFIX = "scrypt";
const PASSWORD_HASH_BYTES = 64;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const MAX_LOGIN_NAME_LENGTH = 64;

export function hashSyncToken(rawToken) {
  return createHash("sha256").update(String(rawToken), "utf8").digest("hex");
}

export function hashSyncInvite(rawInviteCode) {
  return hashSyncToken(rawInviteCode);
}

export function createSyncUser(displayName) {
  const normalizedName = String(displayName || "").trim();
  if (!normalizedName) {
    throw new Error("displayName is required");
  }
  const result = sqlite
    .prepare("INSERT INTO sync_users (display_name) VALUES (?)")
    .run(normalizedName);
  return {
    userId: Number(result.lastInsertRowid),
    displayName: normalizedName,
  };
}

export function createSyncInvite({
  label = null,
  maxUses = 1,
  expiresAt = null,
} = {}) {
  if (!Number.isInteger(maxUses) || maxUses <= 0) {
    throw new Error("maxUses must be a positive integer");
  }
  const normalizedExpiresAt = normalizeExpiresAt(expiresAt);
  const rawInviteCode = `${INVITE_PREFIX}${randomBytes(24).toString("base64url")}`;
  const inviteHash = hashSyncInvite(rawInviteCode);
  const result = sqlite
    .prepare(
      `
      INSERT INTO sync_invites (invite_hash, label, max_uses, expires_at)
      VALUES (?, ?, ?, ?)
    `,
    )
    .run(inviteHash, label, maxUses, normalizedExpiresAt);
  return {
    inviteId: Number(result.lastInsertRowid),
    rawInviteCode,
  };
}

export function createSyncLogin({ userId, loginName, password }) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("userId is required");
  }
  const normalizedLoginName = normalizeLoginName(loginName);
  if (!normalizedLoginName) {
    throw new Error("loginName is required");
  }
  if (normalizedLoginName.length > MAX_LOGIN_NAME_LENGTH) {
    throw new Error("loginName is too long");
  }
  assertValidPassword(password);
  sqlite
    .prepare(
      `
      INSERT INTO sync_credentials (user_id, login_name, password_hash)
      VALUES (?, ?, ?)
    `,
    )
    .run(userId, normalizedLoginName, hashPassword(password));
  return {
    userId,
    loginName: normalizedLoginName,
  };
}

export function createSyncToken({ userId, label = null }) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("userId is required");
  }
  const rawToken = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashSyncToken(rawToken);
  const result = sqlite
    .prepare(
      `
      INSERT INTO sync_tokens (user_id, token_hash, label)
      VALUES (?, ?, ?)
    `,
    )
    .run(userId, tokenHash, label);
  return {
    tokenId: Number(result.lastInsertRowid),
    rawToken,
  };
}

export function loginSyncUser({
  loginName,
  password,
  deviceId,
  deviceName = null,
  platform = null,
  appVersion = null,
}) {
  const normalizedLoginName = normalizeLoginName(loginName);
  if (
    !normalizedLoginName ||
    normalizedLoginName.length > MAX_LOGIN_NAME_LENGTH ||
    !isPasswordShapeValid(password)
  ) {
    return null;
  }
  const credential = sqlite
    .prepare(
      `
      SELECT
        c.user_id,
        c.password_hash,
        u.display_name,
        u.disabled_at
      FROM sync_credentials c
      JOIN sync_users u ON u.user_id = c.user_id
      WHERE c.login_name = ?
    `,
    )
    .get(normalizedLoginName);
  if (!credential || credential.disabled_at != null) {
    return null;
  }
  if (!verifyPassword(password, credential.password_hash)) {
    return null;
  }

  return createLoginResult({
    user: {
      userId: credential.user_id,
      displayName: credential.display_name,
    },
    deviceId,
    deviceName,
    platform,
    appVersion,
  });
}

export function registerSyncUserWithInvite({
  loginName,
  displayName,
  password,
  inviteCode,
  deviceId,
  deviceName = null,
  platform = null,
  appVersion = null,
}) {
  const normalizedLoginName = normalizeLoginName(loginName);
  const normalizedDisplayName = String(displayName || "").trim();
  if (
    !normalizedLoginName ||
    normalizedLoginName.length > MAX_LOGIN_NAME_LENGTH ||
    !normalizedDisplayName ||
    typeof inviteCode !== "string"
  ) {
    return null;
  }
  try {
    assertValidPassword(password);
  } catch {
    return null;
  }

  const register = sqlite.transaction(() => {
    const invite = getActiveInvite(inviteCode);
    if (!invite) {
      return null;
    }

    const user = createSyncUser(normalizedDisplayName);
    createSyncLogin({
      userId: user.userId,
      loginName: normalizedLoginName,
      password,
    });
    sqlite
      .prepare(
        `
        UPDATE sync_invites
        SET used_count = used_count + 1
        WHERE invite_id = ?
      `,
      )
      .run(invite.invite_id);

    return createLoginResult({
      user,
      deviceId,
      deviceName,
      platform,
      appVersion,
    });
  });

  try {
    return register();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return null;
    }
    throw err;
  }
}

export function revokeSyncToken(tokenId) {
  sqlite
    .prepare(
      "UPDATE sync_tokens SET revoked_at = datetime('now') WHERE token_id = ?",
    )
    .run(tokenId);
}

export function authenticateBearerToken(authorizationHeader) {
  const rawToken = parseBearerToken(authorizationHeader);
  if (!rawToken) {
    return null;
  }
  const tokenHash = hashSyncToken(rawToken);
  const rows = sqlite
    .prepare(
      `
      SELECT
        t.token_id,
        t.user_id,
        t.token_hash,
        t.label,
        t.revoked_at,
        u.display_name,
        u.disabled_at
      FROM sync_tokens t
      JOIN sync_users u ON u.user_id = t.user_id
      WHERE t.revoked_at IS NULL
        AND u.disabled_at IS NULL
    `,
    )
    .all();

  const matched = rows.find((row) => equalHashes(row.token_hash, tokenHash));
  if (!matched) {
    return null;
  }

  sqlite
    .prepare(
      "UPDATE sync_tokens SET last_used_at = datetime('now') WHERE token_id = ?",
    )
    .run(matched.token_id);

  return {
    user: {
      userId: matched.user_id,
      displayName: matched.display_name,
    },
    token: {
      tokenId: matched.token_id,
      label: matched.label,
    },
  };
}

export function upsertSyncDevice({
  userId,
  deviceId,
  deviceName = null,
  platform = null,
  appVersion = null,
}) {
  const normalizedDeviceId = String(deviceId || "").trim();
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("userId is required");
  }
  if (!normalizedDeviceId) {
    throw new Error("deviceId is required");
  }
  sqlite
    .prepare(
      `
      INSERT INTO sync_devices (
        user_id, device_id, device_name, platform, app_version
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id) DO UPDATE SET
        device_name = excluded.device_name,
        platform = excluded.platform,
        app_version = excluded.app_version,
        last_seen_at = datetime('now')
    `,
    )
    .run(userId, normalizedDeviceId, deviceName, platform, appVersion);
  return normalizedDeviceId;
}

function parseBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") {
    return null;
  }
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function equalHashes(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function normalizeLoginName(loginName) {
  return String(loginName || "")
    .trim()
    .toLowerCase();
}

function assertValidPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new Error(
      `password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, PASSWORD_HASH_BYTES).toString(
    "base64url",
  );
  return `${PASSWORD_HASH_PREFIX}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || typeof storedHash !== "string") {
    return false;
  }
  const [prefix, salt, hash] = storedHash.split("$");
  if (prefix !== PASSWORD_HASH_PREFIX || !salt || !hash) {
    return false;
  }
  const candidate = scryptSync(password, salt, PASSWORD_HASH_BYTES);
  const stored = Buffer.from(hash, "base64url");
  return (
    candidate.length === stored.length && timingSafeEqual(candidate, stored)
  );
}

function getActiveInvite(inviteCode) {
  const inviteHash = hashSyncInvite(inviteCode);
  const invite = sqlite
    .prepare(
      `
      SELECT invite_id, expires_at
      FROM sync_invites
      WHERE invite_hash = ?
        AND disabled_at IS NULL
        AND used_count < max_uses
    `,
    )
    .get(inviteHash);
  if (!invite) {
    return null;
  }
  if (invite.expires_at && Date.parse(invite.expires_at) <= Date.now()) {
    return null;
  }
  return invite;
}

function createLoginResult({
  user,
  deviceId,
  deviceName,
  platform,
  appVersion,
}) {
  const normalizedDeviceId = upsertSyncDevice({
    userId: user.userId,
    deviceId,
    deviceName,
    platform,
    appVersion,
  });
  const token = createSyncToken({
    userId: user.userId,
    label: deviceName == null ? normalizedDeviceId : String(deviceName),
  });
  return {
    user,
    tokenId: token.tokenId,
    rawToken: token.rawToken,
    deviceId: normalizedDeviceId,
  };
}

function isUniqueConstraintError(err) {
  return (
    err &&
    typeof err.message === "string" &&
    err.message.includes("UNIQUE constraint failed")
  );
}

function isPasswordShapeValid(password) {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}

function normalizeExpiresAt(expiresAt) {
  if (expiresAt == null || expiresAt === "") {
    return null;
  }
  const raw = String(expiresAt);
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) {
    throw new Error("expiresAt must be a valid date");
  }
  return new Date(timestamp).toISOString();
}
