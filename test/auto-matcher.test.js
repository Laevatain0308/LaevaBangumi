import test from "node:test";
import assert from "node:assert/strict";
import { buildTitlePool } from "../src/mappings/titleNormalizer.js";
import { createAutoMatcher } from "../src/mappings/autoMatcher.js";
import {
  AUTO_MATCH_MIN_GAP,
  AUTO_MATCH_MIN_NAME_SCORE,
} from "../src/mappings/config.js";

const NOW = new Date("2026-07-25T04:00:00.000Z");

function subject(overrides = {}) {
  return {
    bangumiId: 1,
    name: "Bocchi the Rock!",
    nameCn: "孤独摇滚！",
    aliases: ["ぼっち・ざ・ろっく！"],
    airDate: "2022-10-09",
    platform: "TV",
    totalEpisodes: 12,
    detailCompleted: true,
    ...overrides,
  };
}

function resource(overrides = {}) {
  return {
    sourceKey: "ffzy",
    sourceItemId: "100",
    title: "孤独摇滚",
    aliases: [],
    year: "2022",
    episodeCount: 12,
    detailCompleted: true,
    ...overrides,
  };
}

function createFixture({ subjects = [subject()], resources = [resource()], initialized = true } = {}) {
  const mappings = new Map();
  const exclusions = new Set();
  const writes = [];
  const key = (bangumiId, sourceKey) => `${bangumiId}:${sourceKey}`;
  const sourceKey = (source, sourceItemId) => `${source}:${sourceItemId}`;
  const repository = {
    findSubjectForMatching(bangumiId) {
      return subjects.find((item) => item.bangumiId === bangumiId) ?? null;
    },
    listSubjectsForMatching() { return subjects; },
    findSourceItemForMatching({ sourceKey: source, sourceItemId }) {
      return resources.find((item) => item.sourceKey === source && item.sourceItemId === sourceItemId) ?? null;
    },
    listSourceItemsForMatching({ sourceKey: source }) {
      return resources.filter((item) => item.sourceKey === source);
    },
    findMapping({ bangumiId, sourceKey: source }) {
      return mappings.get(key(bangumiId, source)) ?? null;
    },
    hasSourceItemMapping({ sourceKey: source, sourceItemId }) {
      return [...mappings.values()].some((item) => sourceKey(item.sourceKey, item.sourceItemId) === sourceKey(source, sourceItemId));
    },
    isSourceInitialized() { return initialized; },
    hasExclusion({ bangumiId, sourceKey: source, sourceItemId }) {
      return exclusions.has(`${bangumiId}:${source}:${sourceItemId}`);
    },
  };
  const mappingService = {
    createAutomaticMapping(input) {
      writes.push(input);
      const mapping = { ...input, sourceEpisodeStart: null, sourceEpisodeEnd: null };
      mappings.set(key(input.bangumiId, input.sourceKey), mapping);
      return { status: "created" };
    },
  };
  const matcher = createAutoMatcher({ repository, mappingService, clock: () => NOW });
  return { matcher, writes, mappings, exclusions };
}

test("automatic matcher uses the configured conservative thresholds", () => {
  assert.equal(AUTO_MATCH_MIN_NAME_SCORE, 0.80);
  assert.equal(AUTO_MATCH_MIN_GAP, 0.15);
  const { matcher } = createFixture();
  assert.equal(matcher.scoreNamePools(
    buildTitlePool({ primaryTitles: ["孤独摇滚"], aliases: [] }),
    buildTitlePool({ primaryTitles: ["孤独摇滚"], aliases: [] }),
  ), 1);
});

test("subject matching writes only a reciprocal unique eligible pair", () => {
  const { matcher, writes } = createFixture();
  assert.deepEqual(matcher.matchSubject({ bangumiId: 1, sourceKey: "ffzy" }), {
    status: "mapped",
    bangumiId: 1,
    sourceKey: "ffzy",
    sourceItemId: "100",
  });
  assert.deepEqual(writes, [{ bangumiId: 1, sourceKey: "ffzy", sourceItemId: "100" }]);
});

test("resource matching performs the same reciprocal selection in reverse", () => {
  const { matcher, writes } = createFixture();
  assert.deepEqual(matcher.matchSourceItem({ sourceKey: "ffzy", sourceItemId: "100" }), {
    status: "mapped",
    bangumiId: 1,
    sourceKey: "ffzy",
    sourceItemId: "100",
  });
  assert.equal(writes.length, 1);
});

test("matcher exposes stable eligibility and hard-filter reasons", () => {
  const cases = [
    [{ initialized: false }, "source_uninitialized"],
    [{ subjects: [subject({ detailCompleted: false })] }, "detail_incomplete"],
    [{ subjects: [subject({ airDate: "2027-01-01" })] }, "not_aired"],
    [{ subjects: [subject({ airDate: "2026" })] }, "air_date_unknown"],
    [{ resources: [resource({ detailCompleted: false, episodeCount: 0 })] }, "no_resource"],
    [{ resources: [resource({ year: "2023" })] }, "year_conflict"],
    [{ subjects: [subject({ nameCn: "某动画 第二季" })], resources: [resource({ title: "某动画 第三季" })] }, "season_conflict"],
    [{ subjects: [subject({ nameCn: "铠真传 第2部分" })], resources: [resource({ title: "铠真传" })] }, "part_ambiguous"],
    [{ subjects: [subject({ nameCn: "某动画 剧场版" })], resources: [resource({ title: "某动画 OVA" })] }, "form_conflict"],
    [{ subjects: [subject({ totalEpisodes: 12 })], resources: [resource({ episodeCount: 13 })] }, "episode_overflow"],
  ];
  for (const [options, reason] of cases) {
    assert.deepEqual(createFixture(options).matcher.explainSubject({ bangumiId: 1, sourceKey: "ffzy" }), { reason }, reason);
  }
});

test("missing year permits only a normalized full-title equality", () => {
  assert.equal(createFixture({
    resources: [resource({ title: "孤独摇滚", year: null })],
  }).matcher.matchSubject({ bangumiId: 1, sourceKey: "ffzy" }).status, "mapped");

  assert.deepEqual(createFixture({
    resources: [resource({ title: "孤独摇滚 青春乐队", year: null })],
  }).matcher.explainSubject({ bangumiId: 1, sourceKey: "ffzy" }), { reason: "name_score_low" });
});

test("exclusions and episode overflow block otherwise exact pairs", () => {
  const excluded = createFixture();
  excluded.exclusions.add("1:ffzy:100");
  assert.deepEqual(excluded.matcher.explainSubject({ bangumiId: 1, sourceKey: "ffzy" }), { reason: "excluded" });
  assert.equal(excluded.writes.length, 0);
});

test("forward or reverse ambiguity prevents automatic writes", () => {
  const forward = createFixture({
    resources: [
      resource({ sourceItemId: "100", title: "孤独摇滚" }),
      resource({ sourceItemId: "101", title: "孤独摇滚！" }),
    ],
  });
  assert.deepEqual(forward.matcher.explainSubject({ bangumiId: 1, sourceKey: "ffzy" }), { reason: "candidate_ambiguous" });

  const reverse = createFixture({
    subjects: [
      subject({ bangumiId: 1 }),
      subject({ bangumiId: 2, name: "孤独摇滚", nameCn: "孤独摇滚" }),
    ],
  });
  assert.deepEqual(reverse.matcher.matchSubject({ bangumiId: 1, sourceKey: "ffzy" }), {
    status: "unmatched",
    reason: "candidate_ambiguous",
  });
  assert.equal(reverse.writes.length, 0);
});
