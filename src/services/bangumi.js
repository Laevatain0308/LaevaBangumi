import { fetch } from "undici";
import { getDispatcher } from "../lib/proxy.js";

const BG = "https://api.bgm.tv";
const TIMEOUT = 30000;
const UA = "laevatain/aslan (https://github.com/Laevatain0308/aslan)";

async function fetchJson(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { headers: extraHeaders, timeoutMs: _timeoutMs, ...restOpts } = opts;
    const fetchOpts = {
      ...restOpts,
      headers: { "User-Agent": UA, ...extraHeaders },
      signal: ac.signal,
      dispatcher: getDispatcher(),
    };
    const res = await fetch(url, fetchOpts);
    if (!res.ok) throw new Error(`Bangumi HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  } finally {
    clearTimeout(t);
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
