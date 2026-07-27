import { formatSubjectDetailDto, formatSubjectSearchDto } from "../dto/subjectDto.js";
import { formatPlayDto } from "../dto/resourceDto.js";
import { buildCoverProxyUrl } from "../lib/coverProxyUrl.js";
import { parseAirDate } from "../lib/airDate.js";
import {
  containsSourceEpisode,
  displayEpisodeIndex,
  projectChannels,
  toPublicSourceAid,
} from "./episodeProjection.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = Object.freeze([
  { en: "Mon", cn: "星期一", ja: "月曜日", id: 1 },
  { en: "Tue", cn: "星期二", ja: "火曜日", id: 2 },
  { en: "Wed", cn: "星期三", ja: "水曜日", id: 3 },
  { en: "Thu", cn: "星期四", ja: "木曜日", id: 4 },
  { en: "Fri", cn: "星期五", ja: "金曜日", id: 5 },
  { en: "Sat", cn: "星期六", ja: "土曜日", id: 6 },
  { en: "Sun", cn: "星期日", ja: "日曜日", id: 7 },
]);

function proxiedCover(subject) {
  return buildCoverProxyUrl({ id: subject.bangumiId, sourceUrl: subject.coverUrl })
    ?? subject.coverUrl;
}

function subjectSummary(subject) {
  return formatSubjectSearchDto(subject, {
    coverUrl: proxiedCover(subject),
    tags: subject.tags,
  });
}

function publicChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    source: channel.source,
    sourceAid: channel.sourceAid,
    resourceTitle: channel.resourceTitle,
    episodes: channel.episodes.map(({ videoUrl: _videoUrl, ...episode }) => episode),
  };
}

function shanghaiDate(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function isFutureCompleteDate(airDate, today) {
  const parsed = parseAirDate(airDate);
  return parsed?.precision === "day" && parsed.value > today;
}

function todayEnd(today, now) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(today ?? "")) && parseAirDate(today)?.precision === "day") {
    return new Date(`${today}T23:59:59.999+08:00`);
  }
  return now;
}

export function createPublicApiService({
  repository,
  sourceDescriptors,
  ensureMetadata = () => {},
  clock = () => new Date(),
} = {}) {
  if (!repository) throw new TypeError("public API service requires a repository");
  if (!Array.isArray(sourceDescriptors)) throw new TypeError("public API service requires source descriptors");
  const descriptors = sourceDescriptors.map((descriptor) => ({ ...descriptor }));
  const sourceOrder = new Map(descriptors.map((descriptor, index) => [descriptor.sourceKey, index]));

  function channelsFor(bangumiId) {
    return projectChannels({
      bangumiId,
      sourceDescriptors: descriptors,
      mappings: repository.listMappingsWithEpisodes(bangumiId),
    });
  }

  async function search({ query = null, tag = null, mediaType = "anime" } = {}) {
    if (mediaType !== "anime") return { data: [], freshness: "empty" };
    const data = repository.searchSubjects({ query, tag }).map(subjectSummary);
    return { data, freshness: data.length > 0 ? "cache" : "empty" };
  }

  async function calendar() {
    const rows = repository.listCalendarSubjects();
    if (rows.length === 0) {
      return { data: [], freshness: "empty", error: "暂无数据，请等待首次同步完成" };
    }
    const data = WEEKDAYS.map((weekday) => ({
      weekday,
      items: rows.filter((row) => row.weekday === weekday.id).map(({ subject }) => {
        const episodes = channelsFor(subject.bangumiId).flatMap((channel) => channel.episodes);
        const latest = episodes.sort((left, right) => (
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.index - left.index
        ))[0];
        return {
          ...subjectSummary(subject),
          latestEp: latest?.index ?? null,
          lastUpdated: latest?.updatedAt ?? null,
          airDate: subject.airDate,
        };
      }),
    }));
    return { data, freshness: "cache" };
  }

  async function detail(bangumiId) {
    ensureMetadata([bangumiId]);
    const subject = repository.findSubject(bangumiId);
    if (!subject) return null;
    const mappings = repository.listMappingsWithEpisodes(bangumiId);
    const channels = projectChannels({
      bangumiId,
      sourceDescriptors: descriptors,
      mappings,
    });
    const channelsBySource = new Map(channels.map((channel) => [channel.source, channel]));
    const mappingsBySource = new Map(mappings.map((mapping) => [mapping.sourceKey, mapping]));
    const future = isFutureCompleteDate(subject.airDate, shanghaiDate(clock()));
    const resourceSources = descriptors.map((descriptor) => {
      const channel = channelsBySource.get(descriptor.sourceKey);
      const sourceMapping = mappingsBySource.get(descriptor.sourceKey);
      return {
        source: descriptor.sourceKey,
        name: descriptor.displayName,
        status: channel ? "ready" : (future ? "wait_airing" : "no_data"),
        sourceAid: sourceMapping
          ? toPublicSourceAid(sourceMapping.sourceKey, sourceMapping.sourceItemId)
          : null,
        note: null,
      };
    });
    const resourceStatus = resourceSources.some((row) => row.status === "ready")
      ? "ready"
      : resourceSources.some((row) => row.status === "wait_airing")
        ? "wait_airing"
        : "no_data";
    const now = clock();
    const freshness = subject.detailSucceededAt
      && subject.nextRefreshAt
      && Date.parse(subject.nextRefreshAt) > now.getTime()
      ? "cache"
      : "stale";
    return {
      data: formatSubjectDetailDto({
        subject,
        coverUrl: proxiedCover(subject),
        tags: subject.tags,
        aliases: repository.listAliases(bangumiId),
        channels: channels.map(publicChannel),
      }),
      freshness,
      resourceStatus,
      resourceSources,
    };
  }

  async function play({ bangumiId, channelIndex, episodeIndex }) {
    const channel = channelsFor(bangumiId)[channelIndex - 1];
    const episode = channel?.episodes.find((item) => item.index === episodeIndex);
    return episode ? formatPlayDto(episode.videoUrl) : null;
  }

  async function updates({ days = 7, limit = 60, today = null, mediaType = "anime" } = {}) {
    if (mediaType !== "anime") return { data: [], freshness: "empty" };
    const now = todayEnd(today, clock());
    const cutoff = new Date(now.getTime() - Math.max(1, days) * DAY_MS);
    const candidates = repository.listUpdateCandidates({
      cutoffAt: cutoff.toISOString(),
      nowAt: now.toISOString(),
    }).filter((candidate) => containsSourceEpisode(candidate, candidate.sourceIndex));
    const bySubject = new Map();
    for (const candidate of candidates) {
      const current = bySubject.get(candidate.bangumiId);
      const candidateTime = Date.parse(candidate.updatedAt);
      const currentTime = Date.parse(current?.updatedAt);
      if (
        !current
        || candidateTime > currentTime
        || (
          candidateTime === currentTime
          && (sourceOrder.get(candidate.sourceKey) ?? Number.MAX_SAFE_INTEGER)
            < (sourceOrder.get(current.sourceKey) ?? Number.MAX_SAFE_INTEGER)
        )
      ) bySubject.set(candidate.bangumiId, candidate);
    }
    const data = [...bySubject.values()].map((candidate) => {
      const latestEp = displayEpisodeIndex(candidate, candidate.sourceIndex);
      return {
        ...subjectSummary(candidate.subject),
        latestEp,
        latestEpisode: `更新至第${String(latestEp).padStart(2, "0")}集`,
        updatedAt: candidate.updatedAt,
        source: candidate.sourceKey,
        sourceAid: toPublicSourceAid(candidate.sourceKey, candidate.sourceItemId),
      };
    }).sort((left, right) => (
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id - right.id
    )).slice(0, Math.max(1, limit));
    return { data, freshness: data.length > 0 ? "cache" : "empty" };
  }

  return Object.freeze({ search, calendar, detail, play, updates });
}
