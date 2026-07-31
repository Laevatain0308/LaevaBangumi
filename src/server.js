import express from "express";
import { log, error } from "./lib/logger.js";
import { envelope } from "./dto/apiEnvelope.js";
import { errorEnvelope, serverErrorEnvelope } from "./dto/errorDto.js";
import { createAccountRouter } from "./routes/accountRoutes.js";
import { createSyncRouter } from "./routes/syncRoutes.js";

function ts() {
  return new Date().toISOString();
}

function assertAnimeType(value) {
  const mediaType = value == null || value === "" ? "anime" : String(value).trim();
  if (mediaType !== "anime") {
    throw new Error(`unsupported media type: ${value}`);
  }
  return mediaType;
}

const emptyPublicApiRuntime = Object.freeze({
  async search() { return { data: [], freshness: "empty" }; },
  async calendar() { return { data: [], freshness: "empty" }; },
  async detail() { return null; },
  async play() { return null; },
  async updates() { return { data: [], freshness: "empty" }; },
});

function positiveInteger(value) {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;
}

export function createServer({
  publicApiRuntime = emptyPublicApiRuntime,
  accountSyncRuntime,
  enqueueRemoteSearch = () => {},
  logger = { log, error },
} = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  if (accountSyncRuntime) {
    app.use("/api/account", createAccountRouter({
      accountService: accountSyncRuntime.accountService,
      authenticate: accountSyncRuntime.authenticate,
      logger,
    }));
    app.use("/api/sync", createSyncRouter({
      authenticate: accountSyncRuntime.authenticate,
      syncMergeService: accountSyncRuntime.syncMergeService,
      syncSnapshotService: accountSyncRuntime.syncSnapshotService,
      logger,
    }));
  }

  // ── /api/calendar ──────────────────────────────────────
  app.get("/api/calendar", async (_req, res) => {
    try {
      logger.log?.("api", "calendar requested");
      const result = await publicApiRuntime.calendar();
      res.json(envelope(result.data, { updatedAt: ts(), meta: { freshness: result.freshness } }));
    } catch (err) {
      logger.error?.("api", "/api/calendar error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/updates ───────────────────────────────────────
  app.get("/api/updates", async (req, res) => {
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 7, 30));
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 60, 120));
    const today = typeof req.query.today === "string" ? req.query.today : null;
    let mediaType;
    try {
      mediaType = assertAnimeType(req.query.type);
    } catch (err) {
      return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: err.message, errorCode: "invalid_query", meta: { total: 0 } }));
    }
    try {
      logger.log?.("api", "updates requested", { days, limit, today, type: mediaType });
      const result = await publicApiRuntime.updates({ days, limit, today });
      res.json(envelope(result.data, {
        updatedAt: ts(),
        meta: { freshness: result.freshness, total: result.data.length, days, type: mediaType },
      }));
    } catch (err) {
      logger.error?.("api", "/api/updates error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/search ────────────────────────────────────────
  app.get("/api/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const tag = typeof req.query.tag === "string" ? req.query.tag.trim() : "";
    let mediaType;
    try {
      mediaType = assertAnimeType(req.query.type);
    } catch (err) {
      return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: err.message, errorCode: "invalid_query", meta: { total: 0 } }));
    }
    if (q && tag) {
      return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: "q 和 tag 不能同时使用", errorCode: "invalid_query", meta: { total: 0 } }));
    }
    if (!tag && (!q || q.length < 2)) {
      return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: "关键词至少需要 2 个字符", errorCode: "invalid_query", meta: { total: 0 } }));
    }
    try {
      logger.log?.("api", "search requested", tag ? { tag, type: mediaType } : { q, type: mediaType });
      const result = await publicApiRuntime.search({ query: q || null, tag: tag || null });
      if (q) enqueueRemoteSearch(q);
      res.json(envelope(result.data, {
        updatedAt: ts(),
        meta: {
          freshness: result.freshness,
          total: result.data.length,
          query: q || null,
          tag: tag || null,
          type: mediaType,
        },
      }));
    } catch (err) {
      logger.error?.("api", "/api/search error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/detail ────────────────────────────────────────
  app.get("/api/detail", async (req, res) => {
    const id = positiveInteger(req.query.id);
    if (id == null) {
      return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: "缺少 id 参数", errorCode: "invalid_query" }));
    }
    try {
      logger.log?.("api", "detail requested", { id });
      const result = await publicApiRuntime.detail(id);
      if (!result) return res.status(404).json(errorEnvelope(null, { updatedAt: ts(), message: "番剧不存在", errorCode: "subject_not_found" }));
      res.json(envelope(result.data, {
        updatedAt: ts(),
        meta: {
          freshness: result.freshness,
          resourceStatus: result.resourceStatus,
          resourceSources: result.resourceSources,
        },
      }));
    } catch (err) {
      logger.error?.("api", "/api/detail error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/play ──────────────────────────────────────────
  app.get("/api/play", async (req, res) => {
    const id = positiveInteger(req.query.id);
    const ch = positiveInteger(req.query.ch);
    const ep = positiveInteger(req.query.ep);
    if (id == null || ch == null || ep == null) {
      return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: "缺少 id / ch / ep 参数", errorCode: "invalid_query" }));
    }
    try {
      logger.log?.("api", "play requested", { id, ch, ep });
      const result = await publicApiRuntime.play({
        bangumiId: id,
        channelIndex: ch,
        episodeIndex: ep,
      });
      if (!result) return res.status(404).json(errorEnvelope(null, { updatedAt: ts(), message: "剧集不存在或无播放地址", errorCode: "episode_not_found" }));
      res.json(envelope(result, { updatedAt: ts(), meta: { freshness: "cache" } }));
    } catch (err) {
      logger.error?.("api", "/api/play error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/health ────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  return app;
}
