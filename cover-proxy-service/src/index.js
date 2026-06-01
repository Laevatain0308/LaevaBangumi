import express from "express";
import { fetch, ProxyAgent } from "undici";
import { decodeCoverSource, verifyCoverSignature } from "./signature.js";
import { allowedHostsFromEnv, isAllowedCoverSource } from "./sourcePolicy.js";
import { cacheRootFromEnv, getCachedFile, safeCachePath, writeCachedFile } from "./cache.js";

const SECRET = process.env.COVER_PROXY_SECRET;
const MAX_BYTES = parseInt(process.env.COVER_MAX_BYTES, 10) || 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = parseInt(process.env.COVER_FETCH_TIMEOUT_MS, 10) || 15000;
const CACHE_CONTROL = process.env.COVER_CACHE_CONTROL || "public, max-age=2592000, immutable";
const FALLBACK_CONTENT_TYPE = "image/jpeg";

let dispatcher = null;

function getDispatcher() {
  const proxyUrl = process.env.COVER_UPSTREAM_PROXY_URL;
  if (!proxyUrl) return null;
  if (!dispatcher) dispatcher = new ProxyAgent(proxyUrl);
  return dispatcher;
}

function contentTypeFromResponse(res) {
  const contentType = res.headers.get("content-type");
  if (contentType?.startsWith("image/")) return contentType;
  return FALLBACK_CONTENT_TYPE;
}

function cacheHeaders(contentType, hit) {
  return {
    "Content-Type": contentType,
    "Cache-Control": CACHE_CONTROL,
    "X-Cover-Cache": hit ? "hit" : "miss",
  };
}

async function fetchCover(sourceUrl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const fetchOptions = { signal: ac.signal };
    const proxyDispatcher = getDispatcher();
    if (proxyDispatcher) fetchOptions.dispatcher = proxyDispatcher;

    const res = await fetch(sourceUrl, fetchOptions);
    if (!res.ok) {
      const err = new Error(`upstream returned ${res.status}`);
      err.statusCode = 502;
      throw err;
    }

    const contentType = contentTypeFromResponse(res);
    const length = parseInt(res.headers.get("content-length"), 10);
    if (Number.isFinite(length) && length > MAX_BYTES) {
      const err = new Error("upstream image too large");
      err.statusCode = 413;
      throw err;
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        const err = new Error("upstream image too large");
        err.statusCode = 413;
        throw err;
      }
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), contentType };
  } finally {
    clearTimeout(timer);
  }
}

function parseCoverRequest(req) {
  const match = String(req.params.file || "").match(/^(\d+)-[A-Za-z0-9]+\.jpg$/);
  if (!match) return null;
  return { id: parseInt(match[1], 10), fileName: req.params.file };
}

export function createApp() {
  const app = express();
  const allowedHosts = allowedHostsFromEnv();
  const cacheRoot = cacheRootFromEnv();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", cacheRoot, allowedHosts });
  });

  app.get("/cover/:file", async (req, res) => {
    if (!SECRET) return res.status(500).json({ error: "COVER_PROXY_SECRET is not configured" });

    const parsed = parseCoverRequest(req);
    const encodedUrl = req.query.u;
    const signature = req.query.sig;
    if (!parsed || typeof encodedUrl !== "string" || typeof signature !== "string") {
      return res.status(400).json({ error: "invalid cover request" });
    }

    if (!verifyCoverSignature({ id: parsed.id, encodedUrl, signature, secret: SECRET })) {
      return res.status(403).json({ error: "invalid cover signature" });
    }

    const sourceUrl = decodeCoverSource(encodedUrl);
    if (!isAllowedCoverSource(sourceUrl, allowedHosts)) {
      return res.status(403).json({ error: "cover source is not allowed" });
    }

    const filePath = safeCachePath(parsed.fileName, cacheRoot);
    if (!filePath) return res.status(400).json({ error: "invalid cache path" });

    const cached = await getCachedFile(filePath);
    if (cached) {
      res.set(cacheHeaders(FALLBACK_CONTENT_TYPE, true));
      return cached.stream.pipe(res);
    }

    try {
      const fetched = await fetchCover(sourceUrl);
      await writeCachedFile(filePath, fetched.buffer);
      res.set(cacheHeaders(fetched.contentType, false));
      return res.send(fetched.buffer);
    } catch (err) {
      const statusCode = err.statusCode || (err.name === "AbortError" ? 504 : 502);
      return res.status(statusCode).json({ error: "cover fetch failed" });
    }
  });

  return app;
}
