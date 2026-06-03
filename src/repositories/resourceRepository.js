import { sqlite } from "../db/index.js";

function assertResourceStateKey({ bangumiId, source }) {
  if (!bangumiId) throw new Error("resource state write requires bangumiId");
  if (!source) throw new Error("resource state write requires source");
}

function ensureResourceSource({ source, name = null, enabled = 1 }) {
  if (!source) throw new Error("resource source write requires source");

  sqlite.prepare(`
    INSERT INTO resource_sources (source, name, enabled)
    VALUES (@source, @name, @enabled)
    ON CONFLICT(source) DO NOTHING
  `).run({ source, name: name ?? source, enabled });

  if (name == null) {
    sqlite.prepare(`
      UPDATE resource_sources
      SET updated_at = datetime('now')
      WHERE source = ?
    `).run(source);
    return;
  }

  sqlite.prepare(`
    UPDATE resource_sources
    SET name = @name, enabled = @enabled, updated_at = datetime('now')
    WHERE source = @source
  `).run({ source, name, enabled });
}

export function listResourceMappingsWithEpisodePresenceForSubject(bangumiId) {
  return sqlite.prepare(`
    SELECT
      rm.source,
      rm.source_aid,
      EXISTS (
        SELECT 1 FROM episodes e
        WHERE e.bangumi_id = rm.bangumi_id
          AND e.source = rm.source
          AND e.source_aid = rm.source_aid
      ) AS has_episodes
    FROM resource_mappings rm
    WHERE rm.bangumi_id = ?
  `).all(bangumiId);
}

export function listRetryStateForSubject(bangumiId, kind = "mapping") {
  return sqlite.prepare(`
    SELECT source, retry_count, retry_at, last_error
    FROM retry_state
    WHERE bangumi_id = ? AND kind = ?
  `).all(bangumiId, kind);
}

export function listManualResourceStatesForSubject(bangumiId) {
  return sqlite.prepare(`
    SELECT source, status, note
    FROM manual_resource_state
    WHERE bangumi_id = ?
  `).all(bangumiId);
}

export function listEpisodeChannelRowsForSubject(bangumiId) {
  return sqlite.prepare(`
    SELECT
      e.source,
      e.source_aid,
      e.ep_index,
      e.source_ep_index,
      e.ep_name,
      e.updated_at,
      rs.name AS source_name,
      COALESCE(rs.priority, 100) AS source_priority,
      ri.title AS resource_title
    FROM episodes e
    JOIN resource_mappings rm
      ON rm.bangumi_id = e.bangumi_id
      AND rm.source = e.source
      AND rm.source_aid = e.source_aid
    LEFT JOIN resource_sources rs ON rs.source = e.source
    LEFT JOIN resource_items ri ON ri.source = e.source AND ri.source_aid = e.source_aid
    WHERE e.bangumi_id = ?
    ORDER BY COALESCE(rs.priority, 100) ASC, e.source ASC, e.source_aid ASC, e.ep_index ASC
  `).all(bangumiId);
}

export function findEpisodeVideoUrl({ bangumiId, source, sourceAid, epIndex }) {
  return sqlite.prepare(`
    SELECT video_url FROM episodes
    WHERE bangumi_id = @bangumiId
      AND source = @source
      AND source_aid = @sourceAid
      AND ep_index = @epIndex
  `).get({ bangumiId, source, sourceAid, epIndex });
}

export function upsertResourceItem({
  source,
  sourceAid,
  title,
  subtitle = null,
  category = null,
  year = null,
  latestText = null,
  detailFetchedAt = null,
}) {
  if (!source) throw new Error("resource item write requires source");
  if (sourceAid == null) throw new Error("resource item write requires sourceAid");
  if (!title) throw new Error("resource item write requires title");

  sqlite.transaction(() => {
    ensureResourceSource({ source });
    sqlite.prepare(`
      INSERT INTO resource_items (
        source, source_aid, title, subtitle, category, year,
        latest_text, detail_fetched_at, updated_at
      )
      VALUES (
        @source, @sourceAid, @title, @subtitle, @category, @year,
        @latestText, @detailFetchedAt, datetime('now')
      )
      ON CONFLICT(source, source_aid) DO UPDATE SET
        title = excluded.title,
        subtitle = COALESCE(excluded.subtitle, resource_items.subtitle),
        category = COALESCE(excluded.category, resource_items.category),
        year = COALESCE(excluded.year, resource_items.year),
        latest_text = COALESCE(excluded.latest_text, resource_items.latest_text),
        detail_fetched_at = COALESCE(excluded.detail_fetched_at, resource_items.detail_fetched_at),
        updated_at = excluded.updated_at
    `).run({
      source,
      sourceAid,
      title,
      subtitle,
      category,
      year,
      latestText,
      detailFetchedAt,
    });
  })();
}

export function upsertResourceSyncState({
  source,
  scope,
  lastSeenAt,
  lastSuccessAt = null,
  status = "success",
  lastStartedAt = null,
  lastError = null,
}) {
  if (!source) throw new Error("resource sync state write requires source");
  if (!scope) throw new Error("resource sync state write requires scope");
  if (!lastSeenAt) throw new Error("resource sync state write requires lastSeenAt");

  sqlite.prepare(`
    INSERT INTO sync_state (
      source, scope, status, last_started_at, last_seen_at, last_success_at, last_error, updated_at
    )
    VALUES (
      @source, @scope, @status, @lastStartedAt, @lastSeenAt,
      COALESCE(@lastSuccessAt, datetime('now')), @lastError, datetime('now')
    )
    ON CONFLICT(source, scope) DO UPDATE SET
      status = excluded.status,
      last_started_at = excluded.last_started_at,
      last_seen_at = excluded.last_seen_at,
      last_success_at = excluded.last_success_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run({ source, scope, lastSeenAt, lastSuccessAt, status, lastStartedAt, lastError });
}

export function upsertResourceEpisode({
  bangumiId,
  source,
  sourceAid,
  epIndex,
  sourceEpIndex = null,
  epName = null,
  videoUrl,
}) {
  assertResourceStateKey({ bangumiId, source });
  if (sourceAid == null) throw new Error("resource episode write requires sourceAid");
  if (epIndex == null) throw new Error("resource episode write requires epIndex");
  if (!videoUrl) throw new Error("resource episode write requires videoUrl");

  const existing = sqlite.prepare(`
    SELECT id FROM episodes
    WHERE source_aid = @sourceAid
      AND ep_index = @epIndex
      AND (
        (bangumi_id = @bangumiId AND source = @source)
        OR (anime_id = @bangumiId AND source_name = @source)
      )
    ORDER BY CASE WHEN bangumi_id = @bangumiId AND source = @source THEN 0 ELSE 1 END
    LIMIT 1
  `).get({ bangumiId, source, sourceAid, epIndex });

  const row = {
    bangumiId,
    source,
    sourceAid,
    epIndex,
    sourceEpIndex,
    epName,
    videoUrl,
  };

  if (!existing) {
    sqlite.prepare(`
      INSERT INTO episodes (
        anime_id, bangumi_id, source_name, source, source_aid,
        ep_index, source_ep_index, ep_name, video_url, updated_at
      )
      VALUES (
        (SELECT id FROM anime WHERE id = @bangumiId), @bangumiId, @source, @source, @sourceAid,
        @epIndex, @sourceEpIndex, @epName, @videoUrl, datetime('now')
      )
    `).run(row);
    return;
  }

  sqlite.prepare(`
    UPDATE episodes
    SET anime_id = (SELECT id FROM anime WHERE id = @bangumiId),
      bangumi_id = @bangumiId,
      source_name = @source,
      source = @source,
      source_aid = @sourceAid,
      ep_index = @epIndex,
      source_ep_index = @sourceEpIndex,
      ep_name = @epName,
      video_url = @videoUrl,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({ ...row, id: existing.id });
}

export function deleteStaleResourceEpisodes({ bangumiId, source, sourceAid, validEpIndexes }) {
  assertResourceStateKey({ bangumiId, source });
  if (sourceAid == null) throw new Error("resource episode prune requires sourceAid");
  const validIndexes = new Set((validEpIndexes || []).map((value) => Number(value)));

  const existing = sqlite.prepare(`
    SELECT id, source_aid, ep_index
    FROM episodes
    WHERE (bangumi_id = @bangumiId AND source = @source)
      OR (anime_id = @bangumiId AND source_name = @source)
  `).all({ bangumiId, source });

  const deleteById = sqlite.prepare("DELETE FROM episodes WHERE id = ?");
  for (const episode of existing) {
    if (episode.source_aid !== sourceAid || !validIndexes.has(episode.ep_index)) {
      deleteById.run(episode.id);
    }
  }
}

export function deleteResourceEpisodesForSubjectSource({ bangumiId, source }) {
  assertResourceStateKey({ bangumiId, source });

  sqlite.prepare(`
    DELETE FROM episodes
    WHERE (bangumi_id = @bangumiId AND source = @source)
      OR (anime_id = @bangumiId AND source_name = @source)
  `).run({ bangumiId, source });
}

export function deleteResourceRowsForSubject({ bangumiId }) {
  if (!bangumiId) throw new Error("resource subject cleanup requires bangumiId");

  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM episodes WHERE bangumi_id = ? OR anime_id = ?").run(bangumiId, bangumiId);
    sqlite.prepare("DELETE FROM resource_mappings WHERE bangumi_id = ?").run(bangumiId);
    sqlite.prepare("DELETE FROM retry_state WHERE bangumi_id = ?").run(bangumiId);
    sqlite.prepare("DELETE FROM manual_resource_state WHERE bangumi_id = ?").run(bangumiId);
  })();
}

export function upsertResourceMapping({
  bangumiId,
  source,
  sourceAid,
  sourceEpStart = null,
  sourceEpEnd = null,
  displayEpOffset = 0,
  score = null,
  matchedBgName = null,
  matchedResourceName = null,
  status = "matched",
  note = null,
  matchedAt = null,
}) {
  assertResourceStateKey({ bangumiId, source });
  if (sourceAid == null) throw new Error("resource mapping write requires sourceAid");

  sqlite.transaction(() => {
    ensureResourceSource({ source });
    sqlite.prepare(`
      INSERT INTO resource_mappings (
        bangumi_id, source, source_aid, source_ep_start, source_ep_end,
        display_ep_offset, score, matched_bg_name, matched_resource_name,
        status, note, matched_at, updated_at
      )
      VALUES (
        @bangumiId, @source, @sourceAid, @sourceEpStart, @sourceEpEnd,
        @displayEpOffset, @score, @matchedBgName, @matchedResourceName,
        @status, @note, COALESCE(@matchedAt, datetime('now')), datetime('now')
      )
      ON CONFLICT(bangumi_id, source) DO UPDATE SET
        source_aid = excluded.source_aid,
        source_ep_start = excluded.source_ep_start,
        source_ep_end = excluded.source_ep_end,
        display_ep_offset = excluded.display_ep_offset,
        score = excluded.score,
        matched_bg_name = excluded.matched_bg_name,
        matched_resource_name = excluded.matched_resource_name,
        status = excluded.status,
        note = excluded.note,
        matched_at = excluded.matched_at,
        updated_at = excluded.updated_at
    `).run({
      bangumiId,
      source,
      sourceAid,
      sourceEpStart,
      sourceEpEnd,
      displayEpOffset,
      score,
      matchedBgName,
      matchedResourceName,
      status,
      note,
      matchedAt,
    });
  })();
}

export function deleteResourceMapping({ bangumiId, source }) {
  assertResourceStateKey({ bangumiId, source });

  sqlite.prepare(`
    DELETE FROM resource_mappings
    WHERE bangumi_id = @bangumiId AND source = @source
  `).run({ bangumiId, source });
}

export function upsertRetryState({ bangumiId, source, kind, retryCount, retryAt = null, lastError = null }) {
  assertResourceStateKey({ bangumiId, source });
  if (!kind) throw new Error("retry state write requires kind");

  sqlite.prepare(`
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, last_error, updated_at)
    VALUES (@bangumiId, @source, @kind, @retryCount, @retryAt, @lastError, datetime('now'))
    ON CONFLICT(bangumi_id, source, kind) DO UPDATE SET
      retry_count = excluded.retry_count,
      retry_at = excluded.retry_at,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run({ bangumiId, source, kind, retryCount, retryAt, lastError });
}

export function deleteRetryState({ bangumiId, source, kind }) {
  assertResourceStateKey({ bangumiId, source });
  if (!kind) throw new Error("retry state delete requires kind");

  sqlite.prepare(`
    DELETE FROM retry_state
    WHERE bangumi_id = @bangumiId AND source = @source AND kind = @kind
  `).run({ bangumiId, source, kind });
}

export function upsertManualResourceState({ bangumiId, source, status, note = null }) {
  assertResourceStateKey({ bangumiId, source });
  if (!status) throw new Error("manual resource state write requires status");

  sqlite.prepare(`
    INSERT INTO manual_resource_state (bangumi_id, source, status, note, updated_at)
    VALUES (@bangumiId, @source, @status, @note, datetime('now'))
    ON CONFLICT(bangumi_id, source) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run({ bangumiId, source, status, note });
}

export function deleteManualResourceState({ bangumiId, source }) {
  assertResourceStateKey({ bangumiId, source });

  sqlite.prepare(`
    DELETE FROM manual_resource_state
    WHERE bangumi_id = @bangumiId AND source = @source
  `).run({ bangumiId, source });
}

export function deleteManualResourceStateByStatus({ bangumiId, source, status }) {
  assertResourceStateKey({ bangumiId, source });
  if (!status) throw new Error("manual resource state delete requires status");

  sqlite.prepare(`
    DELETE FROM manual_resource_state
    WHERE bangumi_id = @bangumiId AND source = @source AND status = @status
  `).run({ bangumiId, source, status });
}
