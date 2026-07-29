import test from "node:test";
import assert from "node:assert/strict";
import FixtureSource from "../test-fixtures/resourceSources/validSource.js";
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

  static get displayName() {
    return "不完整采集站";
  }

  async _initialize() {}
}

class OverridingSource extends FixtureSource {
  static get sourceKey() {
    return "override";
  }

  static get displayName() {
    return "覆盖采集站";
  }

  async update() {
    return null;
  }
}

class ForgedSource {
  static get sourceKey() {
    return "forged";
  }

  async _initialize() {}
  async _update() {}
  async _fetchDetail() {}
  async _saveCatalogItems() {}
  async _saveDetail() {}
  async _searchItems() {}
  async _getItem() {}
  async _getEpisodes() {}
  async _getEpisode() {}
}

Object.setPrototypeOf(ForgedSource.prototype, ResourceSource.prototype);

class MissingDisplayNameSource extends FixtureSource {
  static get sourceKey() {
    return "missing-display-name";
  }
}

test("subclass validation rejects missing hooks and public method overrides", () => {
  assert.throws(() => assertResourceSourceClass(IncompleteSource), /must implement _update/i);
  assert.throws(() => assertResourceSourceClass(OverridingSource), /cannot override public method update/i);
  assert.throws(() => assertResourceSourceClass(MissingDisplayNameSource), /displayName/i);
  assert.throws(() => assertResourceSourceClass(class PlainSource {}), /must extend ResourceSource/i);
  assert.throws(() => assertResourceSourceClass(ForgedSource), /must extend ResourceSource/i);
});

test("loader resolves paths relative to JSON and injects shared infrastructure", async () => {
  const db = { name: "fixture-db" };
  const logger = { name: "fixture-logger" };
  const registry = await loadResourceSourceRegistry({
    manifestPath: new URL("../test-fixtures/resourceSources/valid-manifest.json", import.meta.url),
    db,
    logger,
  });
  const source = registry.get("fixture");
  assert.equal(source instanceof ResourceSource, true);
  assert.equal(source.sourceKey, "fixture");
  assert.equal(source.displayName, "测试采集站");
  assert.equal(source._db, db);
  assert.equal(source._logger, logger);
  assert.deepEqual(registry.list(), [source]);
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.throws(() => registry.get("missing"), /unknown resource source: missing/i);
});

test("loader rejects duplicate hard-coded source keys", async () => {
  await assert.rejects(() => loadResourceSourceRegistry({
    manifestPath: new URL("../test-fixtures/resourceSources/duplicate-manifest.json", import.meta.url),
    db: {},
    logger: {},
  }), /duplicate resource source key: fixture/i);
});

test("loader rejects non-relative plugin module URLs", async () => {
  await assert.rejects(() => loadResourceSourceRegistry({
    manifestPath: new URL("../test-fixtures/resourceSources/non-relative-manifest.json", import.meta.url),
    db: {},
    logger: {},
  }), /relative module path/i);
});

test("loader rejects subclass constructors that return replacement instances", async () => {
  await assert.rejects(() => loadResourceSourceRegistry({
    manifestPath: new URL("../test-fixtures/resourceSources/replacement-manifest.json", import.meta.url),
    db: {},
    logger: {},
  }), /not initialized by ResourceSource/i);
});

test("loader rejects plugins that tamper with fixed public methods during import", async () => {
  await assert.rejects(() => loadResourceSourceRegistry({
    manifestPath: new URL(
      "../test-fixtures/resourceSources/prototype-tampering-manifest.json",
      import.meta.url,
    ),
    db: {},
    logger: {},
  }), /read only|cannot assign/i);
});

test("loader rejects plugins that tamper with a fixed method bind function", async () => {
  await assert.rejects(() => loadResourceSourceRegistry({
    manifestPath: new URL(
      "../test-fixtures/resourceSources/method-bind-tampering-manifest.json",
      import.meta.url,
    ),
    db: {},
    logger: {},
  }), /read only|not extensible|cannot add property/i);
});

test("import-time global changes cannot replace fixed instance methods", async () => {
  const registry = await loadResourceSourceRegistry({
    manifestPath: new URL(
      "../test-fixtures/resourceSources/define-property-tampering-manifest.json",
      import.meta.url,
    ),
    db: {},
    logger: {},
  });

  assert.equal((await registry.get("define-property-tampering").update()).operation, "update");
});
