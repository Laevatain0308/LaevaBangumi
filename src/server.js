import express from "express";
import * as animeService from "./services/anime.js";
import { enqueueSearch } from "./services/queue.js";
import { log, error } from "./lib/logger.js";
import { envelope } from "./dto/apiEnvelope.js";
import { errorEnvelope, serverErrorEnvelope } from "./dto/errorDto.js";
import { createPrivateSyncRouter } from "./routes/privateSyncRoutes.js";

function ts() {
  return new Date().toISOString();
}

export function createServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/sync", createPrivateSyncRouter());

  // ── /api/calendar ──────────────────────────────────────
  app.get("/api/calendar", async (_req, res) => {
    try {
      log("api", "calendar requested");
      const result = await animeService.getCalendarView();
      res.json(envelope(result.data, { updatedAt: ts(), meta: { freshness: result.freshness } }));
    } catch (err) {
      error("api", "/api/calendar error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/updates ───────────────────────────────────────
  app.get("/api/updates", async (req, res) => {
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 7, 30));
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 60, 120));
    const today = typeof req.query.today === "string" ? req.query.today : null;
    try {
      log("api", "updates requested", { days, limit, today });
      const result = await animeService.getUpdates({ days, limit, today });
      res.json(envelope(result.data, {
        updatedAt: ts(),
        meta: { freshness: result.freshness, total: result.data.length, days },
      }));
    } catch (err) {
      error("api", "/api/updates error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/search ────────────────────────────────────────
  app.get("/api/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const tag = typeof req.query.tag === "string" ? req.query.tag.trim() : "";
    if (q && tag) {
      return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: "q 和 tag 不能同时使用", errorCode: "invalid_query", meta: { total: 0 } }));
    }
    if (!tag && (!q || q.length < 2)) {
      return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: "关键词至少需要 2 个字符", errorCode: "invalid_query", meta: { total: 0 } }));
    }
    try {
      log("api", "search requested", tag ? { tag } : { q });
      const result = tag ? await animeService.searchAnimeByTag(tag) : await animeService.searchAnime(q);
      if (q) enqueueSearch(q);
      res.json(envelope(result.data, {
        updatedAt: ts(),
        meta: {
          freshness: result.freshness,
          total: result.data.length,
          query: q || null,
          tag: tag || null,
        },
      }));
    } catch (err) {
      error("api", "/api/search error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/detail ────────────────────────────────────────
  app.get("/api/detail", async (req, res) => {
    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: "缺少 id 参数", errorCode: "invalid_query" }));
    try {
      log("api", "detail requested", { id });
      const result = await animeService.getAnimeDetail(id);
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
      error("api", "/api/detail error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/play ──────────────────────────────────────────
  app.get("/api/play", async (req, res) => {
    const id = parseInt(req.query.id, 10);
    const ch = parseInt(req.query.ch, 10);
    const ep = parseInt(req.query.ep, 10);
    if (!id || !ch || !ep || ep < 1 || ch < 1) {
      return res.status(400).json(errorEnvelope(null, { updatedAt: ts(), message: "缺少 id / ch / ep 参数", errorCode: "invalid_query" }));
    }
    try {
      log("api", "play requested", { id, ch, ep });
      const result = await animeService.getPlayUrl(id, ch, ep);
      if (!result) return res.status(404).json(errorEnvelope(null, { updatedAt: ts(), message: "剧集不存在或无播放地址", errorCode: "episode_not_found" }));
      res.json(envelope(result, { updatedAt: ts(), meta: { freshness: "cache" } }));
    } catch (err) {
      error("api", "/api/play error", err);
      res.status(500).json(serverErrorEnvelope(null, err, { updatedAt: ts() }));
    }
  });

  // ── /api/heartbeat ─────────────────────────────────────
  const visitors = new Map();
  const HEARTBEAT_TTL = 5 * 60 * 1000;
  const heartbeatCleanup = setInterval(() => {
    const cutoff = Date.now() - HEARTBEAT_TTL;
    for (const [k, v] of visitors) {
      if (v.lastSeen < cutoff) visitors.delete(k);
    }
  }, 60_000);
  heartbeatCleanup.unref?.();

  app.get("/api/heartbeat", (req, res) => {
    const { visitorId, page } = req.query;
    if (visitorId) {
      visitors.set(visitorId, { page: page || '/', lastSeen: Date.now() });
    }
    res.json({ online: visitors.size });
  });

  // ── /api/health ────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  return app;
}
