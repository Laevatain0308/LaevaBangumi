import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { buildAiMatchPack, exportAiMatchPack } from "../src/services/aiMatchPackService.js";
import { validateAiMatchSuggestions } from "../src/services/aiMatchSuggestionValidator.js";

const SOURCE = "ai_pack_source";
const SECOND_SOURCE = "ai_pack_source_2";
const OWNER_ID = 990561001;
const TARGET_ID = 990561002;
const LATER_ID = 990561003;
const SOURCE_AID = 990561101;
const UNRELATED_AID = 990561102;

function cleanup() {
  sqlite.exec(`
    DELETE FROM episodes WHERE bangumi_id IN (${OWNER_ID}, ${TARGET_ID}, ${LATER_ID}) OR source IN ('${SOURCE}', '${SECOND_SOURCE}');
    DELETE FROM resource_mappings WHERE bangumi_id IN (${OWNER_ID}, ${TARGET_ID}, ${LATER_ID}) OR source IN ('${SOURCE}', '${SECOND_SOURCE}');
    DELETE FROM retry_state WHERE bangumi_id IN (${OWNER_ID}, ${TARGET_ID}, ${LATER_ID}) OR source IN ('${SOURCE}', '${SECOND_SOURCE}');
    DELETE FROM manual_resource_state WHERE bangumi_id IN (${OWNER_ID}, ${TARGET_ID}, ${LATER_ID}) OR source IN ('${SOURCE}', '${SECOND_SOURCE}');
    DELETE FROM resource_items WHERE source IN ('${SOURCE}', '${SECOND_SOURCE}');
    DELETE FROM resource_sources WHERE source IN ('${SOURCE}', '${SECOND_SOURCE}');
    DELETE FROM subject_aliases WHERE bangumi_id IN (${OWNER_ID}, ${TARGET_ID}, ${LATER_ID});
    DELETE FROM subjects WHERE bangumi_id IN (${OWNER_ID}, ${TARGET_ID}, ${LATER_ID});
  `);
}

function seedAiPackRows() {
  initDb();
  cleanup();
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, name_cn, air_date, eps, total_episodes, rating_distribution_json)
    VALUES
      (${OWNER_ID}, 'Dr.STONE SCIENCE FUTURE', '石纪元 科学与未来', '2025-01-09', 12, 12, '[]'),
      (${TARGET_ID}, 'Dr.STONE SCIENCE FUTURE 第2クール', '石纪元 科学与未来 第2部分', '2025-07-10', 12, 12, '[]'),
      (${LATER_ID}, 'Dr.STONE SCIENCE FUTURE 第3クール', '石纪元 科学与未来 第3部分', '2026-04-02', 13, 13, '[]');
    INSERT INTO subject_aliases (bangumi_id, alias)
    VALUES
      (${TARGET_ID}, '石纪元 第四季 第2部分'),
      (${TARGET_ID}, 'Dr. STONE SCIENCE FUTURE Cour 2');
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('${SOURCE}', 'AI Pack Source', 1);
    INSERT INTO resource_items (source, source_aid, title, subtitle, year, detail_fetched_at)
    VALUES
      ('${SOURCE}', ${SOURCE_AID}, '石纪元第四季', 'Dr.STONE 新石纪 第四季 / 石纪元 科学未来', '2025', datetime('now')),
      ('${SOURCE}', ${UNRELATED_AID}, '完全无关资源', 'Unrelated', '2025', datetime('now'));
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_subject_title, matched_resource_title, matched_at
    )
    VALUES (
      ${OWNER_ID}, '${SOURCE}', ${SOURCE_AID}, 1, 12,
      0, 0.99, '石纪元 科学与未来', '石纪元第四季', datetime('now')
    );
    INSERT INTO manual_resource_state (bangumi_id, source, status, note)
    VALUES (
      ${TARGET_ID}, '${SOURCE}', 'source_already_mapped',
      'source_aid ${SOURCE_AID} is already mapped by Bangumi ID ${OWNER_ID}'
    );
    INSERT INTO episodes (bangumi_id, source, source_aid, ep_index, source_ep_index, title, raw_video_url)
    VALUES
      (${OWNER_ID}, '${SOURCE}', ${SOURCE_AID}, 1, 1, '第01集', 'https://example.invalid/1.m3u8'),
      (${OWNER_ID}, '${SOURCE}', ${SOURCE_AID}, 12, 12, '第12集', 'https://example.invalid/12.m3u8');
  `);
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ai-match-pack-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test.afterEach(() => {
  cleanup();
});

test("AI match pack includes constrained candidates, owners, and episode stats", () => {
  seedAiPackRows();

  const pack = buildAiMatchPack({ source: SOURCE, candidateLimit: 5 });
  const targetCase = pack.cases.find((item) => item.anime.id === TARGET_ID);

  assert.ok(targetCase);
  assert.equal(targetCase.source, SOURCE);
  assert.equal(targetCase.currentState.status, "source_already_mapped");
  assert.deepEqual(targetCase.anime.aliases, [
    "Dr. STONE SCIENCE FUTURE Cour 2",
    "石纪元 第四季 第2部分",
  ]);
  assert.ok(targetCase.candidates.some((candidate) => candidate.sourceAid === SOURCE_AID));
  const candidate = targetCase.candidates.find((item) => item.sourceAid === SOURCE_AID);
  assert.equal(candidate.owners.length, 1);
  assert.equal(candidate.owners[0].animeId, OWNER_ID);
  assert.equal(candidate.episodeStats.episodeCount, 2);
  assert.equal(candidate.episodeStats.sourceEpMin, 1);
  assert.equal(candidate.episodeStats.sourceEpMax, 12);
  assert.ok(!targetCase.candidates.some((item) => item.sourceAid === UNRELATED_AID));
});

test("AI match pack exporter writes the required portable files", async () => {
  seedAiPackRows();

  await withTempDir(async (dir) => {
    const stats = await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });

    assert.ok(stats.cases >= 1);
    assert.equal(stats.resourceItems, 2);
    assert.ok(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")).generatedAt);
    const cases = await readJsonl(join(dir, "cases.jsonl"));
    assert.equal(cases.length, stats.cases);
    assert.ok(cases.some((item) => item.anime.id === TARGET_ID));
    assert.equal((await readJsonl(join(dir, "resource_items.jsonl"))).length, 2);
    assert.equal((await readJsonl(join(dir, "existing_mappings.jsonl"))).length, 1);
    assert.equal((await readJsonl(join(dir, "episode_stats.jsonl"))).length, 1);
    assert.ok(JSON.parse(await readFile(join(dir, "import_schema.json"), "utf8")).manualReviewColumns);
    assert.match(await readFile(join(dir, "README-for-ai.md"), "utf8"), /do not invent source_aid/i);
  });
});

test("AI match pack includes existing mapped shared sources with incomplete ranges", () => {
  seedAiPackRows();
  sqlite.exec(`
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_subject_title, matched_resource_title, matched_at
    )
    VALUES (
      ${TARGET_ID}, '${SOURCE}', ${SOURCE_AID}, 13, null,
      12, 0.95, '石纪元 科学与未来 第2部分', '石纪元第四季', datetime('now')
    ), (
      ${LATER_ID}, '${SOURCE}', ${SOURCE_AID}, 25, null,
      24, 0.95, '石纪元 科学与未来 第3部分', '石纪元第四季', datetime('now')
    );
  `);

  const pack = buildAiMatchPack({ source: SOURCE, candidateLimit: 5 });
  const targetCase = pack.cases.find((item) => item.anime.id === TARGET_ID);

  assert.ok(targetCase);
  assert.equal(targetCase.currentState.status, "mapped_range_incomplete");
});

test("AI suggestion validator rejects source IDs outside the exported candidate list", async () => {
  seedAiPackRows();

  await withTempDir(async (dir) => {
    await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });
    const suggestions = join(dir, "suggestions.jsonl");
    await writeFile(suggestions, `${JSON.stringify({
      animeId: TARGET_ID,
      decision: "match",
      sourceAid: UNRELATED_AID,
      confidence: "high",
      reason: "not in candidate list",
    })}\n`, "utf8");

    await assert.rejects(
      () => validateAiMatchSuggestions({ packDir: dir, suggestionsFile: suggestions, outputDir: dir }),
      /not present in exported candidates/
    );
  });
});

test("AI suggestion validator writes importable manual review CSV for valid suggestions", async () => {
  seedAiPackRows();

  await withTempDir(async (dir) => {
    await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });
    const suggestions = join(dir, "suggestions.jsonl");
    await writeFile(suggestions, `${JSON.stringify({
      animeId: TARGET_ID,
      decision: "match",
      sourceAid: SOURCE_AID,
      sourceEpStart: 13,
      sourceEpEnd: null,
      displayEpOffset: 12,
      confidence: "high",
      reason: "second cour of the same fourth season resource",
    })}\n`, "utf8");

    const stats = await validateAiMatchSuggestions({ packDir: dir, suggestionsFile: suggestions, outputDir: dir });
    const csv = await readFile(join(dir, "manual_review.csv"), "utf8");

    assert.equal(stats.accepted, 1);
    assert.match(csv, /anime_id,bg_title,source/);
    assert.match(csv, new RegExp(`${TARGET_ID}.*match.*${SOURCE_AID}`));
    assert.match(csv, /second cour of the same fourth season resource/);
  });
});

test("AI suggestion validator rejects a non-final shared range without sourceEpEnd", async () => {
  seedAiPackRows();
  sqlite.exec(`
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_subject_title, matched_resource_title, matched_at
    )
    VALUES (
      ${LATER_ID}, '${SOURCE}', ${SOURCE_AID}, 25, null,
      24, 0.95, '石纪元 科学与未来 第3部分', '石纪元第四季', datetime('now')
    );
  `);

  await withTempDir(async (dir) => {
    await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });
    const suggestions = join(dir, "suggestions.jsonl");
    await writeFile(suggestions, `${JSON.stringify({
      animeId: TARGET_ID,
      decision: "match",
      sourceAid: SOURCE_AID,
      sourceEpStart: 13,
      sourceEpEnd: null,
      displayEpOffset: 12,
      confidence: "high",
      reason: "middle segment missing end",
    })}\n`, "utf8");

    await assert.rejects(
      () => validateAiMatchSuggestions({ packDir: dir, suggestionsFile: suggestions, outputDir: dir }),
      /non-final shared range must include sourceEpEnd/
    );
  });
});

test("AI suggestion validator treats a suggestion for an existing mapping as a replacement", async () => {
  seedAiPackRows();
  sqlite.exec(`
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_subject_title, matched_resource_title, matched_at
    )
    VALUES (
      ${TARGET_ID}, '${SOURCE}', ${SOURCE_AID}, 13, null,
      12, 0.95, '石纪元 科学与未来 第2部分', '石纪元第四季', datetime('now')
    ), (
      ${LATER_ID}, '${SOURCE}', ${SOURCE_AID}, 25, null,
      24, 0.95, '石纪元 科学与未来 第3部分', '石纪元第四季', datetime('now')
    );
  `);

  await withTempDir(async (dir) => {
    await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });
    const suggestions = join(dir, "suggestions.jsonl");
    await writeFile(suggestions, `${JSON.stringify({
      caseId: `${TARGET_ID}:${SOURCE}`,
      animeId: TARGET_ID,
      decision: "match",
      sourceAid: SOURCE_AID,
      sourceEpStart: 13,
      sourceEpEnd: 24,
      displayEpOffset: 12,
      confidence: "high",
      reason: "fills the missing end for the middle shared segment",
    })}\n`, "utf8");

    const stats = await validateAiMatchSuggestions({ packDir: dir, suggestionsFile: suggestions, outputDir: dir });

    assert.equal(stats.accepted, 1);
  });
});

test("AI suggestion validator validates shared ranges after applying all suggestions in the batch", async () => {
  seedAiPackRows();
  sqlite.exec(`
    INSERT INTO resource_mappings (
      bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_subject_title, matched_resource_title, matched_at
    )
    VALUES (
      ${TARGET_ID}, '${SOURCE}', ${SOURCE_AID}, null, null,
      0, 0.95, '石纪元 科学与未来 第2部分', '石纪元第四季', datetime('now')
    ), (
      ${LATER_ID}, '${SOURCE}', ${SOURCE_AID}, 25, null,
      24, 0.95, '石纪元 科学与未来 第3部分', '石纪元第四季', datetime('now')
    );
  `);

  await withTempDir(async (dir) => {
    await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });
    const suggestions = join(dir, "suggestions.jsonl");
    await writeFile(suggestions, [
      JSON.stringify({
        caseId: `${TARGET_ID}:${SOURCE}`,
        animeId: TARGET_ID,
        decision: "match",
        sourceAid: SOURCE_AID,
        sourceEpStart: 13,
        sourceEpEnd: 24,
        displayEpOffset: 12,
        confidence: "high",
        reason: "fills the middle shared segment",
      }),
      JSON.stringify({
        caseId: `${LATER_ID}:${SOURCE}`,
        animeId: LATER_ID,
        decision: "match",
        sourceAid: SOURCE_AID,
        sourceEpStart: 25,
        sourceEpEnd: null,
        displayEpOffset: 24,
        confidence: "high",
        reason: "keeps the final ongoing shared segment",
      }),
    ].join("\n") + "\n", "utf8");

    const stats = await validateAiMatchSuggestions({ packDir: dir, suggestionsFile: suggestions, outputDir: dir });

    assert.equal(stats.accepted, 2);
  });
});

test("AI suggestion validator requires confidence and reason for match decisions", async () => {
  seedAiPackRows();

  await withTempDir(async (dir) => {
    await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });
    const suggestions = join(dir, "suggestions.jsonl");
    await writeFile(suggestions, `${JSON.stringify({
      caseId: `${TARGET_ID}:${SOURCE}`,
      animeId: TARGET_ID,
      decision: "match",
      sourceAid: SOURCE_AID,
      sourceEpStart: 13,
      sourceEpEnd: null,
      displayEpOffset: 12,
    })}\n`, "utf8");

    await assert.rejects(
      () => validateAiMatchSuggestions({ packDir: dir, suggestionsFile: suggestions, outputDir: dir }),
      /confidence is required for match/
    );
  });
});

test("AI suggestion validator requires a reason for non-match decisions", async () => {
  seedAiPackRows();

  await withTempDir(async (dir) => {
    await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });
    const suggestions = join(dir, "suggestions.jsonl");
    await writeFile(suggestions, `${JSON.stringify({
      caseId: `${TARGET_ID}:${SOURCE}`,
      animeId: TARGET_ID,
      decision: "ambiguous",
      confidence: "low",
    })}\n`, "utf8");

    await assert.rejects(
      () => validateAiMatchSuggestions({ packDir: dir, suggestionsFile: suggestions, outputDir: dir }),
      /reason is required/
    );
  });
});

test("AI suggestion validator rejects duplicate suggestions for the same case", async () => {
  seedAiPackRows();

  await withTempDir(async (dir) => {
    await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });
    const suggestions = join(dir, "suggestions.jsonl");
    const row = {
      caseId: `${TARGET_ID}:${SOURCE}`,
      animeId: TARGET_ID,
      decision: "ambiguous",
      confidence: "low",
      reason: "duplicate case",
    };
    await writeFile(suggestions, `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`, "utf8");

    await assert.rejects(
      () => validateAiMatchSuggestions({ packDir: dir, suggestionsFile: suggestions, outputDir: dir }),
      /duplicate suggestion for case/
    );
  });
});

test("AI suggestion validator requires caseId or source when animeId appears in multiple cases", async () => {
  seedAiPackRows();
  sqlite.exec(`
    INSERT INTO resource_sources (source, name, enabled)
    VALUES ('${SECOND_SOURCE}', 'AI Pack Second Source', 1);
    INSERT INTO resource_items (source, source_aid, title, subtitle, year, detail_fetched_at)
    VALUES ('${SECOND_SOURCE}', ${SOURCE_AID}, '石纪元第四季', 'Second source copy', '2025', datetime('now'));
  `);

  await withTempDir(async (dir) => {
    await exportAiMatchPack(dir, { source: SOURCE, candidateLimit: 5 });
    const secondDir = join(dir, "second");
    await exportAiMatchPack(secondDir, { source: SECOND_SOURCE, candidateLimit: 5 });
    const firstCases = await readJsonl(join(dir, "cases.jsonl"));
    const secondCases = await readJsonl(join(secondDir, "cases.jsonl"));
    await writeFile(join(dir, "cases.jsonl"), [...firstCases, ...secondCases].map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

    const ambiguousSuggestion = join(dir, "ambiguous.jsonl");
    await writeFile(ambiguousSuggestion, `${JSON.stringify({
      animeId: TARGET_ID,
      decision: "match",
      sourceAid: SOURCE_AID,
      sourceEpStart: 13,
      sourceEpEnd: null,
      displayEpOffset: 12,
      confidence: "high",
      reason: "animeId alone is ambiguous across sources",
    })}\n`, "utf8");

    await assert.rejects(
      () => validateAiMatchSuggestions({ packDir: dir, suggestionsFile: ambiguousSuggestion, outputDir: dir }),
      /appears in multiple exported cases/
    );

    const disambiguatedSuggestion = join(dir, "disambiguated.jsonl");
    await writeFile(disambiguatedSuggestion, `${JSON.stringify({
      caseId: `${TARGET_ID}:${SOURCE}`,
      animeId: TARGET_ID,
      decision: "match",
      sourceAid: SOURCE_AID,
      sourceEpStart: 13,
      sourceEpEnd: null,
      displayEpOffset: 12,
      confidence: "high",
      reason: "caseId selects the intended source",
    })}\n`, "utf8");

    const stats = await validateAiMatchSuggestions({ packDir: dir, suggestionsFile: disambiguatedSuggestion, outputDir: dir });
    const csv = await readFile(join(dir, "manual_review.csv"), "utf8");

    assert.equal(stats.accepted, 1);
    assert.match(csv, new RegExp(`${TARGET_ID}.*${SOURCE}.*match.*${SOURCE_AID}`));
  });
});
