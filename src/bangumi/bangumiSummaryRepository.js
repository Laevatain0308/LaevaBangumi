const CHUNK_SIZE = 500;

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

export function createBangumiSummaryRepository(sqlite) {
  function findByIds(ids) {
    const normalized = [...new Set(ids)]
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((left, right) => left - right);
    if (normalized.length === 0) return new Map();

    const subjectRows = new Map();
    const images = new Map();
    const ratings = new Map();
    const tags = new Map();
    for (const batch of chunks(normalized, CHUNK_SIZE)) {
      const params = placeholders(batch);
      for (const row of sqlite.prepare(`
        SELECT bangumi_id, name, name_cn, summary, air_date, air_weekday,
               platform, eps, total_episodes
        FROM bangumi_subjects WHERE bangumi_id IN (${params})
      `).all(...batch)) subjectRows.set(Number(row.bangumi_id), row);
      for (const row of sqlite.prepare(`
        SELECT bangumi_id, large_url, common_url, medium_url, small_url, grid_url
        FROM bangumi_subject_images WHERE bangumi_id IN (${params})
      `).all(...batch)) images.set(Number(row.bangumi_id), row);
      for (const row of sqlite.prepare(`
        SELECT bangumi_id, score, rank, total
        FROM bangumi_subject_rating WHERE bangumi_id IN (${params})
      `).all(...batch)) ratings.set(Number(row.bangumi_id), row);
      for (const row of sqlite.prepare(`
        SELECT bangumi_id, position, name
        FROM bangumi_subject_tags WHERE bangumi_id IN (${params})
        ORDER BY bangumi_id, position
      `).all(...batch)) {
        const bangumiId = Number(row.bangumi_id);
        if (!tags.has(bangumiId)) tags.set(bangumiId, []);
        tags.get(bangumiId).push(row.name);
      }
    }

    const result = new Map();
    for (const [bangumiId, subject] of subjectRows) {
      const image = images.get(bangumiId);
      const rating = ratings.get(bangumiId);
      result.set(bangumiId, {
        id: bangumiId,
        title: subject.name_cn || subject.name,
        name: subject.name,
        nameCn: subject.name_cn,
        summary: subject.summary,
        airDate: subject.air_date,
        airWeekday: subject.air_weekday,
        platform: subject.platform,
        eps: subject.eps,
        totalEpisodes: subject.total_episodes,
        coverUrl: image?.large_url
          ?? image?.common_url
          ?? image?.medium_url
          ?? image?.small_url
          ?? image?.grid_url
          ?? null,
        ratingScore: rating?.score ?? null,
        rank: rating?.rank ?? null,
        votes: rating?.total ?? null,
        tags: tags.get(bangumiId) ?? [],
      });
    }
    return result;
  }

  return { findByIds };
}
