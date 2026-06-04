import express from "express";
import { envelope } from "../dto/apiEnvelope.js";
import { errorEnvelope, serverErrorEnvelope } from "../dto/errorDto.js";
import { sqlite } from "../db/index.js";
import {
  authenticateBearerToken,
  loginSyncUser,
  registerSyncUserWithInvite,
  upsertSyncDevice,
} from "../services/syncTokenService.js";
import {
  buildPrivateSyncSnapshot,
  mergePrivateSyncEvents,
} from "../services/privateSyncMergeService.js";

function ts() {
  return new Date().toISOString();
}

const MAX_LOGIN_NAME_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 256;
const MAX_INVITE_CODE_LENGTH = 128;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_DEVICE_LABEL_LENGTH = 128;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;
const authFailureBuckets = new Map();

export function clearPrivateSyncRateLimiter() {
  authFailureBuckets.clear();
}

export function createPrivateSyncRouter() {
  const router = express.Router();

  router.post("/register", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const loginName = String(body.loginName || "").trim();
    const displayName = String(body.displayName || "").trim();
    const password = typeof body.password === "string" ? body.password : "";
    const inviteCode = String(body.inviteCode || "").trim();
    const deviceId = String(body.deviceId || "").trim();
    if (!loginName || !displayName || !password || !inviteCode || !deviceId) {
      return invalidQuery(
        res,
        "loginName, displayName, password, inviteCode, and deviceId are required",
      );
    }
    if (
      !withinLength(loginName, MAX_LOGIN_NAME_LENGTH) ||
      !withinLength(displayName, MAX_DISPLAY_NAME_LENGTH) ||
      !withinLength(password, MAX_PASSWORD_LENGTH) ||
      !withinLength(inviteCode, MAX_INVITE_CODE_LENGTH) ||
      !withinLength(deviceId, MAX_DEVICE_ID_LENGTH) ||
      !withinLength(body.deviceName, MAX_DEVICE_LABEL_LENGTH) ||
      !withinLength(body.platform, MAX_DEVICE_LABEL_LENGTH) ||
      !withinLength(body.appVersion, MAX_DEVICE_LABEL_LENGTH)
    ) {
      return invalidQuery(res, "sync registration fields are too long");
    }

    const bucketKey = rateLimitKey(req, "register", inviteCode);
    if (isRateLimited(bucketKey)) {
      return rateLimited(res);
    }

    const result = registerSyncUserWithInvite({
      loginName,
      displayName,
      password,
      inviteCode,
      deviceId,
      deviceName: body.deviceName == null ? null : String(body.deviceName),
      platform: body.platform == null ? null : String(body.platform),
      appVersion: body.appVersion == null ? null : String(body.appVersion),
    });
    if (!result) {
      recordAuthFailure(bucketKey);
      return res.status(401).json(
        errorEnvelope(null, {
          updatedAt: ts(),
          message: "Invalid or expired sync invite",
          errorCode: "invalid_invite",
        }),
      );
    }
    clearAuthFailures(bucketKey);
    return res.json(
      envelope(authPayload(result), {
        updatedAt: ts(),
        meta: { freshness: "cache" },
      }),
    );
  });

  router.post("/login", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const loginName = String(body.loginName || "").trim();
    const password = typeof body.password === "string" ? body.password : "";
    const deviceId = String(body.deviceId || "").trim();
    if (!loginName || !password || !deviceId) {
      return invalidQuery(
        res,
        "loginName, password, and deviceId are required",
      );
    }
    if (
      !withinLength(loginName, MAX_LOGIN_NAME_LENGTH) ||
      !withinLength(password, MAX_PASSWORD_LENGTH) ||
      !withinLength(deviceId, MAX_DEVICE_ID_LENGTH) ||
      !withinLength(body.deviceName, MAX_DEVICE_LABEL_LENGTH) ||
      !withinLength(body.platform, MAX_DEVICE_LABEL_LENGTH) ||
      !withinLength(body.appVersion, MAX_DEVICE_LABEL_LENGTH)
    ) {
      return invalidQuery(res, "sync login fields are too long");
    }

    const bucketKey = rateLimitKey(req, "login", loginName.toLowerCase());
    if (isRateLimited(bucketKey)) {
      return rateLimited(res);
    }

    const result = loginSyncUser({
      loginName,
      password,
      deviceId,
      deviceName: body.deviceName == null ? null : String(body.deviceName),
      platform: body.platform == null ? null : String(body.platform),
      appVersion: body.appVersion == null ? null : String(body.appVersion),
    });
    if (!result) {
      recordAuthFailure(bucketKey);
      return res.status(401).json(
        errorEnvelope(null, {
          updatedAt: ts(),
          message: "Invalid sync login credentials",
          errorCode: "invalid_credentials",
        }),
      );
    }
    clearAuthFailures(bucketKey);
    return res.json(
      envelope(authPayload(result), {
        updatedAt: ts(),
        meta: { freshness: "cache" },
      }),
    );
  });

  router.use((req, res, next) => {
    const auth = authenticateBearerToken(req.get("authorization"));
    if (!auth) {
      return res.status(401).json(
        errorEnvelope(null, {
          updatedAt: ts(),
          message: "Missing or invalid sync token",
          errorCode: "unauthorized",
        }),
      );
    }
    req.syncAuth = auth;
    next();
  });

  router.get("/status", (req, res) => {
    const userId = req.syncAuth.user.userId;
    res.json(
      envelope(
        {
          user: { displayName: req.syncAuth.user.displayName },
          devices: listDevices(userId),
          watchHistoryCount: countRows("watch_history_items", userId),
          collectionCount: countRows("collection_items", userId),
        },
        { updatedAt: ts(), meta: { freshness: "cache" } },
      ),
    );
  });

  router.post("/logout", (req, res) => {
    revokeCurrentToken(req.syncAuth.token.tokenId);
    res.json(
      envelope(
        { revoked: true },
        { updatedAt: ts(), meta: { freshness: "cache" } },
      ),
    );
  });

  router.post("/register-device", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const deviceId = String(body.deviceId || "").trim();
    if (!deviceId) {
      return res.status(400).json(
        errorEnvelope(null, {
          updatedAt: ts(),
          message: "deviceId is required",
          errorCode: "invalid_query",
        }),
      );
    }
    upsertSyncDevice({
      userId: req.syncAuth.user.userId,
      deviceId,
      deviceName: body.deviceName == null ? null : String(body.deviceName),
      platform: body.platform == null ? null : String(body.platform),
      appVersion: body.appVersion == null ? null : String(body.appVersion),
    });
    res.json(
      envelope(
        {
          user: { displayName: req.syncAuth.user.displayName },
          deviceId,
        },
        { updatedAt: ts(), meta: { freshness: "cache" } },
      ),
    );
  });

  router.post("/merge", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const deviceId = String(body.deviceId || "").trim();
    if (!deviceId) {
      return res.status(400).json(
        errorEnvelope(null, {
          updatedAt: ts(),
          message: "deviceId is required",
          errorCode: "invalid_query",
        }),
      );
    }
    try {
      upsertSyncDevice({
        userId: req.syncAuth.user.userId,
        deviceId,
        deviceName: body.deviceName == null ? null : String(body.deviceName),
        platform: body.platform == null ? null : String(body.platform),
        appVersion: body.appVersion == null ? null : String(body.appVersion),
      });
      const result = mergePrivateSyncEvents({
        userId: req.syncAuth.user.userId,
        events: Array.isArray(body.events) ? body.events : [],
      });
      res.json(
        envelope(result, { updatedAt: ts(), meta: { freshness: "cache" } }),
      );
    } catch (err) {
      res.status(400).json(
        errorEnvelope(null, {
          updatedAt: ts(),
          message: err.message,
          errorCode: "invalid_sync_event",
        }),
      );
    }
  });

  router.get("/snapshot", (req, res) => {
    try {
      res.json(
        envelope(
          { snapshot: buildPrivateSyncSnapshot(req.syncAuth.user.userId) },
          { updatedAt: ts(), meta: { freshness: "cache" } },
        ),
      );
    } catch (err) {
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  return router;
}

function revokeCurrentToken(tokenId) {
  sqlite
    .prepare(
      "UPDATE sync_tokens SET revoked_at = datetime('now') WHERE token_id = ?",
    )
    .run(tokenId);
}

function invalidQuery(res, message) {
  return res.status(400).json(
    errorEnvelope(null, {
      updatedAt: ts(),
      message,
      errorCode: "invalid_query",
    }),
  );
}

function rateLimited(res) {
  return res.status(429).json(
    errorEnvelope(null, {
      updatedAt: ts(),
      message: "Too many sync authentication attempts",
      errorCode: "rate_limited",
    }),
  );
}

function withinLength(value, maxLength) {
  if (value == null) {
    return true;
  }
  return String(value).length <= maxLength;
}

function rateLimitKey(req, action, identifier) {
  return `${req.ip || req.socket.remoteAddress || "unknown"}:${action}:${identifier}`;
}

function isRateLimited(key) {
  const bucket = authFailureBuckets.get(key);
  if (!bucket) {
    return false;
  }
  if (Date.now() - bucket.firstFailureAt > RATE_LIMIT_WINDOW_MS) {
    authFailureBuckets.delete(key);
    return false;
  }
  return bucket.count >= RATE_LIMIT_MAX_FAILURES;
}

function recordAuthFailure(key) {
  const now = Date.now();
  const bucket = authFailureBuckets.get(key);
  if (!bucket || now - bucket.firstFailureAt > RATE_LIMIT_WINDOW_MS) {
    authFailureBuckets.set(key, { count: 1, firstFailureAt: now });
    return;
  }
  bucket.count += 1;
}

function clearAuthFailures(key) {
  authFailureBuckets.delete(key);
}

function listDevices(userId) {
  return sqlite
    .prepare(
      `
      SELECT device_id, device_name, platform, app_version, first_seen_at, last_seen_at
      FROM sync_devices
      WHERE user_id = ?
      ORDER BY last_seen_at DESC, device_id ASC
    `,
    )
    .all(userId)
    .map((row) => ({
      deviceId: row.device_id,
      deviceName: row.device_name,
      platform: row.platform,
      appVersion: row.app_version,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }));
}

function countRows(table, userId) {
  return sqlite
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`)
    .get(userId).count;
}

function authPayload(result) {
  return {
    user: {
      displayName: result.user.displayName,
    },
    deviceId: result.deviceId,
    token: result.rawToken,
  };
}
