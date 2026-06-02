import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { upsertAnime } from "../src/services/anime.js";

function resetTables() {
  initDb();
  sqlite.exec(`
    DELETE FROM episodes;
    DELETE FROM resource_mappings;
    DELETE FROM retry_state;
    DELETE FROM manual_resource_state;
    DELETE FROM subject_tags;
    DELETE FROM tags;
    DELETE FROM subject_aliases;
    DELETE FROM subjects;
    DELETE FROM bangumi_cstation_map;
    DELETE FROM match_retry_state;
    DELETE FROM episode_fetch_retry_state;
    DELETE FROM manual_match_state;
    DELETE FROM anime;
    DELETE FROM anime_other;
  `);
}

test("upsertAnime persists Bangumi detail metadata into normalized subject tables", async () => {
  resetTables();

  await upsertAnime({
    id: 547888,
    type: 2,
    name: "Raw Title",
    name_cn: "中文标题",
    summary: "简介",
    date: "2026-04-01",
    platform: "TV",
    eps: 12,
    total_episodes: 12,
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
    tags: [{ name: "原创", count: 10, total_count: 20 }],
    infobox: [
      { key: "别名", value: "Alias A" },
      { key: "别名", value: [{ v: "Alias B" }] },
    ],
  }, 3, { detailFetched: true });

  const subject = sqlite.prepare("SELECT * FROM subjects WHERE bangumi_id = ?").get(547888);
  assert.equal(subject.id, undefined);
  assert.equal(subject.name, "Raw Title");
  assert.equal(subject.name_cn, "中文标题");
  assert.equal(subject.summary, "简介");
  assert.equal(subject.air_date, "2026-04-01");
  assert.equal(subject.air_weekday, 3);
  assert.equal(subject.calendar_weekday, 3);
  assert.equal(subject.eps, 12);
  assert.equal(subject.total_episodes, 12);
  assert.equal(subject.cover_url, "https://example.invalid/cover.jpg");
  assert.equal(subject.rating_score, 7.6);
  assert.equal(subject.rating_rank, 1234);
  assert.equal(subject.rating_total, 420);
  assert.deepEqual(JSON.parse(subject.rating_distribution_json), [0, 0, 1, 2, 3, 10, 20, 30, 5, 1]);
  assert.ok(subject.metadata_fetched_at);
  assert.ok(subject.rating_fetched_at);

  const aliases = sqlite
    .prepare("SELECT alias FROM subject_aliases WHERE bangumi_id = ? ORDER BY alias")
    .all(547888)
    .map((row) => row.alias);
  assert.deepEqual(aliases, ["Alias A", "Alias B"]);

  const tags = sqlite.prepare(`
    SELECT t.name, st.count, st.total_count
    FROM subject_tags st
    JOIN tags t ON t.tag_id = st.tag_id
    WHERE st.bangumi_id = ?
  `).all(547888);
  assert.deepEqual(tags, [{ name: "原创", count: 10, total_count: 20 }]);
});
