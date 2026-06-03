import { sqlite } from "../db/index.js";

function assertResourceStateKey({ bangumiId, source }) {
  if (!bangumiId) throw new Error("resource state write requires bangumiId");
  if (!source) throw new Error("resource state write requires source");
}

function ensureResourceSource({ source, name = null, enabled = 1, baseUrl = null, priority = null }) {
  if (!source) throw new Error("resource source write requires source");

  sqlite.prepare(`
    INSERT INTO resource_sources (source, name, enabled, base_url, priority, updated_at)
    VALUES (@source, @name, @enabled, @baseUrl, @priority, datetime('now'))
    ON CONFLICT(source) DO NOTHING
  `).run({ source, name: name ?? source, enabled, baseUrl, priority: priority ?? 100 });

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
    SET name = @name,
        enabled = @enabled,
        base_url = COALESCE(@baseUrl, base_url),
        priority = COALESCE(@priority, priority),
        updated_at = datetime('now')
    WHERE source = @source
  `).run({ source, name, enabled, baseUrl, priority });
}

export function upsertResourceSource({ source, name = null, enabled = 1, baseUrl = null, priority = null }) {
  ensureResourceSource({ source, name, enabled, baseUrl, priority });
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

export function findResourceMapping({ bangumiId, source }) {
  assertResourceStateKey({ bangumiId, source });

  return sqlite.prepare(`
    SELECT
      bangumi_id,
      source,
      source_aid,
      source_ep_start,
      source_ep_end,
      display_ep_offset,
      score,
      matched_subject_title,
      matched_resource_title,
      matched_at
    FROM resource_mappings
    WHERE bangumi_id = @bangumiId AND source = @source
  `).get({ bangumiId, source });
}

export function findResourceMappingOwner({ source, sourceAid, exceptBangumiId = null }) {
  if (!source) throw new Error("resource mapping owner query requires source");
  if (sourceAid == null) throw new Error("resource mapping owner query requires sourceAid");

  return sqlite.prepare(`
    SELECT bangumi_id, source, source_aid
    FROM resource_mappings
    WHERE source = @source
      AND source_aid = @sourceAid
      AND (@exceptBangumiId IS NULL OR bangumi_id <> @exceptBangumiId)
    LIMIT 1
  `).get({ source, sourceAid, exceptBangumiId });
}

export function listResourceMappings({ sourceKeys = null } = {}) {
  if (sourceKeys != null && sourceKeys.length === 0) return [];
  const sourceFilter = sourceKeys && sourceKeys.length > 0
    ? `WHERE source IN (${sourceKeys.map(() => "?").join(", ")})`
    : "";
  return sqlite.prepare(`
    SELECT
      bangumi_id,
      source,
      source_aid,
      source_ep_start,
      source_ep_end,
      display_ep_offset,
      score,
      matched_subject_title,
      matched_resource_title,
      matched_at
    FROM resource_mappings
    ${sourceFilter}
  `).all(...(sourceKeys || []));
}

export function listResourceMappingsForSource(source) {
  if (!source) throw new Error("resource mapping query requires source");
  return sqlite.prepare(`
    SELECT bangumi_id FROM resource_mappings
    WHERE source = ?
  `).all(source);
}

export function listResourceItemsForSource(source) {
  if (!source) throw new Error("resource item query requires source");

  return sqlite.prepare(`
    SELECT source, source_aid, title, subtitle, category, year, latest_text, detail_fetched_at
    FROM resource_items
    WHERE source = ?
  `).all(source);
}

export function listResourceItems() {
  return sqlite.prepare("SELECT * FROM resource_items").all();
}

export function listRetryStatesByKind(kind, { sourceKeys = null } = {}) {
  if (!kind) throw new Error("retry state query requires kind");
  if (sourceKeys != null && sourceKeys.length === 0) return [];
  const sourceFilter = sourceKeys && sourceKeys.length > 0
    ? `AND source IN (${sourceKeys.map(() => "?").join(", ")})`
    : "";
  return sqlite.prepare(`
    SELECT bangumi_id, source, retry_count, retry_at, updated_at
    FROM retry_state
    WHERE kind = ?
    ${sourceFilter}
  `).all(kind, ...(sourceKeys || []));
}

export function listRetryStatesForSource({ source, kind }) {
  if (!source) throw new Error("retry state query requires source");
  if (!kind) throw new Error("retry state query requires kind");
  return sqlite.prepare(`
    SELECT * FROM retry_state
    WHERE source = ? AND kind = ?
  `).all(source, kind);
}

export function findRetryState({ bangumiId, source, kind }) {
  assertResourceStateKey({ bangumiId, source });
  if (!kind) throw new Error("retry state query requires kind");

  return sqlite.prepare(`
    SELECT bangumi_id, source, retry_count, retry_at, updated_at
    FROM retry_state
    WHERE bangumi_id = @bangumiId AND source = @source AND kind = @kind
  `).get({ bangumiId, source, kind });
}

export function listManualResourceStates({ sourceKeys = null } = {}) {
  if (sourceKeys != null && sourceKeys.length === 0) return [];
  const sourceFilter = sourceKeys && sourceKeys.length > 0
    ? `WHERE source IN (${sourceKeys.map(() => "?").join(", ")})`
    : "";
  return sqlite.prepare(`
    SELECT bangumi_id, source, status, note, updated_at
    FROM manual_resource_state
    ${sourceFilter}
  `).all(...(sourceKeys || []));
}

export function listManualResourceStatesForSource(source) {
  if (!source) throw new Error("manual resource state query requires source");
  return sqlite.prepare(`
    SELECT * FROM manual_resource_state
    WHERE source = ?
  `).all(source);
}

export function findManualResourceState({ bangumiId, source }) {
  assertResourceStateKey({ bangumiId, source });

  return sqlite.prepare(`
    SELECT bangumi_id, source, status, note, updated_at
    FROM manual_resource_state
    WHERE bangumi_id = @bangumiId AND source = @source
  `).get({ bangumiId, source });
}

export function listMappingSubjectIdsBySourceAid({ source, sourceAid }) {
  if (!source) throw new Error("resource mapping query requires source");
  if (sourceAid == null) throw new Error("resource mapping query requires sourceAid");

  return sqlite.prepare(`
    SELECT bangumi_id
    FROM resource_mappings
    WHERE source = @source AND source_aid = @sourceAid
  `).all({ source, sourceAid }).map((row) => row.bangumi_id);
}

export function listUpdateCandidateRows() {
  return sqlite.prepare(`
    SELECT
      s.bangumi_id AS id,
      s.bangumi_id,
      s.name,
      s.name_cn AS nameCn,
      s.name_cn,
      s.summary,
      s.cover_url AS coverUrl,
      s.cover_url,
      s.has_cover AS hasCover,
      s.has_cover,
      s.air_date,
      s.air_weekday,
      s.platform,
      s.eps,
      s.total_episodes,
      s.rating_score,
      s.rating_rank,
      s.rating_total,
      s.rating_distribution_json,
      rm.source,
      rm.source_aid AS sourceAid,
      rm.source_ep_start AS sourceEpStart,
      rm.source_ep_end AS sourceEpEnd,
      rm.display_ep_offset AS displayEpOffset,
      ri.latest_text AS sourceUpdatedAt,
      MAX(e.ep_index) AS latestEp,
      MAX(e.source_ep_index) AS latestSourceEpIndex,
      MAX(e.updated_at) AS episodeUpdatedAt
    FROM resource_mappings rm
    JOIN subjects s ON s.bangumi_id = rm.bangumi_id
    JOIN resource_items ri ON ri.source = rm.source AND ri.source_aid = rm.source_aid
    LEFT JOIN episodes e
      ON e.bangumi_id = rm.bangumi_id
      AND e.source = rm.source
      AND e.source_aid = rm.source_aid
    GROUP BY rm.bangumi_id, rm.source, rm.source_aid
  `).all();
}

export function findResourceItem({ source, sourceAid }) {
  if (!source) throw new Error("resource item query requires source");
  if (sourceAid == null) throw new Error("resource item query requires sourceAid");
  return sqlite.prepare(`
    SELECT * FROM resource_items
    WHERE source = ? AND source_aid = ?
  `).get(source, sourceAid);
}

export function runResourceTransaction(fn) {
  return sqlite.transaction(fn)();
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

export function deleteResourceRowsForSubject({ bangumiId }) {
  if (!bangumiId) throw new Error("resource subject cleanup requires bangumiId");

  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM episodes WHERE bangumi_id = ?").run(bangumiId);
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
  matchedSubjectTitle = null,
  matchedResourceTitle = null,
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
        display_ep_offset, score, matched_subject_title, matched_resource_title,
        status, note, matched_at, updated_at
      )
      VALUES (
        @bangumiId, @source, @sourceAid, @sourceEpStart, @sourceEpEnd,
        @displayEpOffset, @score, @matchedSubjectTitle, @matchedResourceTitle,
        @status, @note, COALESCE(@matchedAt, datetime('now')), datetime('now')
      )
      ON CONFLICT(bangumi_id, source) DO UPDATE SET
        source_aid = excluded.source_aid,
        source_ep_start = excluded.source_ep_start,
        source_ep_end = excluded.source_ep_end,
        display_ep_offset = excluded.display_ep_offset,
        score = excluded.score,
        matched_subject_title = excluded.matched_subject_title,
        matched_resource_title = excluded.matched_resource_title,
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
      matchedSubjectTitle,
      matchedResourceTitle,
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
