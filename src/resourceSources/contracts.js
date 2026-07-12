const RESOURCE_ITEM_KEYS = [
  "sourceKey",
  "sourceItemId",
  "title",
  "aliases",
  "year",
  "sourceUpdatedAt",
];
const RESOURCE_DETAIL_KEYS = [...RESOURCE_ITEM_KEYS, "episodes"];
const RESOURCE_EPISODE_KEYS = ["episodeIndex", "title", "videoUrl"];
const LOCAL_RESOURCE_ITEM_KEYS = [...RESOURCE_ITEM_KEYS, "firstSeenAt", "lastFetchedAt"];
const EXECUTION_SUMMARY_KEYS = [
  "sourceKey",
  "operation",
  "startedAt",
  "finishedAt",
  "fetchedItems",
  "savedItems",
  "fetchedEpisodes",
  "savedEpisodes",
  "failedItems",
];

function fail(label, message) {
  throw new TypeError(`${label} ${message}`);
}

function objectValue(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    fail(label, "must be an object");
  }
  return value;
}

function exactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(label, `must contain exactly: ${expectedKeys.join(", ")}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(label, "must be a non-empty string");
  }
  return value;
}

function nullableString(value, label) {
  if (value === null) return null;
  return requiredString(value, label);
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    fail(label, "must be a positive integer");
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    fail(label, "must be a non-negative integer");
  }
  return value;
}

function itemInput(value) {
  return {
    sourceKey: value.sourceKey,
    sourceItemId: value.sourceItemId,
    title: value.title,
    aliases: value.aliases,
    year: value.year,
    sourceUpdatedAt: value.sourceUpdatedAt,
  };
}

export function validateSourceItemId(value) {
  return requiredString(value, "sourceItemId");
}

export function validateEpisodeIndex(value) {
  return positiveInteger(value, "episodeIndex");
}

export function validateSearchKeyword(value) {
  return requiredString(value, "keyword");
}

export function validateNonNegativeCount(value, label = "count") {
  return nonNegativeInteger(value, label);
}

export function validateResourceItem(value, { sourceKey, label = "resource item" } = {}) {
  const item = objectValue(value, label);
  exactKeys(item, RESOURCE_ITEM_KEYS, label);
  const actualSourceKey = requiredString(item.sourceKey, `${label}.sourceKey`);
  if (sourceKey != null && actualSourceKey !== sourceKey) {
    fail(`${label}.sourceKey`, `must equal ${sourceKey}`);
  }
  if (!Array.isArray(item.aliases)) fail(`${label}.aliases`, "must be an array");
  const aliases = [...new Set(item.aliases.map((alias, index) => (
    requiredString(alias, `${label}.aliases[${index}]`).trim()
  )))];
  return {
    sourceKey: actualSourceKey,
    sourceItemId: validateSourceItemId(item.sourceItemId),
    title: requiredString(item.title, `${label}.title`),
    aliases,
    year: nullableString(item.year, `${label}.year`),
    sourceUpdatedAt: nullableString(item.sourceUpdatedAt, `${label}.sourceUpdatedAt`),
  };
}

export function validateResourceItems(value, options = {}) {
  if (!Array.isArray(value)) fail("resource items", "must be an array");
  return value.map((item, index) => validateResourceItem(item, {
    ...options,
    label: `resource items[${index}]`,
  }));
}

export function validateResourceEpisode(value, { label = "resource episode" } = {}) {
  const episode = objectValue(value, label);
  exactKeys(episode, RESOURCE_EPISODE_KEYS, label);
  return {
    episodeIndex: validateEpisodeIndex(episode.episodeIndex),
    title: requiredString(episode.title, `${label}.title`),
    videoUrl: requiredString(episode.videoUrl, `${label}.videoUrl`),
  };
}

export function validateResourceEpisodes(value) {
  if (!Array.isArray(value)) fail("resource episodes", "must be an array");
  return value.map((episode, index) => validateResourceEpisode(episode, {
    label: `resource episodes[${index}]`,
  }));
}

export function validateResourceDetail(value, { sourceKey, label = "resource detail" } = {}) {
  const detail = objectValue(value, label);
  exactKeys(detail, RESOURCE_DETAIL_KEYS, label);
  const normalizedItem = validateResourceItem(itemInput(detail), { sourceKey, label });
  const episodes = validateResourceEpisodes(detail.episodes);
  const indexes = new Set();
  for (const episode of episodes) {
    if (indexes.has(episode.episodeIndex)) {
      fail(label, `contains duplicate episodeIndex ${episode.episodeIndex}`);
    }
    indexes.add(episode.episodeIndex);
  }
  return { ...normalizedItem, episodes };
}

export function validateLocalResourceItem(value, { sourceKey, label = "local resource item" } = {}) {
  const item = objectValue(value, label);
  exactKeys(item, LOCAL_RESOURCE_ITEM_KEYS, label);
  return {
    ...validateResourceItem(itemInput(item), { sourceKey, label }),
    firstSeenAt: requiredString(item.firstSeenAt, `${label}.firstSeenAt`),
    lastFetchedAt: requiredString(item.lastFetchedAt, `${label}.lastFetchedAt`),
  };
}

export function validateLocalResourceItems(value, options = {}) {
  if (!Array.isArray(value)) fail("local resource items", "must be an array");
  return value.map((item, index) => validateLocalResourceItem(item, {
    ...options,
    label: `local resource items[${index}]`,
  }));
}

export function validateExecutionSummary(value, { sourceKey, operation } = {}) {
  const summary = objectValue(value, "execution summary");
  exactKeys(summary, EXECUTION_SUMMARY_KEYS, "execution summary");
  const actualSourceKey = requiredString(summary.sourceKey, "execution summary.sourceKey");
  if (actualSourceKey !== sourceKey) fail("execution summary.sourceKey", `must equal ${sourceKey}`);
  const actualOperation = requiredString(summary.operation, "execution summary.operation");
  if (actualOperation !== operation) fail("execution summary.operation", `must equal ${operation}`);
  return {
    sourceKey: actualSourceKey,
    operation: actualOperation,
    startedAt: requiredString(summary.startedAt, "execution summary.startedAt"),
    finishedAt: requiredString(summary.finishedAt, "execution summary.finishedAt"),
    fetchedItems: nonNegativeInteger(summary.fetchedItems, "execution summary.fetchedItems"),
    savedItems: nonNegativeInteger(summary.savedItems, "execution summary.savedItems"),
    fetchedEpisodes: nonNegativeInteger(summary.fetchedEpisodes, "execution summary.fetchedEpisodes"),
    savedEpisodes: nonNegativeInteger(summary.savedEpisodes, "execution summary.savedEpisodes"),
    failedItems: nonNegativeInteger(summary.failedItems, "execution summary.failedItems"),
  };
}
