import test from "node:test";
import assert from "node:assert/strict";
import { parseEpisodes } from "../src/services/cstation.js";

test("parseEpisodes keeps explicit source episode indexes", () => {
  const episodes = parseEpisodes({
    dd: {
      "@_flag": "ffm3u8",
      "#text": "第1156集$https://example.invalid/1156.m3u8#第1157集$https://example.invalid/1157.m3u8",
    },
  });

  assert.deepEqual(episodes, [
    {
      epIndex: 1156,
      epName: "第1156集",
      videoUrl: "https://example.invalid/1156.m3u8",
    },
    {
      epIndex: 1157,
      epName: "第1157集",
      videoUrl: "https://example.invalid/1157.m3u8",
    },
  ]);
});

test("parseEpisodes assigns an episode index to movie labels without numbers", () => {
  const episodes = parseEpisodes({
    dd: {
      "@_flag": "ffm3u8",
      "#text": "HD中字$https://vip.ffzy-plays.com/20260122/49681_ff47908a/index.m3u8",
    },
  });

  assert.deepEqual(episodes, [
    {
      epIndex: 1,
      epName: "HD中字",
      videoUrl: "https://vip.ffzy-plays.com/20260122/49681_ff47908a/index.m3u8",
    },
  ]);
});

test("parseEpisodes keeps movie labels as episode names and avoids explicit index collisions", () => {
  const episodes = parseEpisodes({
    dd: {
      "@_flag": "ffm3u8",
      "#text": "HD中字$https://example.invalid/movie.m3u8#第01集$https://example.invalid/1.m3u8",
    },
  });

  assert.deepEqual(episodes, [
    {
      epIndex: 2,
      epName: "HD中字",
      videoUrl: "https://example.invalid/movie.m3u8",
    },
    {
      epIndex: 1,
      epName: "第01集",
      videoUrl: "https://example.invalid/1.m3u8",
    },
  ]);
});
