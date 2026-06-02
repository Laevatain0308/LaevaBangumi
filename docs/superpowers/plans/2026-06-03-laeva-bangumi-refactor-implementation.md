# LaevaBangumi Data Contract Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild LaevaBangumi around `bangumi_id` as the canonical identifier, expose the new stable Aslan/LaevaAnime API contract without legacy fields, and update both clients to consume that contract.

**Architecture:** Split the current monolithic service behavior into schema/migration, repositories, DTO builders, and route-level services while preserving existing endpoint paths. Local test databases may be rebuilt from scratch; deployed databases must use idempotent migrations that copy old data into the new normalized tables.

**Tech Stack:** Node.js ESM, Express 5, better-sqlite3, drizzle-orm, `node --test`; Flutter/Dart for Aslan; React/TypeScript for LaevaAnime.

---

## File Structure

- Modify `src/db/schema.js`: replace old Drizzle table definitions with normalized `subjects`, `subject_aliases`, `tags`, `subject_tags`, `resource_sources`, `resource_items`, `resource_mappings`, `episodes`, `sync_state`, `retry_state`, and `manual_resource_state`.
- Modify `src/db/index.js`: create the new schema, indexes, and an idempotent migration path from old tables. Keep local test rebuild possible by deleting the sqlite file before tests.
- Create `src/dto/apiEnvelope.js`: common success/error envelope helpers.
- Create `src/dto/subjectDto.js`: search, update, calendar, detail DTO formatting.
- Create `src/dto/resourceDto.js`: channel and play DTO formatting.
- Create `src/repositories/subjectRepository.js`: subject metadata, alias, tag, search, calendar, update reads/writes.
- Create `src/repositories/resourceRepository.js`: resource item, mapping, episode, retry/manual state reads/writes.
- Modify `src/services/anime.js`: either replace with a thin compatibility facade over repositories/DTOs or keep existing function exports while moving data access into the new modules.
- Modify `src/server.js`: support `/api/search?tag=...`, reject combined `q` and `tag`, and return the new DTO envelopes.
- Add tests under `test/` for schema migration and API contract.
- Modify Aslan `lib/modules/laeva/laeva_bangumi_models.dart` and `lib/request/apis/laeva_bangumi_api.dart` to consume `playUrl`, `videoUrl`, object tags, and rating distribution.
- Modify LaevaAnime `src/api/types.ts` and detail/player consumers to consume the same fields.

## Task 1: Contract Tests for New DTO Fields

**Files:**
- Create: `test/api-contract.test.js`
- Modify: none

- [ ] **Step 1: Write failing tests for detail/play/search contract**

```js
import test from "node:test";
import assert from "node:assert/strict";
import request from "node:http";
import { createServer } from "../src/server.js";
import { sqlite } from "../src/db/index.js";

function getJson(server, path) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    request.get({ hostname: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function seedSubject() {
  sqlite.exec(`
    DELETE FROM episodes;
    DELETE FROM resource_mappings;
    DELETE FROM resource_items;
    DELETE FROM subject_tags;
    DELETE FROM tags;
    DELETE FROM subject_aliases;
    DELETE FROM subjects;
    INSERT INTO subjects (
      bangumi_id, name, name_cn, summary, platform, air_date, air_weekday,
      eps, total_episodes, cover_url, rating_score, rating_rank,
      rating_total, rating_distribution_json, metadata_fetched_at, rating_fetched_at
    ) VALUES (
      547888, 'Raw title', '中文标题', 'summary', 'TV', '2026-04-01', 3,
      12, 12, 'https://example.invalid/cover.jpg', 7.6, 1234,
      420, '[0,0,1,2,3,10,20,30,5,1]', datetime('now'), datetime('now')
    );
    INSERT INTO subject_aliases (bangumi_id, alias) VALUES (547888, 'Alias A');
    INSERT INTO tags (tag_id, name) VALUES (1, '原创');
    INSERT INTO subject_tags (bangumi_id, tag_id, count, total_count) VALUES (547888, 1, 10, 20);
    INSERT INTO resource_sources (source, name, enabled) VALUES ('ffzy', '非凡资源', 1)
      ON CONFLICT(source) DO UPDATE SET name = excluded.name, enabled = excluded.enabled;
    INSERT INTO resource_items (source, source_aid, title, detail_fetched_at)
      VALUES ('ffzy', 123, '资源站标题', datetime('now'));
    INSERT INTO resource_mappings (bangumi_id, source, source_aid, score, matched_at)
      VALUES (547888, 'ffzy', 123, 0.92, datetime('now'));
    INSERT INTO episodes (bangumi_id, source, source_aid, ep_index, source_ep_index, ep_name, video_url)
      VALUES (547888, 'ffzy', 123, 1, 1, '第01集', 'https://example.invalid/1.m3u8');
  `);
}

test("detail exposes the new stable Aslan DTO contract", async () => {
  seedSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/detail?id=547888");
    assert.equal(response.status, 200);
    const detail = response.body.data;
    assert.equal(detail.id, 547888);
    assert.equal(detail.ratingScore, 7.6);
    assert.equal(detail.rank, 1234);
    assert.equal(detail.votes, 420);
    assert.deepEqual(detail.votesCount, [0,0,1,2,3,10,20,30,5,1]);
    assert.deepEqual(detail.tags, [{ name: "原创", count: 10, totalCount: 20 }]);
    assert.deepEqual(detail.aliases, ["Alias A"]);
    assert.equal(detail.channels[0].id, "ffzy:123");
    assert.equal(detail.channels[0].episodes[0].playUrl, "/anime/api/play?id=547888&ch=1&ep=1");
    assert.equal(Object.hasOwn(detail.channels[0].episodes[0], "url"), false);
    assert.equal(Object.hasOwn(detail, "bangumiId"), false);
  } finally {
    server.close();
  }
});

test("play exposes videoUrl without legacy videoURL", async () => {
  seedSubject();
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/play?id=547888&ch=1&ep=1");
    assert.equal(response.status, 200);
    assert.equal(response.body.data.videoUrl, "https://example.invalid/1.m3u8");
    assert.equal(response.body.data.directPlay, false);
    assert.equal(Object.hasOwn(response.body.data, "videoURL"), false);
  } finally {
    server.close();
  }
});

test("search rejects q and tag together", async () => {
  const server = createServer().listen(0);
  try {
    const response = await getJson(server, "/api/search?q=abc&tag=原创");
    assert.equal(response.status, 400);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run contract tests and verify RED**

Run: `node --test test/api-contract.test.js`

Expected: FAIL because the new normalized tables or DTO fields do not exist yet.

- [ ] **Step 3: Commit the RED tests and design docs**

```bash
git add docs/2026-06-03-laeva-bangumi-refactor-design.md docs/superpowers/plans/2026-06-03-laeva-bangumi-refactor-implementation.md test/api-contract.test.js
git commit -m "test: define LaevaBangumi API contract"
```

## Task 2: Normalized Schema and Migration

**Files:**
- Modify: `src/db/schema.js`
- Modify: `src/db/index.js`
- Create: `test/db-migration.test.js`

- [ ] **Step 1: Write failing schema/migration tests**

Create `test/db-migration.test.js` with assertions that `initDb()` creates all new tables and that old `anime`, `bangumi_cstation_map`, and `episodes` data migrate into `subjects`, `resource_mappings`, and normalized `episodes`.

- [ ] **Step 2: Run migration tests and verify RED**

Run: `node --test test/db-migration.test.js`

Expected: FAIL because the new tables are missing.

- [ ] **Step 3: Implement schema and migration**

Implement `CREATE TABLE IF NOT EXISTS` for all normalized tables and indexes. Add an idempotent migration that checks for old tables with `sqlite_master`, copies rows using `INSERT OR IGNORE` / `ON CONFLICT DO UPDATE`, parses old JSON tag strings into `tags` + `subject_tags`, and leaves old tables in place for deploy safety.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/db-migration.test.js test/api-contract.test.js`

Expected: migration tests pass; contract tests may still fail only on DTO/service behavior.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.js src/db/index.js test/db-migration.test.js
git commit -m "feat: add normalized anime database schema"
```

## Task 3: Repository and DTO Layer

**Files:**
- Create: `src/dto/apiEnvelope.js`
- Create: `src/dto/subjectDto.js`
- Create: `src/dto/resourceDto.js`
- Create: `src/repositories/subjectRepository.js`
- Create: `src/repositories/resourceRepository.js`
- Modify: `src/services/anime.js`

- [ ] **Step 1: Write failing repository/DTO tests**

Add tests that read the seeded subject from Task 1 through repository methods and format it into detail, search, updates, calendar, and play DTOs with no `bangumiId`, no detail episode `url`, and no `videoURL`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/api-contract.test.js`

Expected: FAIL on missing repository/DTO modules or old field names.

- [ ] **Step 3: Implement repositories and DTOs**

Move read formatting out of `anime.js` into repositories and DTO builders. Keep existing exported service function names: `searchAnime`, `getAnimeDetail`, `getPlayUrl`, `getUpdates`, and `getCalendarView`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/api-contract.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dto src/repositories src/services/anime.js test/api-contract.test.js
git commit -m "feat: expose normalized anime API DTOs"
```

## Task 4: Search by Tag and Route Validation

**Files:**
- Modify: `src/server.js`
- Modify: `src/services/anime.js`
- Modify: `src/repositories/subjectRepository.js`
- Modify: `test/api-contract.test.js`

- [ ] **Step 1: Add failing tests for tag search**

Extend `test/api-contract.test.js` to assert `/api/search?tag=原创` returns seeded subject summaries and `/api/search` with neither `q` nor `tag` returns 400.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/api-contract.test.js`

Expected: FAIL because tag search is not implemented.

- [ ] **Step 3: Implement tag route and repository query**

In `server.js`, make `q` and `tag` mutually exclusive. In `subjectRepository.js`, join `subject_tags` and `tags` for tag search and return the same search DTO shape as keyword search.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/api-contract.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/services/anime.js src/repositories/subjectRepository.js test/api-contract.test.js
git commit -m "feat: support subject search by tag"
```

## Task 5: Sync Writes into Normalized Tables

**Files:**
- Modify: `src/services/anime.js`
- Create: `src/normalizers/bangumiSubjectNormalizer.js`
- Create: `src/normalizers/resourceItemNormalizer.js`
- Modify: `src/repositories/subjectRepository.js`
- Modify: `src/repositories/resourceRepository.js`
- Modify existing scheduler/manual review tests as needed.

- [ ] **Step 1: Write failing tests for Bangumi metadata persistence**

Add tests for subject upsert from a Bangumi-like object: rating score, rank, total votes, distribution, tags, aliases, air date, weekday, and cover are persisted in normalized tables.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/bangumi.test.js test/api-contract.test.js`

Expected: FAIL on normalized metadata persistence.

- [ ] **Step 3: Implement normalizers and upsert paths**

Normalize Bangumi subject responses into subject, alias, and tag repository writes. Ensure `bangumi_id` is used throughout and public DTOs still expose `id`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/bangumi.test.js test/api-contract.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/normalizers src/repositories src/services/anime.js test
git commit -m "feat: persist Bangumi metadata in normalized tables"
```

## Task 6: Resource Matching and Playback Writes

**Files:**
- Modify: `src/services/anime.js`
- Modify: `src/repositories/resourceRepository.js`
- Modify: `test/manual-review.test.js`
- Modify related cstation/scheduler tests.

- [ ] **Step 1: Write failing tests for resource persistence**

Assert that resource catalog rows, mappings, manual states, retry states, and episodes are written to `resource_items`, `resource_mappings`, `manual_resource_state`, `retry_state`, and `episodes`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/cstation.test.js test/manual-review.test.js test/scheduler.test.js`

Expected: FAIL where old tables are assumed.

- [ ] **Step 3: Implement normalized resource writes**

Update matching, manual review import/export, retry tracking, and episode refresh code to use normalized resource tables. Keep API endpoint paths unchanged.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/cstation.test.js test/manual-review.test.js test/scheduler.test.js test/api-contract.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/anime.js src/repositories/resourceRepository.js test
git commit -m "feat: normalize resource matching storage"
```

## Task 7: Update Aslan API Consumers

**Files:**
- Modify: `/Users/laevatain/Documents/Code/Aslan/lib/modules/laeva/laeva_bangumi_models.dart`
- Modify: `/Users/laevatain/Documents/Code/Aslan/lib/request/apis/laeva_bangumi_api.dart`
- Modify: `/Users/laevatain/Documents/Code/Aslan/test/laeva_bangumi_models_test.dart`

- [ ] **Step 1: Write failing Dart model tests**

Update tests to assert detail episodes parse `playUrl`, play response parses `videoUrl`, tags parse as objects, and rating distribution maps into existing Bangumi model fields.

- [ ] **Step 2: Run Dart tests and verify RED**

Run: `flutter test test/laeva_bangumi_models_test.dart`

Expected: FAIL on old field parsing.

- [ ] **Step 3: Update Aslan models**

Replace old `url` / `videoURL` parsing with `playUrl` / `videoUrl`, parse tag objects without expecting duplicate Bangumi IDs, and preserve default base URL `https://www.laevatain.top/anime/api`.

- [ ] **Step 4: Verify GREEN**

Run: `flutter test test/laeva_bangumi_models_test.dart`

Expected: PASS.

- [ ] **Step 5: Commit in Aslan**

```bash
git add lib/modules/laeva/laeva_bangumi_models.dart lib/request/apis/laeva_bangumi_api.dart test/laeva_bangumi_models_test.dart
git commit -m "feat: consume normalized LaevaBangumi API"
```

## Task 8: Update LaevaAnime API Consumers

**Files:**
- Modify: `/Users/laevatain/Documents/Code/LaevaAnime/src/api/types.ts`
- Modify: `/Users/laevatain/Documents/Code/LaevaAnime/src/pages/DetailPage.tsx`
- Modify: `/Users/laevatain/Documents/Code/LaevaAnime/src/pages/PlayerPage.tsx`
- Modify: related typecheck/tests.

- [ ] **Step 1: Write failing type assertions**

Update typecheck files to require `playUrl`, `videoUrl`, object tags, and no `bangumiId`.

- [ ] **Step 2: Run type/build check and verify RED**

Run: `npm run build` from LaevaAnime if available, otherwise run the existing typecheck command found in `package.json`.

Expected: FAIL on old field names.

- [ ] **Step 3: Update React consumers**

Change detail/play consumers to use `playUrl` and `videoUrl`, render object tag names, and keep endpoint paths unchanged.

- [ ] **Step 4: Verify GREEN**

Run the same build/typecheck command.

Expected: PASS.

- [ ] **Step 5: Commit in LaevaAnime**

```bash
git add src/api/types.ts src/pages/DetailPage.tsx src/pages/PlayerPage.tsx src
git commit -m "feat: consume normalized LaevaBangumi API"
```

## Task 9: Full Verification

**Files:**
- Modify only if verification exposes defects.

- [ ] **Step 1: Run LaevaBangumi tests**

Run: `node --test`

Expected: PASS.

- [ ] **Step 2: Run Aslan checks**

Run:

```bash
dart format <touched files>
flutter test test/laeva_bangumi_models_test.dart
flutter test
flutter analyze --no-fatal-infos
```

Expected: PASS or report exact pre-existing failures.

- [ ] **Step 3: Run LaevaAnime checks**

Run the package build/typecheck command from LaevaAnime.

Expected: PASS.

- [ ] **Step 4: Run contract grep**

Run:

```bash
rg -n "bangumiId|videoURL|episodes.*url|\\.url\\b" /Users/laevatain/Documents/Code/LaevaBangumi/src /Users/laevatain/Documents/Code/LaevaBangumi/test /Users/laevatain/Documents/Code/Aslan/lib /Users/laevatain/Documents/Code/Aslan/test /Users/laevatain/Documents/Code/LaevaAnime/src
```

Expected: no active consumer or API output for removed legacy fields. Allow explanatory docs or assertions that explicitly verify the fields are absent.

- [ ] **Step 5: Commit final fixes**

Commit any verification fixes in their respective repositories with focused commit messages.

## Self-Review

- Spec coverage: tasks cover normalized DB, production migration, no legacy public fields, tag search, rating distribution, proxy play entry, and Aslan/LaevaAnime consumers.
- Placeholder scan: no task uses unspecified "TODO" behavior; each task names concrete files and checks.
- Type consistency: public subject ID is `id`; database key is `bangumi_id`; detail episode entry is `playUrl`; play response is `videoUrl`; tags are object arrays.
