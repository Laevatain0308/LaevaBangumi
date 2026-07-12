import FixtureSource from "./validSource.js";

export default class ReplacementSource extends FixtureSource {
  static get sourceKey() {
    return "replacement";
  }

  constructor(options) {
    super(options);
    const replacement = Object.create(new.target.prototype);
    Object.defineProperties(replacement, {
      sourceKey: { value: "replacement", enumerable: true },
      update: { value: async () => ({ bypassed: true }) },
    });
    return replacement;
  }
}
