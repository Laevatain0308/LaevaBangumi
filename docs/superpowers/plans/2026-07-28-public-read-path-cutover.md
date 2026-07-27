# LaevaBangumi Public Read Path Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch Search, Calendar, Detail, Play, and Updates to the normalized Bangumi, ResourceSource, and mapping domains, then remove the obsolete legacy read/write path without changing the Aslan API contract.

**Architecture:** Add one pure episode projection module, one read-only SQL repository, one public API service, and one runtime composer. Production injects that runtime into `createServer`; the three normalized write domains remain independent, and public reads only join their facts at request time.

**Tech Stack:** Node.js ES modules, Express 5, better-sqlite3, node:test, SQLite, existing Bangumi/ResourceSource/Mapping runtimes.

---

## File Structure

- `src/publicApi/episodeProjection.js`: pure mapping interval, episode numbering, channel ordering, and public source ID conversion.
- `src/publicApi/publicReadRepository.js`: all read-only SQL over normalized Bangumi, ResourceSource, and mapping tables.
- `src/publicApi/publicApiService.js`: Search, Calendar, Detail, Play, Updates, aliases, cover proxying, freshness, and resource-state policies.
- `src/runtime/publicApiRuntime.js`: compose repository/service with registered source descriptors and Bangumi metadata ensure.
- `src/server.js`: validate HTTP queries and delegate the five public endpoints to the injected runtime.
- `src/index.js`: construct the public runtime, inject it into the server, and route queued remote search persistence into the new Bangumi runtime.
- `src/resourceSources/ResourceSource.js`: require immutable `displayName` metadata beside `sourceKey`.
- `src/resourceSources/ffzy/FFZYSource.js`: identify FFZY publicly as `ffzy` / `非凡资源`.
- `src/resourceSources/ffzy/ffzyRepository.js`: preserve unchanged episode timestamps while replacing the current remote snapshot.
- `src/db/index.js` and `src/db/schema.js`: initialize and expose only normalized schemas.
- `test/public-episode-projection.test.js`: one-to-one, closed, open, gap, channel order, and reverse lookup behavior.
- `test/public-read-repository.test.js`: normalized SQL projections and read-only boundary.
- `test/public-api-service.test.js`: use-case policy tests independent of Express.
- `test/public-api-contract.test.js`: full HTTP contract tests against an isolated normalized database.
- Existing ResourceSource, FFZY, server, database, and architecture tests are updated in the task that changes their contract.

## Task 1: Stable ResourceSource Public Metadata

**Files:**
- Modify: `src/resourceSources/ResourceSource.js`
- Modify: `src/resourceSources/ffzy/FFZYSource.js`
- Modify: `test/resource-source-base.test.js`
- Modify: `test/resource-source-plugins.test.js`
- Modify: `test/ffzy-plugin.test.js`

- [ ] **Step 1: Write failing metadata contract tests**

Add assertions that a valid subclass must declare both getters and that instances expose immutable values:

```js
class CompleteSource extends TestSource {
  static get sourceKey() { return "complete"; }
  static get displayName() { return "完整采集站"; }
}

assert.equal(source.sourceKey, "complete");
assert.equal(source.displayName, "完整采集站");
assert.throws(() => { source.displayName = "changed"; }, TypeError);
assert.throws(
  () => assertResourceSourceClass(class MissingName extends ResourceSource {
    static get sourceKey() { return "missing-name"; }
  }),
  /displayName/,
);
```

Assert registry order and descriptors together:

```js
assert.deepEqual(registry.list().map(({ sourceKey, displayName }) => ({ sourceKey, displayName })), [
  { sourceKey: "first", displayName: "第一线路" },
  { sourceKey: "second", displayName: "第二线路" },
]);
```

- [ ] **Step 2: Run focused tests and verify the new assertions fail**

Run:

```bash
npm test -- --test-name-pattern='ResourceSource|resource source plugin|FFZY plugin'
```

Expected: FAIL because `displayName` is not validated or installed on instances.

- [ ] **Step 3: Add the immutable metadata contract**

In `ResourceSource`, add the static/instance metadata and validate an own read-only getter exactly like `sourceKey`:

```js
static get displayName() {
  return null;
}

// In constructor defineProperties:
displayName: {
  value: this.constructor.displayName,
  writable: false,
  configurable: false,
  enumerable: true,
},
```

In `assertResourceSourceClass` reject missing, blank, or padded names. In `assertResourceSourceInstance`, require equality with the subclass getter. Add to FFZY:

```js
static get displayName() {
  return "非凡资源";
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- --test-name-pattern='ResourceSource|resource source plugin|FFZY plugin'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resourceSources/ResourceSource.js src/resourceSources/ffzy/FFZYSource.js test/resource-source-base.test.js test/resource-source-plugins.test.js test/ffzy-plugin.test.js
git commit -m "feat: expose resource source display metadata"
```

## Task 2: Preserve FFZY Episode Change Timestamps

**Files:**
- Modify: `src/resourceSources/ffzy/ffzyRepository.js`
- Modify: `test/ffzy-repository.test.js`
- Modify: `test/ffzy-source-update.test.js`

- [ ] **Step 1: Write failing snapshot-diff tests**

Seed episodes at `2026-07-01T00:00:00.000Z`, advance the injected clock, and assert:

```js
repository.saveDetail(detailWithEpisodes([
  { episodeIndex: 1, title: "第01集", videoUrl: "https://example/1.m3u8" },
  { episodeIndex: 2, title: "第02集", videoUrl: "https://example/2.m3u8" },
]));

now = new Date("2026-07-02T00:00:00.000Z");
repository.saveDetail(detailWithEpisodes([
  { episodeIndex: 1, title: "第01集", videoUrl: "https://example/1.m3u8" },
  { episodeIndex: 2, title: "第二集", videoUrl: "https://example/2-fixed.m3u8" },
  { episodeIndex: 3, title: "第03集", videoUrl: "https://example/3.m3u8" },
]));

assert.deepEqual(readEpisodeTimes(), [
  [1, "2026-07-01T00:00:00.000Z"],
  [2, "2026-07-02T00:00:00.000Z"],
  [3, "2026-07-02T00:00:00.000Z"],
]);
```

Also assert an omitted remote episode is deleted, an identical refresh preserves every timestamp, and `matchingFactsChanged` still changes only for matching inputs (title, year, aliases, episode count).

- [ ] **Step 2: Run the FFZY repository/update tests and verify failure**

Run:

```bash
npm test -- --test-name-pattern='FFZY repository|FFZY update'
```

Expected: FAIL because `saveDetailWithChanges()` currently deletes all episodes and stamps every row with the new time.

- [ ] **Step 3: Replace delete-and-reinsert with snapshot reconciliation**

Before mutation, load the existing rows into a map keyed by `episode_index`. Upsert each remote row with its previous timestamp only when both title and URL are unchanged:

```js
const prior = existingEpisodes.get(item.episodeIndex);
const episodeUpdatedAt = prior
  && prior.title === item.title
  && prior.video_url === item.videoUrl
    ? prior.updated_at
    : now;
upsertEpisode.run(sourceKey, detail.sourceItemId, item.episodeIndex,
  item.title, item.videoUrl, episodeUpdatedAt);
```

Delete only rows whose indexes are absent from the new snapshot, using a prepared per-index delete inside the same transaction. Keep alias/item/failure updates transactional.

- [ ] **Step 4: Run FFZY tests**

Run:

```bash
npm test -- --test-name-pattern='FFZY repository|FFZY update|FFZY source'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resourceSources/ffzy/ffzyRepository.js test/ffzy-repository.test.js test/ffzy-source-update.test.js
git commit -m "fix: preserve unchanged FFZY episode timestamps"
```

## Task 3: Pure Mapping and Episode Projection

**Files:**
- Create: `src/publicApi/episodeProjection.js`
- Create: `test/public-episode-projection.test.js`

- [ ] **Step 1: Write failing pure-function tests**

Import these not-yet-created functions:

```js
import {
  containsSourceEpisode,
  displayEpisodeIndex,
  projectChannels,
  resolveSourceEpisodeIndex,
  toPublicSourceAid,
} from "../src/publicApi/episodeProjection.js";
```

Cover the exact interval behavior:

```js
assert.equal(displayEpisodeIndex(oneToOne, 13), 13);
assert.equal(displayEpisodeIndex({ sourceEpisodeStart: 13, sourceEpisodeEnd: 24 }, 13), 1);
assert.equal(displayEpisodeIndex({ sourceEpisodeStart: 25, sourceEpisodeEnd: null }, 27), 3);
assert.equal(containsSourceEpisode({ sourceEpisodeStart: 13, sourceEpisodeEnd: 24 }, 25), false);
assert.equal(resolveSourceEpisodeIndex({ sourceEpisodeStart: 13, sourceEpisodeEnd: 24 }, 12), 24);
assert.equal(resolveSourceEpisodeIndex({ sourceEpisodeStart: 13, sourceEpisodeEnd: 24 }, 13), null);
```

Feed mappings and episodes in deliberately shuffled order and assert `projectChannels` follows descriptor order, removes empty mapped sources before assigning `ch`, keeps source titles unchanged, exposes display/source indexes and play URLs, includes only episodes inside closed/open ranges, and leaves legal gaps empty.

Assert `toPublicSourceAid("ffzy", "123") === 123`, while unsafe/non-numeric IDs return `null`.

- [ ] **Step 2: Run the projection test and verify module-not-found failure**

Run:

```bash
node --import ./test/setup.js --test test/public-episode-projection.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the pure projection module**

Use normalized camel-case inputs:

```js
export function containsSourceEpisode(mapping, sourceIndex) {
  if (!Number.isInteger(sourceIndex) || sourceIndex < 1) return false;
  if (mapping.sourceEpisodeStart == null) return mapping.sourceEpisodeEnd == null;
  return sourceIndex >= mapping.sourceEpisodeStart
    && (mapping.sourceEpisodeEnd == null || sourceIndex <= mapping.sourceEpisodeEnd);
}

export function displayEpisodeIndex(mapping, sourceIndex) {
  if (!containsSourceEpisode(mapping, sourceIndex)) return null;
  return mapping.sourceEpisodeStart == null
    ? sourceIndex
    : sourceIndex - mapping.sourceEpisodeStart + 1;
}

export function resolveSourceEpisodeIndex(mapping, displayIndex) {
  if (!Number.isInteger(displayIndex) || displayIndex < 1) return null;
  const sourceIndex = mapping.sourceEpisodeStart == null
    ? displayIndex
    : mapping.sourceEpisodeStart + displayIndex - 1;
  return containsSourceEpisode(mapping, sourceIndex) ? sourceIndex : null;
}
```

`projectChannels({ bangumiId, sourceDescriptors, mappings })` finds one mapping per descriptor, filters/sorts that mapping's episodes by `sourceIndex`, computes display indexes, filters blank URLs, removes empty channels, then assigns 1-based `channelIndex`. Return plain data only; do not query or mutate a repository.

- [ ] **Step 4: Run the projection test**

Run:

```bash
node --import ./test/setup.js --test test/public-episode-projection.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/publicApi/episodeProjection.js test/public-episode-projection.test.js
git commit -m "feat: project mapped public episodes"
```

## Task 4: Normalized Public Read Repository

**Files:**
- Create: `src/publicApi/publicReadRepository.js`
- Create: `test/public-read-repository.test.js`
- Reuse: `test/helpers/testDatabase.js`

- [ ] **Step 1: Write repository contract tests against an isolated database**

Create a database with `initDb(sqlite)`, seed only normalized tables, and require:

```js
const repository = createPublicReadRepository(sqlite);
assert.equal(repository.findSubject(101).nameCn, "中文名");
assert.deepEqual(repository.listAliases(101), ["别名甲", "English Name"]);
assert.deepEqual(repository.searchSubjects({ query: "别名甲" }).map((row) => row.bangumiId), [101]);
assert.deepEqual(repository.searchSubjects({ tag: "原创" }).map((row) => row.bangumiId), [101]);
assert.deepEqual(repository.listCalendarSubjects().map((row) => row.weekday), [3]);
assert.equal(repository.listMappingsWithEpisodes(101)[0].episodes[0].sourceIndex, 13);
assert.equal(repository.listUpdateCandidates({ cutoffAt, nowAt })[0].sourceIndex, 25);
```

Use Infobox list plus scalar rows to prove aliases retain `entry_position/value_position`, exclude primary names, remove blanks/duplicates, and accept only `别名|中文名|日文名|英文名|原名|罗马字`.

Verify search keyword matching over `name`, `name_cn`, alias Infobox values, and tag names; exact tag filtering; stable ordering by votes descending, score descending, ID ascending.

- [ ] **Step 2: Run the repository test and verify failure**

Run:

```bash
node --import ./test/setup.js --test test/public-read-repository.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement normalized row readers**

Expose only these methods:

```js
return Object.freeze({
  findSubject,
  listAliases,
  searchSubjects,
  listCalendarSubjects,
  listMappingsWithEpisodes,
  listUpdateCandidates,
});
```

`findSubject` and list queries return the same camel-case shape:

```js
{
  bangumiId, name, nameCn, summary, airDate, airWeekday, platform,
  eps, totalEpisodes, updatedAt, detailSucceededAt, nextRefreshAt,
  coverUrl, ratingScore, rank, votes, votesCount, tags,
}
```

Build `votesCount` from `count_1` through `count_10`. Prefer image URLs in `large/common/medium/small/grid` order. Use `EXISTS` subqueries for keyword/tag matching to avoid duplicate subject rows. Escape `%`, `_`, and `\\` in LIKE patterns.

`listMappingsWithEpisodes(bangumiId)` returns one mapping object per row with all current source episodes nested. `listUpdateCandidates({ cutoffAt, nowAt })` uses a CTE to select each `(source_key, source_item_id)` row at `MAX(episode_index)`, filters that episode's timestamp to the inclusive window, and joins every mapping of the same source item. Each row includes its Bangumi ID, interval bounds, source title, maximum source episode, timestamp, and normalized subject fields. The service applies interval containment so a legal gap returns no update. Do not use `source_items.source_updated_at`.

Wrap the SQLite connection with an observing `prepare()` proxy in the test and assert every repository statement starts with `SELECT` or `WITH`; this module must not execute a write statement or expose a transaction.

- [ ] **Step 4: Run repository tests**

Run:

```bash
node --import ./test/setup.js --test test/public-read-repository.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/publicApi/publicReadRepository.js test/public-read-repository.test.js
git commit -m "feat: read normalized public anime facts"
```

## Task 5: Public API Use Cases and Runtime

**Files:**
- Create: `src/publicApi/publicApiService.js`
- Create: `src/runtime/publicApiRuntime.js`
- Create: `test/public-api-service.test.js`
- Modify: `src/dto/subjectDto.js`
- Modify: `src/dto/resourceDto.js`
- Modify: `test/dto-contract.test.js`

- [ ] **Step 1: Write failing service policy tests**

Build the service with a fake repository and descriptors:

```js
const service = createPublicApiService({
  repository,
  sourceDescriptors: [
    { sourceKey: "first", displayName: "第一线路" },
    { sourceKey: "ffzy", displayName: "非凡资源" },
  ],
  ensureMetadata(ids) { ensured.push(ids); },
  clock: () => new Date("2026-07-28T04:00:00.000Z"),
});
```

Test the five methods and exact result shapes expected by `server.js`:

```js
await service.search({ query, tag, mediaType });
await service.calendar();
await service.detail(bangumiId);
await service.play({ bangumiId, channelIndex, episodeIndex });
await service.updates({ days, limit, today, mediaType });
```

Required cases:

- Search returns local anime summaries and returns `[]` for every valid non-anime type.
- Calendar always returns seven weekday groups and derives latest display episode/time from projected channels.
- Detail calls `ensureMetadata([id])` once for both existing and missing IDs; missing returns `null`.
- Summary-only Detail returns empty aliases/tags/channels, nullable rating fields, and `freshness: "stale"`.
- Detail is `cache` only when `detailSucceededAt` is present and `nextRefreshAt` is later than the current instant; a due or summary-only row is `stale`. The existing Bangumi ensure mechanism queues refresh without blocking this read.
- Detail and Play share channel order and reverse closed/open segment indexes.
- Source states are only `ready`, `wait_airing`, `no_data`; `wait_airing` requires a complete future date in Asia/Shanghai.
- Aggregate status priority is `ready`, then `wait_airing`, then `no_data`.
- Updates assigns a shared resource's maximum current source episode only to the containing segment, assigns an open last segment, and returns no row when the maximum falls in a legal gap.
- Updates selects one card per Bangumi ID by newest episode time, then configured source order; returns the segment display number and original source metadata.
- `today=YYYY-MM-DD` ends at `23:59:59.999+08:00`; absent `today` uses the injected clock.

- [ ] **Step 2: Run service and DTO tests and verify failure**

Run:

```bash
node --import ./test/setup.js --test test/public-api-service.test.js test/dto-contract.test.js
```

Expected: FAIL because the service/runtime do not exist and DTOs do not yet accept the normalized shape completely.

- [ ] **Step 3: Make DTO formatters accept normalized camel-case rows**

Keep all existing public fields. Update Detail field access from hard-coded snake case to the existing normalization helper, and ensure missing rating produces:

```js
ratingScore: null,
rank: null,
votes: null,
votesCount: [],
tags: [],
aliases: [],
channels: [],
```

Do not add client fields or legacy aliases.

- [ ] **Step 4: Implement the public service and runtime composer**

Use `projectChannels` once per subject and reuse its mapping rules for Detail, Play, Calendar statistics, and status derivation. Use `parseAirDate` for future-date eligibility and construct the Shanghai natural date with:

```js
new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(clock());
```

Public runtime composition is intentionally small:

```js
export function createPublicApiRuntime({
  sqlite,
  resourceSourceRegistry,
  metadataEnsureService,
  clock = () => new Date(),
} = {}) {
  const sourceDescriptors = resourceSourceRegistry.list().map(({ sourceKey, displayName }) => ({
    sourceKey,
    displayName,
  }));
  const repository = createPublicReadRepository(sqlite);
  const service = createPublicApiService({
    repository,
    sourceDescriptors,
    ensureMetadata: metadataEnsureService.ensure,
    clock,
  });
  return Object.freeze({ repository, ...service });
}
```

Convert FFZY `sourceAid` at the projection boundary only; all internal queries keep `sourceItemId` as text. Apply `buildCoverProxyUrl({ id, sourceUrl })`, falling back to the source URL when no proxy configuration is present.

- [ ] **Step 5: Run service/DTO tests**

Run:

```bash
node --import ./test/setup.js --test test/public-api-service.test.js test/dto-contract.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/publicApi/publicApiService.js src/runtime/publicApiRuntime.js src/dto/subjectDto.js src/dto/resourceDto.js test/public-api-service.test.js test/dto-contract.test.js
git commit -m "feat: serve public anime views from normalized facts"
```

## Task 6: Inject the New Runtime into HTTP and Search Lifecycle

**Files:**
- Modify: `src/server.js`
- Modify: `src/index.js`
- Modify: `src/bangumi/metadataService.js`
- Create: `src/bangumi/searchQueue.js`
- Create: `test/public-api-contract.test.js`
- Modify: `test/api-contract.test.js`
- Modify: `test/bangumi-search-lifecycle.test.js`
- Modify: `test/account-api.test.js`
- Modify: `test/sync-api.test.js`

- [ ] **Step 1: Write normalized HTTP contract tests**

Create an isolated database, normalized registry descriptors, Bangumi runtime stub, and `publicApiRuntime`; pass both public and account runtimes to `createServer`. Seed only `bangumi_*`, `source_*`, and `bangumi_resource_mappings` rows.

Retain the current endpoint and envelope assertions for:

```text
GET /api/search?q=
GET /api/search?tag=
GET /api/calendar
GET /api/detail?id=
GET /api/play?id=&ch=&ep=
GET /api/updates?days=&limit=&today=
```

Add contract cases for one-to-one, closed segment, open segment, empty range, missing subject, missing episode, unsupported valid media type, invalid media type, and detail ensure. Assert no test inserts a legacy row.

- [ ] **Step 2: Run the new HTTP tests and verify failure**

Run:

```bash
node --import ./test/setup.js --test test/public-api-contract.test.js
```

Expected: FAIL because `createServer` still statically imports `services/anime.js`.

- [ ] **Step 3: Replace static public services with dependency injection**

Change the server signature to require/inject:

```js
export function createServer({
  publicApiRuntime,
  accountSyncRuntime,
  enqueueRemoteSearch = () => {},
  logger = { log, error },
} = {}) { /* routes */ }
```

Map routes directly:

```js
publicApiRuntime.calendar()
publicApiRuntime.updates({ days, limit, today, mediaType })
publicApiRuntime.search({ query: q, tag, mediaType })
publicApiRuntime.detail(id)
publicApiRuntime.play({ bangumiId: id, channelIndex: ch, episodeIndex: ep })
```

After returning local keyword search, call `enqueueRemoteSearch(q, { mediaType })`. Keep validation, HTTP statuses, error codes, heartbeat, health, Account, and Sync unchanged.

- [ ] **Step 4: Route remote search only into the new Bangumi domain**

Keep the existing `metadataService.searchAndPersist(keyword, { mediaType })`, but make its boundary explicit: only anime is remotely fetched, it invokes the existing Bangumi client once, normalizes/persists exact results with `persistSearchResults`, and lets that method register detail ensures and `onSubjectsPersisted` hooks. Valid non-anime searches return zero counts and do not call Bangumi.

Move the debounced/retrying search-only queue from `src/services/queue.js` to `src/bangumi/searchQueue.js`. Expose only `enqueueSearch`, `onSearchFlush`, and test-only queue stats; generic metadata/episode job registration belongs to the removed runtime and is not retained.

Compose production in this order:

```js
const bangumiRuntime = createBangumiRuntime(...);
const publicApiRuntime = createPublicApiRuntime({
  sqlite,
  resourceSourceRegistry,
  metadataEnsureService: bangumiRuntime.metadataEnsureService,
});
onSearchFlush((keyword, options) => bangumiRuntime.metadataService.searchAndPersist(keyword, options));
const app = createServer({
  publicApiRuntime,
  accountSyncRuntime,
  enqueueRemoteSearch: enqueueSearch,
  logger: { log, error },
});
```

- [ ] **Step 5: Run lifecycle and HTTP tests**

Run:

```bash
node --import ./test/setup.js --test test/public-api-contract.test.js test/bangumi-search-lifecycle.test.js test/account-api.test.js test/sync-api.test.js
```

Expected: PASS.

- [ ] **Step 6: Run the full suite before deleting anything**

Run:

```bash
npm test
```

Expected: all normalized/new-runtime tests pass; remaining failures identify tests coupled only to the old runtime and are handled in Task 7, not hidden by compatibility code.

- [ ] **Step 7: Commit**

```bash
git add src/server.js src/index.js src/bangumi/metadataService.js src/bangumi/searchQueue.js test/public-api-contract.test.js test/api-contract.test.js test/bangumi-search-lifecycle.test.js test/account-api.test.js test/sync-api.test.js
git commit -m "refactor: switch public routes to normalized runtime"
```

## Task 7: Remove the Legacy Runtime and Schema

**Files:**
- Modify: `src/db/index.js`
- Replace: `src/db/schema.js`
- Modify: `package.json`
- Delete: `config/cstations.json`
- Delete: `src/lib/cstationConfig.js`
- Delete: `src/clients/resourceClient.js`
- Delete: `src/clients/resourceSources/ffzyClient.js`
- Delete: `src/services/anime.js`
- Delete legacy-only modules under `src/services/`, `src/repositories/`, `src/normalizers/`, and `src/scripts/` only after import-graph proof.
- Delete legacy-only tests under `test/` only after their replacement coverage is identified.
- Modify: `test/db-migration.test.js`
- Modify: `test/normalized-architecture.test.js`
- Modify: `test/service-layering.test.js`
- Modify: `test/setup.js`

- [ ] **Step 1: Add failing clean-schema and architecture assertions**

Open a new temporary database, call `initDb(connection)`, and assert the exact table set contains normalized domain tables plus SQLite internals, and excludes:

```js
const forbiddenTables = [
  "anime_other", "subjects", "subject_aliases", "tags", "subject_tags",
  "resource_sources", "resource_items", "resource_mappings", "episodes",
  "sync_state", "retry_state", "manual_resource_state",
];
```

Add static scans asserting production `src/` and `package.json` do not reference `cstations.json`, `services/anime.js`, legacy management scripts, or forbidden SQL table names. Permit occurrences in historical ignored docs only.

- [ ] **Step 2: Run architecture/database tests and verify failure**

Run:

```bash
node --import ./test/setup.js --test test/db-migration.test.js test/normalized-architecture.test.js test/service-layering.test.js
```

Expected: FAIL because `initDb()` defaults to legacy creation and legacy production imports/scripts remain.

- [ ] **Step 3: Remove legacy database initialization**

Reduce `initDb` to exactly:

```js
export function initDb(connection = sqlite) {
  initResourceSourceSchema(connection);
  initBangumiMetadataSchema(connection);
  initMappingSchema(connection);
  initAccountSyncSchema(connection);
}
```

Delete `initLegacySchema`, `initLegacyDb`, migration helpers, recommended old indexes, and the `legacy` option. Delete every legacy declaration from `src/db/schema.js` and retain the Account/Sync Drizzle declarations used by `test/account-sync-schema.test.js`. Remove Drizzle construction and the `db` export from `src/db/index.js`; every live runtime uses the injected better-sqlite3 connection.

- [ ] **Step 4: Prove and delete unreachable legacy modules in batches**

Before each deletion batch run:

```bash
rg -n "services/(anime|animeShared|airingStateService|calendarService|catalog|detailService|episodeRefreshService|manualMatches|metadataRefreshService|playService|prewarmService|resourceMatchService|resourceStateService|retryService|searchService|subjectSyncService|updateService)|repositories/(episodeRepository|resourceRepository|subjectRepository|syncRepository|tagRepository)|normalizers/(bangumiCalendarNormalizer|bangumiSubjectNormalizer|resourceItemNormalizer)|clients/resource(Client|Sources/ffzyClient)" src test package.json
```

Delete only modules whose remaining importers are also in the same legacy batch. The batch includes old subject/resource/episode repositories; old catalog, match, retry, manual state, episode refresh, prewarm, legacy metadata/calendar/search/detail/play/update facade services; old CSV review and AI pack scripts; old resource clients/normalizers; and their superseded tests. Preserve `src/clients/bangumiClient.js` because the normalized Bangumi client adapter still delegates HTTP transport to it. Delete `src/services/queue.js` after Task 6 moves search queuing to `src/bangumi/searchQueue.js`.

- [ ] **Step 5: Remove legacy package commands and configuration**

Remove:

```json
"prewarm:anime",
"export:manual-review",
"import:manual-review",
"export:mapped-review",
"import:mapped-review",
"export:ai-match-pack",
"validate:ai-match-suggestions"
```

Keep `start`, `start:sync`, `account`, `mapping:analyze`, and the new XLSX `mapping` command. Delete `config/cstations.json` and its reader after the import scan is empty.

- [ ] **Step 6: Run the full suite and static scan**

Run:

```bash
npm test
rg -n "\\b(subjects|subject_aliases|resource_mappings|episodes|retry_state|manual_resource_state)\\b|cstations\\.json|services/anime\\.js" src package.json
```

Expected: all tests PASS; scan returns no legacy runtime/schema reference. New normalized names such as `bangumi_subjects`, `bangumi_resource_mappings`, and `source_episodes` are not forbidden by the word-boundary expression.

- [ ] **Step 7: Commit**

```bash
git add -A src config package.json test
git commit -m "refactor: remove legacy anime runtime"
```

## Task 8: Full Verification and Cold-Start Acceptance

**Files:**
- Create: `test/cold-start-runtime.test.js`
- Verify: normalized runtime implementation files changed by Tasks 1-7

- [ ] **Step 1: Add deterministic cold-start integration coverage**

Against a fresh temporary SQLite file:

1. initialize all four normalized domains;
2. construct registry, Mapping, Bangumi, Account/Sync, and Public API runtimes;
3. persist a Bangumi calendar/search summary and complete detail through the Bangumi service;
4. save an FFZY catalog/detail through the plugin repository;
5. create an automatic one-to-one mapping through Mapping runtime;
6. request Search, Calendar, Detail, Play, and Updates through Public API runtime;
7. assert the database contains no forbidden legacy tables.

Use fake clients for this deterministic test; it verifies composition and lifecycle without external availability.

- [ ] **Step 2: Run targeted integration and full verification**

Run:

```bash
node --import ./test/setup.js --test test/cold-start-runtime.test.js test/public-api-contract.test.js
npm test
git diff --check
```

Expected: targeted integration PASS, full suite PASS, and no whitespace errors.

- [ ] **Step 3: Start production composition on a separate temporary database**

Choose an unused `/tmp/laeva-public-cutover-*.db` path before starting. Run on a non-production port with the user's local test proxy:

```bash
LAEVA_DB_PATH=/tmp/laeva-public-cutover-acceptance.db PORT=3302 BANGUMI_PROXY_URL=http://127.0.0.1:7897 npm run start:sync
```

Observe initialization long enough to capture Bangumi and FFZY success or a concrete external network/proxy failure. Query `/api/health`, then any locally available Search/Calendar response. Never point this check at `data/anime.db`. Remove the temporary database only after stopping the process and only if it was created by this acceptance step.

- [ ] **Step 4: Record acceptance evidence and inspect the final diff**

Run:

```bash
git status --short
git diff --stat master...HEAD
git log --oneline master..HEAD
```

Confirm no Aslan/client files changed, no user-owned document deletion is included, and commits match Tasks 1-8.

- [ ] **Step 5: Commit the integration test and any diagnostic fix**

Stage `test/cold-start-runtime.test.js` plus only the exact implementation/test files changed to resolve an acceptance defect:

```bash
git add test/cold-start-runtime.test.js
git commit -m "test: verify normalized runtime cold start"
```

If a production file changed, include that concrete path in `git add` and describe the fix in the commit message.

## Task 9: Review and Merge

**Files:**
- Review only: all files changed on `feat/public-read-path-cutover`

- [ ] **Step 1: Review correctness against the design**

Check every section of `docs/superpowers/specs/2026-07-28-public-read-path-cutover-design.md` against code and tests. Pay particular attention to shared-resource seasonal ownership, empty channel filtering before `ch`, Detail/Play reverse mapping, Shanghai date boundaries, and unchanged FFZY timestamps.

- [ ] **Step 2: Re-run final verification after review fixes**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected: all tests pass; no whitespace errors; only intended branch changes are present.

- [ ] **Step 3: Merge without touching the user's existing deletions**

From the main worktree, merge the feature branch with a normal non-destructive merge. Verify the two pre-existing deleted documentation paths remain unstaged and are not restored or included in feature commits.

```bash
git merge --no-ff feat/public-read-path-cutover
git status --short --branch
```

Expected: merge succeeds; the only pre-existing uncommitted entries remain the user's two deleted docs.
