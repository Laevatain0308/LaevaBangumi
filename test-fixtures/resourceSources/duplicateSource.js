import FixtureSource from "./validSource.js";

export default class DuplicateFixtureSource extends FixtureSource {
  static get sourceKey() {
    return "fixture";
  }

  static get displayName() {
    return "重复采集站";
  }
}
