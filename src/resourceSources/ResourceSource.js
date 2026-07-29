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

// Capture contract-critical intrinsics before any configured plugin module is imported.
const bindFunction = Function.prototype.call.bind(Function.prototype.bind);
const defineProperties = Object.defineProperties;
const defineProperty = Object.defineProperty;
const freeze = Object.freeze;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const isPrototypeOf = Function.prototype.call.bind(Object.prototype.isPrototypeOf);
const initializedResourceSources = new WeakSet();
const markResourceSourceInitialized = bindFunction(WeakSet.prototype.add, initializedResourceSources);
const isResourceSourceInitialized = bindFunction(WeakSet.prototype.has, initializedResourceSources);

export const RESOURCE_SOURCE_PUBLIC_METHODS = freeze([
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

export const RESOURCE_SOURCE_HOOKS = freeze([
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
    defineProperties(this, {
      _db: { value: db, writable: false, configurable: false, enumerable: false },
      _logger: { value: logger, writable: false, configurable: false, enumerable: false },
      sourceKey: {
        value: this.constructor.sourceKey,
        writable: false,
        configurable: false,
        enumerable: true,
      },
      displayName: {
        value: this.constructor.displayName,
        writable: false,
        configurable: false,
        enumerable: true,
      },
    });
    for (let index = 0; index < RESOURCE_SOURCE_PUBLIC_METHODS.length; index += 1) {
      const method = RESOURCE_SOURCE_PUBLIC_METHODS[index];
      defineProperty(this, method, {
        value: bindFunction(fixedResourceSourceMethods[method], this),
        writable: false,
        configurable: false,
        enumerable: false,
      });
    }
    markResourceSourceInitialized(this);
  }

  static get sourceKey() {
    return null;
  }

  static get displayName() {
    return null;
  }

  get sourceKey() {
    return this.constructor.sourceKey;
  }

  get displayName() {
    return this.constructor.displayName;
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
      return validateResourceDetail(await this._fetchDetail(id), {
        sourceKey: this.sourceKey,
        sourceItemId: id,
      });
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
      return item === null ? null : validateLocalResourceItem(item, {
        sourceKey: this.sourceKey,
        sourceItemId: id,
      });
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
      return episode === null ? null : validateResourceEpisode(episode, { episodeIndex: index });
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

const fixedResourceSourceMethods = Object.create(null);
for (let index = 0; index < RESOURCE_SOURCE_PUBLIC_METHODS.length; index += 1) {
  const method = RESOURCE_SOURCE_PUBLIC_METHODS[index];
  fixedResourceSourceMethods[method] = freeze(ResourceSource.prototype[method]);
}
freeze(fixedResourceSourceMethods);
freeze(ResourceSource.prototype);
freeze(ResourceSource);

export function assertResourceSourceClass(SourceClass) {
  if (
    typeof SourceClass !== "function"
    || SourceClass === ResourceSource
    || !isPrototypeOf(ResourceSource, SourceClass)
    || !isPrototypeOf(ResourceSource.prototype, SourceClass.prototype)
  ) {
    throw new TypeError("resource source plugin default export must extend ResourceSource");
  }

  const keyDescriptor = getOwnPropertyDescriptor(SourceClass, "sourceKey");
  if (!keyDescriptor || typeof keyDescriptor.get !== "function" || keyDescriptor.set != null) {
    throw new TypeError("resource source subclass must declare its own read-only static sourceKey getter");
  }
  const sourceKey = SourceClass.sourceKey;
  if (typeof sourceKey !== "string" || sourceKey.trim() === "" || sourceKey !== sourceKey.trim()) {
    throw new TypeError("resource source subclass sourceKey must be a trimmed non-empty string");
  }
  const displayNameDescriptor = getOwnPropertyDescriptor(SourceClass, "displayName");
  if (
    !displayNameDescriptor
    || typeof displayNameDescriptor.get !== "function"
    || displayNameDescriptor.set != null
  ) {
    throw new TypeError("resource source subclass must declare its own read-only static displayName getter");
  }
  const displayName = SourceClass.displayName;
  if (
    typeof displayName !== "string"
    || displayName.trim() === ""
    || displayName !== displayName.trim()
  ) {
    throw new TypeError("resource source subclass displayName must be a trimmed non-empty string");
  }

  for (let index = 0; index < RESOURCE_SOURCE_PUBLIC_METHODS.length; index += 1) {
    const method = RESOURCE_SOURCE_PUBLIC_METHODS[index];
    if (SourceClass.prototype[method] !== fixedResourceSourceMethods[method]) {
      throw new TypeError(`resource source subclass cannot override public method ${method}()`);
    }
  }
  for (let index = 0; index < RESOURCE_SOURCE_HOOKS.length; index += 1) {
    const hook = RESOURCE_SOURCE_HOOKS[index];
    if (
      typeof SourceClass.prototype[hook] !== "function"
      || SourceClass.prototype[hook] === ResourceSource.prototype[hook]
    ) {
      throw new TypeError(`resource source subclass must implement ${hook}()`);
    }
  }
  return sourceKey;
}

export function assertResourceSourceInstance(instance, SourceClass, { db, logger } = {}) {
  if (!isResourceSourceInitialized(instance)) {
    throw new TypeError("resource source instance was not initialized by ResourceSource");
  }
  if (getPrototypeOf(instance) !== SourceClass.prototype) {
    throw new TypeError("resource source instance must use its declared subclass prototype");
  }
  if (instance.sourceKey !== SourceClass.sourceKey) {
    throw new TypeError("resource source instance sourceKey must match its subclass sourceKey");
  }
  if (instance.displayName !== SourceClass.displayName) {
    throw new TypeError("resource source instance displayName must match its subclass displayName");
  }
  if (instance._db !== db || instance._logger !== logger) {
    throw new TypeError("resource source instance must retain injected infrastructure");
  }
  for (let index = 0; index < RESOURCE_SOURCE_PUBLIC_METHODS.length; index += 1) {
    const method = RESOURCE_SOURCE_PUBLIC_METHODS[index];
    const descriptor = getOwnPropertyDescriptor(instance, method);
    if (
      !descriptor
      || typeof descriptor.value !== "function"
      || descriptor.writable
      || descriptor.configurable
    ) {
      throw new TypeError(`resource source instance must retain fixed public method ${method}()`);
    }
  }
  return instance;
}
