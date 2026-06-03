import { sqlite } from "../db/index.js";

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
