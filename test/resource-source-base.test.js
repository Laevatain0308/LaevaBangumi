import test from "node:test";
import assert from "node:assert/strict";
import {
  ResourceSource,
  ResourceSourceError,
} from "../src/resourceSources/ResourceSource.js";

const baseItem = {
  sourceKey: "fixture",
  sourceItemId: "item-1",
  title: "Fixture title",
  aliases: [],
  year: "2026",
  sourceUpdatedAt: "2026-07-12 01:00:00",
};

const localItem = {
  ...baseItem,
  firstSeenAt: "2026-07-01 00:00:00",
  lastFetchedAt: "2026-07-12 01:00:01",
};

const episode = {
  episodeIndex: 1,
  title: "HD中字",
  videoUrl: "https://example.invalid/movie.m3u8",
};

class FakeSource extends ResourceSource {
  static get sourceKey() {
    return "fixture";
  }

  calls = [];
  failOperation = null;

  async _initialize() {
    return this.#summary("initialize");
  }

  async _update() {
    if (this.failOperation === "update") throw new Error("remote unavailable");
    return this.#summary("update");
  }

  async _fetchDetail(sourceItemId) {
    this.calls.push(["fetchDetail", sourceItemId]);
    return { ...baseItem, sourceItemId, episodes: [episode] };
  }

  async _saveCatalogItems(items) {
    this.calls.push(["saveCatalogItems", items]);
    return items.length;
  }

  async _saveDetail(detail) {
    this.calls.push(["saveDetail", detail]);
    return detail.episodes.length;
  }

  async _searchItems(keyword) {
    this.calls.push(["searchItems", keyword]);
    return [localItem];
  }

  async _getItem(sourceItemId) {
    this.calls.push(["getItem", sourceItemId]);
    return sourceItemId === "missing" ? null : { ...localItem, sourceItemId };
  }

  async _getEpisodes(sourceItemId) {
    this.calls.push(["getEpisodes", sourceItemId]);
    return [episode];
  }

  async _getEpisode(sourceItemId, episodeIndex) {
    this.calls.push(["getEpisode", sourceItemId, episodeIndex]);
    return episodeIndex === 1 ? episode : null;
  }

  #summary(operation) {
    return {
      sourceKey: "fixture",
      operation,
      startedAt: "2026-07-12 01:00:00",
      finishedAt: "2026-07-12 01:00:01",
      fetchedItems: 1,
      savedItems: 1,
      fetchedEpisodes: 1,
      savedEpisodes: 1,
      failedItems: 0,
    };
  }
}

class FieldOverridingSource extends FakeSource {
  static get sourceKey() {
    return "field-override";
  }

  update = async () => ({ bypassed: true });
}

class KeyOverridingSource extends FakeSource {
  static get sourceKey() {
    return "declared-key";
  }

  sourceKey = "runtime-key";
}

test("ResourceSource cannot be instantiated and keeps injected infrastructure immutable", () => {
  assert.throws(() => new ResourceSource({ db: {}, logger: {} }), /abstract/i);
  const db = { name: "test-db" };
  const logger = { name: "test-logger" };
  const source = new FakeSource({ db, logger });
  assert.equal(source.sourceKey, "fixture");
  assert.equal(source._db, db);
  assert.equal(source._logger, logger);
  assert.throws(() => { source._db = {}; }, TypeError);
});

test("instance fields cannot override fixed public entry points", () => {
  assert.throws(
    () => new FieldOverridingSource({ db: {}, logger: {} }),
    /update/i,
  );
});

test("instance fields cannot override the hard-coded source key", () => {
  assert.throws(
    () => new KeyOverridingSource({ db: {}, logger: {} }),
    /sourceKey/i,
  );
});

test("fixed public methods validate and delegate standard values to hooks", async () => {
  const source = new FakeSource({ db: {}, logger: {} });
  assert.equal((await source.initialize()).operation, "initialize");
  assert.equal((await source.update()).operation, "update");
  assert.equal((await source.fetchDetail("item-2")).sourceItemId, "item-2");
  assert.equal(await source.saveCatalogItems([baseItem]), 1);
  assert.equal(await source.saveDetail({ ...baseItem, episodes: [episode] }), 1);
  assert.equal((await source.searchItems("fixture"))[0].title, "Fixture title");
  assert.equal((await source.getItem("missing")), null);
  assert.equal((await source.getEpisodes("item-1"))[0].episodeIndex, 1);
  assert.equal((await source.getEpisode("item-1", 2)), null);
});

test("invalid arguments fail before the subclass hook is called", async () => {
  const source = new FakeSource({ db: {}, logger: {} });
  await assert.rejects(() => source.fetchDetail("  "), ResourceSourceError);
  await assert.rejects(() => source.getEpisode("item-1", 0), /episodeIndex.*positive integer/i);
  assert.deepEqual(source.calls, []);
});

test("public methods reject source-specific fields instead of leaking them upward", async () => {
  const source = new FakeSource({ db: {}, logger: {} });
  await assert.rejects(() => source.saveCatalogItems([{ ...baseItem, coverUrl: "https://example.invalid/cover.jpg" }]), /exactly/i);
  assert.deepEqual(source.calls, []);
});

test("subclass failures are wrapped with source, operation, and cause", async () => {
  const source = new FakeSource({ db: {}, logger: {} });
  source.failOperation = "update";
  await assert.rejects(() => source.update(), (error) => {
    assert.equal(error instanceof ResourceSourceError, true);
    assert.equal(error.sourceKey, "fixture");
    assert.equal(error.operation, "update");
    assert.equal(error.cause.message, "remote unavailable");
    return true;
  });
});

test("database reads never fall back to the remote detail hook", async () => {
  const source = new FakeSource({ db: {}, logger: {} });
  assert.equal(await source.getItem("missing"), null);
  assert.deepEqual(source.calls, [["getItem", "missing"]]);
});

test("single-item results must match the requested resource and episode", async () => {
  class MismatchedSource extends FakeSource {
    async _fetchDetail() {
      return { ...baseItem, sourceItemId: "other", episodes: [episode] };
    }

    async _getItem() {
      return { ...localItem, sourceItemId: "other" };
    }

    async _getEpisode() {
      return { ...episode, episodeIndex: 2 };
    }
  }

  const source = new MismatchedSource({ db: {}, logger: {} });
  await assert.rejects(() => source.fetchDetail("item-1"), /sourceItemId.*item-1/i);
  await assert.rejects(() => source.getItem("item-1"), /sourceItemId.*item-1/i);
  await assert.rejects(() => source.getEpisode("item-1", 1), /episodeIndex.*1/i);
});
