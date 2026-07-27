import test from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { RESOURCE_SOURCE_PUBLIC_METHODS } from "../src/resourceSources/ResourceSource.js";
import { loadResourceSourceRegistry } from "../src/resourceSources/pluginRegistry.js";

test("production manifest loads the FFZY source without network access", async (t) => {
  const database = createTestDatabase();
  t.after(database.close);
  const registry = await loadResourceSourceRegistry({
    manifestPath: new URL("../config/resource-sources.json", import.meta.url),
    db: database.sqlite,
    logger: { log() {}, warn() {}, error() {} },
  });

  assert.deepEqual(registry.list().map(({ sourceKey, displayName }) => ({
    sourceKey,
    displayName,
  })), [{ sourceKey: "ffzy", displayName: "非凡资源" }]);
  const source = registry.get("ffzy");
  for (const method of RESOURCE_SOURCE_PUBLIC_METHODS) {
    assert.equal(typeof source[method], "function", `${method} should be available`);
  }
});
