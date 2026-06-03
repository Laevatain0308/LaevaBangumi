import { sqlite } from "../db/index.js";

function boundedLimit(value, fallback = 60) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 120);
}

function compactRow(row) {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
}

export function findSubjectById(id) {
  return sqlite.prepare("SELECT * FROM subjects WHERE bangumi_id = ?").get(id);
}

export function findSubjectCoverState(id) {
  return sqlite.prepare(`
    SELECT cover_url AS coverUrl, has_cover AS hasCover
    FROM subjects
    WHERE bangumi_id = ?
  `).get(id);
}

export function listSubjects({ ids = null } = {}) {
  const params = [];
  let where = "";
  if (ids) {
    const normalizedIds = [...ids].map((id) => parseInt(id, 10)).filter(Boolean);
    if (normalizedIds.length === 0) return [];
    where = `WHERE bangumi_id IN (${normalizedIds.map(() => "?").join(", ")})`;
    params.push(...normalizedIds);
  }
  return sqlite.prepare(`
    SELECT * FROM subjects
    ${where}
    ORDER BY bangumi_id
  `).all(...params);
}

export function listCalendarSubjectRows() {
  return sqlite.prepare(`
    SELECT
      bangumi_id AS id,
      bangumi_id,
      name,
      name_cn,
      name_cn AS nameCn,
      summary,
      cover_url AS coverUrl,
      cover_url,
      has_cover AS hasCover,
      has_cover,
      rating_score AS ratingScore,
      rating_score,
      rating_rank,
      rating_total,
      rating_distribution_json,
      eps,
      total_episodes AS totalEpisodes,
      total_episodes,
      air_date AS airDate,
      air_date,
      air_weekday,
      platform,
      COALESCE(calendar_weekday, air_weekday) AS calendarWeekday
    FROM subjects
  `).all();
}

export function markSubjectCalendarSynced({ bangumiId, weekday }) {
  if (!bangumiId) throw new Error("calendar sync mark requires bangumiId");
  sqlite.prepare(`
    UPDATE subjects
    SET calendar_synced_at = datetime('now'),
        calendar_weekday = ?,
        updated_at = datetime('now')
    WHERE bangumi_id = ?
  `).run(weekday ?? null, bangumiId);
}

export function clearStaleCalendarSubjects(activeBangumiIds) {
  if (activeBangumiIds.size === 0) return 0;
  const ids = [...activeBangumiIds];
  const result = sqlite.prepare(`
    UPDATE subjects
    SET calendar_weekday = NULL,
        calendar_synced_at = NULL,
        updated_at = datetime('now')
    WHERE calendar_weekday IS NOT NULL
      AND bangumi_id NOT IN (${ids.map(() => "?").join(", ")})
  `).run(...ids);
  return result.changes ?? 0;
}

export function deleteSubjectById(id) {
  sqlite.prepare("DELETE FROM subjects WHERE bangumi_id = ?").run(id);
}

export function markSubjectHasCover(id, hasCover) {
  sqlite.prepare("UPDATE subjects SET has_cover = ? WHERE bangumi_id = ?").run(hasCover ? 1 : 0, id);
}

export function insertNonAnimeSubject(row) {
  sqlite.prepare(`
    INSERT INTO anime_other (
      id, name, name_cn, summary, platform, cover_url, tags, aliases
    )
    VALUES (
      @id, @name, @nameCn, @summary, @platform, @coverUrl, @tags, @aliases
    )
    ON CONFLICT(id) DO NOTHING
  `).run(row);
}

export function searchSubjectsByKeyword(keyword, { limit = 60 } = {}) {
  if (!keyword) return [];
  return sqlite.prepare(`
    SELECT DISTINCT
      s.bangumi_id,
      s.name,
      s.name_cn,
      s.summary,
      s.air_date,
      s.air_weekday,
      s.platform,
      s.eps,
      s.total_episodes,
      s.cover_url,
      s.has_cover,
      s.rating_score,
      s.rating_rank,
      s.rating_total,
      s.rating_distribution_json
    FROM subjects s
    LEFT JOIN subject_aliases a ON a.bangumi_id = s.bangumi_id
    LEFT JOIN subject_tags st ON st.bangumi_id = s.bangumi_id
    LEFT JOIN tags t ON t.tag_id = st.tag_id
    WHERE s.name LIKE @q OR s.name_cn LIKE @q OR a.alias LIKE @q OR t.name LIKE @q
    ORDER BY s.updated_at DESC
    LIMIT @limit
  `).all({ q: `%${keyword}%`, limit: boundedLimit(limit) });
}

export function searchSubjectsByTag(tag, { limit = 60 } = {}) {
  if (!tag) return [];
  return sqlite.prepare(`
    SELECT DISTINCT
      s.bangumi_id,
      s.name,
      s.name_cn,
      s.summary,
      s.air_date,
      s.air_weekday,
      s.platform,
      s.eps,
      s.total_episodes,
      s.cover_url,
      s.has_cover,
      s.rating_score,
      s.rating_rank,
      s.rating_total,
      s.rating_distribution_json
    FROM subjects s
    JOIN subject_tags st ON st.bangumi_id = s.bangumi_id
    JOIN tags t ON t.tag_id = st.tag_id
    WHERE t.name = @tag
    ORDER BY st.count DESC, s.updated_at DESC
    LIMIT @limit
  `).all({ tag, limit: boundedLimit(limit) });
}

export function listSubjectTags(id) {
  return sqlite.prepare(`
    SELECT t.name, st.count, st.total_count
    FROM subject_tags st
    JOIN tags t ON t.tag_id = st.tag_id
    WHERE st.bangumi_id = ?
    ORDER BY st.count DESC, t.name ASC
  `).all(id).map((row) => ({
    name: row.name,
    count: row.count,
    totalCount: row.total_count,
  }));
}

export function listSubjectAliases(id) {
  return sqlite.prepare(`
    SELECT alias FROM subject_aliases
    WHERE bangumi_id = ?
    ORDER BY alias ASC
  `).all(id).map((row) => row.alias);
}

export function listManualReviewSubjectRows() {
  return listSubjects().map((row) => ({
    ...row,
    aliases: JSON.stringify(listSubjectAliases(row.bangumi_id)),
  }));
}

export function upsertSubjectMetadata({ subject, aliases, tags }) {
  const row = compactRow(subject);
  const columns = Object.keys(row);
  if (!row.bangumi_id) throw new Error("upsertSubjectMetadata requires subject.bangumi_id");

  const placeholders = columns.map((column) => `@${column}`).join(", ");
  const updateColumns = columns.filter((column) => column !== "bangumi_id");

  sqlite.transaction(() => {
    sqlite.prepare(`
      INSERT INTO subjects (${columns.join(", ")})
      VALUES (${placeholders})
      ON CONFLICT(bangumi_id) DO UPDATE SET
        ${updateColumns.map((column) => `${column} = excluded.${column}`).join(", ")}
    `).run(row);

    if (aliases !== undefined) {
      sqlite.prepare("DELETE FROM subject_aliases WHERE bangumi_id = ?").run(row.bangumi_id);
      const insertAlias = sqlite.prepare(`
        INSERT OR IGNORE INTO subject_aliases (bangumi_id, alias, source)
        VALUES (?, ?, 'bangumi')
      `);
      for (const alias of aliases) {
        if (alias) insertAlias.run(row.bangumi_id, alias);
      }
    }

    if (tags !== undefined) {
      sqlite.prepare("DELETE FROM subject_tags WHERE bangumi_id = ?").run(row.bangumi_id);
      const upsertTag = sqlite.prepare(`
        INSERT INTO tags (name, updated_at)
        VALUES (?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at
        RETURNING tag_id
      `);
      const insertSubjectTag = sqlite.prepare(`
        INSERT INTO subject_tags (bangumi_id, tag_id, count, total_count, source, updated_at)
        VALUES (?, ?, ?, ?, 'bangumi', datetime('now'))
        ON CONFLICT(bangumi_id, tag_id) DO UPDATE SET
          count = excluded.count,
          total_count = excluded.total_count,
          updated_at = excluded.updated_at
      `);

      for (const tag of tags) {
        if (!tag.name) continue;
        const tagRow = upsertTag.get(tag.name);
        insertSubjectTag.run(row.bangumi_id, tagRow.tag_id, tag.count, tag.totalCount);
      }
    }
  })();
}
