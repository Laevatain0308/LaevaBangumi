import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runAccountCommand } from "../src/scripts/account.js";

const NOW = "2026-07-16T00:00:00.000Z";
const LATER = "2026-07-17T00:00:00.000Z";

function createService() {
  const calls = [];
  return {
    calls,
    addAccount(input) {
      calls.push(["addAccount", input]);
      return { username: input.username.toLowerCase(), createdAt: NOW, passwordChangedAt: NOW };
    },
    setPassword(input) {
      calls.push(["setPassword", input]);
      return {
        account: { username: input.username, passwordChangedAt: LATER },
        revokedTokenCount: 2,
      };
    },
    deleteAccount(username) {
      calls.push(["deleteAccount", username]);
      return { username, createdAt: NOW, passwordChangedAt: LATER };
    },
    listAccounts() {
      calls.push(["listAccounts"]);
      return [{ username: "alice", createdAt: NOW, passwordChangedAt: LATER, deviceCount: 2 }];
    },
  };
}

test("account CLI delegates the four supported commands", () => {
  const service = createService();

  assert.deepEqual(runAccountCommand([
    "add", "--username", "Alice", "--password", "password-password",
  ], { service }), {
    account: { username: "alice", createdAt: NOW, passwordChangedAt: NOW },
  });
  assert.deepEqual(runAccountCommand([
    "set-password", "--username", "alice", "--password", "new-password",
  ], { service }), {
    account: { username: "alice", passwordChangedAt: LATER },
    revokedTokenCount: 2,
  });
  assert.deepEqual(runAccountCommand([
    "delete", "--username", "alice",
  ], { service }), {
    username: "alice",
    createdAt: NOW,
    passwordChangedAt: LATER,
  });
  assert.deepEqual(runAccountCommand(["list"], { service }), {
    accounts: [{ username: "alice", createdAt: NOW, passwordChangedAt: LATER, deviceCount: 2 }],
  });

  assert.deepEqual(service.calls, [
    ["addAccount", { username: "Alice", password: "password-password" }],
    ["setPassword", { username: "alice", password: "new-password" }],
    ["deleteAccount", "alice"],
    ["listAccounts"],
  ]);
});

test("account CLI rejects missing values, unexpected arguments, and duplicate options", () => {
  const service = createService();

  for (const argv of [
    ["add", "--username", "alice"],
    ["add", "--username", "alice", "--password"],
    ["delete", "--username", ""],
    ["delete", "alice"],
    ["add", "--username", "alice", "--username", "bob", "--password", "password-password"],
  ]) {
    assert.throws(() => runAccountCommand(argv, { service }));
  }
  assert.deepEqual(service.calls, []);
});

test("account CLI accepts only each command's documented options", () => {
  const service = createService();

  for (const argv of [
    ["list", "--username", "alice"],
    ["delete", "--username", "alice", "--password", "password-password"],
    ["add", "--username", "alice", "--password", "password-password", "--invite", "code"],
    ["create-token", "--username", "alice"],
    ["disable", "--username", "alice"],
    ["create-invite", "--label", "friend"],
    [],
  ]) {
    assert.throws(() => runAccountCommand(argv, { service }));
  }
  assert.deepEqual(service.calls, []);
});

test("package exposes account administration and removes the legacy sync user command", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.scripts.account, "node src/scripts/account.js");
  assert.equal("sync:user" in pkg.scripts, false);
});
