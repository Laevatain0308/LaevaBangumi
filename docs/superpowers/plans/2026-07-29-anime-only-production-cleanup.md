# Anime-only Production Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove obsolete server features and code, make every active request path anime-only, and add a production-ready PM2 runbook.

**Architecture:** Enforce anime-only behavior once at the HTTP boundary and encode Bangumi subject type `2` directly in the transport. Remove internal media-type branching so the rest of the normalized domain has one responsibility. Keep resource-source category selection inside the FFZY plugin, where the current `tid=30` restriction already belongs.

**Tech Stack:** Node.js ESM, Express 5, node:test, better-sqlite3, PM2, Nginx, Markdown

---

### Task 1: Lock obsolete-code and anime-only boundaries

**Files:**
- Modify: `test/service-layering.test.js`
- Modify: `test/media-type-config.test.js`
- Modify: `test/cli-args.test.js`

- [ ] **Step 1: Write failing architecture tests**

Add the obsolete matcher and media files to `FORBIDDEN_PATHS`. Replace multi-media helper expectations with an anime-only contract that accepts missing, empty, and `anime` values while rejecting all other values. Replace the platform-discovery parser test with a check that its script is absent.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --import ./test/setup.js --test test/service-layering.test.js test/media-type-config.test.js test/cli-args.test.js`

Expected: failures report that obsolete files still exist and legacy media values remain accepted.

- [ ] **Step 3: Implement the minimal cleanup**

Delete `src/lib/matcher.js`, `src/lib/resourceCandidateRecall.js`, and `src/scripts/discover-bangumi-platforms.js`. Narrow `src/lib/mediaTypes.js` to the request-boundary anime assertion temporarily so the focused tests can turn green before the module is inlined and deleted in Task 2.

- [ ] **Step 4: Run focused tests**

Run the Step 2 command and expect all selected tests to pass.

### Task 2: Remove internal media-type branching and heartbeat

**Files:**
- Modify: `test/public-api-contract.test.js`
- Modify: `test/public-api-service.test.js`
- Modify: `test/bangumi.test.js`
- Modify: `test/bangumi-metadata-service.test.js`
- Modify: `test/bangumi-search-lifecycle.test.js`
- Modify: `src/server.js`
- Modify: `src/clients/bangumiClient.js`
- Modify: `src/bangumi/client.js`
- Modify: `src/bangumi/metadataService.js`
- Modify: `src/bangumi/searchQueue.js`
- Modify: `src/publicApi/publicApiService.js`
- Modify: `src/index.js`
- Delete: `src/lib/mediaTypes.js`

- [ ] **Step 1: Write failing behavior tests**

Require `type=tv`, `type=movie`, and `type=variety` to return the existing HTTP 400 invalid-query envelope; require `/api/heartbeat` to return 404; require `/api/health` to remain 200. Require Bangumi search to always send filter type `[2]` without accepting a media option, and remove internal non-anime empty-result expectations.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --import ./test/setup.js --test test/public-api-contract.test.js test/public-api-service.test.js test/bangumi.test.js test/bangumi-metadata-service.test.js test/bangumi-search-lifecycle.test.js`

Expected: non-anime requests still return 200, heartbeat still returns 200, and internal functions still expose media branching.

- [ ] **Step 3: Implement the anime-only HTTP and domain flow**

Add a small private `assertAnimeType` helper in `src/server.js`, stop passing media types beyond the HTTP boundary, hard-code Bangumi filter type `[2]`, simplify metadata search and queue signatures, remove public-service media branching, delete `src/lib/mediaTypes.js`, and remove the complete heartbeat block.

- [ ] **Step 4: Run focused tests**

Run the Step 2 command and expect all selected tests to pass.

### Task 3: Add the PM2 production runbook

**Files:**
- Create: `test/production-runbook.test.js`
- Create: `docs/production-runbook.md`

- [ ] **Step 1: Write a failing documentation contract test**

Read the runbook and assert that it documents PM2 startup, `BANGUMI_PROXY_URL`, clean first sync, `npm run account`, mapping export/import, `/api/health`, SQLite backup/restore, anime-only scope, and FFZY `tid=30`.

- [ ] **Step 2: Run the test to verify RED**

Run: `node --import ./test/setup.js --test test/production-runbook.test.js`

Expected: failure because `docs/production-runbook.md` does not exist.

- [ ] **Step 3: Write the runbook**

Document prerequisites, environment setup, foreground first sync, PM2 startup, health checks, account and workbook workflows, schedules, logs, upgrades, WAL-safe backup/restore, and troubleshooting. Clearly separate the production proxy placeholder from local development port `7897`.

- [ ] **Step 4: Run the documentation test**

Run the Step 2 command and expect it to pass.

### Task 4: Verify the complete cleanup

**Files:**
- Modify only files required by failures caused by this plan.

- [ ] **Step 1: Search for obsolete concepts**

Run: `rg -n "resourceCandidateRecall|lib/matcher|discover-bangumi-platforms|mediaTypeForBangumi|BANGUMI_SUBJECT_TYPE_BY_MEDIA_TYPE|api/heartbeat" src test package.json docs/production-runbook.md`

Expected: no obsolete production reference; only intentional negative assertions may remain in tests.

- [ ] **Step 2: Run the main test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run the cover-proxy test suite**

Run: `npm test --prefix cover-proxy-service`

Expected: all cover-proxy tests pass with zero failures.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors and only the scoped source, test, and documentation changes.
