import test from "node:test";
import assert from "node:assert/strict";
import { envelope } from "../src/dto/apiEnvelope.js";
import {
  formatLegacyAnimeDetailDto,
  formatSubjectDetailDto,
  formatSubjectSearchDto,
} from "../src/dto/subjectDto.js";
import {
  formatDetailEpisodeDto,
  formatPlayDto,
} from "../src/dto/resourceDto.js";

test("subject DTOs expose the normalized public contract", () => {
  const search = formatSubjectSearchDto({
    bangumi_id: 547888,
    name: "Raw title",
    name_cn: "中文标题",
    summary: "简介[简介原文]原始内容",
    air_date: "2026-04-01",
    air_weekday: 3,
    platform: "TV",
    eps: 12,
    total_episodes: 12,
    rating_score: 7.6,
    rating_rank: 1234,
    rating_total: 420,
    rating_distribution_json: "[0,0,1,2,3,10,20,30,5,1]",
  }, {
    coverUrl: "https://example.invalid/cover.jpg",
    tags: [{ name: "原创", count: 10, totalCount: 20 }],
  });
  assert.deepEqual(search, {
    id: 547888,
    title: "中文标题",
    name: "Raw title",
    nameCn: "中文标题",
    coverUrl: "https://example.invalid/cover.jpg",
    summary: "简介",
    airDate: "2026-04-01",
    airWeekday: 3,
    platform: "TV",
    eps: 12,
    totalEpisodes: 12,
    ratingScore: 7.6,
    rank: 1234,
    votes: 420,
    votesCount: [0, 0, 1, 2, 3, 10, 20, 30, 5, 1],
    tags: [{ name: "原创", count: 10, totalCount: 20 }],
  });
  assert.equal(Object.hasOwn(search, "bangumiId"), false);

  const detail = formatSubjectDetailDto({
    subject: {
      bangumi_id: 547888,
      name: "Raw title",
      name_cn: "中文标题",
      summary: "简介[简介原文]原始内容",
      air_date: "2026-04-01",
      air_weekday: 3,
      platform: "TV",
      eps: 12,
      total_episodes: 12,
      rating_score: 7.6,
      rating_rank: 1234,
      rating_total: 420,
      rating_distribution_json: "[0,0,1,2,3,10,20,30,5,1]",
    },
    coverUrl: "https://example.invalid/cover.jpg",
    tags: [{ name: "原创", count: 10, totalCount: 20 }],
    aliases: ["Alias A"],
    channels: [{ id: "ffzy:123", episodes: [] }],
  });
  assert.equal(detail.id, 547888);
  assert.equal(detail.summary, "简介");
  assert.deepEqual(detail.votesCount, [0, 0, 1, 2, 3, 10, 20, 30, 5, 1]);
  assert.deepEqual(detail.tags, [{ name: "原创", count: 10, totalCount: 20 }]);
  assert.equal(Object.hasOwn(detail, "bangumiId"), false);
});

test("resource DTOs expose playUrl and videoUrl without legacy fields", () => {
  const episode = formatDetailEpisodeDto({
    subjectId: 547888,
    channelIndex: 1,
    episode: {
      ep_index: 1,
      source_ep_index: 1,
      ep_name: "第01集",
      updated_at: "2026-06-03 01:00:00",
    },
  });
  assert.equal(episode.playUrl, "/anime/api/play?id=547888&ch=1&ep=1");
  assert.equal(Object.hasOwn(episode, "url"), false);

  const play = formatPlayDto("https://example.invalid/1.m3u8");
  assert.deepEqual(play, {
    videoUrl: "https://example.invalid/1.m3u8",
    directPlay: false,
    headers: {},
    expiresAt: null,
  });
  assert.equal(Object.hasOwn(play, "videoURL"), false);
});

test("legacy detail DTO keeps the current fallback shape without legacy episode url", () => {
  const detail = formatLegacyAnimeDetailDto({
    anime: {
      id: 547889,
      name: "Legacy raw",
      nameCn: "旧表标题",
      summary: "legacy summary",
      coverUrl: "https://example.invalid/legacy.jpg",
      hasCover: 0,
      eps: 12,
      totalEpisodes: 12,
      airDate: "2026-04-02",
      platform: "TV",
      ratingScore: 7.1,
      rank: 4321,
    },
    fresh: true,
    coverUrl: "https://example.invalid/legacy.jpg",
    tags: ["旧表Tag"],
    channels: [{ name: "ffzy", sourceAid: 456, episodes: [] }],
  });
  assert.equal(detail.data.id, 547889);
  assert.deepEqual(detail.data.tags, ["旧表Tag"]);
  assert.equal(Object.hasOwn(detail.data, "bangumiId"), false);
});

test("api envelope keeps data, timestamp, and meta shape centralized", () => {
  assert.deepEqual(envelope([1], { updatedAt: "2026-06-03T00:00:00.000Z", meta: { total: 1 } }), {
    data: [1],
    updatedAt: "2026-06-03T00:00:00.000Z",
    meta: { total: 1 },
  });
});
