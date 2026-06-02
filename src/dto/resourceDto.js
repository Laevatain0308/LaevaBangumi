function compactDto(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
}

function field(row, snakeName, camelName) {
  return row?.[snakeName] ?? row?.[camelName];
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
  const index = field(episode, "ep_index", "epIndex");
  return compactDto({
    index,
    sourceIndex: field(episode, "source_ep_index", "sourceEpIndex"),
    name: field(episode, "ep_name", "epName"),
    playUrl: formatEpisodePlayUrl({
      subjectId,
      channelIndex,
      episodeIndex: index,
    }),
    updatedAt: field(episode, "updated_at", "updatedAt"),
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
