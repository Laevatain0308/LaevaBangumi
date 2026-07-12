import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ResourceSource,
  assertResourceSourceClass,
  assertResourceSourceInstance,
} from "./ResourceSource.js";

function manifestUrlFor(manifestPath) {
  if (manifestPath instanceof URL) return manifestPath;
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") {
    throw new TypeError("resource source manifestPath must be a path or URL");
  }
  return pathToFileURL(resolve(manifestPath));
}

function parseManifest(raw, manifestUrl) {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`invalid resource source manifest JSON: ${manifestUrl.href}`, { cause });
  }
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("resource source manifest must be an object");
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    throw new TypeError("resource source manifest requires a non-empty sources array");
  }
  if (Object.keys(manifest).length !== 1) {
    throw new TypeError("resource source manifest may only contain sources");
  }
  return manifest.sources.map((modulePath, index) => {
    if (typeof modulePath !== "string" || modulePath.trim() === "") {
      throw new TypeError(`resource source manifest sources[${index}] must be a non-empty module path`);
    }
    if (
      modulePath !== modulePath.trim()
      || (!modulePath.startsWith("./") && !modulePath.startsWith("../"))
    ) {
      throw new TypeError(`resource source manifest sources[${index}] must be a relative module path`);
    }
    return modulePath;
  });
}

export class ResourceSourceRegistry {
  #sources;

  constructor(sources) {
    if (!Array.isArray(sources)) throw new TypeError("ResourceSourceRegistry requires a source array");
    this.#sources = new Map();
    for (const source of sources) {
      if (!(source instanceof ResourceSource)) {
        throw new TypeError("ResourceSourceRegistry only accepts ResourceSource instances");
      }
      if (this.#sources.has(source.sourceKey)) {
        throw new Error(`duplicate resource source key: ${source.sourceKey}`);
      }
      this.#sources.set(source.sourceKey, source);
    }
    Object.freeze(this);
  }

  get(sourceKey) {
    const source = this.#sources.get(sourceKey);
    if (!source) throw new Error(`unknown resource source: ${sourceKey}`);
    return source;
  }

  list() {
    return Object.freeze([...this.#sources.values()]);
  }
}

export async function loadResourceSourceRegistry({ manifestPath, db, logger } = {}) {
  const manifestUrl = manifestUrlFor(manifestPath);
  const modulePaths = parseManifest(await readFile(manifestUrl, "utf8"), manifestUrl);
  const instances = [];

  for (const modulePath of modulePaths) {
    const moduleUrl = new URL(modulePath, manifestUrl);
    const loaded = await import(moduleUrl.href);
    const SourceClass = loaded.default;
    assertResourceSourceClass(SourceClass);
    const instance = new SourceClass({ db, logger });
    assertResourceSourceInstance(instance, SourceClass, { db, logger });
    instances.push(instance);
  }

  return new ResourceSourceRegistry(instances);
}
