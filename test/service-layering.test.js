import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const projectRoot = new URL("..", import.meta.url).pathname;

const FORBIDDEN_PATHS = [
  "config/cstations.json",
  "src/clients/resourceClient.js",
  "src/clients/resourceSources/ffzyClient.js",
  "src/lib/cstationConfig.js",
  "src/normalizers/bangumiCalendarNormalizer.js",
  "src/normalizers/bangumiSubjectNormalizer.js",
  "src/normalizers/resourceItemNormalizer.js",
  "src/repositories/episodeRepository.js",
  "src/repositories/resourceRepository.js",
  "src/repositories/subjectRepository.js",
  "src/repositories/syncRepository.js",
  "src/repositories/tagRepository.js",
  "src/services/anime.js",
  "src/services/queue.js",
];

const FORBIDDEN_SCRIPTS = [
  "prewarm:anime",
  "export:manual-review",
  "import:manual-review",
  "export:mapped-review",
  "import:mapped-review",
  "export:ai-match-pack",
  "validate:ai-match-suggestions",
];

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  }));
  return nested.flat();
}

test("production composition is provided by the normalized domain modules", async () => {
  const publicApi = await import("../src/runtime/publicApiRuntime.js");
  const bangumi = await import("../src/runtime/bangumiRuntime.js");
  const mapping = await import("../src/mappings/mappingRuntime.js");
  const accountSync = await import("../src/runtime/accountSyncRuntime.js");
  const ffzy = await import("../src/resourceSources/ffzy/FFZYSource.js");

  assert.equal(typeof publicApi.createPublicApiRuntime, "function");
  assert.equal(typeof bangumi.createBangumiRuntime, "function");
  assert.equal(typeof mapping.createMappingRuntime, "function");
  assert.equal(typeof accountSync.createAccountSyncRuntime, "function");
  assert.equal(typeof ffzy.default, "function");
});

test("obsolete runtime modules and configuration are absent", () => {
  for (const path of FORBIDDEN_PATHS) {
    assert.equal(existsSync(join(projectRoot, path)), false, path);
  }
});

test("package commands expose only supported server management workflows", async () => {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  for (const script of FORBIDDEN_SCRIPTS) {
    assert.equal(Object.hasOwn(packageJson.scripts, script), false, script);
  }
  for (const script of ["start", "start:sync", "account", "mapping:analyze", "mapping", "test"]) {
    assert.equal(typeof packageJson.scripts[script], "string", script);
  }
});

test("production source contains no legacy imports or SQL table references", async () => {
  const files = await listJavaScriptFiles(join(projectRoot, "src"));
  const forbiddenImport = /(?:services\/(?:anime|queue)|repositories\/(?:episodeRepository|resourceRepository|subjectRepository|syncRepository|tagRepository)|normalizers\/(?:bangumiCalendarNormalizer|bangumiSubjectNormalizer|resourceItemNormalizer)|clients\/(?:resourceClient|resourceSources\/ffzyClient))\.js/;
  const forbiddenSqlTable = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?|REFERENCES|DELETE\s+FROM)\s+(?:anime_other|subjects|subject_aliases|tags|subject_tags|resource_sources|resource_items|resource_mappings|episodes|sync_state|retry_state|manual_resource_state)\b/i;

  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, forbiddenImport, file);
    assert.doesNotMatch(source, forbiddenSqlTable, file);
  }
});

test("normalized Bangumi domain does not depend on resource or account runtimes", async () => {
  const bangumiRoot = join(projectRoot, "src/bangumi");
  for (const file of await listJavaScriptFiles(bangumiRoot)) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\.\.\/(?:mappings|resourceSources|sync|account|publicApi)\//, file);
  }
});
