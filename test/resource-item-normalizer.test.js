import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeResourceEpisodes,
  normalizeResourceItem,
} from "../src/normalizers/resourceItemNormalizer.js";

const resourceDetailFixture = JSON.parse(readFileSync(new URL("./fixtures/resource-detail-ffzy.json", import.meta.url), "utf8"));

test("normalizeResourceItem maps catalog rows into repository input", () => {
  assert.deepEqual(normalizeResourceItem({
    id: "1001",
    name: "资源站标题",
    subname: "副标题",
    category: "TV",
    year: 2026,
    last: "第03集",
    detailFetchedAt: "2026-06-03 01:00:00",
  }, { source: "ffzy" }), {
    source: "ffzy",
    sourceAid: 1001,
    title: "资源站标题",
    subtitle: "副标题",
    category: "TV",
    year: "2026",
    latestText: "第03集",
    detailFetchedAt: "2026-06-03 01:00:00",
  });
});

test("normalizeResourceItem maps detail rows and caller supplied timestamps", () => {
  assert.deepEqual(normalizeResourceItem({
    sourceAid: 1002,
    title: "详情标题",
    type: "OVA",
    note: "更新至第02集",
  }, { source: "ffzy", detailFetchedAt: "2026-06-03 02:00:00" }), {
    source: "ffzy",
    sourceAid: 1002,
    title: "详情标题",
    subtitle: null,
    category: "OVA",
    year: null,
    latestText: "更新至第02集",
    detailFetchedAt: "2026-06-03 02:00:00",
  });
});

test("normalizeResourceEpisodes maps parsed source episodes into repository input", () => {
  assert.deepEqual(normalizeResourceEpisodes([
    {
      epIndex: 1,
      sourceEpIndex: 1,
      epName: "第01集",
      videoUrl: "https://example.invalid/1.m3u8",
    },
    {
      epIndex: 2,
      sourceEpIndex: 2,
      epName: "第02集",
      videoUrl: "https://example.invalid/2.m3u8",
    },
  ], {
    bangumiId: 547888,
    source: "ffzy",
    sourceAid: "1001",
    sourceUpdatedAt: "2026-06-03 02:00:00",
  }), [
    {
      bangumiId: 547888,
      source: "ffzy",
      sourceAid: 1001,
      epIndex: 1,
      sourceEpIndex: 1,
      title: "第01集",
      rawVideoUrl: "https://example.invalid/1.m3u8",
      updatedAt: null,
    },
    {
      bangumiId: 547888,
      source: "ffzy",
      sourceAid: 1001,
      epIndex: 2,
      sourceEpIndex: 2,
      title: "第02集",
      rawVideoUrl: "https://example.invalid/2.m3u8",
      updatedAt: "2026-06-03 02:00:00",
    },
  ]);
});
