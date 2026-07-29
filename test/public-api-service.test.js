import test from "node:test";
import assert from "node:assert/strict";
import { createPublicApiService } from "../src/publicApi/publicApiService.js";
import { createPublicApiRuntime } from "../src/runtime/publicApiRuntime.js";
import { decodeCoverSource } from "../src/lib/coverProxyUrl.js";

const sourceDescriptors = [
  { sourceKey: "first", displayName: "第一线路" },
  { sourceKey: "ffzy", displayName: "非凡资源" },
];

function subject(overrides = {}) {
  return {
    bangumiId: 101,
    name: "Raw Name",
    nameCn: "中文名",
    summary: "简介",
    airDate: "2026-04-01",
    airWeekday: 3,
    platform: "TV",
    eps: 12,
    totalEpisodes: 12,
    updatedAt: "2026-07-20T00:00:00.000Z",
    detailSucceededAt: "2026-07-20T00:00:00.000Z",
    nextRefreshAt: "2026-08-20T00:00:00.000Z",
    coverUrl: "https://images/101.jpg",
    ratingScore: 8.1,
    rank: 100,
    votes: 900,
    votesCount: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    tags: [{ name: "原创", count: 10, totalCount: 20 }],
    ...overrides,
  };
}

function mapping(overrides = {}) {
  return {
    bangumiId: 101,
    sourceKey: "ffzy",
    sourceItemId: "500",
    sourceTitle: "原始资源标题",
    sourceEpisodeStart: 13,
    sourceEpisodeEnd: 24,
    episodes: [
      {
        sourceIndex: 13,
        title: "第13集",
        videoUrl: "https://video/13.m3u8",
        updatedAt: "2026-07-27T02:00:00.000Z",
      },
      {
        sourceIndex: 14,
        title: "第14集",
        videoUrl: "https://video/14.m3u8",
        updatedAt: "2026-07-28T02:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function createRepository(overrides = {}) {
  return {
    findSubject(id) { return id === 101 ? subject() : null; },
    listAliases() { return ["Alias"]; },
    searchSubjects() { return [subject()]; },
    listCalendarSubjects() { return [{ weekday: 3, subject: subject() }]; },
    listMappingsWithEpisodes(id) { return id === 101 ? [mapping()] : []; },
    listUpdateCandidates() { return []; },
    ...overrides,
  };
}

function createService({ repository = createRepository(), ensureMetadata, clock } = {}) {
  return createPublicApiService({
    repository,
    sourceDescriptors,
    ensureMetadata: ensureMetadata ?? (() => {}),
    clock: clock ?? (() => new Date("2026-07-28T04:00:00.000Z")),
  });
}

test("search serves only normalized anime summaries", async () => {
  const calls = [];
  const service = createService({
    repository: createRepository({
      searchSubjects(filters) { calls.push(filters); return [subject()]; },
    }),
  });

  const result = await service.search({ query: "中文", tag: null, mediaType: "anime" });
  assert.deepEqual(calls, [{ query: "中文", tag: null }]);
  assert.equal(result.freshness, "cache");
  assert.equal(result.data[0].id, 101);
  assert.equal(result.data[0].mediaType, "anime");
  assert.equal(result.data[0].ratingScore, 8.1);
  assert.deepEqual(result.data[0].tags, [{ name: "原创", count: 10, totalCount: 20 }]);

  assert.deepEqual(await service.search({ query: "中文", mediaType: "tv" }), {
    data: [],
    freshness: "empty",
  });
  assert.equal(calls.length, 1);
});

test("public subject covers normalize the Bangumi URL with and without the signed proxy", async () => {
  const originalBase = process.env.COVER_PROXY_BASE;
  const originalSecret = process.env.COVER_PROXY_SECRET;
  const coverUrl = "http://lain.bgm.tv/r/400/pic/cover/l/13/c5/400602_ZI8Y9.jpg";
  const normalizedUrl = "https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg";
  const service = createService({
    repository: createRepository({
      searchSubjects() { return [subject({ coverUrl })]; },
    }),
  });

  try {
    process.env.COVER_PROXY_BASE = "https://img.example.test";
    process.env.COVER_PROXY_SECRET = "cover-secret";
    const proxied = await service.search({ query: "中文" });
    const encodedSource = new URL(proxied.data[0].coverUrl).searchParams.get("u");
    assert.equal(decodeCoverSource(encodedSource), normalizedUrl);

    delete process.env.COVER_PROXY_BASE;
    delete process.env.COVER_PROXY_SECRET;
    const direct = await service.search({ query: "中文" });
    assert.equal(direct.data[0].coverUrl, normalizedUrl);
  } finally {
    if (originalBase === undefined) delete process.env.COVER_PROXY_BASE;
    else process.env.COVER_PROXY_BASE = originalBase;
    if (originalSecret === undefined) delete process.env.COVER_PROXY_SECRET;
    else process.env.COVER_PROXY_SECRET = originalSecret;
  }
});

test("detail ensures metadata and returns sparse normalized subjects without a 404", async () => {
  const ensured = [];
  const sparse = subject({
    summary: null,
    detailSucceededAt: null,
    nextRefreshAt: "2026-07-29T00:00:00.000Z",
    ratingScore: null,
    rank: null,
    votes: null,
    votesCount: [],
    tags: [],
  });
  const service = createService({
    ensureMetadata(ids) { ensured.push(ids); },
    repository: createRepository({
      findSubject(id) { return id === 101 ? sparse : null; },
      listAliases() { return []; },
      listMappingsWithEpisodes() { return []; },
    }),
  });

  const result = await service.detail(101);
  assert.deepEqual(ensured, [[101]]);
  assert.equal(result.freshness, "stale");
  assert.equal(result.data.id, 101);
  assert.deepEqual(result.data.aliases, []);
  assert.deepEqual(result.data.tags, []);
  assert.deepEqual(result.data.channels, []);
  assert.deepEqual(result.data.votesCount, []);
  assert.equal(result.resourceStatus, "no_data");
  assert.deepEqual(result.resourceSources.map(({ source, status }) => ({ source, status })), [
    { source: "first", status: "no_data" },
    { source: "ffzy", status: "no_data" },
  ]);

  assert.equal(await service.detail(999), null);
  assert.deepEqual(ensured, [[101], [999]]);
});

test("detail ensure failure does not replace readable local data", async () => {
  const errors = [];
  const service = createPublicApiService({
    repository: createRepository(),
    sourceDescriptors,
    ensureMetadata() { throw new Error("queue unavailable"); },
    clock: () => new Date("2026-07-28T04:00:00.000Z"),
    logger: { error(...args) { errors.push(args); } },
  });

  const result = await service.detail(101);
  assert.equal(result.data.id, 101);
  assert.equal(errors.length, 1);
  assert.match(errors[0][2].message, /queue unavailable/);
});

test("detail and play share filtered channel order and segment indexes", async () => {
  const service = createService({
    repository: createRepository({
      listMappingsWithEpisodes() {
        return [
          mapping({
            sourceKey: "first",
            sourceItemId: "empty",
            sourceEpisodeStart: 30,
            sourceEpisodeEnd: 40,
          }),
          mapping(),
        ];
      },
    }),
  });

  const detail = await service.detail(101);
  assert.equal(detail.freshness, "cache");
  assert.equal(detail.resourceStatus, "ready");
  assert.deepEqual(detail.data.channels, [{
    id: "ffzy:500",
    name: "非凡资源",
    source: "ffzy",
    sourceAid: 500,
    resourceTitle: "原始资源标题",
    episodes: [
      {
        index: 1,
        sourceIndex: 13,
        name: "第13集",
        playUrl: "/anime/api/play?id=101&ch=1&ep=1",
        updatedAt: "2026-07-27T02:00:00.000Z",
      },
      {
        index: 2,
        sourceIndex: 14,
        name: "第14集",
        playUrl: "/anime/api/play?id=101&ch=1&ep=2",
        updatedAt: "2026-07-28T02:00:00.000Z",
      },
    ],
  }]);
  assert.deepEqual(await service.play({ bangumiId: 101, channelIndex: 1, episodeIndex: 2 }), {
    videoUrl: "https://video/14.m3u8",
    directPlay: false,
    headers: {},
    expiresAt: null,
  });
  assert.equal(await service.play({ bangumiId: 101, channelIndex: 1, episodeIndex: 13 }), null);
  assert.equal(await service.play({ bangumiId: 101, channelIndex: 2, episodeIndex: 1 }), null);
});

test("future complete air dates derive wait_airing in the Shanghai natural day", async () => {
  for (const [airDate, expected] of [
    ["2026-07-29", "wait_airing"],
    ["2026-07-28", "no_data"],
    ["2027", "no_data"],
    ["2026-08", "no_data"],
  ]) {
    const service = createService({
      clock: () => new Date("2026-07-27T16:30:00.000Z"),
      repository: createRepository({
        findSubject() { return subject({ airDate }); },
        listMappingsWithEpisodes() { return []; },
      }),
    });
    const result = await service.detail(101);
    assert.equal(result.resourceStatus, expected, airDate);
    assert.ok(result.resourceSources.every((row) => row.status === expected), airDate);
  }
});

test("calendar uses projected display episodes and preserves the empty response", async () => {
  const service = createService();
  const result = await service.calendar();
  assert.equal(result.freshness, "cache");
  assert.equal(result.data.length, 7);
  const wednesday = result.data.find((day) => day.weekday.id === 3);
  assert.equal(wednesday.items[0].latestEp, 2);
  assert.equal(wednesday.items[0].lastUpdated, "2026-07-28T02:00:00.000Z");

  const empty = await createService({
    repository: createRepository({ listCalendarSubjects() { return []; } }),
  }).calendar();
  assert.deepEqual(empty, {
    data: [],
    freshness: "empty",
    error: "暂无数据，请等待首次同步完成",
  });
});

test("updates assign the latest source episode only to its containing segment", async () => {
  const candidates = [
    {
      bangumiId: 100,
      sourceKey: "ffzy",
      sourceItemId: "500",
      sourceTitle: "合集",
      sourceEpisodeStart: 1,
      sourceEpisodeEnd: 12,
      sourceIndex: 25,
      episodeTitle: "第25集",
      videoUrl: "https://video/25.m3u8",
      updatedAt: "2026-07-28T02:00:00.000Z",
      subject: subject({ bangumiId: 100, nameCn: "第一季" }),
    },
    {
      bangumiId: 101,
      sourceKey: "ffzy",
      sourceItemId: "500",
      sourceTitle: "合集",
      sourceEpisodeStart: 13,
      sourceEpisodeEnd: 24,
      sourceIndex: 25,
      episodeTitle: "第25集",
      videoUrl: "https://video/25.m3u8",
      updatedAt: "2026-07-28T02:00:00.000Z",
      subject: subject(),
    },
    {
      bangumiId: 102,
      sourceKey: "ffzy",
      sourceItemId: "500",
      sourceTitle: "合集",
      sourceEpisodeStart: 25,
      sourceEpisodeEnd: null,
      sourceIndex: 25,
      episodeTitle: "第25集",
      videoUrl: "https://video/25.m3u8",
      updatedAt: "2026-07-28T02:00:00.000Z",
      subject: subject({ bangumiId: 102, nameCn: "第三季" }),
    },
  ];
  const calls = [];
  const service = createService({
    repository: createRepository({
      listUpdateCandidates(window) { calls.push(window); return candidates; },
    }),
  });

  const result = await service.updates({
    days: 1,
    limit: 10,
    today: "2026-07-28",
    mediaType: "anime",
  });
  assert.equal(result.freshness, "cache");
  assert.deepEqual(result.data.map((row) => row.id), [102]);
  assert.equal(result.data[0].latestEp, 1);
  assert.equal(result.data[0].latestEpisode, "更新至第01集");
  assert.equal(result.data[0].sourceAid, 500);
  assert.deepEqual(calls, [{
    cutoffAt: "2026-07-27T15:59:59.999Z",
    nowAt: "2026-07-28T15:59:59.999Z",
  }]);

  assert.deepEqual(await service.updates({ mediaType: "tv" }), {
    data: [],
    freshness: "empty",
  });
});

test("runtime captures registry order and delegates metadata ensure", async () => {
  const ensured = [];
  const repository = createRepository();
  const runtime = createPublicApiRuntime({
    sqlite: {},
    resourceSourceRegistry: {
      list() {
        return [
          { sourceKey: "first", displayName: "第一线路" },
          { sourceKey: "ffzy", displayName: "非凡资源" },
        ];
      },
    },
    metadataEnsureService: { ensure(ids) { ensured.push(ids); } },
    repository,
    clock: () => new Date("2026-07-28T04:00:00.000Z"),
  });

  const result = await runtime.detail(101);
  assert.deepEqual(result.resourceSources.map((row) => row.source), ["first", "ffzy"]);
  assert.deepEqual(ensured, [[101]]);
  assert.equal(Object.isFrozen(runtime), true);
});
