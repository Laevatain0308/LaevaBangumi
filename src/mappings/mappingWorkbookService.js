import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import { classifyAirDate } from "./airDateEligibility.js";
import { MappingConflictError, MappingValidationError } from "./mappingService.js";
import {
  WorkbookRowError,
  cellScalar,
  detectWorkbookChange,
  groupWorkbookChanges,
  parseBangumiId,
  parseEpisodeIndex,
  parseSourceItemId,
} from "./workbookChanges.js";
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

const IMPORT_REASON_TEXT = Object.freeze({
  mapping_changed: "数据库映射已在导出后发生变化",
  readonly_identity_changed: "只读标识已被修改",
  dependent_row_invalid: "关联修改组中存在无效行",
  source_item_required: "填写分集范围时必须填写采集站 ID",
  invalid_interval: "分集范围必须为正整数，且末集不得小于始集",
  invalid_source_item_id: "采集站 ID 格式错误",
  formula_not_allowed: "不允许使用公式",
  invalid_cell_type: "单元格格式不受支持",
  missing_reference: "Bangumi ID 或采集站 ID 不存在",
  interval_overlap: "同一采集站 ID 的分段发生重叠",
  open_segment_not_last: "开放分段必须唯一且位于最后",
  source_item_one_to_one_conflict: "一对一映射不能与其他映射共享采集站 ID",
  source_item_segment_conflict: "共享采集站 ID 时每条映射都必须填写始集",
  database_error: "数据库写入失败",
});

class WorkbookStructureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkbookStructureError";
    this.code = code;
  }
}

function structure(condition, code, message) {
  if (!condition) throw new WorkbookStructureError(code, message);
}

function scalarText(value, column) {
  const scalar = cellScalar(value, { column });
  return scalar == null ? null : String(scalar).trim();
}

function exactHeader(sheet, headers) {
  return headers.every((value, index) => sheet.getCell(1, index + 1).value === value)
    && sheet.getCell(1, 8).value == null;
}

function oldMappingFromSnapshot(snapshot) {
  if (snapshot.sourceItemId == null) return null;
  return {
    bangumiId: snapshot.bangumiId,
    sourceItemId: snapshot.sourceItemId,
    sourceEpisodeStart: snapshot.sourceEpisodeStart,
    sourceEpisodeEnd: snapshot.sourceEpisodeEnd,
  };
}

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

  async function readWorkbook(inputPath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);
    const metadata = workbook.getWorksheet(METADATA_SHEET);
    structure(metadata, "metadata_sheet_missing", "mapping metadata sheet is missing");
    structure(
      metadata.getCell("B1").value === WORKBOOK_FORMAT_VERSION,
      "unsupported_workbook_version",
      "unsupported mapping workbook version",
    );
    const sourceKey = scalarText(metadata.getCell("B2").value, "source_key");
    structure(sourceKey, "source_key_missing", "mapping workbook source key is missing");
    structure(
      SNAPSHOT_HEADERS.every((value, index) => metadata.getCell(5, index + 1).value === value),
      "snapshot_missing",
      "mapping workbook snapshot headers are invalid",
    );
    const visible = [
      [PENDING_SHEET, PENDING_HEADERS],
      [MAPPED_SHEET, MAPPED_HEADERS],
    ].map(([sheetName, headers]) => {
      const sheet = workbook.getWorksheet(sheetName);
      structure(sheet, "visible_sheet_missing", `${sheetName} is missing`);
      structure(exactHeader(sheet, headers), "invalid_visible_headers", `${sheetName} headers are invalid`);
      return sheet;
    });

    const snapshots = new Map();
    for (let rowNumber = 6; rowNumber <= metadata.rowCount; rowNumber += 1) {
      const row = metadata.getRow(rowNumber);
      const rowKey = scalarText(row.getCell(1).value, "row_key");
      if (!rowKey) continue;
      structure(!snapshots.has(rowKey), "duplicate_row_key", `duplicate row key: ${rowKey}`);
      let bangumiId;
      try {
        bangumiId = parseBangumiId(row.getCell(4).value);
      } catch {
        throw new WorkbookStructureError("snapshot_missing", `invalid snapshot identity: ${rowKey}`);
      }
      const snapshot = {
        rowKey,
        sheetName: scalarText(row.getCell(2).value, "sheet_name"),
        exportedRowNumber: row.getCell(3).value,
        bangumiId,
        sourceItemId: parseSourceItemId(row.getCell(5).value),
        sourceEpisodeStart: parseEpisodeIndex(row.getCell(6).value, { column: "snapshot start" }),
        sourceEpisodeEnd: parseEpisodeIndex(row.getCell(7).value, { column: "snapshot end" }),
      };
      snapshots.set(rowKey, snapshot);
    }

    const rows = [];
    const usedKeys = new Set();
    for (const sheet of visible) {
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const hasContent = Array.from({ length: 8 }, (_, index) => row.getCell(index + 1).value)
          .some((value) => value != null && String(value).trim() !== "");
        if (!hasContent) continue;
        const rowKey = scalarText(row.getCell(8).value, "row_key");
        structure(rowKey && snapshots.has(rowKey), "snapshot_missing", `${sheet.name}!${rowNumber} snapshot is missing`);
        structure(!usedKeys.has(rowKey), "duplicate_row_key", `duplicate visible row key: ${rowKey}`);
        usedKeys.add(rowKey);
        const snapshot = snapshots.get(rowKey);
        let dependencySourceItemId = null;
        try {
          const bangumiId = parseBangumiId(row.getCell(1).value);
          const sourceColumn = 4;
          const startColumn = sheet.name === PENDING_SHEET ? 5 : 6;
          const endColumn = sheet.name === PENDING_SHEET ? 6 : 7;
          dependencySourceItemId = parseSourceItemId(row.getCell(sourceColumn).value);
          rows.push(detectWorkbookChange({
            sheetName: sheet.name,
            rowNumber,
            rowKey,
            bangumiId,
            edited: {
              sourceItemId: dependencySourceItemId,
              sourceEpisodeStart: parseEpisodeIndex(row.getCell(startColumn).value, { column: "始集" }),
              sourceEpisodeEnd: parseEpisodeIndex(row.getCell(endColumn).value, { column: "末集" }),
            },
            snapshot,
          }));
        } catch (error) {
          if (!(error instanceof WorkbookRowError)) throw error;
          rows.push({
            kind: "invalid",
            bangumiId: snapshot.bangumiId,
            rowRef: { sheetName: sheet.name, rowNumber, rowKey },
            error,
            oldMapping: oldMappingFromSnapshot(snapshot),
            dependencySourceItemId,
          });
        }
      }
    }
    structure(usedKeys.size === snapshots.size, "snapshot_missing", "snapshot and visible row counts differ");
    return { sourceKey, rows };
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

  async function importWorkbook({ inputPath, allowedSourceKeys = null }) {
    const parsed = await readWorkbook(inputPath);
    if (allowedSourceKeys && !allowedSourceKeys.includes(parsed.sourceKey)) {
      throw new WorkbookStructureError("source_key_missing", `unregistered source key: ${parsed.sourceKey}`);
    }
    const report = {
      sourceKey: parsed.sourceKey,
      created: 0,
      replaced: 0,
      deleted: 0,
      ignored: parsed.rows.filter(({ kind }) => kind === "ignore").length,
      conflicts: 0,
      failed: 0,
      issues: [],
    };
    const issue = (change, kind, code) => {
      report[kind === "conflict" ? "conflicts" : "failed"] += 1;
      report.issues.push({
        sheet: change.rowRef.sheetName,
        row: change.rowRef.rowNumber,
        kind,
        code,
        reason: IMPORT_REASON_TEXT[code] ?? IMPORT_REASON_TEXT.database_error,
      });
    };

    for (const group of groupWorkbookChanges(parsed.rows)) {
      const invalid = group.filter(({ kind }) => kind === "invalid");
      if (invalid.length > 0) {
        for (const change of group) {
          issue(change, "failed", change.kind === "invalid" ? change.error.code : "dependent_row_invalid");
        }
        continue;
      }
      const expectedBySubject = new Map();
      for (const change of group) {
        expectedBySubject.set(change.bangumiId, {
          bangumiId: change.bangumiId,
          sourceKey: parsed.sourceKey,
          mapping: change.expectedMapping == null
            ? null
            : { ...change.expectedMapping, sourceKey: parsed.sourceKey },
        });
      }
      const removals = group.flatMap((change) => change.oldMapping
        ? [{ ...change.oldMapping, sourceKey: parsed.sourceKey }]
        : []);
      const upserts = group.flatMap((change) => change.newMapping
        ? [{ ...change.newMapping, sourceKey: parsed.sourceKey }]
        : []);
      try {
        mappingService.applyManualGroup({
          expectedMappings: [...expectedBySubject.values()],
          removals,
          upserts,
        });
        for (const change of group) report[`${change.kind}d`] += 1;
      } catch (error) {
        const conflict = error instanceof MappingConflictError;
        const code = error instanceof MappingConflictError || error instanceof MappingValidationError
          ? error.code
          : "database_error";
        for (const change of group) issue(change, conflict ? "conflict" : "failed", code);
      }
    }
    const sheetOrder = new Map([[PENDING_SHEET, 0], [MAPPED_SHEET, 1]]);
    report.issues.sort((left, right) => (
      sheetOrder.get(left.sheet) - sheetOrder.get(right.sheet) || left.row - right.row
    ));
    return report;
  }

  return Object.freeze({ exportWorkbook, importWorkbook });
}
