function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

export function displaySummary(value) {
  if (!value) return value;
  const text = String(value);
  const markers = ["[简介原文]", "【简介原文】"];
  const markerIndex = markers
    .map((marker) => text.indexOf(marker))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  return (markerIndex == null ? text : text.slice(0, markerIndex)).trim();
}

export function parseVotesCount(value) {
  const parsed = Array.isArray(value) ? value : safeJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function formatSubjectSearchDto(row, { coverUrl } = {}) {
  return {
    id: row.bangumi_id ?? row.id,
    title: row.name_cn || row.nameCn || row.name,
    coverUrl,
  };
}

export function formatSubjectDetailDto({
  subject,
  coverUrl,
  tags = [],
  aliases = [],
  channels = [],
}) {
  return {
    id: subject.bangumi_id,
    title: subject.name_cn || subject.name,
    name: subject.name,
    nameCn: subject.name_cn,
    summary: displaySummary(subject.summary),
    coverUrl,
    airDate: subject.air_date,
    airWeekday: subject.air_weekday,
    platform: subject.platform,
    eps: subject.eps,
    totalEpisodes: subject.total_episodes,
    ratingScore: subject.rating_score,
    rank: subject.rating_rank,
    votes: subject.rating_total,
    votesCount: parseVotesCount(subject.rating_distribution_json),
    tags,
    aliases,
    channels,
  };
}

export function formatLegacyAnimeDetailDto({
  anime,
  fresh,
  coverUrl,
  tags = null,
  channels = [],
}) {
  return {
    data: {
      id: anime.id,
      title: anime.nameCn || anime.name,
      summary: displaySummary(anime.summary),
      coverUrl,
      eps: anime.eps,
      totalEpisodes: anime.totalEpisodes,
      airDate: anime.airDate,
      platform: anime.platform,
      ratingScore: anime.ratingScore,
      rank: anime.rank,
      tags,
      channels,
    },
    freshness: fresh ? "cache" : "stale",
  };
}
