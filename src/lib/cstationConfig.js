import { readFileSync } from "node:fs";

const CONFIG_PATH = new URL("../../config/cstations.json", import.meta.url).pathname;

let cachedConfig = null;

function readConfig() {
  if (cachedConfig) return cachedConfig;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  if (sources.length === 0) throw new Error("config/cstations.json requires at least one source");

  cachedConfig = {
    sources: sources.map(normalizeSource),
  };
  return cachedConfig;
}

function normalizeSource(source) {
  if (!source?.key) throw new Error("cstation source requires key");
  if (!source?.apiEndpoint) throw new Error(`cstation source ${source.key} requires apiEndpoint`);
  return {
    key: String(source.key),
    name: source.name || source.key,
    enabled: source.enabled !== false,
    apiEndpoint: String(source.apiEndpoint),
    priority: Number(source.priority) || 100,
    mediaFlag: source.mediaFlag || "ffm3u8",
    timeoutMs: Number(source.timeoutMs) || 15000,
    catalogTimeoutMs: Number(source.catalogTimeoutMs) || 20000,
    categories: (Array.isArray(source.categories) ? source.categories : []).map((category) => ({
      tid: String(category.tid),
      name: category.name || String(category.tid),
      enabled: category.enabled !== false,
    })).filter((category) => category.tid),
  };
}

export function getCstationConfig() {
  return readConfig();
}

export function getEnabledSources() {
  return readConfig().sources.filter((source) => source.enabled);
}

export function getSourceConfig(sourceKey) {
  if (!sourceKey) throw new Error("source key is required");
  const source = readConfig().sources.find((item) => item.key === sourceKey);
  if (!source) throw new Error(`unknown cstation source: ${sourceKey}`);
  return source;
}

export function getCategoryConfigs(sourceKey) {
  return getSourceConfig(sourceKey).categories.filter((category) => category.enabled);
}

export function getCategoryIds(sourceKey) {
  return getCategoryConfigs(sourceKey).map((category) => category.tid);
}
