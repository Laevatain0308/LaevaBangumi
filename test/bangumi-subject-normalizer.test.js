import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBangumiSubject,
  normalizeCoverUrl,
  normalizeDateValue,
} from "../src/normalizers/bangumiSubjectNormalizer.js";

test("normalizeDateValue converts common Bangumi Chinese date strings", () => {
  assert.equal(normalizeDateValue("2026年4月1日"), "2026-04-01");
  assert.equal(normalizeDateValue("2026年4月"), "2026-04");
  assert.equal(normalizeDateValue("2026年"), "2026");
  assert.equal(normalizeDateValue("2026-04-01"), "2026-04-01");
});

test("normalizeCoverUrl upgrades Bangumi cover URLs to canonical HTTPS URLs", () => {
  assert.equal(
    normalizeCoverUrl("http://lain.bgm.tv/r/400/pic/cover/l/13/c5/400602_ZI8Y9.jpg"),
    "https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg",
  );
});

test("normalizeBangumiSubject returns normalized subject metadata", () => {
  const normalized = normalizeBangumiSubject({
    id: 547888,
    type: 2,
    name: "Raw Title",
    name_cn: "中文标题",
    summary: "简介",
    date: "2026年4月1日",
    platform: "TV",
    eps: "12",
    total_episodes: "12",
    images: { large: "https://example.invalid/cover.jpg" },
    rating: {
      score: 7.6,
      rank: 1234,
      total: 420,
      count: {
        1: 0,
        2: 0,
        3: 1,
        4: 2,
        5: 3,
        6: 10,
        7: 20,
        8: 30,
        9: 5,
        10: 1,
      },
    },
    tags: [
      { name: "原创", count: "10", total_count: "20" },
      { name: "", count: 1 },
    ],
    infobox: [
      { key: "别名", value: "Alias A" },
      { key: "别名", value: [{ v: "Alias B" }] },
    ],
  }, 3, { detailFetched: true, now: () => "2026-06-03 01:02:03" });

  assert.deepEqual(normalized.subject, {
    bangumi_id: 547888,
    type: 2,
    name: "Raw Title",
    name_cn: "中文标题",
    summary: "简介",
    air_date: "2026-04-01",
    air_weekday: 3,
    calendar_weekday: 3,
    eps: 12,
    total_episodes: 12,
    platform: "TV",
    cover_url: "https://example.invalid/cover.jpg",
    rating_score: 7.6,
    rating_rank: 1234,
    rating_total: 420,
    rating_distribution_json: "[0,0,1,2,3,10,20,30,5,1]",
    metadata_fetched_at: "2026-06-03 01:02:03",
    rating_fetched_at: "2026-06-03 01:02:03",
    updated_at: "2026-06-03 01:02:03",
  });
  assert.deepEqual(normalized.aliases, ["Alias A", "Alias B"]);
  assert.deepEqual(normalized.tags, [{ name: "原创", count: 10, totalCount: 20 }]);
  assert.equal(Object.hasOwn(normalized, "legacyAnime"), false);
});
