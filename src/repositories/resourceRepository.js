import { sqlite } from "../db/index.js";

function assertResourceStateKey({ bangumiId, source }) {
  if (!bangumiId) throw new Error("resource state write requires bangumiId");
  if (!source) throw new Error("resource state write requires source");
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
    SELECT source, retry_count, retry_at
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
      ri.title AS resource_title
    FROM episodes e
    JOIN resource_mappings rm
      ON rm.bangumi_id = e.bangumi_id
      AND rm.source = e.source
      AND rm.source_aid = e.source_aid
    LEFT JOIN resource_sources rs ON rs.source = e.source
    LEFT JOIN resource_items ri ON ri.source = e.source AND ri.source_aid = e.source_aid
    WHERE e.bangumi_id = ?
    ORDER BY e.source ASC, e.source_aid ASC, e.ep_index ASC
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

export function upsertRetryState({ bangumiId, source, kind, retryCount, retryAt = null }) {
  assertResourceStateKey({ bangumiId, source });
  if (!kind) throw new Error("retry state write requires kind");

  sqlite.prepare(`
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, updated_at)
    VALUES (@bangumiId, @source, @kind, @retryCount, @retryAt, datetime('now'))
    ON CONFLICT(bangumi_id, source, kind) DO UPDATE SET
      retry_count = excluded.retry_count,
      retry_at = excluded.retry_at,
      updated_at = excluded.updated_at
  `).run({ bangumiId, source, kind, retryCount, retryAt });
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
