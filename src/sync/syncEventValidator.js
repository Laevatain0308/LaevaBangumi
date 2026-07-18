const MAX_EVENTS = 100;
const MAX_ID_LENGTH = 128;
const MAX_EPISODE_NAME_LENGTH = 256;
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const COMMON_KEYS = ["eventId", "deviceId", "seq", "domain", "op", "updatedAt", "payload"];
const ITEM_KEYS = [...COMMON_KEYS, "bangumiId"];
const EMPTY_PAYLOAD_KEYS = [];
const WATCH_PROGRESS_KEYS = [
  "episode",
  "lastWatchEpisode",
  "road",
  "progressMs",
  "lastWatchTime",
  "lastWatchEpisodeName",
];
const COLLECTION_UPSERT_KEYS = ["type", "collectedAt"];

export class SyncEventValidationError extends Error {
  constructor(message, { code = "invalid_sync_event" } = {}) {
    super(message);
    this.name = "SyncEventValidationError";
    this.code = code;
  }
}

function invalid(message, code = "invalid_sync_event") {
  return new SyncEventValidationError(message, { code });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowedKeys, label) {
  if (!isPlainObject(value)) throw invalid(`${label} must be an object`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalid(`${label}.${key} is not allowed`);
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) throw invalid(`${label}.${key} is required`);
  }
}

function boundedString(value, { label, min = 0, max }) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw invalid(`${label} has an invalid length`);
  }
  return value;
}

function safeInteger(value, { label, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${label} must be a safe integer between ${min} and ${max}`);
  }
  return value;
}

function positiveInteger(value, label) {
  return safeInteger(value, { label, min: 1 });
}

function emptyPayload(payload) {
  assertExactKeys(payload, EMPTY_PAYLOAD_KEYS, "payload");
  return {};
}

function watchProgressPayload(payload) {
  assertExactKeys(payload, WATCH_PROGRESS_KEYS, "payload");
  return {
    episode: positiveInteger(payload.episode, "payload.episode"),
    lastWatchEpisode: positiveInteger(payload.lastWatchEpisode, "payload.lastWatchEpisode"),
    road: safeInteger(payload.road, { label: "payload.road" }),
    progressMs: safeInteger(payload.progressMs, { label: "payload.progressMs" }),
    lastWatchTime: safeInteger(payload.lastWatchTime, { label: "payload.lastWatchTime" }),
    lastWatchEpisodeName: boundedString(payload.lastWatchEpisodeName, {
      label: "payload.lastWatchEpisodeName",
      max: MAX_EPISODE_NAME_LENGTH,
    }),
  };
}

function collectionUpsertPayload(payload) {
  assertExactKeys(payload, COLLECTION_UPSERT_KEYS, "payload");
  return {
    type: safeInteger(payload.type, { label: "payload.type", min: 1, max: 5 }),
    collectedAt: safeInteger(payload.collectedAt, { label: "payload.collectedAt" }),
  };
}

const OPERATIONS = {
  "watch.upsertProgress": {
    domain: "watch",
    item: true,
    normalizePayload: watchProgressPayload,
  },
  "watch.delete": {
    domain: "watch",
    item: true,
    normalizePayload: emptyPayload,
  },
  "watch.clear": {
    domain: "watch",
    item: false,
    normalizePayload: emptyPayload,
  },
  "collection.upsert": {
    domain: "collection",
    item: true,
    normalizePayload: collectionUpsertPayload,
  },
  "collection.delete": {
    domain: "collection",
    item: true,
    normalizePayload: emptyPayload,
  },
  "collection.clear": {
    domain: "collection",
    item: false,
    normalizePayload: emptyPayload,
  },
};

export function syncVersion(updatedAtMs, eventId) {
  return `${String(updatedAtMs).padStart(16, "0")}|${eventId}`;
}

export function compareSyncVersions(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function validateBatchContainer(events) {
  if (!Array.isArray(events)) throw invalid("events must be an array");
  if (events.length > MAX_EVENTS) {
    throw invalid(`events must contain at most ${MAX_EVENTS} items`);
  }
  return events;
}

export function normalizeEventIdentity(event, { expectedDeviceId }) {
  if (!isPlainObject(event)) throw invalid("event must be an object");
  const eventId = boundedString(event.eventId, {
    label: "eventId",
    min: 1,
    max: MAX_ID_LENGTH,
  });
  const deviceId = boundedString(event.deviceId, {
    label: "deviceId",
    min: 1,
    max: MAX_ID_LENGTH,
  });
  if (deviceId !== expectedDeviceId) {
    throw invalid("event device does not match the authenticated device", "device_mismatch");
  }
  return { eventId, deviceId };
}

export function normalizeNewEvent(event, { expectedDeviceId, receivedAtMs }) {
  const identity = normalizeEventIdentity(event, { expectedDeviceId });
  const operation = typeof event.op === "string" ? OPERATIONS[event.op] : null;
  if (!operation) throw invalid("op is not supported");
  assertExactKeys(event, operation.item ? ITEM_KEYS : COMMON_KEYS, "event");
  if (event.domain !== operation.domain) throw invalid("domain does not match op");

  const seq = safeInteger(event.seq, { label: "seq" });
  const updatedAtMs = safeInteger(event.updatedAt, { label: "updatedAt" });
  const received = safeInteger(receivedAtMs, { label: "receivedAtMs" });
  if (Math.abs(updatedAtMs - received) > MAX_CLOCK_SKEW_MS) {
    throw invalid("updatedAt differs from server time by more than 24 hours", "clock_skew");
  }

  return {
    ...identity,
    seq,
    domain: operation.domain,
    operation: event.op,
    bangumiId: operation.item ? positiveInteger(event.bangumiId, "bangumiId") : null,
    updatedAtMs,
    receivedAtMs: received,
    version: syncVersion(updatedAtMs, identity.eventId),
    payload: operation.normalizePayload(event.payload),
  };
}
