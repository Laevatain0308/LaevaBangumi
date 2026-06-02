import { sqlite } from "../db/index.js";

function boundedLimit(value, fallback = 60) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 120);
}

export function findSubjectById(id) {
  return sqlite.prepare("SELECT * FROM subjects WHERE bangumi_id = ?").get(id);
}

export function searchSubjectsByKeyword(keyword, { limit = 60 } = {}) {
  if (!keyword) return [];
  return sqlite.prepare(`
    SELECT DISTINCT s.bangumi_id, s.name, s.name_cn, s.cover_url, s.has_cover
    FROM subjects s
    LEFT JOIN subject_aliases a ON a.bangumi_id = s.bangumi_id
    WHERE s.name LIKE @q OR s.name_cn LIKE @q OR a.alias LIKE @q
    ORDER BY s.updated_at DESC
    LIMIT @limit
  `).all({ q: `%${keyword}%`, limit: boundedLimit(limit) });
}

export function searchSubjectsByTag(tag, { limit = 60 } = {}) {
  if (!tag) return [];
  return sqlite.prepare(`
    SELECT DISTINCT s.bangumi_id, s.name, s.name_cn, s.cover_url, s.has_cover
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
