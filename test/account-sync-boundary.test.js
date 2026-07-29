import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

const root = new URL("..", import.meta.url);
const sourceRoot = new URL("../src/", import.meta.url);

function sourceFiles(relativePath) {
  const path = new URL(relativePath, sourceRoot);
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path.pathname, entry.name);
    if (entry.isDirectory()) {
      return readdirSync(child, { withFileTypes: true })
        .filter((nested) => nested.isFile() && extname(nested.name) === ".js")
        .map((nested) => join(child, nested.name));
    }
    return extname(entry.name) === ".js" ? [child] : [];
  });
}

const privateDomainFiles = [
  ...sourceFiles("accounts/"),
  ...sourceFiles("sync/"),
  new URL("routes/accountAuth.js", sourceRoot).pathname,
  new URL("routes/accountRoutes.js", sourceRoot).pathname,
  new URL("routes/syncRoutes.js", sourceRoot).pathname,
  new URL("runtime/accountSyncRuntime.js", sourceRoot).pathname,
];

test("new private domain contains no legacy tables, DTOs, or service imports", () => {
  const source = privateDomainFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  for (const forbidden of [
    "sync_users", "sync_credentials", "sync_invites", "sync_tokens", "sync_devices",
    "watch_history_items", "watch_deleted_items", "watch_clear_state",
    "collection_items", "collection_deleted_items", "collection_clear_state",
    "bangumi_item_json", "entity_key", "adapter_name", "last_src",
    "subjectRepository", "resourceRepository", "syncTokenService", "privateSyncMergeService",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("server mounts only the new account and sync routers", () => {
  const server = readFileSync(new URL("src/server.js", root), "utf8");
  assert.match(server, /routes\/accountRoutes\.js/);
  assert.match(server, /routes\/syncRoutes\.js/);
  assert.doesNotMatch(server, /privateSyncRoutes/);
});

test("entrypoint shares one Bangumi runtime with account sync and detail ensure", () => {
  const entrypoint = readFileSync(new URL("src/index.js", root), "utf8");
  assert.equal((entrypoint.match(/createBangumiRuntime\(/g) ?? []).length, 1);
  assert.match(entrypoint, /metadataEnsureService:\s*bangumiRuntime\.metadataEnsureService/);
  assert.match(entrypoint, /publicApiRuntime/);
});

test("legacy private sync implementation files are deleted", () => {
  for (const relativePath of [
    "src/services/syncTokenService.js",
    "src/services/privateSyncMergeService.js",
    "src/routes/privateSyncRoutes.js",
    "src/scripts/sync-user.js",
  ]) {
    assert.equal(existsSync(new URL(relativePath, root)), false, relativePath);
  }
});

test("runtime does not implement invite registration or login rate limiting", () => {
  const runtimeFiles = [
    new URL("src/runtime/accountSyncRuntime.js", root),
    new URL("src/routes/accountAuth.js", root),
    new URL("src/routes/accountRoutes.js", root),
    new URL("src/routes/syncRoutes.js", root),
  ];
  const source = runtimeFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /invite/i);
  assert.doesNotMatch(source, /rate.?limit/i);
});
