import { log, error } from "../lib/logger.js";

const DEFAULT_DELAY_MS = 500;
const RETRY_DELAYS_MS = Object.freeze([10_000, 30_000, 60_000, 180_000, 300_000]);
const pending = [];
const queuedKeys = new Set();
let handler = null;
let running = false;
let wakeTimer = null;

function schedule() {
  if (running) return;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(runNext, 0);
}

async function runNext() {
  if (running) return;
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  running = true;
  let waiting = false;
  try {
    while (pending.length > 0) {
      pending.sort((left, right) => left.runAt - right.runAt);
      const job = pending[0];
      const waitMs = job.runAt - Date.now();
      if (waitMs > 0) {
        waiting = true;
        wakeTimer = setTimeout(runNext, waitMs);
        return;
      }
      pending.shift();
      if (!handler) {
        queuedKeys.delete(job.key);
        error("bangumi-search", "no search handler", { key: job.key });
        continue;
      }
      try {
        await handler(job.keyword);
        queuedKeys.delete(job.key);
        log("bangumi-search", "search completed", { keyword: job.keyword });
      } catch (cause) {
        job.attempts += 1;
        if (job.attempts > RETRY_DELAYS_MS.length) {
          queuedKeys.delete(job.key);
          error("bangumi-search", "search failed permanently", {
            keyword: job.keyword,
            message: cause.message ?? String(cause),
          });
          continue;
        }
        job.runAt = Date.now() + RETRY_DELAYS_MS[job.attempts - 1];
        pending.push(job);
        error("bangumi-search", "search retry scheduled", {
          keyword: job.keyword,
          attempt: job.attempts,
          message: cause.message ?? String(cause),
        });
      }
    }
  } finally {
    running = false;
    if (!waiting && pending.length > 0) schedule();
  }
}

export function enqueueSearch(keyword) {
  const normalized = String(keyword || "").trim();
  if (!normalized) return false;
  const key = `bangumi-search:${normalized}`;
  if (queuedKeys.has(key)) return false;
  queuedKeys.add(key);
  pending.push({
    keyword: normalized,
    key,
    attempts: 0,
    runAt: Date.now() + DEFAULT_DELAY_MS,
  });
  schedule();
  return true;
}

export function onSearchFlush(callback) {
  if (typeof callback !== "function") throw new TypeError("search queue handler must be a function");
  handler = callback;
}

export function searchQueueStats() {
  return { pending: pending.length, running, registered: handler != null };
}
