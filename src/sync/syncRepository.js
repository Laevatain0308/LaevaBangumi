import { compareSyncVersions } from "./syncEventValidator.js";

function nowIso(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function atLeast(left, right) {
  return compareSyncVersions(left, right) >= 0;
}

function laterThan(left, right) {
  return compareSyncVersions(left, right) > 0;
}

function mapWatchRecord(row) {
  return {
    bangumiId: Number(row.bangumi_id),
    lastWatchEpisode: Number(row.last_watch_episode),
    lastWatchTime: Number(row.last_watch_time_ms),
    lastWatchEpisodeName: row.last_watch_episode_name,
    recordVersion: row.record_version,
  };
}

function mapWatchProgress(row) {
  return {
    bangumiId: Number(row.bangumi_id),
    episode: Number(row.episode),
    road: Number(row.road),
    progressMs: Number(row.progress_ms),
    progressVersion: row.progress_version,
  };
}

function mapCollectionRecord(row) {
  return {
    bangumiId: Number(row.bangumi_id),
    type: Number(row.type),
    collectedAt: Number(row.collected_at_ms),
    updatedAt: Number(row.updated_at_ms),
    recordVersion: row.record_version,
  };
}

export function createSyncRepository({ sqlite, clock = () => new Date() }) {
  const selectEventIds = sqlite.prepare(`
    SELECT event_id FROM sync_events
    WHERE account_id = ? AND event_id IN (SELECT value FROM json_each(?))
  `);
  const insertLedger = sqlite.prepare(`
    INSERT INTO sync_events (
      account_id, event_id, device_id, seq, domain, operation, bangumi_id,
      updated_at_ms, version, payload_json, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectWatchRecord = sqlite.prepare(`
    SELECT record_version FROM watch_records WHERE account_id = ? AND bangumi_id = ?
  `);
  const upsertWatchRecord = sqlite.prepare(`
    INSERT INTO watch_records (
      account_id, bangumi_id, last_watch_episode, last_watch_time_ms,
      last_watch_episode_name, record_version
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, bangumi_id) DO UPDATE SET
      last_watch_episode = excluded.last_watch_episode,
      last_watch_time_ms = excluded.last_watch_time_ms,
      last_watch_episode_name = excluded.last_watch_episode_name,
      record_version = excluded.record_version
  `);
  const selectWatchProgress = sqlite.prepare(`
    SELECT progress_version FROM watch_progress
    WHERE account_id = ? AND bangumi_id = ? AND episode = ?
  `);
  const upsertWatchProgress = sqlite.prepare(`
    INSERT INTO watch_progress (
      account_id, bangumi_id, episode, road, progress_ms, progress_version
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, bangumi_id, episode) DO UPDATE SET
      road = excluded.road,
      progress_ms = excluded.progress_ms,
      progress_version = excluded.progress_version
  `);
  const selectWatchTombstone = sqlite.prepare(`
    SELECT deleted_version FROM watch_tombstones WHERE account_id = ? AND bangumi_id = ?
  `);
  const deleteWatchTombstone = sqlite.prepare(`
    DELETE FROM watch_tombstones WHERE account_id = ? AND bangumi_id = ?
  `);
  const upsertWatchTombstone = sqlite.prepare(`
    INSERT INTO watch_tombstones (account_id, bangumi_id, deleted_version)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, bangumi_id) DO UPDATE SET deleted_version = excluded.deleted_version
  `);
  const deleteWatchProgressForItem = sqlite.prepare(`
    DELETE FROM watch_progress WHERE account_id = ? AND bangumi_id = ?
  `);
  const deleteWatchRecord = sqlite.prepare(`
    DELETE FROM watch_records WHERE account_id = ? AND bangumi_id = ?
  `);
  const selectWatchClear = sqlite.prepare(`
    SELECT clear_version FROM watch_state WHERE account_id = ?
  `);
  const deleteClearedWatchProgress = sqlite.prepare(`
    DELETE FROM watch_progress WHERE account_id = ? AND progress_version <= ? COLLATE BINARY
  `);
  const deleteClearedWatchRecords = sqlite.prepare(`
    DELETE FROM watch_records WHERE account_id = ? AND record_version <= ? COLLATE BINARY
  `);
  const deleteClearedWatchTombstones = sqlite.prepare(`
    DELETE FROM watch_tombstones WHERE account_id = ? AND deleted_version <= ? COLLATE BINARY
  `);
  const upsertWatchClear = sqlite.prepare(`
    INSERT INTO watch_state (account_id, clear_version) VALUES (?, ?)
    ON CONFLICT(account_id) DO UPDATE SET clear_version = excluded.clear_version
  `);

  const selectCollectionRecord = sqlite.prepare(`
    SELECT record_version FROM collection_records WHERE account_id = ? AND bangumi_id = ?
  `);
  const upsertCollectionRecord = sqlite.prepare(`
    INSERT INTO collection_records (
      account_id, bangumi_id, type, collected_at_ms, updated_at_ms, record_version
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, bangumi_id) DO UPDATE SET
      type = excluded.type,
      collected_at_ms = excluded.collected_at_ms,
      updated_at_ms = excluded.updated_at_ms,
      record_version = excluded.record_version
  `);
  const selectCollectionTombstone = sqlite.prepare(`
    SELECT deleted_version FROM collection_tombstones WHERE account_id = ? AND bangumi_id = ?
  `);
  const deleteCollectionTombstone = sqlite.prepare(`
    DELETE FROM collection_tombstones WHERE account_id = ? AND bangumi_id = ?
  `);
  const upsertCollectionTombstone = sqlite.prepare(`
    INSERT INTO collection_tombstones (account_id, bangumi_id, deleted_version)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id, bangumi_id) DO UPDATE SET deleted_version = excluded.deleted_version
  `);
  const deleteCollectionRecord = sqlite.prepare(`
    DELETE FROM collection_records WHERE account_id = ? AND bangumi_id = ?
  `);
  const selectCollectionClear = sqlite.prepare(`
    SELECT clear_version FROM collection_state WHERE account_id = ?
  `);
  const deleteClearedCollectionRecords = sqlite.prepare(`
    DELETE FROM collection_records WHERE account_id = ? AND record_version <= ? COLLATE BINARY
  `);
  const deleteClearedCollectionTombstones = sqlite.prepare(`
    DELETE FROM collection_tombstones WHERE account_id = ? AND deleted_version <= ? COLLATE BINARY
  `);
  const upsertCollectionClear = sqlite.prepare(`
    INSERT INTO collection_state (account_id, clear_version) VALUES (?, ?)
    ON CONFLICT(account_id) DO UPDATE SET clear_version = excluded.clear_version
  `);
  const updateDeviceSeen = sqlite.prepare(`
    UPDATE account_devices SET last_seen_at = ? WHERE account_id = ? AND device_id = ?
  `);

  function transaction(callback) {
    return sqlite.transaction(callback)();
  }

  function findExistingEventIds(accountId, eventIds) {
    if (eventIds.length === 0) return new Set();
    return new Set(selectEventIds.all(accountId, JSON.stringify(eventIds)).map(({ event_id: id }) => id));
  }

  function insertEvent(accountId, event) {
    insertLedger.run(
      accountId,
      event.eventId,
      event.deviceId,
      event.seq,
      event.domain,
      event.operation,
      event.bangumiId,
      event.updatedAtMs,
      event.version,
      JSON.stringify(event.payload),
      new Date(event.receivedAtMs).toISOString(),
    );
  }

  function watchClearVersion(accountId) {
    return selectWatchClear.get(accountId)?.clear_version ?? null;
  }

  function collectionClearVersion(accountId) {
    return selectCollectionClear.get(accountId)?.clear_version ?? null;
  }

  function applyWatchUpsert(accountId, event) {
    const clearVersion = watchClearVersion(accountId);
    if (clearVersion && !laterThan(event.version, clearVersion)) return;
    const tombstone = selectWatchTombstone.get(accountId, event.bangumiId)?.deleted_version ?? null;
    if (tombstone && !laterThan(event.version, tombstone)) return;

    const record = selectWatchRecord.get(accountId, event.bangumiId)?.record_version ?? null;
    if (!record || atLeast(event.version, record)) {
      upsertWatchRecord.run(
        accountId,
        event.bangumiId,
        event.payload.lastWatchEpisode,
        event.payload.lastWatchTime,
        event.payload.lastWatchEpisodeName,
        event.version,
      );
    }
    const progress = selectWatchProgress.get(
      accountId,
      event.bangumiId,
      event.payload.episode,
    )?.progress_version ?? null;
    if (!progress || atLeast(event.version, progress)) {
      upsertWatchProgress.run(
        accountId,
        event.bangumiId,
        event.payload.episode,
        event.payload.road,
        event.payload.progressMs,
        event.version,
      );
    }
    if (tombstone) deleteWatchTombstone.run(accountId, event.bangumiId);
  }

  function applyWatchDelete(accountId, event) {
    const clearVersion = watchClearVersion(accountId);
    if (clearVersion && !laterThan(event.version, clearVersion)) return;
    const record = selectWatchRecord.get(accountId, event.bangumiId)?.record_version ?? null;
    const tombstone = selectWatchTombstone.get(accountId, event.bangumiId)?.deleted_version ?? null;
    if ((record && !atLeast(event.version, record)) || (tombstone && !atLeast(event.version, tombstone))) return;
    deleteWatchProgressForItem.run(accountId, event.bangumiId);
    deleteWatchRecord.run(accountId, event.bangumiId);
    upsertWatchTombstone.run(accountId, event.bangumiId, event.version);
  }

  function applyWatchClear(accountId, event) {
    const current = watchClearVersion(accountId);
    if (current && !laterThan(event.version, current)) return;
    deleteClearedWatchProgress.run(accountId, event.version);
    deleteClearedWatchRecords.run(accountId, event.version);
    deleteClearedWatchTombstones.run(accountId, event.version);
    upsertWatchClear.run(accountId, event.version);
  }

  function applyCollectionUpsert(accountId, event) {
    const clearVersion = collectionClearVersion(accountId);
    if (clearVersion && !laterThan(event.version, clearVersion)) return;
    const tombstone = selectCollectionTombstone.get(accountId, event.bangumiId)?.deleted_version ?? null;
    if (tombstone && !laterThan(event.version, tombstone)) return;
    const record = selectCollectionRecord.get(accountId, event.bangumiId)?.record_version ?? null;
    if (!record || atLeast(event.version, record)) {
      upsertCollectionRecord.run(
        accountId,
        event.bangumiId,
        event.payload.type,
        event.payload.collectedAt,
        event.updatedAtMs,
        event.version,
      );
    }
    if (tombstone) deleteCollectionTombstone.run(accountId, event.bangumiId);
  }

  function applyCollectionDelete(accountId, event) {
    const clearVersion = collectionClearVersion(accountId);
    if (clearVersion && !laterThan(event.version, clearVersion)) return;
    const record = selectCollectionRecord.get(accountId, event.bangumiId)?.record_version ?? null;
    const tombstone = selectCollectionTombstone.get(accountId, event.bangumiId)?.deleted_version ?? null;
    if ((record && !atLeast(event.version, record)) || (tombstone && !atLeast(event.version, tombstone))) return;
    deleteCollectionRecord.run(accountId, event.bangumiId);
    upsertCollectionTombstone.run(accountId, event.bangumiId, event.version);
  }

  function applyCollectionClear(accountId, event) {
    const current = collectionClearVersion(accountId);
    if (current && !laterThan(event.version, current)) return;
    deleteClearedCollectionRecords.run(accountId, event.version);
    deleteClearedCollectionTombstones.run(accountId, event.version);
    upsertCollectionClear.run(accountId, event.version);
  }

  function applyEvent(accountId, event) {
    switch (event.operation) {
      case "watch.upsertProgress": return applyWatchUpsert(accountId, event);
      case "watch.delete": return applyWatchDelete(accountId, event);
      case "watch.clear": return applyWatchClear(accountId, event);
      case "collection.upsert": return applyCollectionUpsert(accountId, event);
      case "collection.delete": return applyCollectionDelete(accountId, event);
      case "collection.clear": return applyCollectionClear(accountId, event);
      default: throw new TypeError(`unsupported sync operation: ${event.operation}`);
    }
  }

  function touchDevice(accountId, deviceId) {
    return updateDeviceSeen.run(nowIso(clock), accountId, deviceId).changes > 0;
  }

  function listWatchRecords(accountId) {
    return sqlite.prepare(`
      SELECT * FROM watch_records WHERE account_id = ? ORDER BY bangumi_id
    `).all(accountId).map(mapWatchRecord);
  }

  function listWatchProgress(accountId) {
    return sqlite.prepare(`
      SELECT * FROM watch_progress WHERE account_id = ? ORDER BY bangumi_id, episode
    `).all(accountId).map(mapWatchProgress);
  }

  function listCollectionRecords(accountId) {
    return sqlite.prepare(`
      SELECT * FROM collection_records WHERE account_id = ? ORDER BY bangumi_id
    `).all(accountId).map(mapCollectionRecord);
  }

  return {
    transaction,
    findExistingEventIds,
    insertEvent,
    applyEvent,
    touchDevice,
    listWatchRecords,
    listWatchProgress,
    findWatchClearVersion: watchClearVersion,
    listCollectionRecords,
    findCollectionClearVersion: collectionClearVersion,
  };
}
