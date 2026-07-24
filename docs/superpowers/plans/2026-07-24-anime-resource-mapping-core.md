# Anime Resource Mapping Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the new local-only Bangumi-to-resource mapping domain, including strict mapping invariants, deterministic automatic matching, airing-date scheduling, and bidirectional Bangumi/resource triggers.

**Architecture:** Add three independent mapping-domain tables and an injected `src/mappings/` runtime. Bangumi and ResourceSource publish successful fact changes through callbacks; the mapping runtime reads only normalized local tables, calculates deterministic matches, and writes mappings through one transactional service.

**Tech Stack:** Node.js ESM, better-sqlite3, Drizzle SQLite schema declarations, node:test, node-cron, he, opencc-js.

---

## Execution Notes

- Work in `/Users/laevatain/Documents/Code/LaevaBangumi`.
- Preserve the existing uncommitted `tid=30` changes in `src/resourceSources/ffzy/FFZYSource.js`, `test/ffzy-source-initialize.test.js`, and `test/ffzy-source-update.test.js`. Task 9 must layer mapping changes on those edits and stage only intended hunks.
- Do not restore or include the existing deletions of the two 2026-06-03 documents.
- Do not read, migrate, or write legacy mapping tables.
- Do not run tests against `data/anime.db`; all tests use temporary or in-memory databases.
- Complete this plan before starting `docs/superpowers/plans/2026-07-24-anime-resource-mapping-workbook.md`.

## File Map

New production files:

- `src/db/mappingSchema.js`: creates the three mapping-domain tables and indexes.
- `src/lib/airDate.js`: validates normalized Bangumi date strings without timezone conversion.
- `src/mappings/config.js`: central matching thresholds and schedule constants.
- `src/mappings/airDateEligibility.js`: classifies `air_date` against the Shanghai natural day.
- `src/mappings/titleNormalizer.js`: builds weighted title variants and structured season/part/form semantics.
- `src/mappings/mappingRepository.js`: injected SQLite facts, mapping, schedule, and exclusion queries/writes.
- `src/mappings/mappingService.js`: transactional automatic and authoritative manual mapping operations.
- `src/mappings/autoMatcher.js`: hard filters, deterministic name scoring, reciprocal-best selection, and live failure reasons.
- `src/mappings/scheduleService.js`: reconciles subjects with one-shot schedules and drains due rows.
- `src/mappings/mappingRuntime.js`: binds Bangumi, ResourceSource, matcher, schedule, cron, and startup behavior.

Modified production files:

- `src/db/index.js`: initializes the mapping schema.
- `src/db/schema.js`: declares the three new tables for Drizzle consumers.
- `src/bangumi/repository.js`: preserves an existing valid `air_date` when summary or detail data is absent or invalid.
- `src/bangumi/metadataService.js`: publishes successful search-summary and detail persistence without turning mapping failures into metadata failures.
- `src/bangumi/calendarService.js`: publishes successful Calendar-summary persistence after its transaction commits.
- `src/runtime/bangumiRuntime.js`: accepts and injects `onSubjectsPersisted` and `onDetailPersisted`.
- `src/resourceSources/contracts.js`: adds `changedItemIds` to source execution summaries.
- `src/resourceSources/ffzy/ffzyRepository.js`: reports IDs whose complete matching facts changed.
- `src/resourceSources/ffzy/FFZYSource.js`: returns changed complete resource IDs.
- `src/resourceSources/scheduler.js`: publishes successful source synchronization separately from collection success.
- `src/index.js`: creates and starts the mapping runtime and injects both event boundaries.
- `package.json`, `package-lock.json`: add `he` and `opencc-js`.
- `test/helpers/testDatabase.js`: initializes mapping tables in isolated tests.

## Task 1: Mapping Schema

**Files:**
- Create: `src/db/mappingSchema.js`
- Modify: `src/db/index.js:1-246`
- Modify: `src/db/schema.js`
- Modify: `test/helpers/testDatabase.js:1-13`
- Create: `test/mapping-schema.test.js`

- [ ] **Step 1: Write the failing schema test**

Create `test/mapping-schema.test.js` with assertions for exact columns, foreign keys, primary keys, and row-level checks:

```js
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initResourceSourceSchema } from "../src/db/resourceSourceSchema.js";
import { initBangumiMetadataSchema } from "../src/db/bangumiMetadataSchema.js";
import { initMappingSchema } from "../src/db/mappingSchema.js";

test("mapping schema creates the three isolated domain tables", () => {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  initResourceSourceSchema(sqlite);
  initBangumiMetadataSchema(sqlite);
  initMappingSchema(sqlite);

  const tables = sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'bangumi_resource_mappings', 'auto_match_schedule', 'auto_match_exclusions'
    ) ORDER BY name
  `).all().map(({ name }) => name);
  assert.deepEqual(tables, [
    "auto_match_exclusions",
    "auto_match_schedule",
    "bangumi_resource_mappings",
  ]);

  assert.throws(() => sqlite.prepare(`
    INSERT INTO bangumi_resource_mappings (
      bangumi_id, source_key, source_item_id,
      source_episode_start, source_episode_end
    ) VALUES (1, 'ffzy', '10', NULL, 12)
  `).run(), /CHECK constraint failed/);
  sqlite.close();
});
```

Add a second test that seeds one Bangumi subject and one source item, inserts valid one-to-one, closed segment, and open segment rows, and verifies a missing Bangumi/source reference fails with `FOREIGN KEY constraint failed`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/mapping-schema.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/db/mappingSchema.js`.

- [ ] **Step 3: Implement the schema**

Create `initMappingSchema(connection)` using the exact SQL approved in the design:

```js
export function initMappingSchema(connection) {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS bangumi_resource_mappings (
      bangumi_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_episode_start INTEGER,
      source_episode_end INTEGER,
      PRIMARY KEY (bangumi_id, source_key),
      FOREIGN KEY (bangumi_id)
        REFERENCES bangumi_subjects(bangumi_id),
      FOREIGN KEY (source_key, source_item_id)
        REFERENCES source_items(source_key, source_item_id),
      CHECK (
        (source_episode_start IS NULL AND source_episode_end IS NULL)
        OR (
          source_episode_start >= 1
          AND (source_episode_end IS NULL OR source_episode_end >= source_episode_start)
        )
      )
    );

    CREATE TABLE IF NOT EXISTS auto_match_schedule (
      bangumi_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      eligible_on TEXT NOT NULL,
      PRIMARY KEY (bangumi_id, source_key),
      FOREIGN KEY (bangumi_id) REFERENCES bangumi_subjects(bangumi_id)
    );

    CREATE TABLE IF NOT EXISTS auto_match_exclusions (
      bangumi_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      PRIMARY KEY (bangumi_id, source_key, source_item_id),
      FOREIGN KEY (bangumi_id) REFERENCES bangumi_subjects(bangumi_id),
      FOREIGN KEY (source_key, source_item_id)
        REFERENCES source_items(source_key, source_item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_bangumi_resource_mappings_source_item
      ON bangumi_resource_mappings(source_key, source_item_id);
    CREATE INDEX IF NOT EXISTS idx_auto_match_schedule_eligible
      ON auto_match_schedule(eligible_on, source_key, bangumi_id);
    CREATE INDEX IF NOT EXISTS idx_auto_match_exclusions_source_item
      ON auto_match_exclusions(source_key, source_item_id);
  `);
}
```

Import and call it from `initDb()`, declare matching Drizzle tables in `src/db/schema.js`, and add it to `createTestDatabase()` after Bangumi and ResourceSource schemas.

- [ ] **Step 4: Run focused schema tests**

Run:

```bash
node --import ./test/setup.js --test test/mapping-schema.test.js test/bangumi-metadata-schema.test.js test/resource-source-schema.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the schema**

```bash
git add src/db/mappingSchema.js src/db/index.js src/db/schema.js test/helpers/testDatabase.js test/mapping-schema.test.js
git commit -m "feat: add anime resource mapping schema"
```

## Task 2: Air-Date Validation and Preservation

**Files:**
- Create: `src/lib/airDate.js`
- Create: `src/mappings/airDateEligibility.js`
- Modify: `src/bangumi/repository.js:1-227`
- Create: `test/air-date-eligibility.test.js`
- Modify: `test/bangumi-metadata-repository.test.js:125-161`

- [ ] **Step 1: Write failing date-classification tests**

Create table-driven tests for full, month, year, invalid, and Shanghai-boundary inputs:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseAirDate } from "../src/lib/airDate.js";
import { classifyAirDate } from "../src/mappings/airDateEligibility.js";

const NOW = new Date("2026-07-24T16:30:00.000Z"); // 2026-07-25 in Shanghai

test("classifies normalized dates against the Shanghai natural day", () => {
  assert.deepEqual(classifyAirDate("2026-07-25", NOW), {
    kind: "aired", precision: "day", eligibleOn: null,
  });
  assert.deepEqual(classifyAirDate("2026-07-26", NOW), {
    kind: "scheduled", precision: "day", eligibleOn: "2026-07-26",
  });
  assert.equal(classifyAirDate("2026-06", NOW).kind, "aired");
  assert.equal(classifyAirDate("2026-07", NOW).kind, "unknown");
  assert.equal(classifyAirDate("2025", NOW).kind, "aired");
  assert.equal(classifyAirDate("2026", NOW).kind, "unknown");
  assert.equal(classifyAirDate("0000-00-00", NOW).kind, "invalid");
});
```

Add parser cases for surrounding whitespace normalization and impossible leap/month dates:

```js
assert.equal(parseAirDate(" 2026-07-25 ").value, "2026-07-25");
assert.equal(parseAirDate("2025-02-29"), null);
assert.equal(parseAirDate("2026-13"), null);
```

Extend the repository test so sparse/invalid Calendar or search summaries and sparse/invalid details keep an existing valid `airDate`, while a new valid summary or detail date replaces it. Assert this sequence explicitly:

```js
repository.mergeSearchResults([
  { subject: { bangumiId: 1, name: "Existing", airDate: "" } },
], { now: LATER });
assert.equal(repository.findById(1).subject.airDate, "2026-07-24");

repository.replaceDetail({
  subject: { bangumiId: 1, name: "Existing", airDate: "0000-00-00" },
}, { now: LATER, nextRefreshAt: NEXT });
assert.equal(repository.findById(1).subject.airDate, "2026-07-24");

repository.mergeSearchResults([
  { subject: { bangumiId: 1, name: "Existing", airDate: "2026-08" } },
], { now: LATER });
assert.equal(repository.findById(1).subject.airDate, "2026-08");
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import ./test/setup.js --test test/air-date-eligibility.test.js test/bangumi-metadata-repository.test.js
```

Expected: the new module is missing and the old sparse-detail assertion still reports `airDate === null`.

- [ ] **Step 3: Implement strict date parsing and Shanghai comparison**

Expose a common parser that rejects impossible calendar dates and `0000-00-00`:

```js
export function parseAirDate(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (/^\d{4}$/.test(text) && text !== "0000") {
    return { value: text, precision: "year", year: Number(text) };
  }
  if (/^\d{4}-\d{2}$/.test(text)) {
    const [year, month] = text.split("-").map(Number);
    if (year > 0 && month >= 1 && month <= 12) return { value: text, precision: "month", year, month };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (year > 0 && check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day) {
      return { value: text, precision: "day", year, month, day };
    }
  }
  return null;
}
```

Use `Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })` to derive comparison parts. Do not convert `air_date` itself into a timestamp.

Before `upsertSubject()` in both `mergeSummaryInternal()` and `replaceDetailInternal()`, replace a valid incoming `airDate` with `parseAirDate(value).value` and remove it when parsing rejects it. In `replaceDetailInternal()`, also omit `airDate` when the detail did not provide it; do not synthesize `null` in `detailSubject()`. This trims the canonical value and lets the existing `ON CONFLICT` update leave `air_date` unchanged while keeping the current full-replacement behavior for every other detail-owned nullable field.

- [ ] **Step 4: Run date and repository tests**

```bash
node --import ./test/setup.js --test test/air-date-eligibility.test.js test/bangumi-metadata-repository.test.js
```

Expected: all tests PASS, including valid-date replacement and invalid-date preservation.

- [ ] **Step 5: Commit date behavior**

```bash
git add src/lib/airDate.js src/mappings/airDateEligibility.js src/bangumi/repository.js test/air-date-eligibility.test.js test/bangumi-metadata-repository.test.js
git commit -m "fix: preserve normalized Bangumi airing dates"
```

## Task 3: Mapping Repository

**Files:**
- Create: `src/mappings/mappingRepository.js`
- Create: `test/mapping-repository.test.js`

- [ ] **Step 1: Write failing repository tests**

Seed normalized Bangumi/source facts and verify these exact injected repository methods:

```js
const repository = createMappingRepository({ sqlite });

assert.equal(repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }), null);
repository.insertMapping({
  bangumiId: 1,
  sourceKey: "ffzy",
  sourceItemId: "100",
  sourceEpisodeStart: null,
  sourceEpisodeEnd: null,
});
assert.equal(repository.hasSourceItemMapping({ sourceKey: "ffzy", sourceItemId: "100" }), true);

repository.upsertSchedule({ bangumiId: 2, sourceKey: "ffzy", eligibleOn: "2026-08-01" });
assert.deepEqual(repository.listDueSchedules({ sourceKey: "ffzy", today: "2026-08-01" }), [
  { bangumiId: 2, sourceKey: "ffzy", eligibleOn: "2026-08-01" },
]);
assert.throws(
  () => repository.upsertSchedule({ bangumiId: 2, sourceKey: "ffzy", eligibleOn: "2026-02-30" }),
  /eligible_on.*complete date/i,
);

repository.insertExclusion({ bangumiId: 3, sourceKey: "ffzy", sourceItemId: "300" });
assert.equal(repository.hasExclusion({ bangumiId: 3, sourceKey: "ffzy", sourceItemId: "300" }), true);
```

Also assert that `findSubjectForMatching()` returns names, infobox aliases, `airDate`, `totalEpisodes`, and completed-detail state; `findSourceItemForMatching()` returns aliases, year, episode count, and detail completeness.

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-repository.test.js
```

Expected: FAIL because `createMappingRepository` is missing.

- [ ] **Step 3: Implement injected facts and primitive writes**

Return one frozen repository with these method groups:

```js
return Object.freeze({
  transaction,
  findMapping,
  listMappingsForSource,
  listMappingsForSourceItem,
  hasSourceItemMapping,
  insertMapping,
  deleteMapping,
  findSubjectForMatching,
  listSubjectsForMatching,
  findSourceItemForMatching,
  listSourceItemsForMatching,
  isSourceInitialized,
  hasExclusion,
  insertExclusion,
  deleteExclusionsForSubject,
  deleteExclusionsForSourceItem,
  upsertSchedule,
  deleteSchedule,
  listDueSchedules,
  listSchedulesForSubject,
});
```

`transaction(callback)` must use a pre-created `sqlite.transaction(callback)` wrapper. `upsertSchedule()` must accept only a `parseAirDate()` result with `precision === "day"` and exact canonical value, so `eligible_on` can never contain a partial or impossible date. Fact queries must read only new `bangumi_*`, `source_*`, and mapping-domain tables. Infobox aliases are limited to keys matching `别名|中文名|英文名|日文名|原名|罗马字|放送译名`.

- [ ] **Step 4: Run repository tests**

```bash
node --import ./test/setup.js --test test/mapping-repository.test.js test/mapping-schema.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit repository primitives**

```bash
git add src/mappings/mappingRepository.js test/mapping-repository.test.js
git commit -m "feat: add mapping domain repository"
```

## Task 4: Transactional Mapping Service

**Files:**
- Create: `src/mappings/mappingService.js`
- Create: `test/mapping-service.test.js`

- [ ] **Step 1: Write failing invariant tests**

Cover automatic creation, one-to-one occupancy, segmented gaps, overlap, one open final segment, authoritative replacement, and exclusion lifecycle. Use the service API:

```js
const service = createMappingService({ repository });

assert.deepEqual(service.createAutomaticMapping({
  bangumiId: 1, sourceKey: "ffzy", sourceItemId: "100",
}), { status: "created" });

assert.deepEqual(service.createAutomaticMapping({
  bangumiId: 2, sourceKey: "ffzy", sourceItemId: "100",
}), { status: "skipped", reason: "source_item_mapped" });

service.applyManualGroup({
  removals: [],
  upserts: [
    { bangumiId: 10, sourceKey: "ffzy", sourceItemId: "500", sourceEpisodeStart: 1, sourceEpisodeEnd: 12 },
    { bangumiId: 11, sourceKey: "ffzy", sourceItemId: "500", sourceEpisodeStart: 14, sourceEpisodeEnd: null },
  ],
});
```

Assert `1-12` plus `14-open` succeeds, `10-15` plus `14-open` rolls back, and an open segment before a later closed segment rolls back. Assert deleting the only mapping inserts an exclusion, deleting one of several segments does not, and any new mapping clears stale exclusions for both occupied sides.

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-service.test.js
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the service around final-state validation**

Expose `createMappingService({ repository })` with the frozen methods `createAutomaticMapping(input)` and `applyManualGroup({ expectedMappings = [], removals, upserts })`. `expectedMappings` contains rows of the form below and is checked inside the same repository transaction as all deletes/inserts:

```js
{
  bangumiId: 10,
  sourceKey: "ffzy",
  mapping: {
    bangumiId: 10,
    sourceKey: "ffzy",
    sourceItemId: "500",
    sourceEpisodeStart: 1,
    sourceEpisodeEnd: 12,
  },
}
```

Use `mapping: null` for a workbook row that was unmapped at export time. If the current row differs field-for-field, throw `MappingConflictError` with code `mapping_changed` before changing any table. This is the workbook layer's optimistic concurrency boundary; it must not perform a separate check outside this transaction.

Inside `applyManualGroup`:

1. Capture every explicitly removed old mapping.
2. Delete requested mappings.
3. For each upsert, remove the existing `(bangumiId, sourceKey)` row.
4. If the target source item has one one-to-one occupant, remove it; if it has segments, retain them.
5. Insert proposed rows.
6. Load every affected source item final state and validate exclusivity, positive ranges, gaps allowed, no overlap, and one final open segment.
7. For each removed pair, insert an exclusion only if the original pair is absent and both original sides are free in final state.
8. For each inserted mapping, clear exclusions for its Bangumi side and source-item side.

Throw `MappingValidationError` with stable codes `invalid_interval`, `interval_overlap`, `open_segment_not_last`, `source_item_one_to_one_conflict`, `source_item_segment_conflict`, and `missing_reference`. Export both error classes so the workbook plan can distinguish conflicts from validation failures.

- [ ] **Step 4: Run service and repository tests**

```bash
node --import ./test/setup.js --test test/mapping-service.test.js test/mapping-repository.test.js
```

Expected: all tests PASS and rejected manual groups leave all involved tables unchanged.

- [ ] **Step 5: Commit transactional mapping behavior**

```bash
git add src/mappings/mappingService.js test/mapping-service.test.js
git commit -m "feat: enforce transactional mapping invariants"
```

## Task 5: Weighted Title Normalization

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/mappings/titleNormalizer.js`
- Create: `test/mapping-title-normalizer.test.js`

- [ ] **Step 1: Install the HTML decoder and local simplified-Chinese converter**

Run:

```bash
npm install he opencc-js
```

Expected: `package.json` and `package-lock.json` contain `he` and `opencc-js`; no existing dependency is upgraded.

- [ ] **Step 2: Write failing normalization tests**

Test HTML decoding, NFKC, punctuation, simplified/traditional conversion, safe Roman numeral variants, seasons, Part/Cour, forms, and title noise:

```js
const pool = buildTitlePool({
  primaryTitles: ["幼女戰記Ⅱ"],
  aliases: ["幼女战记 Season 2", "幼女戦記 第2期"],
});
assert.ok(pool.variants.some(({ text }) => text === "幼女战记2"));
assert.deepEqual([...pool.seasons], [2]);

assert.deepEqual(
  [...buildTitlePool({ primaryTitles: ["鎧真傳 第2クール"], aliases: [] }).parts],
  [2],
);
assert.equal(buildTitlePool({ primaryTitles: ["孤独摇滚总集篇"], aliases: [] }).variants.some(
  ({ text }) => text.includes("总集篇"),
), true);
```

Also assert `一念永恒` and `十万个冷笑话` are not numerically rewritten, while `Let&#039;s Go怪奇组` decodes correctly.

- [ ] **Step 3: Run tests and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-title-normalizer.test.js
```

Expected: FAIL because the module is missing.

- [ ] **Step 4: Implement immutable weighted pools**

Use `he.decode()` and `opencc-js` only in this module. Export:

```js
export function buildTitlePool({ primaryTitles, aliases }) {
  return Object.freeze({
    variants: Object.freeze([
      // { text, role: "primary" | "alias", exactWeight: 1 | 0.96, fuzzyWeight: 1 | 0.92 }
    ]),
    seasons: new Set(),
    parts: new Set(),
    forms: new Set(),
    coreTitles: Object.freeze([]),
  });
}
```

Keep full semantic variants and generate separate stripped recall variants. Do not mutate stored titles. Decode entities before normalization. Preserve `总集篇/recap`; only create an extra comparison variant for `合集/全集`.

- [ ] **Step 5: Run tests and commit**

```bash
node --import ./test/setup.js --test test/mapping-title-normalizer.test.js
git add package.json package-lock.json src/mappings/titleNormalizer.js test/mapping-title-normalizer.test.js
git commit -m "feat: normalize multilingual mapping titles"
```

Expected: tests PASS and the commit contains only the dependency and normalizer work.

## Task 6: Deterministic Reciprocal Auto Matcher

**Files:**
- Create: `src/mappings/config.js`
- Create: `src/mappings/autoMatcher.js`
- Create: `test/auto-matcher.test.js`

- [ ] **Step 1: Write failing hard-filter and score tests**

Define fixture subjects/resources and assert:

- Same valid year proceeds; different valid year returns `year_conflict`.
- Missing year requires a normalized full-title exact match.
- Explicit different seasons return `season_conflict`.
- One-sided Part/Cour returns `part_ambiguous`.
- Explicit different forms return `form_conflict`; one-sided form can continue.
- Resource episode count greater than known `totalEpisodes` returns `episode_overflow`.
- Incomplete detail or zero episodes is rejected.
- `0.80` score and `0.15` gaps are both required.
- Reciprocal ambiguity rejects a pair even when the subject direction is strong.

Use an injected facts fixture and service spy. Add a table of `explainSubject()` expectations so workbook reasons stay stable: `source_uninitialized`, `detail_incomplete`, `not_aired`, `air_date_unknown`, `no_resource`, `name_score_low`, `candidate_ambiguous`, `year_conflict`, `season_conflict`, `part_ambiguous`, `form_conflict`, `episode_overflow`, and `excluded`. When several conditions apply, assert the code from the earliest final rejection stage is returned.

Then verify the write path:

```js
const matcher = createAutoMatcher({
  repository: facts,
  mappingService: {
    createAutomaticMapping(input) { writes.push(input); return { status: "created" }; },
  },
});

const result = matcher.matchSubject({ bangumiId: 1, sourceKey: "ffzy" });
assert.deepEqual(result, {
  status: "mapped",
  bangumiId: 1,
  sourceKey: "ffzy",
  sourceItemId: "100",
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import ./test/setup.js --test test/auto-matcher.test.js
```

Expected: FAIL because matcher/config modules are missing.

- [ ] **Step 3: Implement centralized config and staged evaluation**

Create:

```js
export const AUTO_MATCH_MIN_NAME_SCORE = 0.80;
export const AUTO_MATCH_MIN_GAP = 0.15;
export const AUTO_MATCH_SCHEDULE_CRON = "5 0 * * *";
export const AUTO_MATCH_TIMEZONE = "Asia/Shanghai";
```

Expose matcher methods:

```js
return Object.freeze({
  matchSubject,
  matchSourceItem,
  explainSubject,
  scoreNamePools,
});
```

`scoreNamePools` must use exact equality, containment coverage, CJK n-gram overlap, and edit-distance ratio. Apply role weights once to the best name pair; never add scores for multiple aliases. Candidate retrieval and reverse ranking must use the same filters and score function.

`matchSubject` and `matchSourceItem` write only through `mappingService.createAutomaticMapping()`. `explainSubject` performs the same evaluation but never writes and returns `{ reason }` with one of the stable codes asserted in Step 1; it never returns candidates or scores.

- [ ] **Step 4: Run matcher tests**

```bash
node --import ./test/setup.js --test test/auto-matcher.test.js test/mapping-title-normalizer.test.js test/mapping-service.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the matcher**

```bash
git add src/mappings/config.js src/mappings/autoMatcher.js test/auto-matcher.test.js
git commit -m "feat: add reciprocal anime resource matcher"
```

## Task 7: One-Shot Airing Schedule Service

**Files:**
- Create: `src/mappings/scheduleService.js`
- Create: `test/mapping-schedule-service.test.js`

- [ ] **Step 1: Write failing reconciliation tests**

Cover these exact outcomes:

```js
assert.deepEqual(schedule.reconcileSubject({ bangumiId: 1 }), {
  bangumiId: 1,
  sources: [{ sourceKey: "ffzy", status: "scheduled", eligibleOn: "2026-08-01" }],
});
```

- No completed detail: no schedule and no match.
- Existing mapping: delete schedule and skip.
- Future full date: upsert schedule.
- Aired full/partial date: delete schedule and call `matchSubject` if source initialized.
- Current incomplete month/year: delete schedule and remain unknown.
- Due row with uninitialized source: retain schedule.
- Due row after an effective local attempt: delete schedule even when result is unmatched.
- Matcher/database throw: retain schedule and report failure.

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-schedule-service.test.js
```

Expected: FAIL because `scheduleService.js` is missing.

- [ ] **Step 3: Implement idempotent subject and due reconciliation**

Export `createScheduleService({ repository, matchSubject, sourceKeys, clock })` and return a frozen object containing `reconcileSubject({ bangumiId })`, `reconcileSource({ sourceKey })`, and `runDue({ sourceKey = null } = {})`.

Use `classifyAirDate` and the repository's completed-detail/source-initialized facts. Treat `{ status: "mapped" | "unmatched" | "skipped" }` as a completed local attempt only after the matcher returns normally.

- [ ] **Step 4: Run schedule tests**

```bash
node --import ./test/setup.js --test test/mapping-schedule-service.test.js test/air-date-eligibility.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit schedule behavior**

```bash
git add src/mappings/scheduleService.js test/mapping-schedule-service.test.js
git commit -m "feat: schedule one-shot airing matches"
```

## Task 8: Bangumi Fact Success Boundaries

**Files:**
- Modify: `src/bangumi/metadataService.js:12-141`
- Modify: `src/bangumi/calendarService.js:8-87`
- Modify: `src/runtime/bangumiRuntime.js:11-68`
- Modify: `test/bangumi-metadata-service.test.js`
- Modify: `test/bangumi-search-lifecycle.test.js`
- Modify: `test/bangumi-calendar-service.test.js`

- [ ] **Step 1: Write failing callback and discovery tests**

Add metadata tests proving search-summary/detail callback order and error isolation:

```js
const events = [];
const service = createBangumiMetadataService({
  client,
  repository: {
    ...repository,
    replaceDetail(value, options) {
      events.push("persisted");
      return repository.replaceDetail(value, options);
    },
  },
  onDetailPersisted(bangumiId) {
    events.push(`notified:${bangumiId}`);
    throw new Error("mapping unavailable");
  },
  logger,
});
await service.refreshDetail(1);
assert.deepEqual(events, ["persisted", "notified:1"]);
assert.equal(repository.findRefreshState(1).consecutiveFailures, 0);
```

For search, assert `onSubjectsPersisted([1, 2])` runs after `mergeSearchResults()` and before `ensureMetadata([1, 2])`; callback failure is logged but does not change `{ received, persisted, rejected }`. For Calendar, assert `onSubjectsPersisted([1, 2])` runs only after `replaceCalendarSnapshot()` succeeds. Ensure both tests still assert every accepted summary ID is passed to `ensureMetadata`, including future-dated subjects.

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import ./test/setup.js --test test/bangumi-metadata-service.test.js test/bangumi-search-lifecycle.test.js test/bangumi-calendar-service.test.js
```

Expected: callback assertions fail because `onSubjectsPersisted`/`onDetailPersisted` are not accepted or invoked.

- [ ] **Step 3: Publish only committed detail facts**

Add `onSubjectsPersisted = () => {}` to Calendar service, metadata service, and runtime options; add `onDetailPersisted = () => {}` to metadata service/runtime options. Invoke summary callbacks only after their summary transaction returns, and invoke the detail callback only after `repository.replaceDetail()` returns. Catch callback errors, log scope `bangumi-mapping-notify`, and preserve the successful Bangumi result. Do not mark mapping callback failure as a summary-sync or detail-fetch failure.

Keep existing Calendar/search `ensureMetadata` behavior and make tests explicit so later refactors cannot remove it.

- [ ] **Step 4: Run Bangumi tests**

```bash
node --import ./test/setup.js --test test/bangumi-metadata-service.test.js test/bangumi-calendar-service.test.js test/bangumi-search-lifecycle.test.js test/bangumi-detail-refresh.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the Bangumi boundary**

```bash
git add src/bangumi/metadataService.js src/bangumi/calendarService.js src/runtime/bangumiRuntime.js test/bangumi-metadata-service.test.js test/bangumi-search-lifecycle.test.js test/bangumi-calendar-service.test.js
git commit -m "feat: publish committed Bangumi facts"
```

## Task 9: Resource Change Boundary

**Files:**
- Modify: `src/resourceSources/contracts.js:1-223`
- Modify: `src/resourceSources/ffzy/ffzyRepository.js:89-317`
- Modify: `src/resourceSources/ffzy/FFZYSource.js:1-381`
- Modify: `src/resourceSources/scheduler.js:1-70`
- Modify: `test/resource-source-contracts.test.js`
- Modify: `test/resource-source-scheduler.test.js`
- Modify: `test/ffzy-source-initialize.test.js`
- Modify: `test/ffzy-source-update.test.js`

- [ ] **Step 1: Preserve and inspect existing FFZY edits**

Run:

```bash
git diff -- src/resourceSources/ffzy/FFZYSource.js test/ffzy-source-initialize.test.js test/ffzy-source-update.test.js
```

Expected: the existing `CATEGORY_IDS = ["30"]` and corresponding test changes are present. Keep them intact throughout this task.

- [ ] **Step 2: Write failing change-publication tests**

Extend execution summary fixtures with:

```js
changedItemIds: ["100", "200"],
```

Assert contract validation rejects empty IDs and returns a frozen, sorted, deduplicated array. Add repository tests proving catalog hydration detection remains separate from automatic-match fact detection:

```js
repository.listMatchableItemIds(["missing", "complete", "no-episodes"])
// => ["complete"]

repository.listChangedItemIds([{ ...catalogItem, sourceUpdatedAt: "2026-07-25T00:00:00.000Z" }])
// => ["100"] because the detail needs refreshing

repository.listChangedMatchFactItemIds([{ ...catalogItem, sourceUpdatedAt: "2026-07-25T00:00:00.000Z" }])
// => [] because title and year did not change
```

Extend `test/ffzy-repository.test.js` so `saveDetailWithChanges()` returns `{ savedEpisodes, matchingFactsChanged }`. Assert first complete detail, title change, alias-set change, year change, and episode-count change return `true`; changes only to episode titles/URLs return `false`. Assert a later detail replaces (rather than merges) aliases and episode rows, so alias deletion and episode-count reduction are visible in normalized facts.

Add scheduler tests showing a fulfilled initialization invokes `onSynchronized({ sourceKey, operation: "initialize", changedItemIds: [] })`, a fulfilled update forwards changed IDs, and callback failure is logged without changing the source result from `fulfilled`.

- [ ] **Step 3: Run tests and verify RED**

```bash
node --import ./test/setup.js --test test/resource-source-contracts.test.js test/resource-source-scheduler.test.js test/ffzy-source-initialize.test.js test/ffzy-source-update.test.js
```

Expected: failures for the missing summary key/repository method/callback.

- [ ] **Step 4: Implement changed complete resource reporting**

Add `changedItemIds` to `EXECUTION_SUMMARY_KEYS`; validate every element as a trimmed non-empty string, then deduplicate, sort, and freeze the returned array.

Add repository `saveDetailWithChanges(detail)`, which captures the old title/year/alias set/episode count, replaces the authoritative alias and episode sets in the existing detail transaction, and returns `{ savedEpisodes, matchingFactsChanged }`. First complete detail counts as changed; episode title or URL changes without a count change do not. Keep `saveDetail(detail)` as the public count-returning wrapper used by `ResourceSource.saveDetail()`.

Extend FFZY hydration state with `matchingFactsChangedItemIds`; after `saveDetailWithChanges()` succeeds, add the ID only when `matchingFactsChanged` is true. Add repository `listMatchableItemIds(ids)` that requires `detail_fetched_at IS NOT NULL` and at least one `source_episodes` row. Retain `listChangedItemIds()` for deciding which catalog items require detail hydration, and add `listChangedMatchFactItemIds()` that reports only new items or catalog title/year changes, not `source_updated_at`-only changes.

For initialization return `changedItemIds: []`; the mapping runtime performs subject-side reconciliation once initialization succeeds. For update, return the unique matchable union, filtered through `listMatchableItemIds()`, of:

- catalog IDs whose title or year actually changed;
- due failure IDs whose saved detail changed title, aliases, year, or episode count;
- catalog hydration IDs whose saved detail first became complete or changed those same matching facts.

This prevents a `source_updated_at`-only refresh or video-URL replacement from producing a redundant reverse-match event while ensuring removals from alias/episode collections are observable.

Add optional async `onSynchronized = () => {}` to `createResourceSourceScheduler`. Invoke it after a source operation succeeds, catch/log its failure separately, and preserve source collection success.

- [ ] **Step 5: Run tests and commit only intended hunks**

```bash
node --import ./test/setup.js --test test/resource-source-contracts.test.js test/resource-source-scheduler.test.js test/ffzy-source-initialize.test.js test/ffzy-source-update.test.js test/ffzy-repository.test.js
git add -p src/resourceSources/ffzy/FFZYSource.js test/ffzy-source-initialize.test.js test/ffzy-source-update.test.js
git add src/resourceSources/contracts.js src/resourceSources/ffzy/ffzyRepository.js src/resourceSources/scheduler.js test/resource-source-contracts.test.js test/resource-source-scheduler.test.js test/ffzy-repository.test.js
git diff --cached --check
git commit -m "feat: publish changed resource source items"
```

Expected: mapping-related hunks are committed; pre-existing unrelated working-tree hunks remain preserved unless the user explicitly asks to include them.

## Task 10: Mapping Runtime and Production Wiring

**Files:**
- Create: `src/mappings/mappingRuntime.js`
- Modify: `src/index.js:1-61`
- Create: `test/mapping-runtime.test.js`
- Modify: `test/resource-source-entrypoint.test.js`

- [ ] **Step 1: Write failing runtime tests**

Use injected stubs and fake cron to assert:

- `onDetailPersisted(id)` calls `scheduleService.reconcileSubject({ bangumiId: id })`.
- `onSubjectsPersisted(ids)` calls `scheduleService.reconcileSubject()` once per unique valid ID; subjects without a completed detail safely no-op.
- Source initialization calls `scheduleService.reconcileSource({ sourceKey })` once.
- Source update calls `autoMatcher.matchSourceItem()` once per unique changed ID and skips an empty list.
- `startup()` drains due schedules and performs one local reconciliation for each already initialized source, covering deployment onto an existing normalized resource database.
- `start()` registers `5 0 * * *` in `Asia/Shanghai`.

Expected runtime API:

```js
const runtime = createMappingRuntime({ sqlite, sourceKeys: ["ffzy"], cron, clock, logger });
runtime.onSubjectsPersisted([1, 2]);
runtime.onDetailPersisted(1);
await runtime.onSourceSynchronized({ sourceKey: "ffzy", operation: "update", changedItemIds: ["100"] });
await runtime.startup();
runtime.start();
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-runtime.test.js
```

Expected: FAIL because runtime is missing.

- [ ] **Step 3: Compose the injected runtime and wire startup**

`createMappingRuntime()` creates repository, service, matcher, and schedule service unless test doubles are injected. Its event methods catch per-item matcher errors, log them, and continue other IDs. `startup()` calls `scheduleService.runDue()` and then `reconcileSource()` once for each currently initialized source; this remains a process-start local database pass, not a periodic unmatched retry or a network operation.

Reorder `src/index.js` construction without changing external behavior:

```js
const sourceKeys = resourceSourceRegistry.list().map(({ sourceKey }) => sourceKey);
const mappingRuntime = createMappingRuntime({ sqlite, sourceKeys, cron, logger: { log, error } });
const resourceScheduler = createResourceSourceScheduler({
  registry: resourceSourceRegistry,
  cron,
  logger: { log, error },
  onSynchronized: mappingRuntime.onSourceSynchronized,
});
const bangumiRuntime = createBangumiRuntime({
  sqlite,
  cron,
  logger: { log, error },
  onSubjectsPersisted: mappingRuntime.onSubjectsPersisted,
  onDetailPersisted: mappingRuntime.onDetailPersisted,
});
```

Start the mapping cron and invoke `mappingRuntime.startup()` with a top-level `.catch()` log. Do not await it before the HTTP server starts.

- [ ] **Step 4: Run runtime and boundary tests**

```bash
node --import ./test/setup.js --test test/mapping-runtime.test.js test/resource-source-entrypoint.test.js test/bangumi-scheduler.test.js test/resource-source-scheduler.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit runtime wiring**

```bash
git add src/mappings/mappingRuntime.js src/index.js test/mapping-runtime.test.js test/resource-source-entrypoint.test.js
git commit -m "feat: wire automatic mapping lifecycle"
```

## Task 11: Core Integration and Read-Only Calibration Harness

**Files:**
- Create: `test/mapping-lifecycle.test.js`
- Create: `src/scripts/analyze-mapping-thresholds.js`
- Modify: `package.json`

- [ ] **Step 1: Write the end-to-end in-memory lifecycle test**

Build one test using real schemas/repository/service/matcher/schedule with no network:

1. Insert a future Bangumi summary and pending detail state.
2. Assert no mapping or schedule before first detail success.
3. Persist full detail with aliases and future `air_date`; reconcile and assert a schedule.
4. Advance the injected clock to the airing date; drain due schedules with no resource and assert the schedule is removed.
5. Insert a complete FFZY item afterward; call `matchSourceItem` and assert a one-to-one mapping.
6. Assert a second Bangumi cannot automatically claim the mapped source ID.
7. Manually replace the mapping with two non-overlapping segments and assert automatic matching never changes them.

- [ ] **Step 2: Run the lifecycle test and verify the assembled interfaces**

```bash
node --import ./test/setup.js --test test/mapping-lifecycle.test.js
```

Expected: PASS. If it fails, return to the task that owns the mismatched interface, make the smallest correction there, rerun that task's focused tests, and then rerun this lifecycle test. Do not add legacy-table bridges.

- [ ] **Step 3: Add a read-only calibration command**

Create a script that requires `--db`, opens it with `{ readonly: true, fileMustExist: true }`, never calls `initDb()`, and prints aggregate counts for thresholds without writing candidates:

```text
threshold=0.75 mapped=...
threshold=0.80 mapped=...
threshold=0.85 mapped=...
threshold=0.90 mapped=...
```

The script must use the production normalizer/matcher hard filters, accept `--source` and `--today`, and print a warning when completed Bangumi detail count is zero. Add package script:

```json
"mapping:analyze": "node src/scripts/analyze-mapping-thresholds.js"
```

- [ ] **Step 4: Run focused and full verification**

```bash
node --import ./test/setup.js --test test/mapping-*.test.js test/auto-matcher.test.js test/air-date-eligibility.test.js
npm test
```

Expected: all mapping tests and the complete suite PASS. Do not run the analyzer against production automatically.

- [ ] **Step 5: Commit the integration checkpoint**

```bash
git add test/mapping-lifecycle.test.js src/scripts/analyze-mapping-thresholds.js package.json
git commit -m "test: verify automatic mapping lifecycle"
```

## Core Completion Checkpoint

Before starting the workbook plan, verify:

```bash
git status --short
git log -11 --oneline
npm test
```

Expected:

- The complete suite passes.
- No mapping implementation is mixed with legacy tables.
- Existing unrelated working-tree changes remain preserved.
- The mapping service, matcher, schedule, and runtime are stable enough for the XLSX layer to consume.
