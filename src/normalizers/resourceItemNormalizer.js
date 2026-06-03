function intValue(value) {
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function sourceAidFromItem(item) {
  return intValue(item.sourceAid ?? item.source_aid ?? item.id ?? item.aid);
}

function titleFromItem(item) {
  return stringValue(item.title ?? item.name);
}

export function normalizeResourceItem(item, { source, detailFetchedAt = null } = {}) {
  if (!source) throw new Error("normalizeResourceItem requires source");
  const sourceAid = sourceAidFromItem(item);
  const title = titleFromItem(item);
  if (sourceAid == null) throw new Error("normalizeResourceItem requires sourceAid");
  if (!title) throw new Error("normalizeResourceItem requires title");

  return {
    source,
    sourceAid,
    title,
    subtitle: stringValue(item.subtitle ?? item.subname),
    category: stringValue(item.category ?? item.type),
    year: stringValue(item.year),
    latestText: stringValue(item.latestText ?? item.latest_text ?? item.last ?? item.note),
    detailFetchedAt: stringValue(item.detailFetchedAt ?? item.detail_fetched_at ?? detailFetchedAt),
  };
}

export function normalizeResourceEpisodes(episodes, { bangumiId, source, sourceAid } = {}) {
  if (!bangumiId) throw new Error("normalizeResourceEpisodes requires bangumiId");
  if (!source) throw new Error("normalizeResourceEpisodes requires source");
  const normalizedSourceAid = intValue(sourceAid);
  if (normalizedSourceAid == null) throw new Error("normalizeResourceEpisodes requires sourceAid");

  return (episodes || [])
    .map((episode) => {
      const epIndex = intValue(episode.epIndex ?? episode.index);
      const videoUrl = stringValue(episode.videoUrl ?? episode.video_url ?? episode.url);
      if (epIndex == null || !videoUrl) return null;
      const sourceEpIndex = intValue(episode.sourceEpIndex ?? episode.sourceIndex) ?? epIndex;
      return {
        bangumiId,
        source,
        sourceAid: normalizedSourceAid,
        epIndex,
        sourceEpIndex,
        epName: stringValue(episode.epName ?? episode.name),
        videoUrl,
      };
    })
    .filter(Boolean);
}
