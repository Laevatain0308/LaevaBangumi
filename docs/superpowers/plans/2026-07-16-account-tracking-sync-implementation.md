# Account Tracking Sync Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy private account and sync implementation with a clean server-only account, device-token, watch-progress, collection, and Bangumi metadata-ensure domain for a brand-new database.

**Architecture:** Persist an immutable per-account event ledger and apply each new event transactionally to normalized current-state, tombstone, and clear-watermark tables. Keep authentication in a separate account domain, bind one active long-lived token to each account/device pair, and enrich local-only sync snapshots from the new Bangumi metadata domain while scheduling missing or stale metadata asynchronously.

**Tech Stack:** Node.js ESM, Express 5, better-sqlite3, Drizzle SQLite declarations, node:crypto scrypt/SHA-256, node:test, node:assert

---

## File Map

- `src/db/accountSyncSchema.js`: create only the 11 new private-domain tables and indexes.
- `src/db/index.js`: initialize the new schema and stop creating legacy private-sync tables/indexes.
- `src/db/schema.js`: replace legacy private-sync Drizzle declarations with the new table names and columns.
- `src/accounts/password.js`: normalize usernames and hash/verify passwords.
- `src/accounts/accountRepository.js`: all account, device, and token SQL.
- `src/accounts/accountService.js`: account administration, login, token rotation, authentication, status, and logout.
- `src/scripts/account.js`: `add`, `set-password`, `delete`, and `list` CLI.
- `src/sync/syncEventValidator.js`: validate event identity/new payloads and derive stable versions.
- `src/sync/syncRepository.js`: event ledger plus normalized watch/collection state SQL.
- `src/sync/syncMergeService.js`: atomic duplicate detection, validation, sorting, event application, and metadata ensure handoff.
- `src/sync/syncSnapshotService.js`: local snapshot construction and batched Bangumi summary attachment.
- `src/bangumi/metadataEnsureService.js`: persistent, idempotent scheduling for unknown, summary-only, failed, and stale subjects.
- `src/bangumi/metadataRefreshWorker.js`: single-flight due-task draining and wake-up behavior.
- `src/bangumi/bangumiSummaryRepository.js`: batch-read normalized subject summaries for sync snapshots.
- `src/bangumi/repository.js`: allow unknown IDs in refresh state and support ensure/failure/success transitions.
- `src/bangumi/calendarService.js`: ensure full metadata after calendar summary persistence.
- `src/bangumi/metadataService.js`: ensure search summaries and persist detail refresh success.
- `src/bangumi/scheduler.js`: run the persistent worker at startup and cron boundaries.
- `src/runtime/accountSyncRuntime.js`: compose production account and sync dependencies once.
- `src/runtime/bangumiRuntime.js`: compose shared Bangumi repository, ensure service, worker, and services once.
- `src/routes/accountAuth.js`: one reusable Bearer-token authentication middleware for both new routers.
- `src/routes/accountRoutes.js`: `/api/account/login|logout|status`.
- `src/routes/syncRoutes.js`: `/api/sync/merge|snapshot`.
- `src/server.js`: mount only the two new routers.
- `src/index.js`: share the Bangumi ensure/worker runtime with account sync and scheduler.
- `package.json`: replace `sync:user` with `account`.
- Delete `src/services/syncTokenService.js`, `src/services/privateSyncMergeService.js`, `src/routes/privateSyncRoutes.js`, and `src/scripts/sync-user.js` after the replacement is wired.
- Replace `test/private-sync-*.test.js` with focused `account-*`, `sync-*`, and metadata ensure/worker tests.

Do not stage or modify the existing FFZY working-tree changes while executing this plan. Every commit command below names only files owned by its task.

### Task 1: Create the New Private-Domain Schema

**Files:**
- Create: `src/db/accountSyncSchema.js`
- Modify: `src/db/index.js:1-370`
- Modify: `src/db/schema.js:159-286`
- Modify: `test/helpers/testDatabase.js`
- Create: `test/account-sync-schema.test.js`
- Modify: `test/db-migration.test.js`
- Delete: `test/private-sync-auth.test.js`
- Delete: `test/private-sync-admin.test.js`
- Delete: `test/private-sync-api.test.js`
- Delete: `test/private-sync-merge.test.js`

- [ ] **Step 1: Write the failing schema contract**

Create `test/account-sync-schema.test.js` using an isolated `Database(":memory:")`, enable foreign keys, call `initAccountSyncSchema(sqlite)`, and assert the exact private table set:

```js
const PRIVATE_TABLES = [
  "accounts",
  "account_devices",
  "account_tokens",
  "sync_events",
  "watch_records",
  "watch_progress",
  "watch_tombstones",
  "watch_state",
  "collection_records",
  "collection_tombstones",
  "collection_state",
];

test("account sync schema creates only the new private-domain tables", (t) => {
  const sqlite = new Database(":memory:");
  t.after(() => sqlite.close());
  sqlite.pragma("foreign_keys = ON");
  initAccountSyncSchema(sqlite);

  const names = new Set(sqlite.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => row.name));
  for (const table of PRIVATE_TABLES) assert.equal(names.has(table), true, table);
  for (const oldTable of [
    "sync_users", "sync_credentials", "sync_invites", "sync_tokens",
    "sync_devices", "watch_history_items", "watch_deleted_items",
    "watch_clear_state", "collection_items", "collection_deleted_items",
    "collection_clear_state",
  ]) assert.equal(names.has(oldTable), false, oldTable);
});
```

Add tests that insert an account, watch record with an unknown `bangumi_id`, and collection record without any `bangumi_subjects` row; assert all inserts succeed. Delete the account and assert every private table has zero rows. Query `PRAGMA foreign_key_list(watch_records)` and `PRAGMA foreign_key_list(collection_records)` to prove neither references `bangumi_subjects`. Query `sqlite_master` to prove the active-token partial unique index exists.

Update `test/db-migration.test.js` so `initDb()` expects the 11 new private tables and explicitly rejects the old private table names. Delete all four legacy private-sync test files in the same change: their table/API contracts are intentionally invalid as soon as this schema switches, and Tasks 2–9 replace their coverage with the new contract before final completion.

- [ ] **Step 2: Run the schema tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/account-sync-schema.test.js test/db-migration.test.js
```

Expected: FAIL because `src/db/accountSyncSchema.js` does not exist and `initDb()` still creates the legacy private tables.

- [ ] **Step 3: Implement the schema initializer**

Create `initAccountSyncSchema(connection)` with one `connection.exec()` and this exact table/index structure:

```sql
CREATE TABLE IF NOT EXISTS accounts (
  account_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  password_changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_devices (
  account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  platform TEXT,
  app_version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (account_id, device_id)
);

CREATE TABLE IF NOT EXISTS account_tokens (
  token_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (account_id, device_id)
    REFERENCES account_devices(account_id, device_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tokens_active_device
  ON account_tokens(account_id, device_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS sync_events (
  account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  domain TEXT NOT NULL CHECK (domain IN ('watch', 'collection')),
  operation TEXT NOT NULL,
  bangumi_id INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (account_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_events_account_domain_version
  ON sync_events(account_id, domain, version);
CREATE INDEX IF NOT EXISTS idx_sync_events_account_device_seq
  ON sync_events(account_id, device_id, seq);

CREATE TABLE IF NOT EXISTS watch_records (
  account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
  last_watch_episode INTEGER NOT NULL CHECK (last_watch_episode >= 1),
  last_watch_time_ms INTEGER NOT NULL CHECK (last_watch_time_ms >= 0),
  last_watch_episode_name TEXT NOT NULL,
  record_version TEXT NOT NULL,
  PRIMARY KEY (account_id, bangumi_id)
);

CREATE TABLE IF NOT EXISTS watch_progress (
  account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
  episode INTEGER NOT NULL CHECK (episode >= 1),
  road INTEGER NOT NULL CHECK (road >= 0),
  progress_ms INTEGER NOT NULL CHECK (progress_ms >= 0),
  progress_version TEXT NOT NULL,
  PRIMARY KEY (account_id, bangumi_id, episode)
);

CREATE TABLE IF NOT EXISTS watch_tombstones (
  account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
  deleted_version TEXT NOT NULL,
  PRIMARY KEY (account_id, bangumi_id)
);

CREATE TABLE IF NOT EXISTS watch_state (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  clear_version TEXT
);

CREATE TABLE IF NOT EXISTS collection_records (
  account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
  type INTEGER NOT NULL CHECK (type BETWEEN 1 AND 5),
  collected_at_ms INTEGER NOT NULL CHECK (collected_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  record_version TEXT NOT NULL,
  PRIMARY KEY (account_id, bangumi_id)
);

CREATE TABLE IF NOT EXISTS collection_tombstones (
  account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0),
  deleted_version TEXT NOT NULL,
  PRIMARY KEY (account_id, bangumi_id)
);

CREATE TABLE IF NOT EXISTS collection_state (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  clear_version TEXT
);
```

Import and call the initializer from `initDb()`. Remove all old private DDL and old sync-event index creation from `initLegacySchema()`/`ensureRecommendedIndexes()`. Replace the legacy Drizzle private declarations with matching declarations for these 11 tables. Update `createTestDatabase()` to call the new initializer.

- [ ] **Step 4: Run schema tests and verify GREEN**

Run:

```bash
node --import ./test/setup.js --test test/account-sync-schema.test.js test/db-migration.test.js
```

Expected: PASS; no legacy private table is created in the temporary database.

- [ ] **Step 5: Commit the schema boundary**

```bash
git add src/db/accountSyncSchema.js src/db/index.js src/db/schema.js test/helpers/testDatabase.js test/account-sync-schema.test.js test/db-migration.test.js test/private-sync-auth.test.js test/private-sync-admin.test.js test/private-sync-api.test.js test/private-sync-merge.test.js
git commit -m "refactor: replace private sync schema"
```

### Task 2: Implement Account Passwords, Device Tokens, and Administration

**Files:**
- Create: `src/accounts/password.js`
- Create: `src/accounts/accountRepository.js`
- Create: `src/accounts/accountService.js`
- Create: `test/account-service.test.js`

- [ ] **Step 1: Write account-service RED tests**

Use `createTestDatabase()` and injected fixed clock/token bytes. Cover:

```js
test("account names normalize and passwords are stored only as scrypt hashes", () => {
  const context = createContext();
  const account = context.service.addAccount({
    username: "  Alice  ",
    password: "password-password",
  });
  assert.equal(account.username, "alice");
  const row = context.sqlite.prepare("SELECT * FROM accounts").get();
  assert.equal(row.username, "alice");
  assert.match(row.password_hash, /^scrypt\$/);
  assert.notEqual(row.password_hash, "password-password");
  assert.throws(
    () => context.service.addAccount({ username: "ALICE", password: "another-password" }),
    /already exists/,
  );
});

test("same-device login rotates only that device token", () => {
  const context = createContext();
  context.service.addAccount({ username: "alice", password: "password-password" });
  const first = context.service.login({ username: "alice", password: "password-password", deviceId: "phone" });
  const laptop = context.service.login({ username: "alice", password: "password-password", deviceId: "laptop" });
  const second = context.service.login({ username: "ALICE", password: "password-password", deviceId: "phone" });
  assert.equal(context.service.authenticate(first.token), null);
  assert.equal(context.service.authenticate(laptop.token).device.deviceId, "laptop");
  assert.equal(context.service.authenticate(second.token).device.deviceId, "phone");
  assert.equal(context.sqlite.prepare(`
    SELECT COUNT(*) AS n FROM account_tokens WHERE revoked_at IS NULL
  `).get().n, 2);
});
```

Also test invalid password returns `null`; raw tokens start with `lbat_` and never appear in the database; token hashes are 64 lowercase hex characters; `setPassword()` revokes every active token; new password works and old password fails; `logout()` revokes only current token; `deleteAccount()` cascades private rows without deleting a seeded `bangumi_subjects` row; `listAccounts()` exposes only username/timestamps/device count.

- [ ] **Step 2: Run account tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/account-service.test.js
```

Expected: FAIL because the account modules do not exist.

- [ ] **Step 3: Implement password primitives**

Export these exact functions from `password.js`:

```js
export function normalizeUsername(value) {
  const username = String(value ?? "").trim().toLowerCase();
  if (username.length < 1 || username.length > 64) {
    throw new TypeError("username must be between 1 and 64 characters");
  }
  return username;
}

export function hashPassword(password, { randomBytesImpl = randomBytes } = {}) {
  assertPassword(password);
  const salt = randomBytesImpl(16).toString("base64url");
  const digest = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${digest}`;
}

export function verifyPassword(password, storedHash) {
  if (!validPasswordShape(password) || typeof storedHash !== "string") return false;
  const [scheme, salt, encoded] = storedHash.split("$");
  if (scheme !== "scrypt" || !salt || !encoded) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(encoded, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

`assertPassword()` enforces 8–256 characters before invoking scrypt.

- [ ] **Step 4: Implement repository and service factories**

`createAccountRepository({ sqlite, clock })` must expose:

```js
{
  transaction,
  createAccount,
  findAccountByUsername,
  replacePasswordAndRevokeTokens,
  deleteAccount,
  listAccounts,
  rotateDeviceToken,
  findActiveToken,
  touchToken,
  revokeToken,
  listDevices,
}
```

`transaction(fn)` is the repository's `sqlite.transaction(fn)` boundary. `rotateDeviceToken({ accountId, device, tokenHash })` performs the three SQL writes without opening a nested transaction: upsert `account_devices`, revoke the active token for the same account/device, and insert the new hash. `findActiveToken(tokenHash)` joins account, token, and device by the indexed hash and returns `accountId`, `username`, `tokenId`, and device fields.

`createAccountService({ repository, clock, randomBytesImpl })` must expose:

```js
{
  addAccount({ username, password }),
  setPassword({ username, password }),
  deleteAccount(username),
  listAccounts(),
  login({ username, password, deviceId, deviceName, platform, appVersion }),
  authenticate(rawToken),
  logout(tokenId),
  status(auth),
}
```

Generate raw tokens as `lbat_${randomBytesImpl(32).toString("base64url")}` and persist only `sha256(rawToken)`. `authenticate()` rejects values without the prefix before hashing, touches `last_used_at` on success, and never scans all token rows.

Wrap each `addAccount()`, `setPassword()`, `deleteAccount()`, and `login()` mutation in `repository.transaction()`. In particular, `login()` must normalize the username, load the account, verify its scrypt hash, upsert the device, revoke only that device's active token, and insert the replacement hash inside one transaction. Use a private invalid-credentials sentinel so a missing account and a wrong password both return `null` after the transaction aborts, while SQLite failures still propagate.

- [ ] **Step 5: Run account tests and verify GREEN**

Run:

```bash
node --import ./test/setup.js --test test/account-service.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit account core**

```bash
git add src/accounts/password.js src/accounts/accountRepository.js src/accounts/accountService.js test/account-service.test.js
git commit -m "feat: add account and device token domain"
```

### Task 3: Replace the Admin CLI

**Files:**
- Create: `src/scripts/account.js`
- Modify: `package.json`
- Create: `test/account-cli.test.js`

- [ ] **Step 1: Write failing CLI tests**

Inject an account service into `runAccountCommand(argv, { service })`. Test exact parsing/results:

```js
assert.deepEqual(runAccountCommand(
  ["add", "--username", "Alice", "--password", "password-password"],
  { service },
), { account: { username: "alice", createdAt: NOW, passwordChangedAt: NOW } });

assert.deepEqual(runAccountCommand(
  ["set-password", "--username", "alice", "--password", "new-password"],
  { service },
), { account: { username: "alice", passwordChangedAt: LATER }, revokedTokenCount: 2 });
```

Test `delete --username`, `list`, missing arguments, unknown flags, unknown commands, and that no command supports invite/token/disable options. Assert `package.json` contains `"account": "node src/scripts/account.js"` and does not contain `sync:user`.

- [ ] **Step 2: Run CLI tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/account-cli.test.js
```

Expected: FAIL because the script and package entry do not exist.

- [ ] **Step 3: Implement the four-command script**

Use this command switch and strict `--key value` parser:

```js
switch (command) {
  case "add":
    return { account: service.addAccount({
      username: requireOption(options, "username"),
      password: requireOption(options, "password"),
    }) };
  case "set-password":
    return service.setPassword({
      username: requireOption(options, "username"),
      password: requireOption(options, "password"),
    });
  case "delete":
    return service.deleteAccount(requireOption(options, "username"));
  case "list":
    if (Object.keys(options).length > 0) throw new Error("list accepts no options");
    return { accounts: service.listAccounts() };
  default:
    throw new Error("Usage: account.js <add|set-password|delete|list> [--username value] [--password value]");
}
```

The executable `main()` calls `initDb()`, builds the repository/service from production `sqlite`, runs the command, and prints formatted JSON.

- [ ] **Step 4: Run CLI tests and verify GREEN**

Run:

```bash
node --import ./test/setup.js --test test/account-cli.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit CLI**

```bash
git add src/scripts/account.js package.json test/account-cli.test.js
git commit -m "feat: add account administration command"
```

### Task 4: Define and Validate the New Sync Event Contract

**Files:**
- Create: `src/sync/syncEventValidator.js`
- Create: `test/sync-event-validator.test.js`

- [ ] **Step 1: Write validator RED tests**

Test `validateBatchContainer`, `normalizeEventIdentity`, `normalizeNewEvent`, `syncVersion`, and `SyncEventValidationError`.

Use a fixed `receivedAtMs = 1_784_131_200_000`. Assert:

```js
assert.equal(syncVersion(42, "device-a:1"), "0000000000000042|device-a:1");

const normalized = normalizeNewEvent(watchUpsert(), {
  expectedDeviceId: "device-a",
  receivedAtMs,
});
assert.deepEqual(normalized.payload, {
  episode: 3,
  lastWatchEpisode: 3,
  road: 0,
  progressMs: 120000,
  lastWatchTime: receivedAtMs,
  lastWatchEpisodeName: "第 3 集",
});
```

Cover all six operations; 100 events accepted and 101 rejected; positive integer `bangumiId/episode`; collection type 1–5; empty clear payload and omitted `bangumiId`; field length caps; safe integer timestamps; exact 24-hour skew accepted and 24 hours + 1ms rejected with code `clock_skew`; mismatched device rejected with code `device_mismatch`; old keys `entityKey`, `adapterName`, `bangumiItem`, and `lastSrc` rejected rather than ignored. Include same-time ASCII and non-ASCII event IDs and assert `compareSyncVersions()` uses the same UTF-8 byte order as SQLite `BINARY` collation.

Test identity-only parsing separately: a duplicate-shaped object containing only valid `eventId/deviceId` plus malformed business fields can produce identity, allowing the merge service to classify it as an existing duplicate without revalidating old payload/time.

- [ ] **Step 2: Run validator tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/sync-event-validator.test.js
```

Expected: FAIL because the validator module does not exist.

- [ ] **Step 3: Implement strict validation**

Export:

```js
export class SyncEventValidationError extends Error {
  constructor(message, { code = "invalid_sync_event" } = {}) {
    super(message);
    this.name = "SyncEventValidationError";
    this.code = code;
  }
}

export function syncVersion(updatedAtMs, eventId) {
  return `${String(updatedAtMs).padStart(16, "0")}|${eventId}`;
}

export function compareSyncVersions(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function validateBatchContainer(events) {
  if (!Array.isArray(events)) throw invalid("events must be an array");
  if (events.length > 100) throw invalid("events must contain at most 100 items");
  return events;
}
```

`normalizeEventIdentity()` validates only a 1–128 character `eventId`, a 1–128 character `deviceId`, and exact device binding. `normalizeNewEvent()` validates identity plus `seq/domain/op/updatedAt/bangumiId/payload`, rejects extra legacy payload keys, calculates version, and returns JSON-safe minimal payload. Use operation-specific allowed-key sets so omitted/extra fields fail deterministically.

- [ ] **Step 4: Run validator tests and verify GREEN**

Run:

```bash
node --import ./test/setup.js --test test/sync-event-validator.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit event contract**

```bash
git add src/sync/syncEventValidator.js test/sync-event-validator.test.js
git commit -m "feat: define tracking sync event contract"
```

### Task 5: Implement Atomic Watch and Collection Event Merging

**Files:**
- Create: `src/sync/syncRepository.js`
- Create: `src/sync/syncMergeService.js`
- Modify: `src/sync/syncEventValidator.js`
- Create: `test/sync-merge-service.test.js`

- [ ] **Step 1: Write merge RED tests**

Create an isolated database/account/device context and call:

```js
const result = service.merge({
  accountId,
  deviceId: "device-a",
  events: [watchUpsert({ eventId: "device-a:1", updatedAt: NOW_MS })],
});
```

Assert the event ledger stores `operation`, minimal `payload_json`, no old keys, and the normalized watch/progress rows. Add independent tests for:

- duplicate re-upload returns `duplicateEventIds` and does not change state;
- a second occurrence of the same `eventId` inside one request is classified as duplicate and never applied twice;
- duplicate older than 24 hours still classifies as duplicate;
- same timestamp uses `eventId` lexical order;
- two episodes retain independent progress versions;
- `watch.delete` removes all progress, writes tombstone, blocks older upsert, and newer upsert revives;
- `watch.clear` removes watch rows/tombstones whose own versions are not newer than the clear, stores the waterline, blocks older offline events, and preserves newer state when an older clear arrives late;
- collection upsert/delete/revive/clear mirrors watch semantics;
- one invalid new event rolls back every ledger/state write in the batch;
- injected trigger failure rolls back ledger and state together;
- post-commit `ensureMetadata(ids)` receives only unique IDs referenced by accepted new upsert/delete events and its thrown error does not roll back sync data.

- [ ] **Step 2: Run merge tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/sync-event-validator.test.js test/sync-merge-service.test.js
```

Expected: FAIL because the repository and merge service do not exist.

- [ ] **Step 3: Implement repository primitives**

`createSyncRepository({ sqlite, clock })` exposes:

```js
{
  transaction(fn),
  findExistingEventIds(accountId, eventIds),
  insertEvent(accountId, event),
  applyEvent(accountId, event),
  touchDevice(accountId, deviceId),
  listWatchRecords(accountId),
  listWatchProgress(accountId),
  findWatchClearVersion(accountId),
  listCollectionRecords(accountId),
  findCollectionClearVersion(accountId),
}
```

`applyEvent()` dispatches the six exact operations and uses the validator's UTF-8 `compareSyncVersions()` helper, which matches SQLite's default `BINARY` text ordering; never use locale-sensitive collation. Use `>= 0` for item/progress/tombstone replacement and strict `> 0` against clear watermarks. Watch delete removes `watch_progress` before `watch_records`. Watch clear deletes progress where `progress_version <= clearVersion`, records where `record_version <= clearVersion`, and tombstones where `deleted_version <= clearVersion`, then upserts the watermark; collection clear applies the same version predicates. This preserves state newer than a late-arriving clear. Every list method used by snapshots orders rows by `bangumi_id`, then progress by `episode`, so repeated snapshots are deterministic.

- [ ] **Step 4: Implement merge orchestration**

`createSyncMergeService({ repository, ensureMetadata = () => {}, snapshotService = null, clock, logger = {} })` exposes `merge({ accountId, deviceId, events })`.

Fix `receivedAtMs` once, validate the batch container, and normalize every event identity before opening the transaction. This rejects an invalid device binding without writing anything while intentionally leaving duplicate business fields unparsed. Then, inside one repository transaction:

1. Fetch existing IDs once with an `IN` query and initialize `seenEventIds` from that result.
2. Iterate request events in order: when identity is already in `seenEventIds`, put it in `duplicateEventIds` without new-event validation; otherwise normalize it with the fixed `receivedAtMs`, insert its ledger row, add it to `seenEventIds`, and put it in `acceptedEventIds`.
3. Sort accepted normalized events by the same binary version order and apply them.
4. Touch the bound device.

This makes duplicates already stored in the database and repeated IDs inside the current request follow the same rule. The first occurrence of a new ID must be valid; later occurrences are duplicates. After commit, call `ensureMetadata([...uniqueBangumiIds])` inside `try/catch` without awaiting network work. Log ensure-registration errors but do not change the successful merge result. Return:

```js
{
  acceptedEventIds,
  duplicateEventIds,
}
```

Snapshot attachment is added in Task 6.

- [ ] **Step 5: Run merge tests and verify GREEN**

Run:

```bash
node --import ./test/setup.js --test test/sync-event-validator.test.js test/sync-merge-service.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit merge engine**

```bash
git add src/sync/syncEventValidator.js src/sync/syncRepository.js src/sync/syncMergeService.js test/sync-merge-service.test.js
git commit -m "feat: merge tracking events atomically"
```

### Task 6: Build Local Sync Snapshots with Batched Bangumi Summaries

**Files:**
- Create: `src/bangumi/bangumiSummaryRepository.js`
- Create: `src/sync/syncSnapshotService.js`
- Modify: `src/sync/syncMergeService.js`
- Create: `test/sync-snapshot-service.test.js`

- [ ] **Step 1: Write snapshot RED tests**

Seed watch and collection state plus normalized Bangumi subject/images/rating/tags. Assert one snapshot has the exact structure from the spec and that the same subject used in both domains is fetched once through the injected summary repository.

The attached summary shape is:

```js
{
  id: 123,
  title: "中文标题",
  name: "Original title",
  nameCn: "中文标题",
  summary: "summary",
  airDate: "2026-07-01",
  airWeekday: 3,
  platform: "TV",
  eps: 12,
  totalEpisodes: 12,
  coverUrl: "https://example.invalid/cover.jpg",
  ratingScore: 8.2,
  rank: 20,
  votes: 100,
  tags: ["动画", "冒险"],
}
```

Seed another private record with unknown ID and assert `subject === null`. Inject a Bangumi client that throws if called to prove snapshot is local-only. Recursively inspect JSON output and assert it contains none of `bangumiItem`, `entityKey`, `adapterName`, or `lastSrc`.

- [ ] **Step 2: Run snapshot tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/sync-snapshot-service.test.js
```

Expected: FAIL because summary and snapshot services do not exist.

- [ ] **Step 3: Implement batch summary reads**

`createBangumiSummaryRepository(sqlite)` exports `findByIds(ids)`, returning a `Map<number, Summary>`. Deduplicate positive integer IDs, return an empty map for no IDs, and use bounded chunked `IN` queries of at most 500 IDs. Batch-read `bangumi_subjects`, `bangumi_subject_images`, `bangumi_subject_rating`, and `bangumi_subject_tags`; assemble the exact shape above without querying old `subjects`.

- [ ] **Step 4: Implement snapshot assembly**

`createSyncSnapshotService({ syncRepository, summaryRepository, ensureMetadata = () => {}, clock })` exposes `build(accountId)`:

```js
return {
  generatedAt: clock().getTime(),
  watch: {
    clearVersion: syncRepository.findWatchClearVersion(accountId),
    records: watchRows.map(toWatchRecord),
  },
  collection: {
    clearVersion: syncRepository.findCollectionClearVersion(accountId),
    records: collectionRows.map(toCollectionRecord),
  },
};
```

Group progress rows by `bangumiId` using string episode keys. Attach `summaries.get(bangumiId) ?? null`. After local reads, call `ensureMetadata(allIds)` inside `try/catch`; log registration errors and still return the local snapshot. Update merge service so successful merge requires the injected `snapshotService` and returns `{ acceptedEventIds, duplicateEventIds, snapshot: snapshotService.build(accountId) }`. Tests that exercise Task 5 before snapshot construction may omit it and receive only the two event-ID arrays; production composition in Task 9 always injects it.

- [ ] **Step 5: Run snapshot and merge tests and verify GREEN**

Run:

```bash
node --import ./test/setup.js --test test/sync-merge-service.test.js test/sync-snapshot-service.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit snapshot domain**

```bash
git add src/bangumi/bangumiSummaryRepository.js src/sync/syncSnapshotService.js src/sync/syncMergeService.js test/sync-merge-service.test.js test/sync-snapshot-service.test.js
git commit -m "feat: build normalized tracking snapshots"
```

### Task 7: Make Bangumi Metadata Ensure Persistent and Idempotent

**Files:**
- Modify: `src/db/bangumiMetadataSchema.js`
- Modify: `src/db/schema.js:379-386`
- Modify: `src/bangumi/repository.js`
- Create: `src/bangumi/metadataEnsureService.js`
- Modify: `test/bangumi-metadata-schema.test.js`
- Modify: `test/bangumi-metadata-repository.test.js`
- Create: `test/bangumi-metadata-ensure.test.js`

- [ ] **Step 1: Write metadata ensure RED tests**

Change schema expectations so `bangumi_subject_refresh_state` has nullable `last_succeeded_at/last_attempted_at`, mandatory `next_refresh_at/updated_at`, and no foreign key. Insert ensure state for an ID absent from `bangumi_subjects`.

Test:

```js
const result = service.ensure([3, 3, 2]);
assert.deepEqual(result, {
  ensuredIds: [2, 3],
  newlyDueIds: [2, 3],
  dueIds: [2, 3],
});
assert.deepEqual(repository.listDueRefreshIds({ now: NOW, limit: 100 }), [
  { bangumiId: 2, consecutiveFailures: 0 },
  { bangumiId: 3, consecutiveFailures: 0 },
]);
```

Ensure repeated calls do not duplicate rows; successful fresh detail remains scheduled seven days out; failed backoff remains unchanged before due; an already-due row remains due. Test detail success transforms a pending unknown row into success state after inserting metadata.

- [ ] **Step 2: Run metadata tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/bangumi-metadata-schema.test.js test/bangumi-metadata-repository.test.js test/bangumi-metadata-ensure.test.js
```

Expected: FAIL because refresh state still requires a subject and completed detail.

- [ ] **Step 3: Update refresh-state schema and repository**

Use this exact DDL shape:

```sql
CREATE TABLE IF NOT EXISTS bangumi_subject_refresh_state (
  bangumi_id INTEGER PRIMARY KEY CHECK (bangumi_id > 0),
  last_succeeded_at TEXT,
  next_refresh_at TEXT NOT NULL,
  last_attempted_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bangumi_subject_refresh_due
  ON bangumi_subject_refresh_state(next_refresh_at);
```

Update Drizzle declarations. Extend `createBangumiRepository(sqlite)` with:

```js
ensureRefreshIds(ids, { now })
findRefreshState(bangumiId)
```

`ensureRefreshIds()` runs one transaction: query existing rows, `INSERT OR IGNORE` each deduplicated ID with `next_refresh_at = now`, then query all ensured rows due at `now`. Return `{ ensuredIds, newlyDueIds, dueIds }` in numeric ID order, where `ensuredIds` contains every valid requested ID, `newlyDueIds` contains only inserted rows, and `dueIds` contains inserted plus previously due rows. Existing future success/backoff rows remain byte-for-byte unchanged. `findRefreshState()` returns the normalized state regardless of whether a subject row exists. Change `hasCompletedDetail()` to require `last_succeeded_at IS NOT NULL`, not merely the existence of a refresh row. Update detail success upsert to set `last_succeeded_at`, `next_refresh_at`, `last_attempted_at`, failure count/error, and `updated_at`. Update failure recording to work for pending IDs, increment exactly once per network attempt, and set `updated_at`.

- [ ] **Step 4: Implement ensure service**

`createMetadataEnsureService({ repository, clock, wake = () => {} })` exposes:

```js
function ensure(ids) {
  const normalized = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  if (normalized.length === 0) return { ensuredIds: [], newlyDueIds: [], dueIds: [] };
  const result = repository.ensureRefreshIds(normalized, { now: clock().toISOString() });
  if (result.dueIds.length > 0) wake();
  return result;
}
```

`ensureRefreshIds()` returns `{ ensuredIds, newlyDueIds, dueIds }`: `newlyDueIds` are inserted rows, while `dueIds` include both inserted rows and already-existing rows whose `next_refresh_at <= now`. This ensures an existing due task wakes the worker without altering a future success or backoff time. Invalid IDs from internal callers are filtered rather than creating corrupt tasks; public event validation remains strict.

- [ ] **Step 5: Run metadata tests and verify GREEN**

Run:

```bash
node --import ./test/setup.js --test test/bangumi-metadata-schema.test.js test/bangumi-metadata-repository.test.js test/bangumi-metadata-ensure.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit persistent ensure state**

```bash
git add src/db/bangumiMetadataSchema.js src/db/schema.js src/bangumi/repository.js src/bangumi/metadataEnsureService.js test/bangumi-metadata-schema.test.js test/bangumi-metadata-repository.test.js test/bangumi-metadata-ensure.test.js
git commit -m "feat: persist Bangumi metadata ensure tasks"
```

### Task 8: Drain Due Metadata and Connect Every Discovery Path

**Files:**
- Create: `src/bangumi/metadataRefreshWorker.js`
- Modify: `src/bangumi/detailRefreshService.js`
- Modify: `src/bangumi/calendarService.js`
- Modify: `src/bangumi/metadataService.js`
- Modify: `src/bangumi/scheduler.js`
- Create: `src/runtime/bangumiRuntime.js`
- Modify: `src/services/searchService.js`
- Modify: `src/index.js`
- Modify: `test/bangumi-detail-refresh.test.js`
- Modify: `test/bangumi-calendar-service.test.js`
- Modify: `test/bangumi-metadata-service.test.js`
- Create: `test/bangumi-metadata-worker.test.js`
- Modify: `test/bangumi-scheduler.test.js`
- Create: `test/bangumi-search-lifecycle.test.js`

- [ ] **Step 1: Write worker and discovery-path RED tests**

Test a single-flight worker:

```js
const first = worker.wake();
const second = worker.wake();
assert.equal(first, second);
await first;
assert.deepEqual(batchResults, [
  { due: 100, succeeded: 100, failed: 0, settled: 100 },
  { due: 2, succeeded: 2, failed: 0, settled: 2 },
]);
```

Test it stops when a batch has fewer than 100 due rows, re-runs when `wake()` arrives during the final batch, and never overlaps two drains. A full batch whose success/failure state writes all fail reports `settled: 0` and stops instead of spinning on the same 100 due rows. Keep existing 2-concurrency, 500ms spacing, and 6h/24h/72h tests.

Extend `test/bangumi-detail-refresh.test.js` so one logical detail request still uses the existing Bangumi client transport retry policy: transient network blockage gets the client's short 500ms then 1500ms retries before the metadata attempt is classified as one failure and enters 6-hour persistent backoff. Assert those transport retries do not increment `consecutiveFailures` more than once.

Test detail reads against a shared metadata service: a fresh completed detail returns locally; a stale completed detail returns locally and wakes background refresh; a first missing/summary-only detail creates a due row and performs one foreground fetch; a row still inside failure backoff returns its available local summary (or `null`) without bypassing the backoff. Race a foreground read with the worker and assert their shared per-ID single-flight map starts only one Bangumi request and records at most one success/failure transition.

Inject `ensureMetadata` into calendar and metadata services. Assert successful calendar persistence ensures all member IDs; persisted search summaries ensure their IDs; failed calendar/search does not ensure; detail success sets seven-day next refresh without creating duplicates. Add a production wiring test proving startup and cron call the shared worker rather than a separate refresher instance.

In `test/bangumi-search-lifecycle.test.js`, inject one fake legacy Bangumi search returning two subjects plus a fake metadata service. Assert `enrichFromBangumiSearch()` invokes the external search exactly once, retains its existing `upsertAnime()` behavior, and passes those exact already-fetched subjects to `persistSearchResults()` once. Assert the search callback registered in `index.js` receives the shared runtime metadata service.

- [ ] **Step 2: Run focused Bangumi tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/bangumi-detail-refresh.test.js test/bangumi-calendar-service.test.js test/bangumi-metadata-service.test.js test/bangumi-metadata-worker.test.js test/bangumi-scheduler.test.js test/bangumi-search-lifecycle.test.js
```

Expected: FAIL because worker/wake and discovery ensures are missing.

- [ ] **Step 3: Implement worker single-flight drain**

`createMetadataRefreshWorker({ detailRefresher, batchSize = 100, logger })` exposes `wake()`, `drain()`, and `state()`.

Use a shared `activePromise` and `wakeRequested` flag. `wake()` is a non-`async` function that marks requested and returns the exact one active promise, starting it only when absent; `drain()` delegates to `wake()` so startup, cron, and ensure signals share the same flight. The loop clears the flag, calls `runDueBatch()`, and repeats when a wake arrived during the call or when `result.due === batchSize && result.settled > 0`. It stops on a short batch or a full no-progress batch. In `finally`, clear `activePromise`; if a wake raced with cleanup, immediately start the next drain. `state()` returns `{ running: activePromise !== null, wakeRequested }`. The runtime's fire-and-forget ensure callback attaches an error handler to `wake()` so a batch failure cannot become an unhandled rejection.

- [ ] **Step 4: Connect calendar, search, scheduler, and runtime**

- `calendarService.sync()` calls `ensureMetadata(entries.map(({ metadata }) => metadata.subject.bangumiId))` only after `replaceCalendarSnapshot()` succeeds. Catch/log ensure-registration failure separately so the already-persisted calendar remains a successful sync and is not mislabeled by `recordCalendarSyncFailure()`.
- `metadataService.searchAndPersist()` calls ensure only for successfully persisted valid IDs and likewise catches/logs ensure-registration failure without retrying the already-completed Bangumi search. Move failure-state calculation into the shared `metadataService.refreshDetail()` attempt: use the current row's failure count to select 6h/24h/72h, write it once, and rethrow a `DetailRefreshError` carrying `refreshStateRecorded: true`; if that state write also fails, log it and rethrow with `refreshStateRecorded: false`. `detailRefreshService` remains responsible only for due selection, request-start spacing, concurrency, and batch counts. It reports `settled` as successful details plus failures whose backoff state was recorded. Guard the complete fetch/write/failure transition with a per-`bangumiId` promise map so worker and explicit reads coalesce. Keep `src/clients/bangumiClient.js` transport retries at 500ms and 1500ms: they absorb brief proxy/network stalls inside one logical attempt, and only final exhaustion increments persistent failure count once.
- Update `getDetail()` to inspect local detail plus `findRefreshState()`. A completed future-due detail returns immediately. A completed due detail calls ensure and returns stale local data while the worker refreshes it. An incomplete detail calls ensure; fetch in the foreground only when that ID is currently due, sharing the same per-ID promise with the worker. If a failure row is still in backoff, return the local summary or `null` without a network call.
- Add `persistSearchResults(items)` to metadata service so `src/services/searchService.js` can pass the already-fetched Bangumi results without a second network request; it validates/normalizes, writes new-domain summaries, ensures IDs, and contains the same non-fatal ensure error boundary. Change `enrichFromBangumiSearch(keyword, { mediaType, metadataService })` to call both its existing legacy-domain `upsertAnime()` loop and `metadataService.persistSearchResults(subjects)` once. In `index.js`, register `onSearchFlush((keyword, options) => enrichFromBangumiSearch(keyword, { ...options, metadataService: bangumiRuntime.metadataService }))`; focused tests inject a fake metadata service.
- `createBangumiScheduler()` receives `metadataWorker`; `runDetails()` delegates to `metadataWorker.drain()`. Remove `createProductionBangumiScheduler()`; production composition now belongs only to the runtime.
- `createBangumiRuntime({ sqlite, cron, logger, clock, client = createBangumiMetadataClient() })` builds one repository/client/metadata service/calendar service/refresher/worker/ensure graph and returns all services plus one scheduler. The injectable client keeps wiring tests offline. Resolve the ensure→wake relationship with `let metadataWorker`, construct ensure with a closure that calls `metadataWorker?.wake()` and attaches `logger.error` on rejection, then assign the single worker after the metadata/detail services exist. No constructor invokes ensure before assignment, and no second worker or repository is created.
- `index.js` creates this runtime once, starts its scheduler, and wires it into the search callback. Task 9 then passes the same ensure service into the new account-sync runtime and server detail route; Task 8 does not reference modules that do not exist yet.

- [ ] **Step 5: Run focused Bangumi tests and verify GREEN**

Run:

```bash
node --import ./test/setup.js --test test/bangumi-detail-refresh.test.js test/bangumi-calendar-service.test.js test/bangumi-metadata-service.test.js test/bangumi-metadata-worker.test.js test/bangumi-scheduler.test.js test/bangumi-search-lifecycle.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit metadata lifecycle**

```bash
git add src/bangumi/metadataRefreshWorker.js src/bangumi/detailRefreshService.js src/bangumi/calendarService.js src/bangumi/metadataService.js src/bangumi/scheduler.js src/runtime/bangumiRuntime.js src/services/searchService.js src/index.js test/bangumi-detail-refresh.test.js test/bangumi-calendar-service.test.js test/bangumi-metadata-service.test.js test/bangumi-metadata-worker.test.js test/bangumi-scheduler.test.js test/bangumi-search-lifecycle.test.js
git commit -m "feat: complete Bangumi metadata lifecycle"
```

### Task 9: Switch to the New Account and Sync HTTP APIs

**Files:**
- Create: `src/routes/accountAuth.js`
- Create: `src/routes/accountRoutes.js`
- Create: `src/routes/syncRoutes.js`
- Create: `src/runtime/accountSyncRuntime.js`
- Modify: `src/server.js`
- Modify: `src/index.js`
- Modify: `test/api-contract.test.js`
- Create: `test/account-api.test.js`
- Create: `test/sync-api.test.js`

- [ ] **Step 1: Write account API RED tests**

Build an injected runtime over a test database and `createServer({ accountSyncRuntime })`. Cover:

- `POST /api/account/login` success and exact `account.username/deviceId/token` response;
- invalid fields return 400 `invalid_query` before scrypt;
- bad username/password return 401 `invalid_credentials`;
- `GET /api/account/status` returns username, current device, all devices, and no secret fields;
- `POST /api/account/logout` revokes only current token;
- missing/revoked token returns 401 `unauthorized`.

Assert `/api/sync/register`, `/api/sync/login`, `/api/sync/logout`, `/api/sync/status`, `/api/sync/register-device`, and `/api/sync/clear` all return 404.

Use a spy account service to prove status, logout, merge, and snapshot all pass through the same exported authentication middleware and each successful request calls `authenticate()` exactly once.

Extend the existing detail API contract test with an injected `ensureMetadata` spy. Assert each valid `/api/detail?id=<positive integer>` read calls `ensureMetadata([id])` once, while invalid IDs do not. A thrown ensure-registration error is logged and does not replace the existing cached detail response or trigger a network wait.

- [ ] **Step 2: Write sync API RED tests**

Cover authenticated `POST /api/sync/merge` and `GET /api/sync/snapshot`; device mismatch maps to 400 `device_mismatch`; excessive clock skew maps to 400 `clock_skew`; other validation maps to 400 `invalid_sync_event`; injected SQLite failure maps to 500 and leaves no ledger row. Assert 500 responses contain only the generic `server_error` code/message and never the injected SQL/trigger error, event payload, password, or Token. Assert request body is only `{ events }` and top-level `deviceId/clientSeq` are rejected.

- [ ] **Step 3: Run API tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/api-contract.test.js test/account-api.test.js test/sync-api.test.js
```

Expected: FAIL because the new routers/runtime do not exist and server still mounts the legacy router.

- [ ] **Step 4: Implement account routes**

Create `accountAuth.js` with `createAccountAuthMiddleware({ accountService, logger })`. It strictly parses one `Authorization: Bearer <token>` value, calls `accountService.authenticate(rawToken)`, assigns `req.accountAuth`, and returns the standard 401 `unauthorized` envelope for a missing/invalid Token. An unexpected authentication database error is logged server-side and returns a generic 500 `server_error` without its message. `createAccountRouter({ accountService, authenticate = createAccountAuthMiddleware({ accountService, logger }), logger })` defines login before this shared middleware, then authenticated status/logout. Validate the exact username/password/device length limits and allowed request keys at the route boundary before calling scrypt. Map expected invalid credentials to 401; log all other account-service errors and return only the same generic 500 envelope.

- [ ] **Step 5: Implement sync routes and runtime composition**

`createSyncRouter({ authenticate, syncMergeService, syncSnapshotService, logger })` requires the same middleware instance created for account routes and authenticates all routes. Merge accepts only a plain object whose sole key is `events`, then passes `accountId` and token-bound `deviceId`; snapshot passes `accountId`. Catch `SyncEventValidationError` and use its stable `code` with field-only messages that never serialize submitted values. Log unexpected errors server-side and return `errorEnvelope(null, { message: "Internal server error", errorCode: "server_error" })` with HTTP 500; do not use the current `serverErrorEnvelope`, which includes the original exception message.

`createAccountSyncRuntime({ sqlite, metadataEnsureService, clock, logger })` builds repositories/services once, injects the snapshot service into merge, creates one `authenticate` middleware, and returns `{ accountService, authenticate, syncMergeService, syncSnapshotService }`. Mount account router at `/api/account` and sync router at `/api/sync`. Define `createServer({ accountSyncRuntime = createAccountSyncRuntime({ sqlite, metadataEnsureService: { ensure() {} } }), ensureMetadata = () => {}, logger } = {})` so existing non-sync API tests keep using the temporary global database without constructing Bangumi network dependencies. The existing `/api/detail` route calls this local-only ensure entry after validating the ID, catches/logs registration failure, and continues its existing public DTO behavior. `index.js` explicitly passes the shared production account-sync runtime and `bangumiRuntime.metadataEnsureService.ensure` to `createServer()`.

- [ ] **Step 6: Run API tests and verify GREEN**

Run:

```bash
node --import ./test/setup.js --test test/api-contract.test.js test/account-api.test.js test/sync-api.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit HTTP cutover**

```bash
git add src/routes/accountAuth.js src/routes/accountRoutes.js src/routes/syncRoutes.js src/runtime/accountSyncRuntime.js src/server.js src/index.js test/api-contract.test.js test/account-api.test.js test/sync-api.test.js
git commit -m "refactor: replace account and sync APIs"
```

### Task 10: Remove Legacy Private Sync Code and Verify the Fresh-Database Boundary

**Files:**
- Delete: `src/services/syncTokenService.js`
- Delete: `src/services/privateSyncMergeService.js`
- Delete: `src/routes/privateSyncRoutes.js`
- Delete: `src/scripts/sync-user.js`
- Modify: `test/normalized-architecture.test.js`
- Modify: `test/resource-source-entrypoint.test.js`
- Create: `test/account-sync-boundary.test.js`

- [ ] **Step 1: Write the boundary test before deleting legacy modules**

Read only the new private-domain production modules with `readFileSync` and assert:

```js
for (const forbidden of [
  "sync_users", "sync_credentials", "sync_invites", "sync_tokens", "sync_devices",
  "watch_history_items", "watch_deleted_items", "watch_clear_state",
  "collection_items", "collection_deleted_items", "collection_clear_state",
  "bangumi_item_json", "entity_key", "adapter_name", "last_src",
]) {
  assert.equal(privateDomainSourceText.includes(forbidden), false, forbidden);
}
```

Build `privateDomainSourceText` only from `src/accounts`, `src/sync`, `src/routes/accountAuth.js`, `src/routes/accountRoutes.js`, `src/routes/syncRoutes.js`, and `src/runtime/accountSyncRuntime.js`; otherwise assertions for the forbidden literals would match the boundary test's own array or unrelated public resource-domain code. Assert `src/server.js` no longer imports `privateSyncRoutes` and does import both `accountRoutes` and `syncRoutes`; `src/index.js` shares one `bangumiRuntime`; the four legacy files do not exist; account/sync modules never import old `subjectRepository`, `resourceRepository`, `syncTokenService`, or `privateSyncMergeService`; and no runtime file implements invite registration or login rate limiting.

Update normalized architecture tests so a brand-new temporary database contains the new private tables, does not contain old private tables, and still contains all independent Bangumi/resource tables.

- [ ] **Step 2: Run boundary tests and verify RED**

Run:

```bash
node --import ./test/setup.js --test test/account-sync-boundary.test.js test/normalized-architecture.test.js test/resource-source-entrypoint.test.js
```

Expected: FAIL because legacy files still exist.

- [ ] **Step 3: Delete legacy code and tests**

Delete the four legacy implementation files. The four legacy private-sync tests were already deleted in Task 1. Remove every remaining import/reference. Do not add compatibility exports or forwarding facades.

- [ ] **Step 4: Run all focused account/sync/Bangumi tests**

Run:

```bash
node --import ./test/setup.js --test \
  test/account-sync-schema.test.js \
  test/account-service.test.js \
  test/account-cli.test.js \
  test/account-api.test.js \
  test/sync-event-validator.test.js \
  test/sync-merge-service.test.js \
  test/sync-snapshot-service.test.js \
  test/sync-api.test.js \
  test/bangumi-metadata-ensure.test.js \
  test/bangumi-metadata-worker.test.js \
  test/account-sync-boundary.test.js
```

Expected: PASS with zero real network calls.

- [ ] **Step 5: Run the complete regression suite**

Record the production database checksum and modification time, run all tests, then compare:

```bash
shasum -a 256 data/anime.db
stat -f '%m %z' data/anime.db
npm test
shasum -a 256 data/anime.db
stat -f '%m %z' data/anime.db
```

Expected: all tests pass; both checksum lines match and both stat lines match. If the production database has already been intentionally deleted before execution, verify instead that `npm test` does not create `data/anime.db`.

- [ ] **Step 6: Verify a fresh local database and CLI without touching production**

Use a temporary path:

```bash
tmpdir=$(mktemp -d)
LAEVA_DB_PATH="$tmpdir/anime.db" npm run account -- add --username alice --password password-password
LAEVA_DB_PATH="$tmpdir/anime.db" npm run account -- list
LAEVA_DB_PATH="$tmpdir/anime.db" node --input-type=module -e '
  import Database from "better-sqlite3";
  const db = new Database(process.env.LAEVA_DB_PATH, { readonly: true });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all("table").map((row) => row.name);
  console.log(JSON.stringify(names));
'
```

Expected: `alice` is listed; all 11 new private tables exist; no old-only private table name exists; reused `sync_events` and `watch_progress` contain only the new columns. Remove the temporary directory after inspection.

- [ ] **Step 7: Run final static and diff checks**

```bash
rg -n 'sync_users|sync_credentials|sync_invites|sync_tokens|sync_devices|watch_history_items|watch_deleted_items|watch_clear_state|collection_items|collection_deleted_items|collection_clear_state|bangumi_item_json|entity_key|adapter_name|last_src' src/accounts src/sync src/routes/accountAuth.js src/routes/accountRoutes.js src/routes/syncRoutes.js src/runtime/accountSyncRuntime.js
rg -n 'privateSyncRoutes|syncTokenService|privateSyncMergeService|scripts/sync-user' src
git diff --check
git status --short --branch
```

Expected: the two `rg` commands return no new-private-domain or runtime matches; `git diff --check` reports no errors. Old endpoint literals remain intentionally present in API tests asserting 404, and old table literals remain intentionally present in schema/boundary tests asserting absence. Git status may still show the pre-existing FFZY changes and user-owned document deletions, which must remain untouched.

- [ ] **Step 8: Commit cleanup**

```bash
git add src/services/syncTokenService.js src/services/privateSyncMergeService.js src/routes/privateSyncRoutes.js src/scripts/sync-user.js test/normalized-architecture.test.js test/resource-source-entrypoint.test.js test/account-sync-boundary.test.js
git commit -m "refactor: remove legacy private sync runtime"
```

## Final Review Checklist

- [ ] All account/sync requirements in `docs/superpowers/specs/2026-07-16-account-tracking-sync-design.md` map to a task above.
- [ ] New private tables are created only for a fresh database; no migration, export/import, drop, or compatibility code exists.
- [ ] Password and token plaintext never enter SQLite or API status/snapshot responses.
- [ ] Same-device token rotation, password-wide revocation, and account cascade deletion are covered.
- [ ] Duplicate events, 24-hour skew, tombstones, clear watermarks, and transaction rollback are covered.
- [ ] Private rows store only Bangumi IDs and tracking state, never metadata copies or playback URLs.
- [ ] Snapshot reads only local normalized Bangumi tables and attaches `null` for unknown IDs.
- [ ] Persistent ensure state supports unknown IDs, retry backoff, seven-day refresh, wake, and restart recovery.
- [ ] Old endpoints, commands, tables, modules, and tests are absent.
- [ ] Aslan is not modified.
- [ ] Production `data/anime.db` is not modified by automated tests or verification.
