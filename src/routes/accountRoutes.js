import express from "express";
import { envelope } from "../dto/apiEnvelope.js";
import { errorEnvelope } from "../dto/errorDto.js";
import { createAccountAuthMiddleware } from "./accountAuth.js";

const LOGIN_KEYS = new Set([
  "username",
  "password",
  "deviceId",
  "deviceName",
  "platform",
  "appVersion",
]);

function ts() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validString(value, min, max) {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function validOptionalDeviceField(value) {
  return value == null || validString(value, 0, 128);
}

function validLoginBody(body) {
  if (!isPlainObject(body)) return false;
  if (Object.keys(body).some((key) => !LOGIN_KEYS.has(key))) return false;
  return typeof body.username === "string"
    && validString(body.username.trim(), 1, 64)
    && validString(body.password, 8, 256)
    && validString(body.deviceId, 1, 128)
    && validOptionalDeviceField(body.deviceName)
    && validOptionalDeviceField(body.platform)
    && validOptionalDeviceField(body.appVersion);
}

function invalidQuery(res) {
  return res.status(400).json(errorEnvelope(null, {
    updatedAt: ts(),
    message: "Invalid account login fields",
    errorCode: "invalid_query",
  }));
}

function serverError(res) {
  return res.status(500).json(errorEnvelope(null, {
    updatedAt: ts(),
    message: "Internal server error",
    errorCode: "server_error",
  }));
}

export function createAccountRouter({
  accountService,
  authenticate = createAccountAuthMiddleware({ accountService }),
  logger = {},
}) {
  const router = express.Router();
  const writeError = logger.error ?? (() => {});

  router.post("/login", (req, res) => {
    if (!validLoginBody(req.body)) return invalidQuery(res);
    try {
      const result = accountService.login({
        username: req.body.username,
        password: req.body.password,
        deviceId: req.body.deviceId,
        deviceName: req.body.deviceName ?? null,
        platform: req.body.platform ?? null,
        appVersion: req.body.appVersion ?? null,
      });
      if (!result) {
        return res.status(401).json(errorEnvelope(null, {
          updatedAt: ts(),
          message: "Invalid username or password",
          errorCode: "invalid_credentials",
        }));
      }
      return res.json(envelope(result, {
        updatedAt: ts(),
        meta: { freshness: "cache" },
      }));
    } catch (error) {
      writeError("account-login", "login failed", {
        message: error.message ?? String(error),
      });
      return serverError(res);
    }
  });

  router.use(authenticate);

  router.get("/status", (req, res) => {
    try {
      return res.json(envelope(accountService.status(req.accountAuth), {
        updatedAt: ts(),
        meta: { freshness: "cache" },
      }));
    } catch (error) {
      writeError("account-status", "status failed", {
        message: error.message ?? String(error),
      });
      return serverError(res);
    }
  });

  router.post("/logout", (req, res) => {
    try {
      accountService.logout(req.accountAuth.tokenId);
      return res.json(envelope({ revoked: true }, {
        updatedAt: ts(),
        meta: { freshness: "cache" },
      }));
    } catch (error) {
      writeError("account-logout", "logout failed", {
        message: error.message ?? String(error),
      });
      return serverError(res);
    }
  });

  return router;
}
