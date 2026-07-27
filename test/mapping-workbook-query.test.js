import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createMappingRepository } from "../src/mappings/mappingRepository.js";

const NOW = "2026-07-25T00:00:00.000Z";

function seedSubject(sqlite, {
  bangumiId,
  name,
  nameCn = null,
  airDate,
  completed = true,
}) {
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (
      bangumi_id, name, name_cn, air_date, discovered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(bangumiId, name, nameCn, airDate, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO bangumi_subject_refresh_state (
      bangumi_id, last_succeeded_at, next_refresh_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(bangumiId, completed ? NOW : null, NOW, NOW);
}

function seedResource(sqlite, { sourceItemId, title }) {
  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title,
      first_seen_at, last_fetched_at, detail_fetched_at
    ) VALUES ('ffzy', ?, ?, ?, ?, ?)
  `).run(sourceItemId, title, NOW, NOW, NOW);
}

test("review projections use normalized complete-detail facts and stable filters", (t) => {
  const database = createTestDatabase();
  t.after(database.close);
  const { sqlite } = database;
  seedSubject(sqlite, {
    bangumiId: 1,
    name: "Bocchi the Rock!",
    nameCn: "孤独摇滚！",
    airDate: "2026-01-01",
  });
  seedSubject(sqlite, {
    bangumiId: 2,
    name: "Uma Musume Season 3",
    nameCn: "赛马娘 第三季",
    airDate: "2023-10-05",
  });
  seedSubject(sqlite, {
    bangumiId: 3,
    name: "Future Anime",
    nameCn: "未来动画",
    airDate: "2027-01-01",
  });
  seedSubject(sqlite, {
    bangumiId: 4,
    name: "Original Fallback",
    airDate: "2024",
  });
  seedSubject(sqlite, {
    bangumiId: 5,
    name: "Incomplete Detail",
    airDate: "2026-01-01",
    completed: false,
  });
  seedResource(sqlite, { sourceItemId: "9007199254740993", title: "赛马娘第三季" });
  seedResource(sqlite, { sourceItemId: "future", title: "未来动画" });
  sqlite.prepare(`
    INSERT INTO bangumi_resource_mappings (
      bangumi_id, source_key, source_item_id,
      source_episode_start, source_episode_end
    ) VALUES (2, 'ffzy', '9007199254740993', NULL, NULL),
             (3, 'ffzy', 'future', 1, 12)
  `).run();
  const repository = createMappingRepository({ sqlite });

  assert.deepEqual(repository.listUnmappedReviewSubjects({
    sourceKey: "ffzy",
    name: "摇滚",
    year: "2026",
    bangumiId: null,
  }), [{ bangumiId: 1, title: "孤独摇滚！", airDate: "2026-01-01" }]);
  assert.deepEqual(repository.listUnmappedReviewSubjects({
    sourceKey: "ffzy",
    name: "fallback",
    year: null,
    bangumiId: null,
  }), [{ bangumiId: 4, title: "Original Fallback", airDate: "2024" }]);
  assert.deepEqual(repository.listMappedReviewRows({
    sourceKey: "ffzy",
    name: null,
    year: null,
    bangumiId: 2,
  }), [{
    bangumiId: 2,
    title: "赛马娘 第三季",
    airDate: "2023-10-05",
    sourceItemId: "9007199254740993",
    sourceTitle: "赛马娘第三季",
    sourceEpisodeStart: null,
    sourceEpisodeEnd: null,
  }]);
  assert.equal(repository.listUnmappedReviewSubjects({ sourceKey: "ffzy" }).some(({ bangumiId }) => bangumiId === 2), false);
  assert.equal(repository.listUnmappedReviewSubjects({ sourceKey: "ffzy" }).some(({ bangumiId }) => bangumiId === 5), false);
  assert.equal(repository.listMappedReviewRows({ sourceKey: "ffzy" }).some(({ bangumiId }) => bangumiId === 3), true);
});
