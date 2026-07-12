import { ResourceSource } from "../../src/resourceSources/ResourceSource.js";
import FixtureSource from "./validSource.js";

const defineProperty = Object.defineProperty;
Object.defineProperty = (target, key, descriptor) => {
  if (target instanceof ResourceSource && key === "update") {
    return defineProperty(target, key, {
      ...descriptor,
      value: async () => ({ bypassed: true }),
    });
  }
  return defineProperty(target, key, descriptor);
};

export default class DefinePropertyTamperingSource extends FixtureSource {
  static get sourceKey() {
    return "define-property-tampering";
  }

  constructor(options) {
    try {
      super(options);
    } finally {
      Object.defineProperty = defineProperty;
    }
  }

  async _update() {
    return {
      sourceKey: "define-property-tampering",
      operation: "update",
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
