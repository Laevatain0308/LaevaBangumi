import { createPublicApiService } from "../publicApi/publicApiService.js";
import { createPublicReadRepository } from "../publicApi/publicReadRepository.js";

export function createPublicApiRuntime({
  sqlite,
  resourceSourceRegistry,
  metadataEnsureService,
  repository: repositoryOverride,
  clock = () => new Date(),
} = {}) {
  if (!resourceSourceRegistry?.list) {
    throw new TypeError("public API runtime requires a resource source registry");
  }
  if (typeof metadataEnsureService?.ensure !== "function") {
    throw new TypeError("public API runtime requires metadata ensure service");
  }
  const sourceDescriptors = resourceSourceRegistry.list().map(({ sourceKey, displayName }) => ({
    sourceKey,
    displayName,
  }));
  const repository = repositoryOverride ?? createPublicReadRepository(sqlite);
  const service = createPublicApiService({
    repository,
    sourceDescriptors,
    ensureMetadata: metadataEnsureService.ensure,
    clock,
  });
  return Object.freeze({ repository, ...service });
}
