import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BangumiPayloadError,
  validateAnimeSubject,
  validateCalendarPayload,
} from "../src/bangumi/validation.js";
import { normalizeSubject } from "../src/bangumi/normalizer.js";

const fullFixture = JSON.parse(readFileSync(
  new URL("./fixtures/bangumi-metadata-subject-detail.json", import.meta.url),
  "utf8",
));

test("accepts only numeric Bangumi type 2", () => {
  assert.equal(validateAnimeSubject({ id: 1, type: 2, name: "Anime" }).type, 2);
  assert.throws(() => validateAnimeSubject({ id: 1, type: "2", name: "Anime" }), BangumiPayloadError);
  assert.throws(() => validateAnimeSubject({ id: 1, type: 6, name: "Person" }), BangumiPayloadError);
  assert.throws(() => validateAnimeSubject({ id: 0, type: 2, name: "Anime" }), BangumiPayloadError);
  assert.throws(
    () => validateAnimeSubject({ id: 1, type: 2, name: "Anime" }, { expectedId: 2 }),
    (error) => error.code === "id_mismatch",
  );
});

test("rejects malformed optional and nested subject fields", () => {
  assert.throws(
    () => validateAnimeSubject({ id: 1, type: 2, name: "Anime", eps: "12" }),
    (error) => error.path === "$.eps",
  );
  assert.throws(
    () => validateAnimeSubject({ id: 1, type: 2, name: "Anime", images: [] }),
    (error) => error.path === "$.images",
  );
  assert.throws(
    () => validateAnimeSubject({ id: 1, type: 2, name: "Anime", infobox: [{ key: "别名", value: [{ v: 3 }] }] }),
    (error) => error.path === "$.infobox[0].value[0].v",
  );
});

test("validates calendar containers before item validation", () => {
  assert.deepEqual(validateCalendarPayload([{ weekday: { id: 3 }, items: [{ type: "bad" }] }]), [
    { weekday: 3, items: [{ type: "bad" }] },
  ]);
  assert.throws(() => validateCalendarPayload({}), BangumiPayloadError);
  assert.throws(
    () => validateCalendarPayload([{ weekday: { id: 8 }, items: [] }]),
    (error) => error.path === "$[0].weekday.id",
  );
});

test("normalizes all relational metadata without raw JSON", () => {
  validateAnimeSubject(fullFixture);
  const normalized = normalizeSubject(fullFixture, { weekday: 5 });

  assert.deepEqual(normalized.subject, {
    bangumiId: 547888,
    name: "Raw Title",
    nameCn: "中文标题",
    summary: "简介",
    airDate: "2026-04-01",
    airWeekday: 3,
    platform: "TV",
    eps: 12,
    totalEpisodes: 12,
    volumes: 0,
    series: false,
    locked: false,
    nsfw: false,
  });
  assert.equal(Object.hasOwn(normalized.subject, "type"), false);
  assert.deepEqual(normalized.images, {
    largeUrl: "https://example.invalid/large.jpg",
    commonUrl: "https://example.invalid/common.jpg",
    mediumUrl: "https://example.invalid/medium.jpg",
    smallUrl: "https://example.invalid/small.jpg",
    gridUrl: "https://example.invalid/grid.jpg",
  });
  assert.deepEqual(normalized.rating, {
    score: 7.6,
    rank: 1234,
    total: 420,
    counts: [0, 0, 1, 2, 3, 10, 20, 30, 5, 1],
  });
  assert.deepEqual(normalized.collection, { wish: 100, collect: 200, doing: 30, onHold: 4, dropped: 5 });
  assert.deepEqual(normalized.tags, [
    { position: 0, name: "原创", count: 10, totalCount: 20 },
    { position: 1, name: "TV", count: 8, totalCount: 40 },
  ]);
  assert.deepEqual(normalized.metaTags, [
    { position: 0, name: "日本" },
    { position: 1, name: "原创" },
    { position: 2, name: "TV" },
  ]);
  assert.deepEqual(normalized.infobox[1], {
    entryPosition: 1,
    key: "别名",
    valueKind: "list",
    values: [
      { valuePosition: 0, label: null, value: "Alias B" },
      { valuePosition: 1, label: "英文名", value: "Alias C" },
    ],
  });
  assert.deepEqual(normalized.infobox[2].values, []);
});

test("preserves missing fields, explicit null, and calendar weekday fallback", () => {
  const missing = normalizeSubject({ id: 1, type: 2, name: "Anime" }, { weekday: 6 });
  assert.deepEqual(missing.subject, { bangumiId: 1, name: "Anime", airWeekday: 6 });
  assert.equal(missing.images, undefined);
  assert.equal(missing.tags, undefined);

  const explicitNull = normalizeSubject({
    id: 1,
    type: 2,
    name: "Anime",
    name_cn: null,
    images: null,
    rating: null,
    tags: null,
  });
  assert.equal(explicitNull.subject.nameCn, null);
  assert.equal(explicitNull.images, null);
  assert.equal(explicitNull.rating, null);
  assert.equal(explicitNull.tags, null);
});
