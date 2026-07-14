const BACKOFF_HOURS = [6, 12, 24];
const MAX_ERROR_LENGTH = 1_000;

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("FFZY repository clock returned an invalid time");
  return date.toISOString();
}

function errorSummary(error) {
  return String(error instanceof Error ? error.message : error).slice(0, MAX_ERROR_LENGTH);
}

function aliasesFor(sqlite, sourceKey, sourceItemId) {
  return sqlite.prepare(`
    SELECT alias FROM source_item_aliases
    WHERE source_key = ? AND source_item_id = ?
    ORDER BY rowid
  `).all(sourceKey, sourceItemId).map((row) => row.alias);
}

function localItem(row, aliases) {
  if (!row) return null;
  return {
    sourceKey: row.source_key,
    sourceItemId: row.source_item_id,
    title: row.title,
    aliases,
    year: row.year,
    sourceUpdatedAt: row.source_updated_at,
    firstSeenAt: row.first_seen_at,
    lastFetchedAt: row.last_fetched_at,
  };
}

function episode(row) {
  if (!row) return null;
  return {
    episodeIndex: row.episode_index,
    title: row.title,
    videoUrl: row.video_url,
  };
}

export function createFFZYRepository({
  sqlite,
  sourceKey = "ffzy",
  clock = () => new Date(),
} = {}) {
  if (!sqlite?.prepare || !sqlite?.transaction) {
    throw new TypeError("FFZY repository requires a better-sqlite3 connection");
  }

  const upsertItem = sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, year, source_updated_at,
      first_seen_at, last_fetched_at, detail_fetched_at
    ) VALUES (
      @sourceKey, @sourceItemId, @title, @year, @sourceUpdatedAt,
      @now, @now, @detailFetchedAt
    )
    ON CONFLICT(source_key, source_item_id) DO UPDATE SET
      title = excluded.title,
      year = excluded.year,
      source_updated_at = excluded.source_updated_at,
      last_fetched_at = excluded.last_fetched_at,
      detail_fetched_at = COALESCE(excluded.detail_fetched_at, source_items.detail_fetched_at)
  `);
  const insertAlias = sqlite.prepare(`
    INSERT INTO source_item_aliases (source_key, source_item_id, alias)
    VALUES (?, ?, ?)
    ON CONFLICT(source_key, source_item_id, alias) DO NOTHING
  `);
  const upsertEpisode = sqlite.prepare(`
    INSERT INTO source_episodes (
      source_key, source_item_id, episode_index, title, video_url, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_item_id, episode_index) DO UPDATE SET
      title = excluded.title,
      video_url = excluded.video_url,
      updated_at = excluded.updated_at
  `);
  const deleteFailure = sqlite.prepare(`
    DELETE FROM source_detail_failures
    WHERE source_key = ? AND source_item_id = ?
  `);

  function saveCatalogItems(items) {
    const now = nowIso(clock);
    const transaction = sqlite.transaction((rows) => {
      for (const item of rows) {
        upsertItem.run({ ...item, sourceKey, now, detailFetchedAt: null });
      }
    });
    transaction(items);
    return items.length;
  }

  function listChangedItemIds(items) {
    const getExisting = sqlite.prepare(`
      SELECT title, year, source_updated_at
      FROM source_items
      WHERE source_key = ? AND source_item_id = ?
    `);
    return items.filter((item) => {
      const row = getExisting.get(sourceKey, item.sourceItemId);
      return !row
        || row.title !== item.title
        || row.year !== item.year
        || row.source_updated_at !== item.sourceUpdatedAt;
    }).map((item) => item.sourceItemId);
  }

  const saveDetailTransaction = sqlite.transaction((detail, now) => {
    upsertItem.run({ ...detail, sourceKey, now, detailFetchedAt: now });
    for (const alias of detail.aliases) insertAlias.run(sourceKey, detail.sourceItemId, alias);
    for (const item of detail.episodes) {
      upsertEpisode.run(
        sourceKey,
        detail.sourceItemId,
        item.episodeIndex,
        item.title,
        item.videoUrl,
        now,
      );
    }
    deleteFailure.run(sourceKey, detail.sourceItemId);
  });

  function saveDetail(detail) {
    saveDetailTransaction(detail, nowIso(clock));
    return detail.episodes.length;
  }

  function getItem(sourceItemId) {
    const row = sqlite.prepare(`
      SELECT * FROM source_items
      WHERE source_key = ? AND source_item_id = ?
    `).get(sourceKey, sourceItemId);
    return localItem(row, row ? aliasesFor(sqlite, sourceKey, sourceItemId) : []);
  }

  function searchItems(keyword) {
    const pattern = `%${keyword.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = sqlite.prepare(`
      SELECT DISTINCT i.*
      FROM source_items i
      LEFT JOIN source_item_aliases a
        ON a.source_key = i.source_key AND a.source_item_id = i.source_item_id
      WHERE i.source_key = @sourceKey
        AND (i.title LIKE @pattern ESCAPE '\\' OR a.alias LIKE @pattern ESCAPE '\\')
      ORDER BY i.source_updated_at DESC, i.source_item_id
    `).all({ sourceKey, pattern });
    return rows.map((row) => localItem(
      row,
      aliasesFor(sqlite, sourceKey, row.source_item_id),
    ));
  }

  function getEpisodes(sourceItemId) {
    return sqlite.prepare(`
      SELECT episode_index, title, video_url
      FROM source_episodes
      WHERE source_key = ? AND source_item_id = ?
      ORDER BY episode_index
    `).all(sourceKey, sourceItemId).map(episode);
  }

  function getEpisode(sourceItemId, episodeIndex) {
    return episode(sqlite.prepare(`
      SELECT episode_index, title, video_url
      FROM source_episodes
      WHERE source_key = ? AND source_item_id = ? AND episode_index = ?
    `).get(sourceKey, sourceItemId, episodeIndex));
  }

  function ensureSyncState() {
    const now = nowIso(clock);
    sqlite.prepare(`
      INSERT INTO source_sync_state (source_key, updated_at)
      VALUES (?, ?)
      ON CONFLICT(source_key) DO NOTHING
    `).run(sourceKey, now);
  }

  function getSyncState() {
    ensureSyncState();
    const row = sqlite.prepare(`
      SELECT * FROM source_sync_state WHERE source_key = ?
    `).get(sourceKey);
    return {
      initialized: Boolean(row.initialized),
      watermarkAt: row.watermark_at,
      status: row.status,
      lastOperation: row.last_operation,
      lastStartedAt: row.last_started_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
    };
  }

  function markRunning(operation) {
    ensureSyncState();
    const now = nowIso(clock);
    sqlite.prepare(`
      UPDATE source_sync_state
      SET status = 'running', last_operation = ?, last_started_at = ?,
          last_error = NULL, updated_at = ?
      WHERE source_key = ?
    `).run(operation, now, now, sourceKey);
  }

  function markSuccess(operation, { initialized = null, watermarkAt = undefined } = {}) {
    ensureSyncState();
    const now = nowIso(clock);
    sqlite.prepare(`
      UPDATE source_sync_state
      SET status = 'success', last_operation = ?, last_success_at = ?,
          initialized = COALESCE(?, initialized),
          watermark_at = CASE WHEN ? THEN ? ELSE watermark_at END,
          last_error = NULL, updated_at = ?
      WHERE source_key = ?
    `).run(
      operation,
      now,
      initialized == null ? null : Number(initialized),
      watermarkAt !== undefined ? 1 : 0,
      watermarkAt ?? null,
      now,
      sourceKey,
    );
  }

  function markFailed(operation, error) {
    ensureSyncState();
    const now = nowIso(clock);
    sqlite.prepare(`
      UPDATE source_sync_state
      SET status = 'failed', last_operation = ?, last_error = ?, updated_at = ?
      WHERE source_key = ?
    `).run(operation, errorSummary(error), now, sourceKey);
  }

  function markSkipped(operation, reason) {
    ensureSyncState();
    const now = nowIso(clock);
    sqlite.prepare(`
      UPDATE source_sync_state
      SET status = 'skipped', last_operation = ?, last_error = ?, updated_at = ?
      WHERE source_key = ?
    `).run(operation, errorSummary(reason), now, sourceKey);
  }

  function listDueDetailFailures() {
    const now = nowIso(clock);
    return sqlite.prepare(`
      SELECT source_item_id, failure_count, next_retry_at, last_error
      FROM source_detail_failures
      WHERE source_key = ? AND next_retry_at <= ?
      ORDER BY next_retry_at, source_item_id
    `).all(sourceKey, now).map((row) => ({
      sourceItemId: row.source_item_id,
      failureCount: row.failure_count,
      nextRetryAt: row.next_retry_at,
      lastError: row.last_error,
    }));
  }

  function listDetailFailureIds() {
    return sqlite.prepare(`
      SELECT source_item_id FROM source_detail_failures
      WHERE source_key = ?
      ORDER BY source_item_id
    `).all(sourceKey).map((row) => row.source_item_id);
  }

  function recordDetailFailure(sourceItemId, error) {
    const now = nowIso(clock);
    const current = sqlite.prepare(`
      SELECT failure_count FROM source_detail_failures
      WHERE source_key = ? AND source_item_id = ?
    `).get(sourceKey, sourceItemId);
    const failureCount = (current?.failure_count ?? 0) + 1;
    const hours = BACKOFF_HOURS[Math.min(failureCount - 1, BACKOFF_HOURS.length - 1)];
    const nextRetryAt = new Date(new Date(now).getTime() + hours * 60 * 60 * 1000).toISOString();
    sqlite.prepare(`
      INSERT INTO source_detail_failures (
        source_key, source_item_id, failure_count, next_retry_at,
        last_failed_at, last_error
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key, source_item_id) DO UPDATE SET
        failure_count = excluded.failure_count,
        next_retry_at = excluded.next_retry_at,
        last_failed_at = excluded.last_failed_at,
        last_error = excluded.last_error
    `).run(sourceKey, sourceItemId, failureCount, nextRetryAt, now, errorSummary(error));
    return { sourceItemId, failureCount, nextRetryAt };
  }

  return Object.freeze({
    saveCatalogItems,
    listChangedItemIds,
    saveDetail,
    searchItems,
    getItem,
    getEpisodes,
    getEpisode,
    getSyncState,
    markRunning,
    markSuccess,
    markFailed,
    markSkipped,
    listDueDetailFailures,
    listDetailFailureIds,
    recordDetailFailure,
  });
}
