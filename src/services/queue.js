import { log, error } from "../lib/logger.js";

const DEFAULT_DELAY = 500;
const RETRY_DELAYS = [10_000, 30_000, 60_000, 180_000, 300_000];

const handlers = new Map();
const pending = [];
const queuedKeys = new Set();

let running = false;
let wakeTimer = null;

function keyOf(type, payload) {
  return `${type}:${payload?.key ?? JSON.stringify(payload ?? {})}`;
}

export function registerJob(type, handler) {
  handlers.set(type, handler);
}

export function enqueueJob(type, payload = {}, options = {}) {
  const key = options.key ?? keyOf(type, payload);
  if (queuedKeys.has(key)) return false;

  queuedKeys.add(key);
  pending.push({
    type,
    payload,
    key,
    attempts: 0,
    runAt: Date.now() + (options.delayMs ?? DEFAULT_DELAY),
  });
  log("queue", "job enqueued", { type, key, pending: pending.length });
  schedule();
  return true;
}

export function enqueueSearch(keyword) {
  const q = String(keyword || "").trim();
  if (!q) return false;
  return enqueueJob("bangumi-search", { keyword: q }, { key: `bangumi-search:${q}` });
}

export function onSearchFlush(fn) {
  registerJob("bangumi-search", ({ keyword }) => fn(keyword));
}

export function queueStats() {
  return { pending: pending.length, running, registered: [...handlers.keys()] };
}

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
      pending.sort((a, b) => a.runAt - b.runAt);
      const job = pending[0];
      const waitMs = job.runAt - Date.now();
      if (waitMs > 0) {
        waiting = true;
        wakeTimer = setTimeout(runNext, waitMs);
        return;
      }

      pending.shift();
      const handler = handlers.get(job.type);
      if (!handler) {
        queuedKeys.delete(job.key);
        error("queue", "no handler", { type: job.type, key: job.key });
        continue;
      }

      try {
        log("queue", "job started", { type: job.type, key: job.key, attempt: job.attempts + 1 });
        await handler(job.payload);
        queuedKeys.delete(job.key);
        log("queue", "job completed", { type: job.type, key: job.key, pending: pending.length });
      } catch (err) {
        job.attempts++;
        if (job.attempts > RETRY_DELAYS.length) {
          queuedKeys.delete(job.key);
          error("queue", "job failed permanently", { type: job.type, key: job.key, message: err.message });
          continue;
        }
        job.runAt = Date.now() + RETRY_DELAYS[job.attempts - 1];
        pending.push(job);
        error("queue", "job failed, retry scheduled", { type: job.type, key: job.key, attempt: job.attempts, message: err.message });
      }
    }
  } finally {
    running = false;
    if (!waiting && pending.length > 0) schedule();
  }
}
