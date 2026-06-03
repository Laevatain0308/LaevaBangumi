import { findEpisodeRawVideoUrl } from "../repositories/episodeRepository.js";
import { formatPlayDto } from "../dto/resourceDto.js";
import { collectEpisodeChannels } from "./detailService.js";

export async function getPlayUrl(id, ch, ep) {
  const channels = collectEpisodeChannels(id);
  const channel = channels[ch - 1];
  if (!channel) return null;
  const episode = channel.episodes.find((row) => row.index === ep);
  if (!episode) return null;
  const row = findEpisodeRawVideoUrl({
    bangumiId: id,
    source: channel.source,
    sourceAid: channel.sourceAid,
    epIndex: ep,
  });
  if (!row) return null;
  return formatPlayDto(row.raw_video_url);
}
