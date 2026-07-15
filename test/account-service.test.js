import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestDatabase } from "./helpers/testDatabase.js";
import {
  hashPassword,
  normalizeUsername,
  verifyPassword,
} from "../src/accounts/password.js";
import { createAccountRepository } from "../src/accounts/accountRepository.js";
import { createAccountService } from "../src/accounts/accountService.js";

const NOW = "2026-07-16T00:00:00.000Z";
const LATER = "2026-07-17T00:00:00.000Z";
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

function createContext(t, { wrapRepository } = {}) {
  const { sqlite, close } = createTestDatabase();
  t.after(close);
  let now = NOW;
  let randomByte = 0;
  const clock = () => new Date(now);
  const randomBytesImpl = (size) => {
    randomByte += 1;
    return Buffer.alloc(size, randomByte);
  };
  const baseRepository = createAccountRepository({ sqlite, clock });
  const repository = wrapRepository?.(baseRepository) ?? baseRepository;
  const service = createAccountService({ repository, clock, randomBytesImpl });
  return {
    sqlite,
    repository,
    service,
    setNow(value) {
      now = value;
    },
  };
}

function addAlice(service) {
  return service.addAccount({ username: "alice", password: "password-password" });
}

function loginAlice(service, deviceId, fields = {}) {
  return service.login({
    username: "alice",
    password: "password-password",
    deviceId,
    ...fields,
  });
}

function assertNoSecrets(value) {
  const visit = (candidate) => {
    if (candidate == null || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      assert.equal(
        ["passwordHash", "token", "tokenHash", "rawToken"].includes(key),
        false,
        `secret field exposed: ${key}`,
      );
      visit(child);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /scrypt\$/);
  assert.doesNotMatch(serialized, /lbat_/);
}

test("username and password primitives enforce normalization, bounds, and safe scrypt hashes", () => {
  assert.equal(normalizeUsername("  Alice  "), "alice");
  assert.equal(normalizeUsername("a".repeat(64)), "a".repeat(64));
  assert.throws(() => normalizeUsername("   "), /between 1 and 64/);
  assert.throws(() => normalizeUsername("a".repeat(65)), /between 1 and 64/);

  assert.match(hashPassword("a".repeat(8)), /^scrypt\$[^$]+\$[^$]+$/);
  assert.match(hashPassword("a".repeat(256)), /^scrypt\$[^$]+\$[^$]+$/);
  assert.throws(() => hashPassword("a".repeat(7)), /between 8 and 256/);
  assert.throws(() => hashPassword("a".repeat(257)), /between 8 and 256/);

  const first = hashPassword("password-password");
  const second = hashPassword("password-password");
  assert.notEqual(first, second, "each password hash must use a fresh salt");
  assert.equal(verifyPassword("password-password", first), true);
  assert.equal(verifyPassword("wrong-password", first), false);
  assert.equal(verifyPassword("short", first), false);

  for (const malformed of [
    null,
    "",
    "scrypt$salt",
    "scrypt$salt$digest$extra",
    "other$salt$digest",
    "scrypt$$digest",
    "scrypt$salt$",
    "scrypt$salt$!",
  ]) {
    assert.doesNotThrow(() => verifyPassword("password-password", malformed));
    assert.equal(verifyPassword("password-password", malformed), false);
  }
});

test("accounts store normalized unique names and only salted scrypt password hashes", (t) => {
  const { sqlite, service } = createContext(t);
  const first = service.addAccount({ username: "  Alice  ", password: "password-password" });
  const second = service.addAccount({ username: "bob", password: "password-password" });

  assert.deepEqual(first, {
    username: "alice",
    createdAt: NOW,
    passwordChangedAt: NOW,
  });
  const rows = sqlite.prepare("SELECT * FROM accounts ORDER BY username").all();
  assert.equal(rows[0].username, "alice");
  assert.match(rows[0].password_hash, /^scrypt\$/);
  assert.notEqual(rows[0].password_hash, "password-password");
  assert.notEqual(rows[0].password_hash, rows[1].password_hash);
  assert.equal(second.username, "bob");
  assert.throws(
    () => service.addAccount({ username: "ALICE", password: "another-password" }),
    /already exists/,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 2);
});

test("login accepts the correct password and hides missing or wrong account details", (t) => {
  const { service } = createContext(t);
  addAlice(service);

  assert.ok(loginAlice(service, "phone"));
  assert.equal(service.login({
    username: "alice",
    password: "wrong-password",
    deviceId: "other-phone",
  }), null);
  assert.equal(service.login({
    username: "missing",
    password: "wrong-password",
    deviceId: "other-phone",
  }), null);
});

test("login enters its transaction before normalizing or validating input", () => {
  let inTransaction = false;
  let transactionCount = 0;
  const repository = {
    transaction(callback) {
      transactionCount += 1;
      inTransaction = true;
      try {
        return callback();
      } finally {
        inTransaction = false;
      }
    },
    findAccountByUsername() {
      return null;
    },
  };
  const service = createAccountService({ repository });
  const observedUsername = {
    [Symbol.toPrimitive]() {
      assert.equal(inTransaction, true, "username normalization must run inside the transaction");
      return "alice";
    },
  };

  assert.equal(service.login({
    username: observedUsername,
    password: "password-password",
    deviceId: "phone",
  }), null);
  assert.throws(() => service.login({
    username: "alice",
    password: "password-password",
    deviceId: "",
  }), /deviceId/);
  assert.equal(transactionCount, 2, "invalid device input must be validated after transaction entry");
});

test("login propagates unexpected repository failures", () => {
  const databaseError = Object.assign(new Error("database is unavailable"), { code: "SQLITE_IOERR" });
  const service = createAccountService({
    repository: {
      transaction(callback) {
        return callback();
      },
      findAccountByUsername() {
        throw databaseError;
      },
    },
    clock: () => new Date(NOW),
    randomBytesImpl: (size) => Buffer.alloc(size, 1),
  });

  assert.throws(
    () => service.login({ username: "alice", password: "password-password", deviceId: "phone" }),
    (error) => error === databaseError,
  );
});

test("addAccount does not disguise unrelated SQLite constraints as duplicate usernames", () => {
  const databaseError = Object.assign(new Error("UNIQUE constraint failed: account_insert_guard.singleton"), {
    code: "SQLITE_CONSTRAINT_UNIQUE",
  });
  const service = createAccountService({
    repository: {
      transaction(callback) {
        return callback();
      },
      findAccountByUsername() {
        return null;
      },
      createAccount() {
        throw databaseError;
      },
    },
    clock: () => new Date(NOW),
    randomBytesImpl: (size) => Buffer.alloc(size, 1),
  });

  assert.throws(
    () => service.addAccount({ username: "alice", password: "password-password" }),
    (error) => error === databaseError,
  );
});

test("tokens use the lbat format while persistence receives only an indexed SHA-256 lookup key", (t) => {
  let lookupCount = 0;
  let lookupHash;
  const { sqlite, service } = createContext(t, {
    wrapRepository(base) {
      return {
        ...base,
        findActiveToken(tokenHash) {
          lookupCount += 1;
          lookupHash = tokenHash;
          return base.findActiveToken(tokenHash);
        },
      };
    },
  });
  addAlice(service);
  const login = loginAlice(service, "phone");

  assert.match(login.token, /^lbat_[A-Za-z0-9_-]{43}$/);
  const row = sqlite.prepare("SELECT token_hash FROM account_tokens").get();
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.token_hash, login.token);
  assert.equal(JSON.stringify(sqlite.prepare("SELECT * FROM account_tokens").all()).includes(login.token), false);

  assert.equal(service.authenticate("not-a-laeva-token"), null);
  assert.equal(lookupCount, 0, "invalid prefixes must not query token storage");
  assert.ok(service.authenticate(login.token));
  assert.equal(lookupCount, 1);
  assert.equal(lookupHash, createHash("sha256").update(login.token).digest("hex"));
});

test("same-device login preserves first seen time and rotates only that device token", (t) => {
  const { sqlite, service, setNow } = createContext(t);
  addAlice(service);
  const first = loginAlice(service, "phone", {
    deviceName: "Old Phone",
    platform: "ios",
    appVersion: "1.0.0",
  });
  const laptop = loginAlice(service, "laptop", {
    deviceName: "Laptop",
    platform: "macos",
    appVersion: null,
  });
  setNow(LATER);
  const second = service.login({
    username: "ALICE",
    password: "password-password",
    deviceId: "phone",
    deviceName: "New Phone",
    platform: "ios",
    appVersion: "2.0.0",
  });

  assert.equal(service.authenticate(first.token), null);
  assert.equal(service.authenticate(laptop.token).device.deviceId, "laptop");
  assert.equal(service.authenticate(second.token).device.deviceId, "phone");
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS n FROM account_tokens WHERE revoked_at IS NULL
  `).get().n, 2);
  assert.deepEqual(sqlite.prepare(`
    SELECT device_name, platform, app_version, first_seen_at, last_seen_at
    FROM account_devices WHERE device_id = 'phone'
  `).get(), {
    device_name: "New Phone",
    platform: "ios",
    app_version: "2.0.0",
    first_seen_at: NOW,
    last_seen_at: LATER,
  });
});

test("device identifiers and optional metadata enforce their bounds", (t) => {
  const { service } = createContext(t);
  addAlice(service);

  assert.ok(loginAlice(service, "d".repeat(128), {
    deviceName: null,
    platform: null,
    appVersion: null,
  }));
  for (const deviceId of ["", "d".repeat(129)]) {
    assert.throws(() => loginAlice(service, deviceId), /deviceId/);
  }
  for (const field of ["deviceName", "platform", "appVersion"]) {
    assert.throws(
      () => loginAlice(service, `${field}-device`, { [field]: "x".repeat(129) }),
      new RegExp(field),
    );
  }
});

test("authenticate returns account and device identity and touches token use time", (t) => {
  const { sqlite, service, setNow } = createContext(t);
  addAlice(service);
  const accountId = sqlite.prepare("SELECT account_id FROM accounts").get().account_id;
  const login = loginAlice(service, "phone", {
    deviceName: "Alice Phone",
    platform: "android",
    appVersion: "3.0.0",
  });
  setNow(LATER);

  const auth = service.authenticate(login.token);
  assert.deepEqual(auth, {
    accountId,
    username: "alice",
    tokenId: auth.tokenId,
    device: {
      deviceId: "phone",
      deviceName: "Alice Phone",
      platform: "android",
      appVersion: "3.0.0",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
  });
  assert.equal(
    sqlite.prepare("SELECT last_used_at FROM account_tokens WHERE token_id = ?").get(auth.tokenId).last_used_at,
    LATER,
  );
});

test("authenticate rejects a token revoked between lookup and last-used touch", () => {
  const auth = {
    accountId: 1,
    username: "alice",
    tokenId: 2,
    device: { deviceId: "phone" },
  };
  const service = createAccountService({
    repository: {
      findActiveToken() {
        return auth;
      },
      touchToken() {
        return false;
      },
    },
  });

  assert.equal(service.authenticate("lbat_raced-token"), null);
});

test("setPassword atomically replaces the hash and revokes every account token", (t) => {
  const { sqlite, service, setNow } = createContext(t);
  addAlice(service);
  const phone = loginAlice(service, "phone");
  const laptop = loginAlice(service, "laptop");
  const oldHash = sqlite.prepare("SELECT password_hash FROM accounts").get().password_hash;
  setNow(LATER);

  const result = service.setPassword({ username: " ALICE ", password: "new-password-password" });
  assert.deepEqual(result, {
    account: { username: "alice", passwordChangedAt: LATER },
    revokedTokenCount: 2,
  });
  const row = sqlite.prepare("SELECT password_hash, password_changed_at FROM accounts").get();
  assert.notEqual(row.password_hash, oldHash);
  assert.equal(row.password_changed_at, LATER);
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS n FROM account_tokens WHERE revoked_at IS NULL
  `).get().n, 0);
  assert.equal(service.authenticate(phone.token), null);
  assert.equal(service.authenticate(laptop.token), null);
  assert.equal(loginAlice(service, "tablet"), null);
  assert.ok(service.login({
    username: "alice",
    password: "new-password-password",
    deviceId: "tablet",
  }));
  assert.throws(
    () => service.setPassword({ username: "missing", password: "new-password-password" }),
    /does not exist/,
  );
});

test("logout revokes only the current token", (t) => {
  const { service } = createContext(t);
  addAlice(service);
  const phone = loginAlice(service, "phone");
  const laptop = loginAlice(service, "laptop");
  const phoneAuth = service.authenticate(phone.token);

  assert.equal(service.logout(phoneAuth.tokenId), true);
  assert.equal(service.authenticate(phone.token), null);
  assert.equal(service.authenticate(laptop.token).device.deviceId, "laptop");
});

test("deleteAccount cascades all private data but preserves public Bangumi metadata", (t) => {
  const { sqlite, service } = createContext(t);
  addAlice(service);
  const accountId = sqlite.prepare("SELECT account_id FROM accounts").get().account_id;
  loginAlice(service, "phone");
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (bangumi_id, name, discovered_at, updated_at)
    VALUES (42, 'Public Subject', ?, ?)
  `).run(NOW, NOW);
  sqlite.prepare(`
    INSERT INTO sync_events (
      account_id, event_id, device_id, seq, domain, operation, bangumi_id,
      updated_at_ms, version, payload_json, received_at
    ) VALUES (?, 'event', 'phone', 0, 'watch', 'upsert', 42, 0, 'v1', '{}', ?)
  `).run(accountId, NOW);
  sqlite.prepare(`
    INSERT INTO watch_records (
      account_id, bangumi_id, last_watch_episode, last_watch_time_ms,
      last_watch_episode_name, record_version
    ) VALUES (?, 42, 1, 0, 'Episode 1', 'v1')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO watch_progress (
      account_id, bangumi_id, episode, road, progress_ms, progress_version
    ) VALUES (?, 42, 1, 0, 100, 'v1')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO watch_tombstones (account_id, bangumi_id, deleted_version)
    VALUES (?, 43, 'v1')
  `).run(accountId);
  sqlite.prepare("INSERT INTO watch_state (account_id, clear_version) VALUES (?, 'v1')")
    .run(accountId);
  sqlite.prepare(`
    INSERT INTO collection_records (
      account_id, bangumi_id, type, collected_at_ms, updated_at_ms, record_version
    ) VALUES (?, 42, 3, 0, 0, 'v1')
  `).run(accountId);
  sqlite.prepare(`
    INSERT INTO collection_tombstones (account_id, bangumi_id, deleted_version)
    VALUES (?, 43, 'v1')
  `).run(accountId);
  sqlite.prepare("INSERT INTO collection_state (account_id, clear_version) VALUES (?, 'v1')")
    .run(accountId);

  assert.equal(service.deleteAccount(" ALICE ").username, "alice");
  for (const table of PRIVATE_TABLES) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM bangumi_subjects").get().n, 1);
  assert.throws(() => service.deleteAccount("missing"), /does not exist/);
});

test("listAccounts is sorted and exposes only public administration fields", (t) => {
  const { service, setNow } = createContext(t);
  service.addAccount({ username: "zoe", password: "password-password" });
  setNow(LATER);
  addAlice(service);
  loginAlice(service, "phone");
  loginAlice(service, "laptop");

  const accounts = service.listAccounts();
  assert.deepEqual(accounts, [
    {
      username: "alice",
      createdAt: LATER,
      passwordChangedAt: LATER,
      deviceCount: 2,
    },
    {
      username: "zoe",
      createdAt: NOW,
      passwordChangedAt: NOW,
      deviceCount: 0,
    },
  ]);
  assertNoSecrets(accounts);
});

test("status returns the current device and all account devices without secrets", (t) => {
  const { service, setNow } = createContext(t);
  addAlice(service);
  const phone = loginAlice(service, "phone", {
    deviceName: "Phone",
    platform: "android",
    appVersion: "1.0.0",
  });
  setNow(LATER);
  loginAlice(service, "laptop", {
    deviceName: "Laptop",
    platform: "linux",
    appVersion: null,
  });
  const auth = service.authenticate(phone.token);

  const status = service.status(auth);
  assert.deepEqual(status, {
    username: "alice",
    currentDevice: auth.device,
    devices: [
      {
        deviceId: "laptop",
        deviceName: "Laptop",
        platform: "linux",
        appVersion: null,
        firstSeenAt: LATER,
        lastSeenAt: LATER,
      },
      {
        deviceId: "phone",
        deviceName: "Phone",
        platform: "android",
        appVersion: "1.0.0",
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ],
  });
  assertNoSecrets(status);
});

test("account mutations always enter the repository transaction boundary", (t) => {
  let transactions = 0;
  const { service } = createContext(t, {
    wrapRepository(base) {
      return {
        ...base,
        transaction(callback) {
          transactions += 1;
          return base.transaction(callback);
        },
      };
    },
  });

  addAlice(service);
  loginAlice(service, "phone");
  service.setPassword({ username: "alice", password: "new-password-password" });
  service.deleteAccount("alice");
  assert.equal(transactions, 4);
});

test("failed token insertion rolls back device updates and previous-token revocation", (t) => {
  const { sqlite, service, setNow } = createContext(t);
  addAlice(service);
  const first = loginAlice(service, "phone", {
    deviceName: "Original Phone",
    platform: "android",
    appVersion: "1.0.0",
  });
  const originalToken = sqlite.prepare("SELECT * FROM account_tokens").get();
  const originalDevice = sqlite.prepare("SELECT * FROM account_devices").get();
  sqlite.exec(`
    CREATE TRIGGER fail_account_token_insert
    BEFORE INSERT ON account_tokens
    BEGIN
      SELECT RAISE(ABORT, 'token insert failed');
    END;
  `);
  setNow(LATER);

  assert.throws(() => service.login({
    username: "alice",
    password: "password-password",
    deviceId: "phone",
    deviceName: "Changed Phone",
    platform: "android",
    appVersion: "2.0.0",
  }), /token insert failed/);
  assert.deepEqual(sqlite.prepare("SELECT * FROM account_tokens").get(), originalToken);
  assert.deepEqual(sqlite.prepare("SELECT * FROM account_devices").get(), originalDevice);
  assert.equal(service.authenticate(first.token).device.deviceName, "Original Phone");
});
