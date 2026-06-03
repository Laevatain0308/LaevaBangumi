import * as ffzyClient from "./resourceSources/ffzyClient.js";

const sourceClients = new Map([
  ["ffzy", ffzyClient],
]);

function clientForSource(source) {
  const client = sourceClients.get(source);
  if (!client) throw new Error(`unknown resource source client: ${source}`);
  return client;
}

export function parseEpisodes(dl, { source = "ffzy", ...options } = {}) {
  return clientForSource(source).parseEpisodes(dl, options);
}

export function parseLastTime(value, { source = "ffzy" } = {}) {
  return clientForSource(source).parseLastTime(value);
}

export function sourceKeys({ source = "ffzy" } = {}) {
  return clientForSource(source).sourceKeys();
}

export async function searchAndParse(keyword, { source = "ffzy", ...options } = {}) {
  return clientForSource(source).searchAndParse(keyword, { source, ...options });
}

export async function fetchById(id, { source = "ffzy", ...options } = {}) {
  return clientForSource(source).fetchById(id, { source, ...options });
}

export async function fetchByIds(ids, { source = "ffzy", ...options } = {}) {
  return clientForSource(source).fetchByIds(ids, { source, ...options });
}

export async function fetchCatalog({ source = "ffzy", ...options } = {}) {
  return clientForSource(source).fetchCatalog({ source, ...options });
}

export async function fetchCatalogIncremental({ source = "ffzy", ...options } = {}) {
  return clientForSource(source).fetchCatalogIncremental({ source, ...options });
}
