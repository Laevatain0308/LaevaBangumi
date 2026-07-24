import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createMappingRepository } from "../src/mappings/mappingRepository.js";

const NOW = "2026-07-25T00:00:00.000Z";

function seedSubject(sqlite, {
  bangumiId,
  name = `Subject ${bangumiId}`,
  nameCn = null,
  airDate = "2026-01-01",
  platform = "TV",
  totalEpisodes = null,
  completed = true,
  aliases = [],
} = {}) {
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (
      bangumi_id, name, name_cn, air_date, platform, total_episodes,
      discovered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bangumiId, name, nameCn, airDate, platform, totalEpisodes, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO bangumi_subject_refresh_state (
      bangumi_id, last_succeeded_at, next_refresh_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(bangumiId, completed ? NOW : null, NOW, NOW);
  aliases.forEach((value, index) => {
    sqlite.prepare(`
      INSERT INTO bangumi_subject_infobox_entries (
        bangumi_id, entry_position, key, value_kind
      ) VALUES (?, ?, ?, 'scalar')
    `).run(bangumiId, index, value.key);
    sqlite.prepare(`
      INSERT INTO bangumi_subject_infobox_values (
        bangumi_id, entry_position, value_position, label, value
      ) VALUES (?, ?, 0, NULL, ?)
    `).run(bangumiId, index, value.value);
  });
}

function seedSourceItem(sqlite, {
  sourceItemId,
  title = `Source ${sourceItemId}`,
  year = "2026",
  complete = true,
  aliases = [],
  episodeCount = 1,
} = {}) {
  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, year, first_seen_at,
      last_fetched_at, detail_fetched_at
    ) VALUES ('ffzy', ?, ?, ?, ?, ?, ?)
  `).run(sourceItemId, title, year, NOW, NOW, complete ? NOW : null);
  for (const alias of aliases) {
    sqlite.prepare(`
      INSERT INTO source_item_aliases (source_key, source_item_id, alias)
      VALUES ('ffzy', ?, ?)
    `).run(sourceItemId, alias);
  }
  for (let index = 1; index <= episodeCount; index += 1) {
    sqlite.prepare(`
      INSERT INTO source_episodes (
        source_key, source_item_id, episode_index, title, video_url, updated_at
      ) VALUES ('ffzy', ?, ?, ?, ?, ?)
    `).run(sourceItemId, index, `Episode ${index}`, `https://example.invalid/${sourceItemId}/${index}`, NOW);
  }
}

function createFixture(t) {
  const database = createTestDatabase();
  t.after(database.close);
  return { ...database, repository: createMappingRepository({ sqlite: database.sqlite }) };
}

test("mapping repository exposes normalized subject and resource matching facts", (t) => {
  const { sqlite, repository } = createFixture(t);
  seedSubject(sqlite, {
    bangumiId: 1,
    name: "Bocchi the Rock!",
    nameCn: "孤独摇滚！",
    totalEpisodes: 12,
    aliases: [
      { key: "别名", value: "ぼっち・ざ・ろっく！" },
      { key: "制作", value: "CloverWorks" },
    ],
  });
  seedSubject(sqlite, { bangumiId: 2, completed: false });
  seedSourceItem(sqlite, {
    sourceItemId: "100",
    title: "孤独摇滚",
    aliases: ["ぼっち・ざ・ろっく！"],
    episodeCount: 12,
  });

  assert.deepEqual(repository.findSubjectForMatching(1), {
    bangumiId: 1,
    name: "Bocchi the Rock!",
    nameCn: "孤独摇滚！",
    aliases: ["ぼっち・ざ・ろっく！"],
    airDate: "2026-01-01",
    platform: "TV",
    totalEpisodes: 12,
    detailCompleted: true,
  });
  assert.equal(repository.findSubjectForMatching(2).detailCompleted, false);
  assert.deepEqual(repository.listSubjectsForMatching().map(({ bangumiId }) => bangumiId), [1, 2]);

  assert.deepEqual(repository.findSourceItemForMatching({ sourceKey: "ffzy", sourceItemId: "100" }), {
    sourceKey: "ffzy",
    sourceItemId: "100",
    title: "孤独摇滚",
    aliases: ["ぼっち・ざ・ろっく！"],
    year: "2026",
    episodeCount: 12,
    detailCompleted: true,
  });
  assert.deepEqual(repository.listSourceItemsForMatching({ sourceKey: "ffzy" }).map(({ sourceItemId }) => sourceItemId), ["100"]);
});

test("mapping repository provides primitive mapping schedule and exclusion operations", (t) => {
  const { sqlite, repository } = createFixture(t);
  for (const bangumiId of [1, 2, 3]) seedSubject(sqlite, { bangumiId });
  for (const sourceItemId of ["100", "200", "300"]) seedSourceItem(sqlite, { sourceItemId });

  assert.equal(repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }), null);
  repository.insertMapping({
    bangumiId: 1,
    sourceKey: "ffzy",
    sourceItemId: "100",
    sourceEpisodeStart: null,
    sourceEpisodeEnd: null,
  });
  assert.equal(repository.hasSourceItemMapping({ sourceKey: "ffzy", sourceItemId: "100" }), true);
  assert.deepEqual(repository.listMappingsForSource("ffzy"), [{
    bangumiId: 1,
    sourceKey: "ffzy",
    sourceItemId: "100",
    sourceEpisodeStart: null,
    sourceEpisodeEnd: null,
  }]);
  assert.deepEqual(repository.listMappingsForSourceItem({ sourceKey: "ffzy", sourceItemId: "100" }), repository.listMappingsForSource("ffzy"));

  repository.upsertSchedule({ bangumiId: 2, sourceKey: "ffzy", eligibleOn: "2026-08-01" });
  assert.deepEqual(repository.listDueSchedules({ sourceKey: "ffzy", today: "2026-08-01" }), [
    { bangumiId: 2, sourceKey: "ffzy", eligibleOn: "2026-08-01" },
  ]);
  assert.deepEqual(repository.listSchedulesForSubject(2), [
    { bangumiId: 2, sourceKey: "ffzy", eligibleOn: "2026-08-01" },
  ]);
  assert.throws(
    () => repository.upsertSchedule({ bangumiId: 2, sourceKey: "ffzy", eligibleOn: "2026-02-30" }),
    /eligible_on.*complete date/i,
  );

  repository.insertExclusion({ bangumiId: 3, sourceKey: "ffzy", sourceItemId: "300" });
  assert.equal(repository.hasExclusion({ bangumiId: 3, sourceKey: "ffzy", sourceItemId: "300" }), true);
  repository.deleteExclusionsForSubject({ bangumiId: 3, sourceKey: "ffzy" });
  assert.equal(repository.hasExclusion({ bangumiId: 3, sourceKey: "ffzy", sourceItemId: "300" }), false);

  repository.deleteMapping({ bangumiId: 1, sourceKey: "ffzy" });
  repository.deleteSchedule({ bangumiId: 2, sourceKey: "ffzy" });
  assert.equal(repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }), null);
  assert.deepEqual(repository.listSchedulesForSubject(2), []);
});

test("mapping repository reports initialization and rolls transactions back", (t) => {
  const { sqlite, repository } = createFixture(t);
  seedSubject(sqlite, { bangumiId: 1 });
  seedSourceItem(sqlite, { sourceItemId: "100" });
  assert.equal(repository.isSourceInitialized("ffzy"), false);
  sqlite.prepare(`
    INSERT INTO source_sync_state (source_key, initialized, updated_at)
    VALUES ('ffzy', 1, ?)
  `).run(NOW);
  assert.equal(repository.isSourceInitialized("ffzy"), true);

  assert.throws(() => repository.transaction(() => {
    repository.insertMapping({
      bangumiId: 1,
      sourceKey: "ffzy",
      sourceItemId: "100",
      sourceEpisodeStart: null,
      sourceEpisodeEnd: null,
    });
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }), null);
});
