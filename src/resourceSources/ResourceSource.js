import {
  validateEpisodeIndex,
  validateExecutionSummary,
  validateLocalResourceItem,
  validateLocalResourceItems,
  validateNonNegativeCount,
  validateResourceDetail,
  validateResourceEpisode,
  validateResourceEpisodes,
  validateResourceItems,
  validateSearchKeyword,
  validateSourceItemId,
} from "./contracts.js";

export const RESOURCE_SOURCE_PUBLIC_METHODS = Object.freeze([
  "initialize",
  "update",
  "fetchDetail",
  "saveCatalogItems",
  "saveDetail",
  "searchItems",
  "getItem",
  "getEpisodes",
  "getEpisode",
]);

export const RESOURCE_SOURCE_HOOKS = Object.freeze([
  "_initialize",
  "_update",
  "_fetchDetail",
  "_saveCatalogItems",
  "_saveDetail",
  "_searchItems",
  "_getItem",
  "_getEpisodes",
  "_getEpisode",
]);

export class ResourceSourceError extends Error {
  constructor({ sourceKey, operation, cause }) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`resource source ${sourceKey || "<unknown>"} ${operation} failed: ${causeMessage}`, { cause });
    this.name = "ResourceSourceError";
    this.sourceKey = sourceKey;
    this.operation = operation;
  }
}

export class ResourceSource {
  constructor({ db, logger } = {}) {
    if (new.target === ResourceSource) {
      throw new TypeError("ResourceSource is abstract and cannot be instantiated directly");
    }
    if (db == null) throw new TypeError("ResourceSource requires db");
    if (logger == null) throw new TypeError("ResourceSource requires logger");
    Object.defineProperties(this, {
      _db: { value: db, writable: false, configurable: false, enumerable: false },
      _logger: { value: logger, writable: false, configurable: false, enumerable: false },
    });
  }

  static get sourceKey() {
    return null;
  }

  get sourceKey() {
    return this.constructor.sourceKey;
  }

  async #invoke(operation, callback) {
    try {
      return await callback();
    } catch (cause) {
      if (
        cause instanceof ResourceSourceError
        && cause.sourceKey === this.sourceKey
        && cause.operation === operation
      ) {
        throw cause;
      }
      throw new ResourceSourceError({ sourceKey: this.sourceKey, operation, cause });
    }
  }

  async initialize() {
    return this.#invoke("initialize", async () => validateExecutionSummary(
      await this._initialize(),
      { sourceKey: this.sourceKey, operation: "initialize" },
    ));
  }

  async update() {
    return this.#invoke("update", async () => validateExecutionSummary(
      await this._update(),
      { sourceKey: this.sourceKey, operation: "update" },
    ));
  }

  async fetchDetail(sourceItemId) {
    return this.#invoke("fetchDetail", async () => {
      const id = validateSourceItemId(sourceItemId);
      return validateResourceDetail(await this._fetchDetail(id), { sourceKey: this.sourceKey });
    });
  }

  async saveCatalogItems(items) {
    return this.#invoke("saveCatalogItems", async () => {
      const normalized = validateResourceItems(items, { sourceKey: this.sourceKey });
      return validateNonNegativeCount(await this._saveCatalogItems(normalized), "saved item count");
    });
  }

  async saveDetail(detail) {
    return this.#invoke("saveDetail", async () => {
      const normalized = validateResourceDetail(detail, { sourceKey: this.sourceKey });
      return validateNonNegativeCount(await this._saveDetail(normalized), "saved episode count");
    });
  }

  async searchItems(keyword) {
    return this.#invoke("searchItems", async () => {
      const normalizedKeyword = validateSearchKeyword(keyword);
      return validateLocalResourceItems(await this._searchItems(normalizedKeyword), { sourceKey: this.sourceKey });
    });
  }

  async getItem(sourceItemId) {
    return this.#invoke("getItem", async () => {
      const id = validateSourceItemId(sourceItemId);
      const item = await this._getItem(id);
      return item === null ? null : validateLocalResourceItem(item, { sourceKey: this.sourceKey });
    });
  }

  async getEpisodes(sourceItemId) {
    return this.#invoke("getEpisodes", async () => {
      const id = validateSourceItemId(sourceItemId);
      return validateResourceEpisodes(await this._getEpisodes(id));
    });
  }

  async getEpisode(sourceItemId, episodeIndex) {
    return this.#invoke("getEpisode", async () => {
      const id = validateSourceItemId(sourceItemId);
      const index = validateEpisodeIndex(episodeIndex);
      const episode = await this._getEpisode(id, index);
      return episode === null ? null : validateResourceEpisode(episode);
    });
  }

  async _initialize() { throw new Error("_initialize() must be implemented"); }
  async _update() { throw new Error("_update() must be implemented"); }
  async _fetchDetail() { throw new Error("_fetchDetail() must be implemented"); }
  async _saveCatalogItems() { throw new Error("_saveCatalogItems() must be implemented"); }
  async _saveDetail() { throw new Error("_saveDetail() must be implemented"); }
  async _searchItems() { throw new Error("_searchItems() must be implemented"); }
  async _getItem() { throw new Error("_getItem() must be implemented"); }
  async _getEpisodes() { throw new Error("_getEpisodes() must be implemented"); }
  async _getEpisode() { throw new Error("_getEpisode() must be implemented"); }
}

export function assertResourceSourceClass(SourceClass) {
  if (
    typeof SourceClass !== "function"
    || SourceClass === ResourceSource
    || !(SourceClass.prototype instanceof ResourceSource)
  ) {
    throw new TypeError("resource source plugin default export must extend ResourceSource");
  }

  const keyDescriptor = Object.getOwnPropertyDescriptor(SourceClass, "sourceKey");
  if (!keyDescriptor || typeof keyDescriptor.get !== "function" || keyDescriptor.set != null) {
    throw new TypeError("resource source subclass must declare its own read-only static sourceKey getter");
  }
  const sourceKey = SourceClass.sourceKey;
  if (typeof sourceKey !== "string" || sourceKey.trim() === "" || sourceKey !== sourceKey.trim()) {
    throw new TypeError("resource source subclass sourceKey must be a trimmed non-empty string");
  }

  for (const method of RESOURCE_SOURCE_PUBLIC_METHODS) {
    if (SourceClass.prototype[method] !== ResourceSource.prototype[method]) {
      throw new TypeError(`resource source subclass cannot override public method ${method}()`);
    }
  }
  for (const hook of RESOURCE_SOURCE_HOOKS) {
    if (
      typeof SourceClass.prototype[hook] !== "function"
      || SourceClass.prototype[hook] === ResourceSource.prototype[hook]
    ) {
      throw new TypeError(`resource source subclass must implement ${hook}()`);
    }
  }
  return sourceKey;
}
