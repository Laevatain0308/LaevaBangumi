import test from "node:test";
import assert from "node:assert/strict";
import {
  containsSourceEpisode,
  displayEpisodeIndex,
  projectChannels,
  resolveSourceEpisodeIndex,
  toPublicSourceAid,
} from "../src/publicApi/episodeProjection.js";

const oneToOne = {
  sourceEpisodeStart: null,
  sourceEpisodeEnd: null,
};

test("episode intervals project and reverse one-to-one closed and open indexes", () => {
  assert.equal(displayEpisodeIndex(oneToOne, 13), 13);
  assert.equal(resolveSourceEpisodeIndex(oneToOne, 13), 13);

  const closed = { sourceEpisodeStart: 13, sourceEpisodeEnd: 24 };
  assert.equal(containsSourceEpisode(closed, 12), false);
  assert.equal(containsSourceEpisode(closed, 13), true);
  assert.equal(containsSourceEpisode(closed, 24), true);
  assert.equal(containsSourceEpisode(closed, 25), false);
  assert.equal(displayEpisodeIndex(closed, 13), 1);
  assert.equal(displayEpisodeIndex(closed, 24), 12);
  assert.equal(displayEpisodeIndex(closed, 25), null);
  assert.equal(resolveSourceEpisodeIndex(closed, 12), 24);
  assert.equal(resolveSourceEpisodeIndex(closed, 13), null);

  const open = { sourceEpisodeStart: 25, sourceEpisodeEnd: null };
  assert.equal(displayEpisodeIndex(open, 27), 3);
  assert.equal(resolveSourceEpisodeIndex(open, 3), 27);
});

test("invalid logical indexes and malformed intervals do not project", () => {
  assert.equal(containsSourceEpisode(oneToOne, 0), false);
  assert.equal(displayEpisodeIndex(oneToOne, 1.5), null);
  assert.equal(resolveSourceEpisodeIndex(oneToOne, -1), null);
  assert.equal(containsSourceEpisode({ sourceEpisodeStart: null, sourceEpisodeEnd: 12 }, 1), false);
});

test("channels follow plugin order and assign ch after empty lines are removed", () => {
  const sourceDescriptors = [
    { sourceKey: "empty", displayName: "空线路" },
    { sourceKey: "ffzy", displayName: "非凡资源" },
    { sourceKey: "other", displayName: "其他线路" },
  ];
  const mappings = [
    {
      sourceKey: "other",
      sourceItemId: "other-id",
      sourceTitle: "其他资源",
      sourceEpisodeStart: null,
      sourceEpisodeEnd: null,
      episodes: [
        { sourceIndex: 2, title: "Other 2", videoUrl: "https://other/2.m3u8", updatedAt: "2026-07-02T00:00:00.000Z" },
      ],
    },
    {
      sourceKey: "empty",
      sourceItemId: "empty-id",
      sourceTitle: "空资源",
      sourceEpisodeStart: 20,
      sourceEpisodeEnd: 21,
      episodes: [
        { sourceIndex: 19, title: "Outside", videoUrl: "https://empty/19.m3u8", updatedAt: "2026-07-01T00:00:00.000Z" },
      ],
    },
    {
      sourceKey: "ffzy",
      sourceItemId: "123",
      sourceTitle: "原始第2季标题",
      sourceEpisodeStart: 13,
      sourceEpisodeEnd: 24,
      episodes: [
        { sourceIndex: 25, title: "第25集", videoUrl: "https://ffzy/25.m3u8", updatedAt: "2026-07-03T00:00:00.000Z" },
        { sourceIndex: 14, title: "第14集", videoUrl: "https://ffzy/14.m3u8", updatedAt: "2026-07-02T00:00:00.000Z" },
        { sourceIndex: 13, title: "第13集", videoUrl: "https://ffzy/13.m3u8", updatedAt: "2026-07-01T00:00:00.000Z" },
        { sourceIndex: 15, title: "第15集", videoUrl: "", updatedAt: "2026-07-03T00:00:00.000Z" },
      ],
    },
  ];

  const channels = projectChannels({ bangumiId: 101, sourceDescriptors, mappings });
  assert.deepEqual(channels.map(({ channelIndex, source }) => ({ channelIndex, source })), [
    { channelIndex: 1, source: "ffzy" },
    { channelIndex: 2, source: "other" },
  ]);
  assert.deepEqual(channels[0], {
    channelIndex: 1,
    id: "ffzy:123",
    name: "非凡资源",
    source: "ffzy",
    sourceItemId: "123",
    sourceAid: 123,
    resourceTitle: "原始第2季标题",
    sourceEpisodeStart: 13,
    sourceEpisodeEnd: 24,
    episodes: [
      {
        index: 1,
        sourceIndex: 13,
        name: "第13集",
        videoUrl: "https://ffzy/13.m3u8",
        playUrl: "/anime/api/play?id=101&ch=1&ep=1",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        index: 2,
        sourceIndex: 14,
        name: "第14集",
        videoUrl: "https://ffzy/14.m3u8",
        playUrl: "/anime/api/play?id=101&ch=1&ep=2",
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ],
  });
  assert.equal(channels[1].sourceAid, null);
});

test("public source IDs convert only safe positive FFZY identifiers", () => {
  assert.equal(toPublicSourceAid("ffzy", "123"), 123);
  assert.equal(toPublicSourceAid("ffzy", "9007199254740992"), null);
  assert.equal(toPublicSourceAid("ffzy", "abc"), null);
  assert.equal(toPublicSourceAid("other", "123"), null);
});
