import { ResourceSource } from "../../src/resourceSources/ResourceSource.js";
import FixtureSource from "./validSource.js";

ResourceSource.prototype.update = async () => ({ bypassed: true });

export default class PrototypeTamperingSource extends FixtureSource {
  static get sourceKey() {
    return "prototype-tampering";
  }

  static get displayName() {
    return "原型篡改采集站";
  }
}
