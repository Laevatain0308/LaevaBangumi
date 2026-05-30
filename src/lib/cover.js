import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fetch } from "undici";
import { getDispatcher } from "./proxy.js";

const COVERS_DIR = new URL("../../data/covers/", import.meta.url).pathname;
const TIMEOUT = 15000;

export function coverPath(id) {
  return join(COVERS_DIR, `${id}.jpg`);
}

export function coverExists(id) {
  return existsSync(coverPath(id));
}

/** 下载封面到本地，返回 true/false */
export async function downloadCover(id, url) {
  if (!url) return false;
  if (coverExists(id)) return true;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);

  try {
    const dispatcher = getDispatcher();
    const fetchOptions = { signal: ac.signal };
    if (dispatcher) fetchOptions.dispatcher = dispatcher;
    const res = await fetch(url, fetchOptions);
    if (!res.ok) return false;

    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(COVERS_DIR, { recursive: true });
    await writeFile(coverPath(id), buf);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
