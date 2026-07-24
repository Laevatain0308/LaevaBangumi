import test from "node:test";
import assert from "node:assert/strict";
import { parseAirDate } from "../src/lib/airDate.js";
import { classifyAirDate } from "../src/mappings/airDateEligibility.js";

const NOW = new Date("2026-07-24T16:30:00.000Z");

test("parses only canonical real Bangumi air dates", () => {
  assert.deepEqual(parseAirDate(" 2026-07-25 "), {
    value: "2026-07-25",
    precision: "day",
    year: 2026,
    month: 7,
    day: 25,
  });
  assert.deepEqual(parseAirDate("2026-07"), {
    value: "2026-07",
    precision: "month",
    year: 2026,
    month: 7,
  });
  assert.deepEqual(parseAirDate("2026"), {
    value: "2026",
    precision: "year",
    year: 2026,
  });
  for (const invalid of [null, "", "0000", "0000-00-00", "2025-02-29", "2026-13", "2026-04-31"]) {
    assert.equal(parseAirDate(invalid), null, invalid);
  }
});

test("classifies dates against the Shanghai natural day", () => {
  assert.deepEqual(classifyAirDate("2026-07-25", NOW), {
    kind: "aired",
    precision: "day",
    eligibleOn: null,
  });
  assert.deepEqual(classifyAirDate("2026-07-26", NOW), {
    kind: "scheduled",
    precision: "day",
    eligibleOn: "2026-07-26",
  });
  assert.deepEqual(classifyAirDate("2026-06", NOW), {
    kind: "aired",
    precision: "month",
    eligibleOn: null,
  });
  assert.deepEqual(classifyAirDate("2026-07", NOW), {
    kind: "unknown",
    precision: "month",
    eligibleOn: null,
  });
  assert.equal(classifyAirDate("2025", NOW).kind, "aired");
  assert.equal(classifyAirDate("2026", NOW).kind, "unknown");
  assert.deepEqual(classifyAirDate("0000-00-00", NOW), {
    kind: "invalid",
    precision: null,
    eligibleOn: null,
  });
});
