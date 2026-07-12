import test from "node:test";
import assert from "node:assert/strict";
import FixtureSource from "./fixtures/resourceSources/validSource.js";
import {
  ResourceSource,
  assertResourceSourceClass,
} from "../src/resourceSources/ResourceSource.js";
import {
  loadResourceSourceRegistry,
} from "../src/resourceSources/pluginRegistry.js";

class IncompleteSource extends ResourceSource {
  static get sourceKey() {
    return "incomplete";
  }

  async _initialize() {}
}

class OverridingSource extends FixtureSource {
  static get sourceKey() {
    return "override";
  }

  async update() {
    return null;
  }
}

test("subclass validation rejects missing hooks and public method overrides", () => {
  assert.throws(() => assertResourceSourceClass(IncompleteSource), /must implement _update/i);
  assert.throws(() => assertResourceSourceClass(OverridingSource), /cannot override public method update/i);
  assert.throws(() => assertResourceSourceClass(class PlainSource {}), /must extend ResourceSource/i);
});

test("loader resolves paths relative to JSON and injects shared infrastructure", async () => {
  const db = { name: "fixture-db" };
  const logger = { name: "fixture-logger" };
  const registry = await loadResourceSourceRegistry({
    manifestPath: new URL("./fixtures/resourceSources/valid-manifest.json", import.meta.url),
    db,
    logger,
  });
  const source = registry.get("fixture");
  assert.equal(source instanceof ResourceSource, true);
  assert.equal(source._db, db);
  assert.equal(source._logger, logger);
  assert.deepEqual(registry.list(), [source]);
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.throws(() => registry.get("missing"), /unknown resource source: missing/i);
});

test("loader rejects duplicate hard-coded source keys", async () => {
  await assert.rejects(() => loadResourceSourceRegistry({
    manifestPath: new URL("./fixtures/resourceSources/duplicate-manifest.json", import.meta.url),
    db: {},
    logger: {},
  }), /duplicate resource source key: fixture/i);
});
