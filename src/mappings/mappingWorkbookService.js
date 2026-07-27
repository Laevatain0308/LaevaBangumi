import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import { classifyAirDate } from "./airDateEligibility.js";
import {
  MAPPED_HEADERS,
  MAPPED_SHEET,
  METADATA_SHEET,
  PENDING_HEADERS,
  PENDING_SHEET,
  SNAPSHOT_HEADERS,
  WORKBOOK_FORMAT_VERSION,
  reasonText,
} from "./workbookFormat.js";

const WIDTHS = Object.freeze({
  pending: [14, 42, 16, 20, 10, 10, 28],
  mapped: [14, 42, 16, 20, 42, 10, 10],
});
const COLORS = Object.freeze({
  header: "1F4E78",
  headerText: "FFFFFF",
  editable: "FFF2CC",
  reference: "F2F2F2",
  border: "D9E2F3",
});

function fill(color) {
  return { type: "pattern", pattern: "solid", fgColor: { argb: color } };
}

function styleSheet(sheet, { widths, editableColumns }) {
  sheet.views = [{ state: "frozen", xSplit: 0, ySplit: 1, showGridLines: false }];
  sheet.showGridLines = false;
  sheet.getColumn(8).hidden = true;
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  const header = sheet.getRow(1);
  header.height = 24;
  header.font = { bold: true, color: { argb: COLORS.headerText } };
  header.fill = fill(COLORS.header);
  header.alignment = { vertical: "middle", horizontal: "center" };
  header.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = { bottom: { style: "thin", color: { argb: COLORS.border } } };
  });
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.height = 30;
    for (let column = 1; column <= 7; column += 1) {
      const cell = row.getCell(column);
      cell.fill = fill(editableColumns.has(column) ? COLORS.editable : COLORS.reference);
      cell.alignment = { vertical: "middle", wrapText: [2, 5, 7].includes(column) };
      cell.border = { bottom: { style: "hair", color: { argb: COLORS.border } } };
    }
  }
  const endRow = Math.max(1, sheet.rowCount);
  sheet.autoFilter = { from: "A1", to: `G${endRow}` };
}

function validateEpisodeColumns(sheet, columns) {
  const lastRow = Math.max(sheet.rowCount, 2);
  for (const column of columns) {
    for (let row = 2; row <= lastRow; row += 1) {
      sheet.getCell(row, column).dataValidation = {
        type: "whole",
        operator: "greaterThanOrEqual",
        allowBlank: true,
        formulae: [1],
        showErrorMessage: true,
        errorTitle: "分集格式错误",
        error: "请输入大于等于 1 的正整数，或留空。",
      };
    }
  }
}

function writeSnapshot(metadata, snapshot) {
  const row = metadata.addRow([
    snapshot.rowKey,
    snapshot.sheetName,
    snapshot.rowNumber,
    snapshot.bangumiId,
    snapshot.sourceItemId,
    snapshot.sourceEpisodeStart,
    snapshot.sourceEpisodeEnd,
  ]);
  row.getCell(5).numFmt = "@";
}

export function createMappingWorkbookService({
  repository,
  explainSubject,
  mappingService,
  clock = () => new Date(),
  rowKeyFactory = randomUUID,
} = {}) {
  if (!repository || typeof explainSubject !== "function" || !mappingService) {
    throw new TypeError("mapping workbook service requires repository, explainSubject, and mappingService");
  }

  async function exportWorkbook({ sourceKey, outputPath, filters = {} }) {
    const query = {
      sourceKey,
      name: filters.name ?? null,
      year: filters.year ?? null,
      bangumiId: filters.bangumiId ?? null,
    };
    const pendingFacts = repository.listUnmappedReviewSubjects(query)
      .map((item) => ({ item, airing: classifyAirDate(item.airDate, clock()) }))
      .filter(({ airing }) => filters.includeUpcoming || airing.kind === "aired")
      .sort((left, right) => left.item.bangumiId - right.item.bangumiId);
    const mappedFacts = repository.listMappedReviewRows(query)
      .slice()
      .sort((left, right) => left.bangumiId - right.bangumiId);
    const limit = Number.isInteger(filters.limit) && filters.limit > 0 ? filters.limit : null;
    const pendingRows = limit == null ? pendingFacts : pendingFacts.slice(0, limit);
    const mappedRows = limit == null ? mappedFacts : mappedFacts.slice(0, limit);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "LaevaBangumi";
    workbook.created = clock();
    const pending = workbook.addWorksheet(PENDING_SHEET);
    const mapped = workbook.addWorksheet(MAPPED_SHEET);
    const metadata = workbook.addWorksheet(METADATA_SHEET, { state: "veryHidden" });
    metadata.state = "veryHidden";
    pending.addRow(PENDING_HEADERS);
    mapped.addRow(MAPPED_HEADERS);
    metadata.addRow(["format_version", WORKBOOK_FORMAT_VERSION]);
    metadata.addRow(["source_key", sourceKey]);
    metadata.addRow(["exported_at", clock().toISOString()]);
    metadata.addRow([]);
    metadata.addRow(SNAPSHOT_HEADERS);

    for (const { item, airing } of pendingRows) {
      let reason;
      if (airing.kind === "aired") {
        reason = reasonText(explainSubject({ bangumiId: item.bangumiId, sourceKey }).reason);
      } else if (airing.kind === "scheduled") {
        reason = "尚未放送";
      } else {
        reason = "放送日期不足以判断";
      }
      const rowKey = rowKeyFactory();
      const row = pending.addRow([
        item.bangumiId, item.title, item.airDate, null, null, null, reason, rowKey,
      ]);
      row.getCell(3).numFmt = "@";
      row.getCell(4).numFmt = "@";
      writeSnapshot(metadata, {
        rowKey,
        sheetName: PENDING_SHEET,
        rowNumber: row.number,
        bangumiId: item.bangumiId,
        sourceItemId: null,
        sourceEpisodeStart: null,
        sourceEpisodeEnd: null,
      });
    }

    for (const item of mappedRows) {
      const rowKey = rowKeyFactory();
      const row = mapped.addRow([
        item.bangumiId,
        item.title,
        item.airDate,
        String(item.sourceItemId),
        item.sourceTitle,
        item.sourceEpisodeStart,
        item.sourceEpisodeEnd,
        rowKey,
      ]);
      row.getCell(3).numFmt = "@";
      row.getCell(4).numFmt = "@";
      writeSnapshot(metadata, {
        rowKey,
        sheetName: MAPPED_SHEET,
        rowNumber: row.number,
        bangumiId: item.bangumiId,
        sourceItemId: String(item.sourceItemId),
        sourceEpisodeStart: item.sourceEpisodeStart,
        sourceEpisodeEnd: item.sourceEpisodeEnd,
      });
    }

    styleSheet(pending, { widths: WIDTHS.pending, editableColumns: new Set([4, 5, 6]) });
    styleSheet(mapped, { widths: WIDTHS.mapped, editableColumns: new Set([4, 6, 7]) });
    validateEpisodeColumns(pending, [5, 6]);
    validateEpisodeColumns(mapped, [6, 7]);
    await mkdir(dirname(outputPath), { recursive: true });
    await workbook.xlsx.writeFile(outputPath);
    return {
      outputPath,
      sourceKey,
      pending: pendingRows.length,
      mapped: mappedRows.length,
    };
  }

  async function importWorkbook() {
    throw new Error("mapping workbook import is not implemented");
  }

  return Object.freeze({ exportWorkbook, importWorkbook });
}
