import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { createTestDatabase } from "./helpers/testDatabase.js";
import { createMappingRepository } from "../src/mappings/mappingRepository.js";
import { createMappingService } from "../src/mappings/mappingService.js";
import { createMappingWorkbookService } from "../src/mappings/mappingWorkbookService.js";
import { MAPPED_SHEET, METADATA_SHEET, PENDING_SHEET } from "../src/mappings/workbookFormat.js";

const NOW = "2026-07-25T00:00:00.000Z";

function seedSubject(sqlite, bangumiId) {
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (
      bangumi_id, name, name_cn, air_date, discovered_at, updated_at
    ) VALUES (?, ?, ?, '2025-01-01', ?, ?)
  `).run(bangumiId, `Subject ${bangumiId}`, `番剧 ${bangumiId}`, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO bangumi_subject_refresh_state (
      bangumi_id, last_succeeded_at, next_refresh_at, updated_at
    ) VALUES (?, ?, ?, ?)
  `).run(bangumiId, NOW, NOW, NOW);
}

function seedSource(sqlite, sourceItemId) {
  sqlite.prepare(`
    INSERT INTO source_items (
      source_key, source_item_id, title, first_seen_at, last_fetched_at
    ) VALUES ('ffzy', ?, ?, ?, ?)
  `).run(sourceItemId, `资源 ${sourceItemId}`, NOW, NOW);
}

function mapping(bangumiId, sourceItemId, start = null, end = null) {
  return {
    bangumiId,
    sourceKey: "ffzy",
    sourceItemId,
    sourceEpisodeStart: start,
    sourceEpisodeEnd: end,
  };
}

async function createFixture(t, { subjects, sources, mappings = [] }) {
  const directory = await mkdtemp(join(tmpdir(), "mapping-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = createTestDatabase();
  t.after(database.close);
  subjects.forEach((id) => seedSubject(database.sqlite, id));
  sources.forEach((id) => seedSource(database.sqlite, id));
  const repository = createMappingRepository({ sqlite: database.sqlite });
  mappings.forEach((row) => repository.insertMapping(row));
  let rowKey = 0;
  const service = createMappingWorkbookService({
    repository,
    explainSubject: () => ({ reason: "no_resource" }),
    mappingService: createMappingService({ repository }),
    clock: () => new Date("2026-07-25T04:00:00.000Z"),
    rowKeyFactory: () => `row-${++rowKey}`,
  });
  const inputPath = join(directory, "review.xlsx");
  await service.exportWorkbook({
    sourceKey: "ffzy",
    outputPath: inputPath,
    filters: { includeUpcoming: false },
  });
  return { ...database, repository, service, inputPath };
}

test("workbook import isolates unrelated creates replacements deletes conflicts and failures", async (t) => {
  const fixture = await createFixture(t, {
    subjects: [1, 2, 3, 4, 5, 6, 7],
    sources: ["100", "300", "301", "400", "500", "501", "502", "700"],
    mappings: [mapping(3, "300"), mapping(4, "400"), mapping(5, "500"), mapping(7, "700")],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.inputPath);
  const pending = workbook.getWorksheet(PENDING_SHEET);
  const mapped = workbook.getWorksheet(MAPPED_SHEET);
  pending.getCell("D2").value = "100";
  pending.getCell("D3").value = "missing";
  mapped.getCell("D2").value = "301";
  mapped.getCell("D3").value = null;
  mapped.getCell("D4").value = "502";
  await workbook.xlsx.writeFile(fixture.inputPath);

  fixture.repository.deleteMapping({ bangumiId: 5, sourceKey: "ffzy" });
  fixture.repository.insertMapping(mapping(5, "501"));
  const report = await fixture.service.importWorkbook({
    inputPath: fixture.inputPath,
    allowedSourceKeys: ["ffzy"],
  });
  assert.deepEqual(report, {
    sourceKey: "ffzy",
    created: 1,
    replaced: 1,
    deleted: 1,
    ignored: 2,
    conflicts: 1,
    failed: 1,
    issues: [
      {
        sheet: PENDING_SHEET,
        row: 3,
        kind: "failed",
        code: "missing_reference",
        reason: "Bangumi ID 或采集站 ID 不存在",
      },
      {
        sheet: MAPPED_SHEET,
        row: 4,
        kind: "conflict",
        code: "mapping_changed",
        reason: "数据库映射已在导出后发生变化",
      },
    ],
  });
  assert.equal(fixture.repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }).sourceItemId, "100");
  assert.equal(fixture.repository.findMapping({ bangumiId: 2, sourceKey: "ffzy" }), null);
  assert.equal(fixture.repository.findMapping({ bangumiId: 3, sourceKey: "ffzy" }).sourceItemId, "301");
  assert.equal(fixture.repository.findMapping({ bangumiId: 4, sourceKey: "ffzy" }), null);
  assert.equal(fixture.repository.findMapping({ bangumiId: 5, sourceKey: "ffzy" }).sourceItemId, "501");
});

test("overlapping dependent rows roll back together while an unrelated group commits", async (t) => {
  const fixture = await createFixture(t, {
    subjects: [10, 11, 12, 13],
    sources: ["900", "901"],
    mappings: [mapping(10, "900")],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.inputPath);
  const pending = workbook.getWorksheet(PENDING_SHEET);
  pending.getCell("D2").value = "900";
  pending.getCell("E2").value = 1;
  pending.getCell("F2").value = 12;
  pending.getCell("D3").value = "900";
  pending.getCell("E3").value = 10;
  pending.getCell("D4").value = "901";
  await workbook.xlsx.writeFile(fixture.inputPath);

  const report = await fixture.service.importWorkbook({ inputPath: fixture.inputPath });
  assert.equal(report.created, 1);
  assert.equal(report.failed, 2);
  assert.equal(report.issues.every(({ code }) => code === "interval_overlap"), true);
  assert.equal(fixture.repository.findMapping({ bangumiId: 10, sourceKey: "ffzy" }).sourceItemId, "900");
  assert.equal(fixture.repository.findMapping({ bangumiId: 11, sourceKey: "ffzy" }), null);
  assert.equal(fixture.repository.findMapping({ bangumiId: 12, sourceKey: "ffzy" }), null);
  assert.equal(fixture.repository.findMapping({ bangumiId: 13, sourceKey: "ffzy" }).sourceItemId, "901");
});

test("damaged workbook metadata aborts before any mapping call", async (t) => {
  const fixture = await createFixture(t, { subjects: [1], sources: ["100"] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.inputPath);
  workbook.getWorksheet(METADATA_SHEET).getCell("B1").value = "unsupported";
  await workbook.xlsx.writeFile(fixture.inputPath);
  await assert.rejects(
    () => fixture.service.importWorkbook({ inputPath: fixture.inputPath }),
    (error) => error.code === "unsupported_workbook_version",
  );
  assert.equal(fixture.repository.findMapping({ bangumiId: 1, sourceKey: "ffzy" }), null);
});
