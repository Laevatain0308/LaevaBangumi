import { sqlite } from "../db/index.js";

const MAX_EVENTS_PER_MERGE = 100;
const MAX_ID_LENGTH = 128;
const MAX_ENTITY_KEY_LENGTH = 256;
const MAX_DOMAIN_LENGTH = 32;
const MAX_OP_LENGTH = 64;
const MAX_PAYLOAD_JSON_BYTES = 32 * 1024;
const MAX_SAFE_TIMESTAMP_MS = 9_000_000_000_000_000;

export function syncVersion(updatedAtMs, eventId) {
  return `${Number(updatedAtMs).toString().padStart(16, "0")}|${eventId}`;
}

export function mergePrivateSyncEvents({ userId, events }) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("userId is required");
  }
  const acceptedEventIds = [];
  const ignoredDuplicateEventIds = [];
  const normalizedEvents = Array.isArray(events) ? events : [];
  if (normalizedEvents.length > MAX_EVENTS_PER_MERGE) {
    throw new Error(`Too many sync events; max ${MAX_EVENTS_PER_MERGE}`);
  }

  sqlite.transaction(() => {
    const acceptedEvents = [];
    for (const event of normalizedEvents) {
      const normalized = normalizeEvent(event);
      const inserted = insertEvent(userId, normalized);
      if (inserted) {
        acceptedEventIds.push(normalized.eventId);
        acceptedEvents.push(normalized);
      } else {
        ignoredDuplicateEventIds.push(normalized.eventId);
      }
    }

    acceptedEvents.sort((a, b) => a.version.localeCompare(b.version));
    for (const event of acceptedEvents) {
      applyEvent(userId, event);
    }
  })();

  return {
    acceptedEventIds,
    ignoredDuplicateEventIds,
    snapshot: buildPrivateSyncSnapshot(userId),
  };
}

export function buildPrivateSyncSnapshot(userId) {
  return {
    generatedAt: Date.now(),
    watch: buildWatchSnapshot(userId),
    collection: buildCollectionSnapshot(userId),
  };
}

export function clearPrivateSyncData({
  userId,
  watch = false,
  collection = false,
}) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("userId is required");
  }
  sqlite.transaction(() => {
    if (watch) {
      sqlite
        .prepare("DELETE FROM watch_progress WHERE user_id = ?")
        .run(userId);
      sqlite
        .prepare("DELETE FROM watch_history_items WHERE user_id = ?")
        .run(userId);
      sqlite
        .prepare("DELETE FROM watch_deleted_items WHERE user_id = ?")
        .run(userId);
      sqlite
        .prepare("DELETE FROM watch_clear_state WHERE user_id = ?")
        .run(userId);
    }
    if (collection) {
      sqlite
        .prepare("DELETE FROM collection_items WHERE user_id = ?")
        .run(userId);
      sqlite
        .prepare("DELETE FROM collection_deleted_items WHERE user_id = ?")
        .run(userId);
      sqlite
        .prepare("DELETE FROM collection_clear_state WHERE user_id = ?")
        .run(userId);
    }
  })();
  return buildPrivateSyncSnapshot(userId);
}

function normalizeEvent(event) {
  const eventId = stringValue(event?.eventId);
  const deviceId = stringValue(event?.deviceId);
  const seq = numberValue(event?.seq);
  const domain = stringValue(event?.domain);
  const op = stringValue(event?.op);
  const updatedAtMs = numberValue(event?.updatedAt ?? event?.updatedAtMs);
  const payload =
    event?.payload && typeof event.payload === "object" ? event.payload : {};
  if (
    !eventId ||
    !deviceId ||
    !withinLength(eventId, MAX_ID_LENGTH) ||
    !withinLength(deviceId, MAX_ID_LENGTH) ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    !domain ||
    !withinLength(domain, MAX_DOMAIN_LENGTH) ||
    !op ||
    !withinLength(op, MAX_OP_LENGTH) ||
    !Number.isFinite(updatedAtMs) ||
    updatedAtMs < 0 ||
    updatedAtMs > MAX_SAFE_TIMESTAMP_MS
  ) {
    throw new Error("Invalid sync event");
  }
  if (!["watch", "collection"].includes(domain)) {
    throw new Error(`Unknown sync event domain: ${domain}`);
  }
  const entityKey = event?.entityKey == null ? null : String(event.entityKey);
  if (!withinLength(entityKey, MAX_ENTITY_KEY_LENGTH)) {
    throw new Error("Invalid sync event");
  }
  const payloadJson = stringifyPayload(payload);
  return {
    eventId,
    deviceId,
    seq,
    domain,
    op,
    entityKey,
    bangumiId: event?.bangumiId == null ? null : numberValue(event.bangumiId),
    updatedAtMs,
    version: syncVersion(updatedAtMs, eventId),
    payload,
    payloadJson,
  };
}

function insertEvent(userId, event) {
  const result = sqlite
    .prepare(
      `
      INSERT OR IGNORE INTO sync_events (
        user_id, event_id, device_id, seq, domain, op, entity_key,
        bangumi_id, updated_at_ms, version, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      userId,
      event.eventId,
      event.deviceId,
      event.seq,
      event.domain,
      event.op,
      event.entityKey,
      event.bangumiId,
      event.updatedAtMs,
      event.version,
      event.payloadJson,
    );
  return result.changes > 0;
}

function applyEvent(userId, event) {
  if (event.domain === "watch") {
    applyWatchEvent(userId, event);
    return;
  }
  if (event.domain === "collection") {
    applyCollectionEvent(userId, event);
  }
}

function applyWatchEvent(userId, event) {
  switch (event.op) {
    case "watch.upsertProgress":
      applyWatchUpsert(userId, event);
      return;
    case "watch.deleteHistory":
      applyWatchDelete(userId, event);
      return;
    case "watch.clearAll":
      applyWatchClear(userId, event);
      return;
    default:
      throw new Error(`Unknown watch sync op: ${event.op}`);
  }
}

function applyWatchUpsert(userId, event) {
  const payload = event.payload;
  const entityKey = stringValue(payload.entityKey ?? event.entityKey);
  const adapterName = stringValue(payload.adapterName);
  const bangumiId = numberValue(payload.bangumiId ?? event.bangumiId);
  const episode = numberValue(payload.episode);
  const lastWatchEpisode = numberValue(payload.lastWatchEpisode ?? episode);
  const road = numberValue(payload.road);
  const progressMs = numberValue(payload.progressMs);
  const bangumiItem =
    payload.bangumiItem && typeof payload.bangumiItem === "object"
      ? payload.bangumiItem
      : null;
  if (
    !entityKey ||
    !withinLength(entityKey, MAX_ENTITY_KEY_LENGTH) ||
    !adapterName ||
    !Number.isFinite(bangumiId) ||
    !Number.isFinite(episode) ||
    !Number.isFinite(lastWatchEpisode) ||
    !Number.isFinite(road) ||
    !Number.isFinite(progressMs) ||
    !bangumiItem
  ) {
    throw new Error("Invalid watch.upsertProgress payload");
  }
  if (!isNewerThanWatchClear(userId, event.version)) {
    return;
  }
  const deleted = watchDeletedVersion(userId, entityKey);
  if (deleted && compareVersion(event.version, deleted) <= 0) {
    return;
  }

  const currentItem = sqlite
    .prepare(
      "SELECT item_version FROM watch_history_items WHERE user_id = ? AND entity_key = ?",
    )
    .get(userId, entityKey);
  if (
    !currentItem ||
    compareVersion(event.version, currentItem.item_version) >= 0
  ) {
    sqlite
      .prepare(
        `
        INSERT INTO watch_history_items (
          user_id, entity_key, bangumi_id, adapter_name, last_watch_episode,
          last_watch_time_ms, last_src, last_watch_episode_name,
          bangumi_item_json, item_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, entity_key) DO UPDATE SET
          bangumi_id = excluded.bangumi_id,
          adapter_name = excluded.adapter_name,
          last_watch_episode = excluded.last_watch_episode,
          last_watch_time_ms = excluded.last_watch_time_ms,
          last_src = excluded.last_src,
          last_watch_episode_name = excluded.last_watch_episode_name,
          bangumi_item_json = excluded.bangumi_item_json,
          item_version = excluded.item_version
      `,
      )
      .run(
        userId,
        entityKey,
        bangumiId,
        adapterName,
        lastWatchEpisode,
        Number.isFinite(numberValue(payload.lastWatchTime))
          ? numberValue(payload.lastWatchTime)
          : event.updatedAtMs,
        stringValue(payload.lastSrc) || "",
        stringValue(payload.lastWatchEpisodeName) || "",
        JSON.stringify(bangumiItem),
        event.version,
      );
  }

  const currentProgress = sqlite
    .prepare(
      "SELECT progress_version FROM watch_progress WHERE user_id = ? AND entity_key = ? AND episode = ?",
    )
    .get(userId, entityKey, episode);
  if (
    !currentProgress ||
    compareVersion(event.version, currentProgress.progress_version) >= 0
  ) {
    sqlite
      .prepare(
        `
        INSERT INTO watch_progress (
          user_id, entity_key, episode, road, progress_ms, progress_version
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, entity_key, episode) DO UPDATE SET
          road = excluded.road,
          progress_ms = excluded.progress_ms,
          progress_version = excluded.progress_version
      `,
      )
      .run(userId, entityKey, episode, road, progressMs, event.version);
  }

  sqlite
    .prepare(
      "DELETE FROM watch_deleted_items WHERE user_id = ? AND entity_key = ?",
    )
    .run(userId, entityKey);
}

function applyWatchDelete(userId, event) {
  const entityKey = stringValue(event.payload.entityKey ?? event.entityKey);
  if (!entityKey || !isNewerThanWatchClear(userId, event.version)) {
    return;
  }
  const currentItem = sqlite
    .prepare(
      "SELECT item_version FROM watch_history_items WHERE user_id = ? AND entity_key = ?",
    )
    .get(userId, entityKey);
  const deleted = watchDeletedVersion(userId, entityKey);
  const newerThanItem =
    !currentItem ||
    compareVersion(event.version, currentItem.item_version) >= 0;
  const newerThanDelete =
    !deleted || compareVersion(event.version, deleted) >= 0;
  if (!newerThanItem || !newerThanDelete) {
    return;
  }
  sqlite
    .prepare("DELETE FROM watch_progress WHERE user_id = ? AND entity_key = ?")
    .run(userId, entityKey);
  sqlite
    .prepare(
      "DELETE FROM watch_history_items WHERE user_id = ? AND entity_key = ?",
    )
    .run(userId, entityKey);
  sqlite
    .prepare(
      `
      INSERT INTO watch_deleted_items (user_id, entity_key, deleted_version)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, entity_key) DO UPDATE SET
        deleted_version = excluded.deleted_version
    `,
    )
    .run(userId, entityKey, event.version);
}

function applyWatchClear(userId, event) {
  const clearVersion = watchClearVersion(userId);
  if (clearVersion && compareVersion(event.version, clearVersion) <= 0) {
    return;
  }
  sqlite.prepare("DELETE FROM watch_progress WHERE user_id = ?").run(userId);
  sqlite
    .prepare("DELETE FROM watch_history_items WHERE user_id = ?")
    .run(userId);
  sqlite
    .prepare("DELETE FROM watch_deleted_items WHERE user_id = ?")
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO watch_clear_state (user_id, clear_version)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET clear_version = excluded.clear_version
    `,
    )
    .run(userId, event.version);
}

function applyCollectionEvent(userId, event) {
  switch (event.op) {
    case "collection.upsert":
      applyCollectionUpsert(userId, event);
      return;
    case "collection.delete":
      applyCollectionDelete(userId, event);
      return;
    case "collection.clearAll":
      applyCollectionClear(userId, event);
      return;
    default:
      throw new Error(`Unknown collection sync op: ${event.op}`);
  }
}

function applyCollectionUpsert(userId, event) {
  const payload = event.payload;
  const bangumiId = numberValue(payload.bangumiId ?? event.bangumiId);
  const type = numberValue(payload.type);
  const bangumiItem =
    payload.bangumiItem && typeof payload.bangumiItem === "object"
      ? payload.bangumiItem
      : null;
  if (
    !Number.isFinite(bangumiId) ||
    !Number.isInteger(type) ||
    type < 1 ||
    type > 5 ||
    !bangumiItem
  ) {
    throw new Error("Invalid collection.upsert payload");
  }
  if (!isNewerThanCollectionClear(userId, event.version)) {
    return;
  }
  const deleted = collectionDeletedVersion(userId, bangumiId);
  if (deleted && compareVersion(event.version, deleted) <= 0) {
    return;
  }
  const current = sqlite
    .prepare(
      "SELECT item_version FROM collection_items WHERE user_id = ? AND bangumi_id = ?",
    )
    .get(userId, bangumiId);
  if (!current || compareVersion(event.version, current.item_version) >= 0) {
    sqlite
      .prepare(
        `
        INSERT INTO collection_items (
          user_id, bangumi_id, type, collected_at_ms, updated_at_ms,
          bangumi_item_json, item_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, bangumi_id) DO UPDATE SET
          type = excluded.type,
          collected_at_ms = excluded.collected_at_ms,
          updated_at_ms = excluded.updated_at_ms,
          bangumi_item_json = excluded.bangumi_item_json,
          item_version = excluded.item_version
      `,
      )
      .run(
        userId,
        bangumiId,
        type,
        payload.collectedAt == null
          ? event.updatedAtMs
          : numberValue(payload.collectedAt),
        event.updatedAtMs,
        JSON.stringify(bangumiItem),
        event.version,
      );
  }
  sqlite
    .prepare(
      "DELETE FROM collection_deleted_items WHERE user_id = ? AND bangumi_id = ?",
    )
    .run(userId, bangumiId);
}

function applyCollectionDelete(userId, event) {
  const bangumiId = numberValue(event.payload.bangumiId ?? event.bangumiId);
  if (
    !Number.isFinite(bangumiId) ||
    !isNewerThanCollectionClear(userId, event.version)
  ) {
    return;
  }
  const current = sqlite
    .prepare(
      "SELECT item_version FROM collection_items WHERE user_id = ? AND bangumi_id = ?",
    )
    .get(userId, bangumiId);
  const deleted = collectionDeletedVersion(userId, bangumiId);
  const newerThanItem =
    !current || compareVersion(event.version, current.item_version) >= 0;
  const newerThanDelete =
    !deleted || compareVersion(event.version, deleted) >= 0;
  if (!newerThanItem || !newerThanDelete) {
    return;
  }
  sqlite
    .prepare(
      "DELETE FROM collection_items WHERE user_id = ? AND bangumi_id = ?",
    )
    .run(userId, bangumiId);
  sqlite
    .prepare(
      `
      INSERT INTO collection_deleted_items (user_id, bangumi_id, deleted_version)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, bangumi_id) DO UPDATE SET
        deleted_version = excluded.deleted_version
    `,
    )
    .run(userId, bangumiId, event.version);
}

function applyCollectionClear(userId, event) {
  const clearVersion = collectionClearVersion(userId);
  if (clearVersion && compareVersion(event.version, clearVersion) <= 0) {
    return;
  }
  sqlite.prepare("DELETE FROM collection_items WHERE user_id = ?").run(userId);
  sqlite
    .prepare("DELETE FROM collection_deleted_items WHERE user_id = ?")
    .run(userId);
  sqlite
    .prepare(
      `
      INSERT INTO collection_clear_state (user_id, clear_version)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET clear_version = excluded.clear_version
    `,
    )
    .run(userId, event.version);
}

function buildWatchSnapshot(userId) {
  const clearVersion = watchClearVersion(userId);
  const items = sqlite
    .prepare(
      `
      SELECT * FROM watch_history_items
      WHERE user_id = ?
      ORDER BY last_watch_time_ms DESC, entity_key ASC
    `,
    )
    .all(userId);
  const progressRows = sqlite
    .prepare(
      `
      SELECT * FROM watch_progress
      WHERE user_id = ?
      ORDER BY entity_key ASC, episode ASC
    `,
    )
    .all(userId);
  const progressByEntity = new Map();
  for (const row of progressRows) {
    const progress = progressByEntity.get(row.entity_key) || {};
    progress[String(row.episode)] = {
      episode: row.episode,
      road: row.road,
      progressMs: row.progress_ms,
      version: row.progress_version,
    };
    progressByEntity.set(row.entity_key, progress);
  }
  return {
    clearVersion: clearVersion ?? null,
    histories: items.map((row) => ({
      entityKey: row.entity_key,
      bangumiId: row.bangumi_id,
      adapterName: row.adapter_name,
      lastWatchEpisode: row.last_watch_episode,
      lastWatchTime: row.last_watch_time_ms,
      lastSrc: row.last_src ?? "",
      lastWatchEpisodeName: row.last_watch_episode_name ?? "",
      bangumiItem: JSON.parse(row.bangumi_item_json),
      itemVersion: row.item_version,
      progresses: progressByEntity.get(row.entity_key) || {},
    })),
  };
}

function buildCollectionSnapshot(userId) {
  const clearVersion = collectionClearVersion(userId);
  const rows = sqlite
    .prepare(
      `
      SELECT * FROM collection_items
      WHERE user_id = ?
      ORDER BY updated_at_ms DESC, bangumi_id ASC
    `,
    )
    .all(userId);
  return {
    clearVersion: clearVersion ?? null,
    items: rows.map((row) => ({
      bangumiId: row.bangumi_id,
      type: row.type,
      collectedAt: row.collected_at_ms,
      updatedAt: row.updated_at_ms,
      bangumiItem: JSON.parse(row.bangumi_item_json),
      itemVersion: row.item_version,
    })),
  };
}

function isNewerThanWatchClear(userId, version) {
  const clearVersion = watchClearVersion(userId);
  return !clearVersion || compareVersion(version, clearVersion) > 0;
}

function isNewerThanCollectionClear(userId, version) {
  const clearVersion = collectionClearVersion(userId);
  return !clearVersion || compareVersion(version, clearVersion) > 0;
}

function watchClearVersion(userId) {
  return (
    sqlite
      .prepare("SELECT clear_version FROM watch_clear_state WHERE user_id = ?")
      .get(userId)?.clear_version ?? null
  );
}

function collectionClearVersion(userId) {
  return (
    sqlite
      .prepare(
        "SELECT clear_version FROM collection_clear_state WHERE user_id = ?",
      )
      .get(userId)?.clear_version ?? null
  );
}

function watchDeletedVersion(userId, entityKey) {
  return (
    sqlite
      .prepare(
        "SELECT deleted_version FROM watch_deleted_items WHERE user_id = ? AND entity_key = ?",
      )
      .get(userId, entityKey)?.deleted_version ?? null
  );
}

function collectionDeletedVersion(userId, bangumiId) {
  return (
    sqlite
      .prepare(
        "SELECT deleted_version FROM collection_deleted_items WHERE user_id = ? AND bangumi_id = ?",
      )
      .get(userId, bangumiId)?.deleted_version ?? null
  );
}

function compareVersion(a, b) {
  return String(a).localeCompare(String(b));
}

function stringValue(value) {
  if (value == null) {
    return "";
  }
  return String(value);
}

function withinLength(value, maxLength) {
  if (value == null) {
    return true;
  }
  return String(value).length <= maxLength;
}

function stringifyPayload(payload) {
  const payloadJson = JSON.stringify(payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    throw new Error("Sync event payload is too large");
  }
  return payloadJson;
}

function numberValue(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return NaN;
}
