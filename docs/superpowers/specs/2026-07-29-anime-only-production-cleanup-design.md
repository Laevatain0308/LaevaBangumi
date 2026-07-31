# Anime-only Production Cleanup Design

## Goal

Complete the server refactor cleanup by removing unreachable matching code, removing the public heartbeat feature, narrowing every server search path to anime, and documenting the supported PM2 production workflow.

## Scope

The server handles Bangumi anime subjects only. Omitting the public `type` query parameter or passing `type=anime` remains valid. Any other value, including the formerly accepted `tv`, `movie`, and `variety` values, returns the existing `invalid_query` HTTP 400 envelope.

The public DTO continues to emit `mediaType: "anime"` as a stable client-facing fact. This constant does not represent a multi-media abstraction.

Resource-source categories are independent from public media types. FFZY remains restricted to the current Japanese-anime category `tid=30`. This cleanup neither enables `tid=29/31` nor prevents adding another anime category later inside the FFZY plugin.

## Code Cleanup

Delete `src/lib/matcher.js` and `src/lib/resourceCandidateRecall.js`. They form an unreachable old matching chain; the live mapping domain uses `src/mappings/autoMatcher.js` and `src/mappings/titleNormalizer.js`.

Delete `src/lib/mediaTypes.js` and `src/scripts/discover-bangumi-platforms.js`. Replace their remaining uses with explicit anime behavior:

- the HTTP boundary accepts only the optional literal `anime` type;
- Bangumi search always sends subject type `2`;
- internal metadata, queue, and public API calls no longer branch on media type;
- public response metadata and DTOs continue to identify results as anime.

Architecture tests will require all four obsolete files to be absent so they cannot silently return.

## Heartbeat Removal

Remove `/api/heartbeat`, its visitor map, TTL, and cleanup interval from the main server. No compatibility response or replacement endpoint is provided; requests naturally return Express 404.

Keep `/api/health`. It reports process liveness for PM2, reverse proxies, and deployment checks and does not track visitors or maintain heartbeat state.

## Production Runbook

Create `docs/production-runbook.md` as the primary operational guide. It documents:

- supported Node.js, SQLite, PM2, proxy, and filesystem prerequisites;
- main-service and cover-proxy environment variables;
- dependency installation and directory preparation;
- clean-database initialization and one-time foreground `--sync` execution;
- normal PM2 startup and health verification;
- account administration and mapping XLSX commands;
- schedules and the fixed anime/FFZY `tid=30` scope;
- logs, deployment updates, SQLite WAL-safe backup and restore;
- common Bangumi proxy, FFZY, cover, database, and mapping failures.

The runbook uses placeholders for production-specific hostnames, secrets, and proxy ports. It mentions local port `7897` only as a local-development example and never assumes it is the production proxy port.

## Verification

Testing proceeds in three boundaries:

1. Architecture tests fail while obsolete matcher/media files still exist.
2. HTTP and Bangumi transport tests fail while non-anime requests are still accepted and heartbeat is still mounted.
3. Documentation contract tests fail until the runbook contains the supported first-start, PM2, proxy, account, mapping, backup, restore, and anime-only instructions.

After the targeted tests pass, run the complete root test suite and the independent cover-proxy test suite.

## Non-goals

- No Aslan/client changes.
- No old database migration or compatibility.
- No FFZY category expansion.
- No route decomposition, graceful-shutdown work, or cover-proxy behavior changes.
- No automatic segmented mapping or server web administration.
