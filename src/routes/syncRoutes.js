import express from "express";
import { envelope } from "../dto/apiEnvelope.js";
import { errorEnvelope } from "../dto/errorDto.js";
import { SyncEventValidationError } from "../sync/syncEventValidator.js";

function ts() {
  return new Date().toISOString();
}

function validMergeBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const prototype = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(body).length === 1 && Object.hasOwn(body, "events");
}

function validationError(res, code = "invalid_sync_event") {
  const message = code === "device_mismatch"
    ? "Event device does not match the authenticated device"
    : code === "clock_skew"
      ? "Event time differs from server time by more than 24 hours"
      : "Invalid sync event";
  return res.status(400).json(errorEnvelope(null, {
    updatedAt: ts(),
    message,
    errorCode: code,
  }));
}

function serverError(res) {
  return res.status(500).json(errorEnvelope(null, {
    updatedAt: ts(),
    message: "Internal server error",
    errorCode: "server_error",
  }));
}

export function createSyncRouter({
  authenticate,
  syncMergeService,
  syncSnapshotService,
  logger = {},
}) {
  const router = express.Router();
  const writeError = logger.error ?? (() => {});

  router.post("/merge", authenticate, (req, res) => {
    if (!validMergeBody(req.body)) return validationError(res);
    try {
      const result = syncMergeService.merge({
        accountId: req.accountAuth.accountId,
        deviceId: req.accountAuth.device.deviceId,
        events: req.body.events,
      });
      return res.json(envelope(result, {
        updatedAt: ts(),
        meta: { freshness: "cache" },
      }));
    } catch (error) {
      if (error instanceof SyncEventValidationError) {
        return validationError(res, error.code);
      }
      writeError("sync-merge", "merge failed", {
        message: error.message ?? String(error),
      });
      return serverError(res);
    }
  });

  router.get("/snapshot", authenticate, (req, res) => {
    try {
      const result = syncSnapshotService.build(req.accountAuth.accountId);
      return res.json(envelope(result, {
        updatedAt: ts(),
        meta: { freshness: "cache" },
      }));
    } catch (error) {
      writeError("sync-snapshot", "snapshot failed", {
        message: error.message ?? String(error),
      });
      return serverError(res);
    }
  });

  return router;
}
