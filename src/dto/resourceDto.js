function compactDto(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

function normalizedField(row, snakeName, camelName = null) {
  return row?.[snakeName] ?? (camelName ? row?.[camelName] : undefined);
}

export function formatEpisodePlayUrl({
  subjectId,
  channelIndex,
  episodeIndex,
  basePath = "/anime/api/play",
}) {
  return `${basePath}?id=${subjectId}&ch=${channelIndex}&ep=${episodeIndex}`;
}

export function formatDetailEpisodeDto({ subjectId, channelIndex, episode }) {
  const index = normalizedField(episode, "ep_index", "epIndex");
  return compactDto({
    index,
    sourceIndex: normalizedField(episode, "source_ep_index", "sourceEpIndex"),
    name: normalizedField(episode, "title"),
    playUrl: formatEpisodePlayUrl({
      subjectId,
      channelIndex,
      episodeIndex: index,
    }),
    updatedAt: normalizedField(episode, "updated_at", "updatedAt"),
  });
}

export function formatPlayDto(videoUrl, {
  directPlay = false,
  headers = {},
  expiresAt = null,
} = {}) {
  return {
    videoUrl,
    directPlay,
    headers,
    expiresAt,
  };
}
