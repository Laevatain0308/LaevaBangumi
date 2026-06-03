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

export function formatSubjectSearchDto(row, { coverUrl, tags = [] } = {}) {
  return {
    id: row.bangumi_id ?? row.id,
    title: row.name_cn || row.nameCn || row.name,
    name: row.name,
    nameCn: row.name_cn ?? row.nameCn ?? null,
    coverUrl,
    summary: displaySummary(row.summary),
    airDate: row.air_date ?? row.airDate ?? null,
    airWeekday: row.air_weekday ?? row.airWeekday ?? null,
    platform: row.platform ?? null,
    eps: row.eps ?? null,
    totalEpisodes: row.total_episodes ?? row.totalEpisodes ?? null,
    ratingScore: row.rating_score ?? row.ratingScore ?? null,
    rank: row.rating_rank ?? row.rank ?? null,
    votes: row.rating_total ?? row.votes ?? null,
    votesCount: parseVotesCount(row.rating_distribution_json ?? row.votesCount),
    tags,
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
