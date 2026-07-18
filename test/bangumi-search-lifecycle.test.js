import test from "node:test";
import assert from "node:assert/strict";
import { findSubjectById, deleteSubjectById } from "../src/repositories/subjectRepository.js";
import { enrichFromBangumiSearch } from "../src/services/searchService.js";

test("search persists the exact fetched subjects in both metadata domains without refetching", async (t) => {
  const ids = [990571001, 990571002];
  t.after(() => ids.forEach((id) => deleteSubjectById(id)));
  const items = ids.map((id) => ({
    id,
    type: 2,
    name: `Search ${id}`,
    name_cn: `搜索 ${id}`,
    platform: "TV",
  }));
  let searchCalls = 0;
  const persisted = [];

  const result = await enrichFromBangumiSearch("搜索", {
    mediaType: "anime",
    searchSubjects: async () => {
      searchCalls += 1;
      return { data: items };
    },
    metadataService: {
      persistSearchResults(received) {
        persisted.push(received);
        return { received: received.length, persisted: received.length, rejected: 0 };
      },
    },
  });

  assert.equal(searchCalls, 1);
  assert.deepEqual(persisted, [items]);
  assert.equal(result.upserted, 2);
  assert.equal(findSubjectById(ids[0]).name_cn, `搜索 ${ids[0]}`);
  assert.equal(findSubjectById(ids[1]).name_cn, `搜索 ${ids[1]}`);
});

test("metadata persistence runs once after search even when the result is empty", async () => {
  const persisted = [];
  await enrichFromBangumiSearch("empty", {
    searchSubjects: async () => ({ data: [] }),
    metadataService: {
      persistSearchResults(items) { persisted.push(items); },
    },
  });
  assert.deepEqual(persisted, [[]]);
});
