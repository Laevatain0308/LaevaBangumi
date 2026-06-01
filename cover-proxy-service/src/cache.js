import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

const DEFAULT_CACHE_DIR = "/var/cache/laeva-covers";

export function cacheRootFromEnv() {
  return process.env.COVER_CACHE_DIR || DEFAULT_CACHE_DIR;
}

export function safeCachePath(fileName, cacheRoot = cacheRootFromEnv()) {
  const safeName = String(fileName || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(safeName)) return null;
  const root = normalize(cacheRoot);
  const fullPath = normalize(join(root, safeName));
  if (!fullPath.startsWith(`${root}/`) && fullPath !== root) return null;
  return fullPath;
}

export async function getCachedFile(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0) return null;
    return { size: info.size, stream: createReadStream(filePath) };
  } catch {
    return null;
  }
}

export async function writeCachedFile(filePath, buffer) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, buffer);
  await rename(tempPath, filePath);
}
