import { ResourceSource } from "../../src/resourceSources/ResourceSource.js";

export default class FixtureSource extends ResourceSource {
  static get sourceKey() {
    return "fixture";
  }

  async _initialize() { return this.#summary("initialize"); }
  async _update() { return this.#summary("update"); }

  async _fetchDetail(sourceItemId) {
    return {
      sourceKey: "fixture",
      sourceItemId,
      title: "Fixture title",
      aliases: [],
      year: null,
      sourceUpdatedAt: null,
      episodes: [],
    };
  }

  async _saveCatalogItems(items) { return items.length; }
  async _saveDetail(detail) { return detail.episodes.length; }
  async _searchItems() { return []; }
  async _getItem() { return null; }
  async _getEpisodes() { return []; }
  async _getEpisode() { return null; }

  #summary(operation) {
    return {
      sourceKey: "fixture",
      operation,
      startedAt: "2026-07-12 01:00:00",
      finishedAt: "2026-07-12 01:00:01",
      fetchedItems: 0,
      savedItems: 0,
      fetchedEpisodes: 0,
      savedEpisodes: 0,
      failedItems: 0,
    };
  }
}
