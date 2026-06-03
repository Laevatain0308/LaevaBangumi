import { sqlite } from "../db/index.js";

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function resourceSyncKey({ source, scope }) {
  if (!source) throw new Error("resource sync state requires source");
  if (!scope) throw new Error("resource sync state requires scope");
  return `resource:${source}:${scope}`;
}

export function findResourceSyncState({ source, scope }) {
  const key = resourceSyncKey({ source, scope });
  return sqlite.prepare(`
    SELECT
      key,
      status,
      last_started_at AS lastStartedAt,
      last_seen_at AS lastSeenAt,
      last_success_at AS lastSuccessAt,
      last_error AS lastError
    FROM sync_state
    WHERE key = ?
  `).get(key);
}

export function upsertResourceSyncState({
  source,
  scope,
  lastSeenAt,
  lastSuccessAt = null,
  status = "success",
  lastStartedAt = null,
  lastError = null,
}) {
  const key = resourceSyncKey({ source, scope });

  sqlite.prepare(`
    INSERT INTO sync_state (
      key, status, last_started_at, last_seen_at, last_success_at, last_error, updated_at
    )
    VALUES (
      @key, @status, @lastStartedAt, @lastSeenAt,
      @lastSuccessAt, @lastError, datetime('now')
    )
    ON CONFLICT(key) DO UPDATE SET
      status = excluded.status,
      last_started_at = excluded.last_started_at,
      last_seen_at = COALESCE(excluded.last_seen_at, sync_state.last_seen_at),
      last_success_at = COALESCE(excluded.last_success_at, sync_state.last_success_at),
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run({ key, lastSeenAt, lastSuccessAt, status, lastStartedAt, lastError });
}

export function markResourceSyncStarted({ source, scope, startedAt = now() }) {
  upsertResourceSyncState({
    source,
    scope,
    status: "running",
    lastStartedAt: startedAt,
    lastSeenAt: null,
    lastSuccessAt: null,
    lastError: null,
  });
  return startedAt;
}

export function markResourceSyncSucceeded({
  source,
  scope,
  lastSeenAt,
  lastSuccessAt = now(),
  lastStartedAt = null,
}) {
  upsertResourceSyncState({
    source,
    scope,
    status: "success",
    lastStartedAt,
    lastSeenAt,
    lastSuccessAt,
    lastError: null,
  });
}

export function markResourceSyncFailed({
  source,
  scope,
  error,
  lastStartedAt = null,
}) {
  upsertResourceSyncState({
    source,
    scope,
    status: "error",
    lastStartedAt,
    lastSeenAt: null,
    lastSuccessAt: null,
    lastError: error?.message ?? String(error),
  });
}
