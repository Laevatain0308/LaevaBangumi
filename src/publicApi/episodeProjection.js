function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

export function containsSourceEpisode(mapping, sourceIndex) {
  if (!mapping || !isPositiveInteger(sourceIndex)) return false;
  const start = mapping.sourceEpisodeStart;
  const end = mapping.sourceEpisodeEnd;
  if (start == null) return end == null;
  if (!isPositiveInteger(start)) return false;
  if (end != null && (!isPositiveInteger(end) || end < start)) return false;
  return sourceIndex >= start && (end == null || sourceIndex <= end);
}

export function displayEpisodeIndex(mapping, sourceIndex) {
  if (!containsSourceEpisode(mapping, sourceIndex)) return null;
  return mapping.sourceEpisodeStart == null
    ? sourceIndex
    : sourceIndex - mapping.sourceEpisodeStart + 1;
}

export function resolveSourceEpisodeIndex(mapping, displayIndex) {
  if (!isPositiveInteger(displayIndex)) return null;
  const sourceIndex = mapping?.sourceEpisodeStart == null
    ? displayIndex
    : mapping.sourceEpisodeStart + displayIndex - 1;
  return containsSourceEpisode(mapping, sourceIndex) ? sourceIndex : null;
}

export function toPublicSourceAid(sourceKey, sourceItemId) {
  if (sourceKey !== "ffzy" || !/^[1-9]\d*$/.test(String(sourceItemId))) return null;
  const value = Number(sourceItemId);
  return Number.isSafeInteger(value) ? value : null;
}

export function projectChannels({ bangumiId, sourceDescriptors, mappings }) {
  const mappingsBySource = new Map(mappings.map((mapping) => [mapping.sourceKey, mapping]));
  const channels = [];

  for (const descriptor of sourceDescriptors) {
    const mapping = mappingsBySource.get(descriptor.sourceKey);
    if (!mapping) continue;
    const episodes = mapping.episodes
      .filter((episode) => typeof episode.videoUrl === "string" && episode.videoUrl.trim())
      .map((episode) => ({
        ...episode,
        index: displayEpisodeIndex(mapping, episode.sourceIndex),
      }))
      .filter((episode) => episode.index != null)
      .sort((left, right) => left.sourceIndex - right.sourceIndex);
    if (episodes.length === 0) continue;

    const channelIndex = channels.length + 1;
    channels.push({
      channelIndex,
      id: `${mapping.sourceKey}:${mapping.sourceItemId}`,
      name: descriptor.displayName,
      source: mapping.sourceKey,
      sourceItemId: mapping.sourceItemId,
      sourceAid: toPublicSourceAid(mapping.sourceKey, mapping.sourceItemId),
      resourceTitle: mapping.sourceTitle,
      sourceEpisodeStart: mapping.sourceEpisodeStart,
      sourceEpisodeEnd: mapping.sourceEpisodeEnd,
      episodes: episodes.map((episode) => ({
        index: episode.index,
        sourceIndex: episode.sourceIndex,
        name: episode.title,
        videoUrl: episode.videoUrl,
        playUrl: `/anime/api/play?id=${bangumiId}&ch=${channelIndex}&ep=${episode.index}`,
        updatedAt: episode.updatedAt,
      })),
    });
  }

  return channels;
}
