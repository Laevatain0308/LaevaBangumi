import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createMappingRepository } from "../src/mappings/mappingRepository.js";
import { createMappingService } from "../src/mappings/mappingService.js";
import { createAutoMatcher } from "../src/mappings/autoMatcher.js";
import { createScheduleService } from "../src/mappings/scheduleService.js";

const NOW = "2026-07-25T04:00:00.000Z";

function seedSubject(sqlite, bangumiId, { airDate, completed }) {
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (
      bangumi_id, name, name_cn, air_date, platform, total_episodes,
      discovered_at, updated_at
    ) VALUES (?, ?, ?, ?, 'TV', 12, ?, ?)
  `).run(bangumiId, `Bocchi ${bangumiId}`, "孤独摇滚", airDate, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO bangumi_subject_refresh_state (
      bangumi_id, last_succeeded_at, next_refresh_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(bangumiId, completed ? NOW : null, NOW, NOW);
}

function initializeSource(sqlite) {
  sqlite.prepare(`
    INSERT INTO source_sync_state (source_key, initialized, updated_at)
    VALUES ('ffzy', 1, ?)
  `).run(NOW);
}

function seedResource(sqlite) {
  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, year,
      first_seen_at, last_fetched_at, detail_fetched_at
    ) VALUES ('ffzy', '100', '孤独摇滚', '2026', ?, ?, ?)
  `).run(NOW, NOW, NOW);
  for (let episodeIndex = 1; episodeIndex <= 12; episodeIndex += 1) {
    sqlite.prepare(`
      INSERT INTO source_episodes (
        source_key, source_item_id, episode_index, title, video_url, updated_at
      ) VALUES ('ffzy', '100', ?, ?, ?, ?)
    `).run(episodeIndex, `第${episodeIndex}集`, `https://example.invalid/${episodeIndex}`, NOW);
  }
}

test("future detail, one-shot schedule, reverse match, and manual segments form one lifecycle", (t) => {
  const database = createTestDatabase();
  t.after(database.close);
  const { sqlite } = database;
  let now = new Date(NOW);
  const repository = createMappingRepository({ sqlite });
  const mappingService = createMappingService({ repository });
  const matcher = createAutoMatcher({ repository, mappingService, clock: () => now });
  const schedule = createScheduleService({
    repository,
    matchSubject: matcher.matchSubject,
    sourceKeys: ["ffzy"],
    clock: () => now,
  });

  seedSubject(sqlite, 1, { airDate: "2026-08-01", completed: false });
  initializeSource(sqlite);
  assert.equal(repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }), null);
  assert.deepEqual(repository.listSchedulesForSubject(1), []);

  sqlite.prepare(`
    UPDATE bangumi_subject_refresh_state
    SET last_succeeded_at = ? WHERE bangumi_id = 1
  `).run(NOW);
  schedule.reconcileSubject({ bangumiId: 1 });
  assert.deepEqual(repository.listSchedulesForSubject(1), [{
    bangumiId: 1,
    sourceKey: "ffzy",
    eligibleOn: "2026-08-01",
  }]);

  now = new Date("2026-08-01T04:00:00.000Z");
  assert.equal(schedule.runDue().results[0].status, "unmatched");
  assert.deepEqual(repository.listSchedulesForSubject(1), []);

  seedResource(sqlite);
  assert.equal(matcher.matchSourceItem({ sourceKey: "ffzy", sourceItemId: "100" }).status, "mapped");
  assert.equal(repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }).sourceItemId, "100");

  seedSubject(sqlite, 2, { airDate: "2026-08-01", completed: true });
  assert.notEqual(matcher.matchSubject({ bangumiId: 2, sourceKey: "ffzy" }).status, "mapped");

  mappingService.applyManualGroup({
    removals: [repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" })],
    upserts: [
      {
        bangumiId: 1,
        sourceKey: "ffzy",
        sourceItemId: "100",
        sourceEpisodeStart: 1,
        sourceEpisodeEnd: 6,
      },
      {
        bangumiId: 2,
        sourceKey: "ffzy",
        sourceItemId: "100",
        sourceEpisodeStart: 7,
        sourceEpisodeEnd: null,
      },
    ],
  });
  assert.equal(repository.listMappingsForSourceItem({ sourceKey: "ffzy", sourceItemId: "100" }).length, 2);
  assert.notEqual(matcher.matchSourceItem({ sourceKey: "ffzy", sourceItemId: "100" }).status, "mapped");
});
