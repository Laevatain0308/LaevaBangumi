import { fetch } from "undici";
import { getDispatcher, getProxyStatus } from "../lib/proxy.js";

const BG = "https://api.bgm.tv";
const TIMEOUT = 30000;
const UA = "laevatain/aslan (https://github.com/Laevatain0308/aslan)";
const DEFAULT_RETRY_DELAYS_MS = [500, 1500];
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFetchError(err) {
  const cause = err.cause;
  if (cause) return `${cause.code || cause.name || "cause"}: ${cause.message || String(cause)}`;
  return err.message;
}

function isRetryableFetchError(err) {
  if (err?.name === "AbortError") return true;
  const code = err?.cause?.code || err?.code;
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true;
  const causeName = err?.cause?.name;
  return causeName === "ConnectTimeoutError" || causeName === "SocketError";
}

export async function fetchJson(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT;
  const retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { headers: extraHeaders, timeoutMs: _timeoutMs, retryDelaysMs: _retryDelaysMs, fetchImpl: _fetchImpl, ...restOpts } = opts;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const dispatcher = getDispatcher();
    const fetchOpts = {
      ...restOpts,
      headers: { "User-Agent": UA, ...extraHeaders },
      signal: ac.signal,
    };
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
    let res;
    try {
      try {
        res = await fetchImpl(url, fetchOpts);
      } catch (err) {
        if (isRetryableFetchError(err) && attempt < retryDelaysMs.length) {
          await sleep(retryDelaysMs[attempt]);
          continue;
        }
        const proxy = getProxyStatus();
        const detail = describeFetchError(err);
        throw new Error(`Bangumi fetch failed (${detail}; proxy=${proxy.enabled ? proxy.url : "disabled"}; after ${attempt + 1} attempts)`, { cause: err });
      }
      if (!res.ok) throw new Error(`Bangumi HTTP ${res.status}: ${res.statusText}`);
      return res.json();
    } finally {
      clearTimeout(t);
    }
  }
}

/** GET /calendar */
export async function getCalendar() {
  return fetchJson(`${BG}/calendar`);
}

/** POST /v0/search/subjects */
export async function searchSubjects(keyword, { sort = "rank", offset = 0 } = {}) {
  const url = `${BG}/v0/search/subjects?limit=20&offset=${offset}`;
  const body = {
    keyword,
    sort,
    filter: { type: [2], tag: [], rank: [">=0", "<=99999"], nsfw: false },
  };
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET /v0/subjects/{id} */
export async function getSubject(id, opts = {}) {
  return fetchJson(`${BG}/v0/subjects/${id}`, opts);
}

/** 从 infobox 提取别名 */
export function extractAliases(infobox) {
  if (!infobox || !Array.isArray(infobox)) return [];
  const aliasesItem = infobox.find((item) => item.key === "别名");
  if (!aliasesItem) return [];
  const val = aliasesItem.value;
  if (Array.isArray(val)) return val.map((v) => v.v).filter(Boolean);
  if (typeof val === "string") return [val];
  return [];
}

export function collectSearchNames(item) {
  const names = [];
  if (item.name_cn) names.push(item.name_cn);
  if (item.name) names.push(item.name);
  const aliases = extractAliases(item.infobox || []);
  for (const a of aliases) names.push(a);
  return [...new Set(names)];
}

export function extractYear(airDate) {
  if (!airDate) return null;
  const m = String(airDate).match(/(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}
