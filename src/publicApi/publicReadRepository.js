const ALIAS_KEYS = Object.freeze(["别名", "中文名", "日文名", "英文名", "原名", "罗马字"]);

function escapeLike(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function unique(values) {
  return [...new Set(values)];
}

function rowToSubject(row, tags) {
  if (!row) return null;
  return {
    bangumiId: row.bangumi_id,
    name: row.name,
    nameCn: row.name_cn,
    summary: row.summary,
    airDate: row.air_date,
    airWeekday: row.air_weekday,
    platform: row.platform,
    eps: row.eps,
    totalEpisodes: row.total_episodes,
    updatedAt: row.updated_at,
    detailSucceededAt: row.last_succeeded_at,
    nextRefreshAt: row.next_refresh_at,
    coverUrl: row.large_url
      ?? row.common_url
      ?? row.medium_url
      ?? row.small_url
      ?? row.grid_url
      ?? null,
    ratingScore: row.score,
    rank: row.rank,
    votes: row.total,
    votesCount: row.rating_bangumi_id == null
      ? []
      : Array.from({ length: 10 }, (_, index) => row[`count_${index + 1}`]),
    tags,
  };
}

export function createPublicReadRepository(sqlite) {
  if (!sqlite?.prepare) throw new TypeError("public read repository requires SQLite prepare()");

  const findSubjectStatement = sqlite.prepare(`
    SELECT
      s.*,
      i.large_url, i.common_url, i.medium_url, i.small_url, i.grid_url,
      r.bangumi_id AS rating_bangumi_id, r.score, r.rank, r.total,
      r.count_1, r.count_2, r.count_3, r.count_4, r.count_5,
      r.count_6, r.count_7, r.count_8, r.count_9, r.count_10,
      f.last_succeeded_at, f.next_refresh_at
    FROM bangumi_subjects s
    LEFT JOIN bangumi_subject_images i ON i.bangumi_id = s.bangumi_id
    LEFT JOIN bangumi_subject_rating r ON r.bangumi_id = s.bangumi_id
    LEFT JOIN bangumi_subject_refresh_state f ON f.bangumi_id = s.bangumi_id
    WHERE s.bangumi_id = ?
  `);
  const tagsStatement = sqlite.prepare(`
    SELECT name, count, total_count
    FROM bangumi_subject_tags
    WHERE bangumi_id = ?
    ORDER BY position
  `);
  const aliasesStatement = sqlite.prepare(`
    SELECT s.name, s.name_cn, v.value
    FROM bangumi_subjects s
    JOIN bangumi_subject_infobox_entries e ON e.bangumi_id = s.bangumi_id
    JOIN bangumi_subject_infobox_values v
      ON v.bangumi_id = e.bangumi_id AND v.entry_position = e.entry_position
    WHERE s.bangumi_id = ?
      AND e.key IN ('别名', '中文名', '日文名', '英文名', '原名', '罗马字')
    ORDER BY e.entry_position, v.value_position
  `);
  const searchStatement = sqlite.prepare(`
    SELECT s.bangumi_id
    FROM bangumi_subjects s
    LEFT JOIN bangumi_subject_rating r ON r.bangumi_id = s.bangumi_id
    WHERE (
      @pattern IS NOT NULL
      AND (
        s.name LIKE @pattern ESCAPE '\\'
        OR s.name_cn LIKE @pattern ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM bangumi_subject_infobox_entries e
          JOIN bangumi_subject_infobox_values v
            ON v.bangumi_id = e.bangumi_id AND v.entry_position = e.entry_position
          WHERE e.bangumi_id = s.bangumi_id
            AND e.key IN ('别名', '中文名', '日文名', '英文名', '原名', '罗马字')
            AND v.value LIKE @pattern ESCAPE '\\'
        )
        OR EXISTS (
          SELECT 1 FROM bangumi_subject_tags t
          WHERE t.bangumi_id = s.bangumi_id
            AND t.name LIKE @pattern ESCAPE '\\'
        )
      )
    ) OR (
      @tag IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM bangumi_subject_tags t
        WHERE t.bangumi_id = s.bangumi_id AND t.name = @tag
      )
    )
    ORDER BY COALESCE(r.total, 0) DESC, COALESCE(r.score, 0) DESC, s.bangumi_id
  `);
  const calendarStatement = sqlite.prepare(`
    SELECT bangumi_id, weekday
    FROM bangumi_calendar_subjects
    ORDER BY weekday, bangumi_id
  `);
  const mappingsStatement = sqlite.prepare(`
    SELECT
      m.bangumi_id, m.source_key, m.source_item_id,
      m.source_episode_start, m.source_episode_end,
      i.title AS source_title
    FROM bangumi_resource_mappings m
    JOIN source_items i
      ON i.source_key = m.source_key AND i.source_item_id = m.source_item_id
    WHERE m.bangumi_id = ?
    ORDER BY m.source_key
  `);
  const episodesStatement = sqlite.prepare(`
    SELECT episode_index, title, video_url, updated_at
    FROM source_episodes
    WHERE source_key = ? AND source_item_id = ?
    ORDER BY episode_index
  `);
  const updateCandidatesStatement = sqlite.prepare(`
    WITH latest_indexes AS (
      SELECT source_key, source_item_id, MAX(episode_index) AS episode_index
      FROM source_episodes
      GROUP BY source_key, source_item_id
    ), latest_episodes AS (
      SELECT e.source_key, e.source_item_id, e.episode_index,
             e.title, e.video_url, e.updated_at
      FROM source_episodes e
      JOIN latest_indexes l
        ON l.source_key = e.source_key
       AND l.source_item_id = e.source_item_id
       AND l.episode_index = e.episode_index
      WHERE e.updated_at >= ? AND e.updated_at <= ?
    )
    SELECT
      m.bangumi_id, m.source_key, m.source_item_id,
      m.source_episode_start, m.source_episode_end,
      i.title AS source_title,
      e.episode_index, e.title AS episode_title,
      e.video_url, e.updated_at
    FROM latest_episodes e
    JOIN source_items i
      ON i.source_key = e.source_key AND i.source_item_id = e.source_item_id
    JOIN bangumi_resource_mappings m
      ON m.source_key = e.source_key AND m.source_item_id = e.source_item_id
    JOIN bangumi_calendar_subjects c
      ON c.bangumi_id = m.bangumi_id
    ORDER BY e.updated_at DESC, m.bangumi_id, m.source_key
  `);

  function listTags(bangumiId) {
    return tagsStatement.all(bangumiId).map((row) => ({
      name: row.name,
      count: row.count,
      totalCount: row.total_count,
    }));
  }

  function findSubject(bangumiId) {
    const row = findSubjectStatement.get(bangumiId);
    return rowToSubject(row, row ? listTags(bangumiId) : []);
  }

  function listAliases(bangumiId) {
    const rows = aliasesStatement.all(bangumiId);
    if (rows.length === 0) return [];
    const mainNames = new Set([rows[0].name, rows[0].name_cn].filter(Boolean));
    return unique(rows
      .map((row) => row.value.trim())
      .filter((value) => value && !mainNames.has(value)));
  }

  function searchSubjects({ query = null, tag = null } = {}) {
    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    const normalizedTag = typeof tag === "string" ? tag.trim() : "";
    if (!normalizedQuery && !normalizedTag) return [];
    const ids = searchStatement.all({
      pattern: normalizedQuery ? `%${escapeLike(normalizedQuery)}%` : null,
      tag: normalizedTag || null,
    });
    return ids.map((row) => findSubject(row.bangumi_id)).filter(Boolean);
  }

  function listCalendarSubjects() {
    return calendarStatement.all().map((row) => ({
      weekday: row.weekday,
      subject: findSubject(row.bangumi_id),
    })).filter((row) => row.subject != null);
  }

  function mappingFromRow(row) {
    return {
      bangumiId: row.bangumi_id,
      sourceKey: row.source_key,
      sourceItemId: row.source_item_id,
      sourceTitle: row.source_title,
      sourceEpisodeStart: row.source_episode_start,
      sourceEpisodeEnd: row.source_episode_end,
      episodes: episodesStatement.all(row.source_key, row.source_item_id).map((episode) => ({
        sourceIndex: episode.episode_index,
        title: episode.title,
        videoUrl: episode.video_url,
        updatedAt: episode.updated_at,
      })),
    };
  }

  function listMappingsWithEpisodes(bangumiId) {
    return mappingsStatement.all(bangumiId).map(mappingFromRow);
  }

  function listUpdateCandidates({ cutoffAt, nowAt }) {
    return updateCandidatesStatement.all(cutoffAt, nowAt).map((row) => ({
      bangumiId: row.bangumi_id,
      sourceKey: row.source_key,
      sourceItemId: row.source_item_id,
      sourceTitle: row.source_title,
      sourceEpisodeStart: row.source_episode_start,
      sourceEpisodeEnd: row.source_episode_end,
      sourceIndex: row.episode_index,
      episodeTitle: row.episode_title,
      videoUrl: row.video_url,
      updatedAt: row.updated_at,
      subject: findSubject(row.bangumi_id),
    })).filter((row) => row.subject != null);
  }

  return Object.freeze({
    findSubject,
    listAliases,
    searchSubjects,
    listCalendarSubjects,
    listMappingsWithEpisodes,
    listUpdateCandidates,
  });
}

export { ALIAS_KEYS };
