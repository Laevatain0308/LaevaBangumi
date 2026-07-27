import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { createMappingWorkbookService } from "../src/mappings/mappingWorkbookService.js";
import {
  MAPPED_HEADERS,
  MAPPED_SHEET,
  METADATA_SHEET,
  PENDING_HEADERS,
  PENDING_SHEET,
  SNAPSHOT_HEADERS,
  WORKBOOK_FORMAT_VERSION,
} from "../src/mappings/workbookFormat.js";

function createService() {
  let rowKey = 0;
  return createMappingWorkbookService({
    repository: {
      listUnmappedReviewSubjects() {
        return [
          { bangumiId: 1, title: "孤独摇滚！", airDate: "2022-10-09" },
          { bangumiId: 3, title: "未来动画", airDate: "2027-01-01" },
          { bangumiId: 4, title: "日期不明动画", airDate: "2026" },
        ];
      },
      listMappedReviewRows() {
        return [{
          bangumiId: 2,
          title: "赛马娘 第三季",
          airDate: "2023-10-05",
          sourceItemId: "9007199254740993",
          sourceTitle: "赛马娘第三季",
          sourceEpisodeStart: 1,
          sourceEpisodeEnd: 13,
        }];
      },
    },
    explainSubject: () => ({ reason: "name_score_low" }),
    mappingService: { applyManualGroup() { throw new Error("not used"); } },
    clock: () => new Date("2026-07-24T04:00:00.000Z"),
    rowKeyFactory: () => `row-${++rowKey}`,
  });
}

test("workbook export preserves the fixed visible and hidden contract", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mapping-workbook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "nested", "mapping.xlsx");
  const result = await createService().exportWorkbook({
    sourceKey: "ffzy",
    outputPath,
    filters: {
      includeUpcoming: false,
      name: null,
      year: null,
      bangumiId: null,
      limit: null,
    },
  });
  assert.deepEqual(result, { outputPath, sourceKey: "ffzy", pending: 1, mapped: 1 });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const pending = workbook.getWorksheet(PENDING_SHEET);
  const mapped = workbook.getWorksheet(MAPPED_SHEET);
  const metadata = workbook.getWorksheet(METADATA_SHEET);
  assert.deepEqual(pending.getRow(1).values.slice(1, 8), PENDING_HEADERS);
  assert.deepEqual(mapped.getRow(1).values.slice(1, 8), MAPPED_HEADERS);
  assert.equal(mapped.getCell("D2").value, "9007199254740993");
  assert.equal(mapped.getCell("D2").numFmt, "@");
  assert.equal(pending.getCell("H2").value, "row-1");
  assert.equal(mapped.getCell("H2").value, "row-2");
  assert.equal(pending.getColumn(8).hidden, true);
  assert.equal(mapped.getColumn(8).hidden, true);
  assert.equal(metadata.state, "veryHidden");
  assert.equal(metadata.getCell("B1").value, WORKBOOK_FORMAT_VERSION);
  assert.equal(metadata.getCell("B2").value, "ffzy");
  assert.deepEqual(metadata.getRow(5).values.slice(1, 8), SNAPSHOT_HEADERS);
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => (
    metadata.getRow(6).getCell(index + 1).value
  )), ["row-1", PENDING_SHEET, 2, 1, null, null, null]);
  assert.deepEqual(metadata.getRow(7).values.slice(1, 8), [
    "row-2", MAPPED_SHEET, 2, 2, "9007199254740993", 1, 13,
  ]);

  for (const sheet of [pending, mapped]) {
    assert.equal(sheet.views[0].state, "frozen");
    assert.equal(sheet.views[0].ySplit, 1);
    assert.equal(sheet.autoFilter, "A1:G2");
    assert.equal(sheet.views[0].showGridLines, false);
    assert.equal(sheet.getRow(1).font.bold, true);
  }
  assert.deepEqual(pending.columns.slice(0, 7).map(({ width }) => width), [14, 42, 16, 20, 10, 10, 28]);
  assert.deepEqual(mapped.columns.slice(0, 7).map(({ width }) => width), [14, 42, 16, 20, 42, 10, 10]);
  assert.equal(pending.getCell("B2").alignment.wrapText, true);
  assert.equal(pending.getCell("D2").fill.fgColor.argb, "FFF2CC");
  assert.equal(pending.getCell("A2").fill.fgColor.argb, "F2F2F2");
  assert.equal(pending.getCell("E2").dataValidation.type, "whole");
  assert.equal(pending.getCell("E2").dataValidation.operator, "greaterThanOrEqual");
  assert.equal(mapped.getCell("F2").dataValidation.type, "whole");
});

test("pending export optionally includes future and imprecise dates", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mapping-workbook-upcoming-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "mapping.xlsx");
  const result = await createService().exportWorkbook({
    sourceKey: "ffzy",
    outputPath,
    filters: { includeUpcoming: true, limit: 2 },
  });
  assert.equal(result.pending, 2);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const pending = workbook.getWorksheet(PENDING_SHEET);
  assert.deepEqual([pending.getCell("A2").value, pending.getCell("A3").value], [1, 3]);
  assert.equal(pending.getCell("G3").value, "尚未放送");
});
