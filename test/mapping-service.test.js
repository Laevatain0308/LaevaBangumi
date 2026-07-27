import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createMappingRepository } from "../src/mappings/mappingRepository.js";
import {
  createMappingService,
  MappingConflictError,
  MappingValidationError,
} from "../src/mappings/mappingService.js";

const NOW = "2026-07-25T00:00:00.000Z";

function seedSubject(sqlite, bangumiId) {
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (bangumi_id, name, discovered_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(bangumiId, `Subject ${bangumiId}`, NOW, NOW);
}

function seedSourceItem(sqlite, sourceItemId) {
  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, first_seen_at, last_fetched_at
    ) VALUES ('ffzy', ?, ?, ?, ?)
  `).run(sourceItemId, `Source ${sourceItemId}`, NOW, NOW);
}

function createFixture(t) {
  const database = createTestDatabase();
  t.after(database.close);
  for (let id = 1; id <= 20; id += 1) seedSubject(database.sqlite, id);
  for (const id of ["100", "200", "300", "400", "500", "600"]) {
    seedSourceItem(database.sqlite, id);
  }
  const repository = createMappingRepository({ sqlite: database.sqlite });
  return {
    ...database,
    repository,
    service: createMappingService({ repository }),
  };
}

function oneToOne(bangumiId, sourceItemId) {
  return {
    bangumiId,
    sourceKey: "ffzy",
    sourceItemId,
    sourceEpisodeStart: null,
    sourceEpisodeEnd: null,
  };
}

function segment(bangumiId, sourceItemId, sourceEpisodeStart, sourceEpisodeEnd) {
  return {
    bangumiId,
    sourceKey: "ffzy",
    sourceItemId,
    sourceEpisodeStart,
    sourceEpisodeEnd,
  };
}

test("automatic mappings require both sides free and honor exact exclusions", (t) => {
  const { repository, service } = createFixture(t);
  assert.deepEqual(service.createAutomaticMapping({
    bangumiId: 1,
    sourceKey: "ffzy",
    sourceItemId: "100",
  }), { status: "created" });
  assert.deepEqual(service.createAutomaticMapping({
    bangumiId: 1,
    sourceKey: "ffzy",
    sourceItemId: "200",
  }), { status: "skipped", reason: "bangumi_mapped" });
  assert.deepEqual(service.createAutomaticMapping({
    bangumiId: 2,
    sourceKey: "ffzy",
    sourceItemId: "100",
  }), { status: "skipped", reason: "source_item_mapped" });

  repository.insertExclusion({ bangumiId: 3, sourceKey: "ffzy", sourceItemId: "300" });
  assert.deepEqual(service.createAutomaticMapping({
    bangumiId: 3,
    sourceKey: "ffzy",
    sourceItemId: "300",
  }), { status: "skipped", reason: "excluded" });
  assert.deepEqual(service.createAutomaticMapping({
    bangumiId: 4,
    sourceKey: "ffzy",
    sourceItemId: "300",
  }), { status: "created" });
  assert.equal(repository.hasExclusion({ bangumiId: 3, sourceKey: "ffzy", sourceItemId: "300" }), false);
});

test("manual mappings allow gaps but reject overlaps and non-final open segments atomically", (t) => {
  const { repository, service } = createFixture(t);
  assert.deepEqual(service.applyManualGroup({
    removals: [],
    upserts: [
      segment(1, "500", 1, 12),
      segment(2, "500", 14, null),
    ],
  }), { status: "applied", removed: 0, upserted: 2 });

  assert.throws(() => service.applyManualGroup({
    removals: [],
    upserts: [segment(3, "500", 10, 15)],
  }), (error) => error instanceof MappingValidationError && error.code === "interval_overlap");
  assert.deepEqual(repository.listMappingsForSourceItem({ sourceKey: "ffzy", sourceItemId: "500" }), [
    segment(1, "500", 1, 12),
    segment(2, "500", 14, null),
  ]);

  assert.throws(() => service.applyManualGroup({
    removals: [segment(2, "500", 14, null)],
    upserts: [
      segment(2, "500", 14, null),
      segment(3, "500", 26, 30),
    ],
  }), (error) => error instanceof MappingValidationError && error.code === "open_segment_not_last");
  assert.equal(repository.findMapping({ bangumiId: 3, sourceKey: "ffzy" }), null);
});

test("manual segmented writes replace a one-to-one occupant but never existing segments", (t) => {
  const { repository, service } = createFixture(t);
  repository.insertMapping(oneToOne(1, "500"));

  service.applyManualGroup({
    removals: [],
    upserts: [
      segment(2, "500", 1, 12),
      segment(3, "500", 14, null),
    ],
  });
  assert.equal(repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }), null);
  assert.deepEqual(repository.listMappingsForSourceItem({ sourceKey: "ffzy", sourceItemId: "500" }), [
    segment(2, "500", 1, 12),
    segment(3, "500", 14, null),
  ]);

  assert.throws(() => service.applyManualGroup({
    removals: [],
    upserts: [oneToOne(4, "500")],
  }), (error) => error instanceof MappingValidationError && error.code === "source_item_segment_conflict");
  assert.equal(repository.findMapping({ bangumiId: 4, sourceKey: "ffzy" }), null);
});

test("manual deletion creates only live exact exclusions and new mappings clear stale ones", (t) => {
  const { repository, service } = createFixture(t);
  repository.insertMapping(oneToOne(1, "100"));
  service.applyManualGroup({ removals: [oneToOne(1, "100")], upserts: [] });
  assert.equal(repository.hasExclusion({ bangumiId: 1, sourceKey: "ffzy", sourceItemId: "100" }), true);

  service.applyManualGroup({ removals: [], upserts: [oneToOne(1, "200")] });
  assert.equal(repository.hasExclusion({ bangumiId: 1, sourceKey: "ffzy", sourceItemId: "100" }), false);

  service.applyManualGroup({ removals: [oneToOne(1, "200")], upserts: [oneToOne(2, "200")] });
  assert.equal(repository.hasExclusion({ bangumiId: 1, sourceKey: "ffzy", sourceItemId: "200" }), false);
  assert.deepEqual(repository.findMapping({ bangumiId: 2, sourceKey: "ffzy" }), oneToOne(2, "200"));
});

test("optimistic expectations are checked inside the write transaction", (t) => {
  const { repository, service } = createFixture(t);
  repository.insertMapping(oneToOne(1, "100"));

  assert.throws(() => service.applyManualGroup({
    expectedMappings: [{ bangumiId: 1, sourceKey: "ffzy", mapping: oneToOne(1, "200") }],
    removals: [oneToOne(1, "100")],
    upserts: [oneToOne(1, "300")],
  }), (error) => error instanceof MappingConflictError && error.code === "mapping_changed");
  assert.deepEqual(repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }), oneToOne(1, "100"));

  assert.throws(() => service.applyManualGroup({
    expectedMappings: [{ bangumiId: 2, sourceKey: "ffzy", mapping: oneToOne(2, "100") }],
    removals: [],
    upserts: [oneToOne(2, "300")],
  }), MappingConflictError);
  assert.equal(repository.findMapping({ bangumiId: 2, sourceKey: "ffzy" }), null);
});

test("invalid references and intervals use stable validation codes", (t) => {
  const { service } = createFixture(t);
  assert.throws(() => service.applyManualGroup({
    removals: [],
    upserts: [segment(1, "100", null, 12)],
  }), (error) => error instanceof MappingValidationError && error.code === "invalid_interval");
  assert.throws(() => service.applyManualGroup({
    removals: [],
    upserts: [oneToOne(999, "100")],
  }), (error) => error instanceof MappingValidationError && error.code === "missing_reference");
  assert.throws(() => service.applyManualGroup({
    removals: [],
    upserts: [oneToOne(1, "missing")],
  }), (error) => error instanceof MappingValidationError && error.code === "missing_reference");
});
