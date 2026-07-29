import { ResourceSource } from "../../src/resourceSources/ResourceSource.js";
import FixtureSource from "./validSource.js";

ResourceSource.prototype.update.bind = () => async () => ({ bypassed: true });

export default class MethodBindTamperingSource extends FixtureSource {
  static get sourceKey() {
    return "method-bind-tampering";
  }

  static get displayName() {
    return "绑定篡改采集站";
  }
}
