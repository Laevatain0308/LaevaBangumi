import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createBangumiRepository } from "../src/bangumi/repository.js";
import { createBangumiMetadataService } from "../src/bangumi/metadataService.js";

function anime(id) {
  return {
    id,
    type: 2,
    name: `Search ${id}`,
    name_cn: `搜索 ${id}`,
    platform: "TV",
  };
}

test("remote search persists exact results only in the normalized Bangumi domain", async (t) => {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const repository = createBangumiRepository(sqlite);
  const ensured = [];
  const persisted = [];
  let calls = 0;
  const service = createBangumiMetadataService({
    repository,
    client: {
      async search(keyword, options) {
        calls += 1;
        assert.equal(keyword, "搜索");
        assert.deepEqual(options, { mediaType: "anime" });
        return { data: [anime(990571001), anime(990571002)] };
      },
    },
    ensureMetadata(ids) { ensured.push(ids); },
    onSubjectsPersisted(ids) { persisted.push(ids); },
    clock: () => new Date("2026-07-28T00:00:00.000Z"),
  });

  const result = await service.searchAndPersist("搜索", { mediaType: "anime" });
  assert.equal(calls, 1);
  assert.deepEqual(result, { received: 2, persisted: 2, rejected: 0 });
  assert.equal(repository.findById(990571001).subject.nameCn, "搜索 990571001");
  assert.equal(repository.findById(990571002).subject.nameCn, "搜索 990571002");
  assert.deepEqual(ensured, [[990571001, 990571002]]);
  assert.deepEqual(persisted, [[990571001, 990571002]]);
});

test("valid non-anime search never calls Bangumi or writes metadata", async (t) => {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  const repository = createBangumiRepository(sqlite);
  let calls = 0;
  const service = createBangumiMetadataService({
    repository,
    client: { async search() { calls += 1; return { data: [anime(1)] }; } },
  });

  assert.deepEqual(await service.searchAndPersist("搜索", { mediaType: "tv" }), {
    received: 0,
    persisted: 0,
    rejected: 0,
  });
  assert.equal(calls, 0);
  assert.equal(repository.findById(1), null);
});
