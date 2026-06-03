import { sqlite } from "../db/index.js";

function assertEpisodeKey({ bangumiId, source }) {
  if (!bangumiId) throw new Error("episode query requires bangumiId");
  if (!source) throw new Error("episode query requires source");
}

export function listEpisodeSubjectSourceRows({ sourceKeys = null } = {}) {
  if (sourceKeys != null && sourceKeys.length === 0) return [];
  const sourceFilter = sourceKeys && sourceKeys.length > 0
    ? `AND source IN (${sourceKeys.map(() => "?").join(", ")})`
    : "";
  return sqlite.prepare(`
    SELECT bangumi_id, source
    FROM episodes
    WHERE bangumi_id IS NOT NULL AND source IS NOT NULL
    ${sourceFilter}
  `).all(...(sourceKeys || []));
}

export function listEpisodeChannelRowsForSubject(bangumiId) {
  return sqlite.prepare(`
    SELECT
      e.source,
      e.source_aid,
      e.ep_index,
      e.source_ep_index,
      e.title,
      e.updated_at,
      rs.name AS source_label,
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

export function listEpisodeStatsForMapping({ bangumiId, source, sourceAid }) {
  assertEpisodeKey({ bangumiId, source });
  if (sourceAid == null) throw new Error("episode stats query requires sourceAid");
  return sqlite.prepare(`
    SELECT ep_index, source_ep_index
    FROM episodes
    WHERE bangumi_id = ? AND source = ? AND source_aid = ?
  `).all(bangumiId, source, sourceAid);
}

export function listLatestEpisodeStatsBySubject() {
  return sqlite.prepare(`
    SELECT bangumi_id AS id, ep_index AS latestEp, updated_at AS lastUpdated
    FROM episodes e1
    WHERE updated_at = (
      SELECT MAX(updated_at)
      FROM episodes e2
      WHERE e2.bangumi_id = e1.bangumi_id
    )
  `).all();
}

export function findEpisodeRawVideoUrl({ bangumiId, source, sourceAid, epIndex }) {
  return sqlite.prepare(`
    SELECT raw_video_url FROM episodes
    WHERE bangumi_id = @bangumiId
      AND source = @source
      AND source_aid = @sourceAid
      AND ep_index = @epIndex
  `).get({ bangumiId, source, sourceAid, epIndex });
}

export function upsertResourceEpisode({
  bangumiId,
  source,
  sourceAid,
  epIndex,
  sourceEpIndex = null,
  title = null,
  rawVideoUrl,
  updatedAt = null,
}) {
  assertEpisodeKey({ bangumiId, source });
  if (sourceAid == null) throw new Error("resource episode write requires sourceAid");
  if (epIndex == null) throw new Error("resource episode write requires epIndex");
  if (!rawVideoUrl) throw new Error("resource episode write requires rawVideoUrl");

  const existing = sqlite.prepare(`
    SELECT episode_id FROM episodes
    WHERE bangumi_id = @bangumiId
      AND source = @source
      AND source_aid = @sourceAid
      AND ep_index = @epIndex
    LIMIT 1
  `).get({ bangumiId, source, sourceAid, epIndex });

  const row = {
    bangumiId,
    source,
    sourceAid,
    epIndex,
    sourceEpIndex,
    title,
    rawVideoUrl,
    updatedAt,
  };

  if (!existing) {
    sqlite.prepare(`
      INSERT INTO episodes (
        bangumi_id, source, source_aid,
        ep_index, source_ep_index, title, raw_video_url, updated_at
      )
      VALUES (
        @bangumiId, @source, @sourceAid,
        @epIndex, @sourceEpIndex, @title, @rawVideoUrl, @updatedAt
      )
    `).run(row);
    return;
  }

  sqlite.prepare(`
    UPDATE episodes
    SET bangumi_id = @bangumiId,
      source = @source,
      source_aid = @sourceAid,
      ep_index = @epIndex,
      source_ep_index = @sourceEpIndex,
      title = @title,
      raw_video_url = @rawVideoUrl,
      updated_at = COALESCE(@updatedAt, updated_at)
    WHERE episode_id = @episodeId
  `).run({ ...row, episodeId: existing.episode_id });
}

export function deleteStaleResourceEpisodes({ bangumiId, source, sourceAid, validEpIndexes }) {
  assertEpisodeKey({ bangumiId, source });
  if (sourceAid == null) throw new Error("resource episode prune requires sourceAid");
  const validIndexes = new Set((validEpIndexes || []).map((value) => Number(value)));

  const existing = sqlite.prepare(`
    SELECT episode_id, source_aid, ep_index
    FROM episodes
    WHERE bangumi_id = @bangumiId AND source = @source
  `).all({ bangumiId, source });

  const deleteById = sqlite.prepare("DELETE FROM episodes WHERE episode_id = ?");
  for (const episode of existing) {
    if (episode.source_aid !== sourceAid || !validIndexes.has(episode.ep_index)) {
      deleteById.run(episode.episode_id);
    }
  }
}

export function deleteResourceEpisodesForSubjectSource({ bangumiId, source }) {
  assertEpisodeKey({ bangumiId, source });

  sqlite.prepare(`
    DELETE FROM episodes
    WHERE bangumi_id = @bangumiId AND source = @source
  `).run({ bangumiId, source });
}
