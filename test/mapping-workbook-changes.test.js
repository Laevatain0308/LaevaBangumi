import test from "node:test";
import assert from "node:assert/strict";
import {
  WorkbookRowError,
  detectWorkbookChange,
  groupWorkbookChanges,
  parseBangumiId,
  parseEpisodeIndex,
  parseSourceItemId,
} from "../src/mappings/workbookChanges.js";
import { MAPPED_SHEET, PENDING_SHEET } from "../src/mappings/workbookFormat.js";

test("workbook scalar parsers preserve text identifiers and reject formulas", () => {
  assert.equal(parseSourceItemId(" 00123 "), "00123");
  assert.equal(parseSourceItemId(123), "123");
  assert.equal(parseSourceItemId({ richText: [{ text: "00" }, { text: "123" }] }), "00123");
  assert.equal(parseSourceItemId(""), null);
  assert.throws(() => parseSourceItemId(9007199254740992), /unsafe numeric identifier/i);
  assert.equal(parseEpisodeIndex("12", { column: "始集" }), 12);
  assert.equal(parseEpisodeIndex("", { column: "末集" }), null);
  assert.throws(() => parseEpisodeIndex("1.5", { column: "始集" }), /positive integer/i);
  assert.throws(
    () => parseEpisodeIndex({ formula: "=1+1", result: 2 }, { column: "始集" }),
    /formulas are not allowed/i,
  );
  assert.equal(parseBangumiId("12"), 12);
});

function change(overrides = {}) {
  return detectWorkbookChange({
    sheetName: PENDING_SHEET,
    rowNumber: 2,
    rowKey: "pending-1",
    bangumiId: 1,
    edited: { sourceItemId: "100", sourceEpisodeStart: null, sourceEpisodeEnd: null },
    snapshot: {
      rowKey: "pending-1",
      sheetName: PENDING_SHEET,
      bangumiId: 1,
      sourceItemId: null,
      sourceEpisodeStart: null,
      sourceEpisodeEnd: null,
    },
    ...overrides,
  });
}

test("snapshot-driven detection creates ignores replaces and deletes", () => {
  assert.deepEqual(change(), {
    kind: "create",
    bangumiId: 1,
    rowRef: { sheetName: PENDING_SHEET, rowNumber: 2, rowKey: "pending-1" },
    expectedMapping: null,
    oldMapping: null,
    newMapping: { bangumiId: 1, sourceItemId: "100", sourceEpisodeStart: null, sourceEpisodeEnd: null },
  });
  assert.equal(change({ edited: { sourceItemId: null, sourceEpisodeStart: null, sourceEpisodeEnd: null } }).kind, "ignore");

  const snapshot = {
    rowKey: "mapped-1", sheetName: MAPPED_SHEET, bangumiId: 2,
    sourceItemId: "100", sourceEpisodeStart: 1, sourceEpisodeEnd: 12,
  };
  assert.equal(change({
    sheetName: MAPPED_SHEET, rowKey: "mapped-1", bangumiId: 2, snapshot,
    edited: { sourceItemId: "100", sourceEpisodeStart: 1, sourceEpisodeEnd: 12 },
  }).kind, "ignore");
  assert.equal(change({
    sheetName: MAPPED_SHEET, rowKey: "mapped-1", bangumiId: 2, snapshot,
    edited: { sourceItemId: null, sourceEpisodeStart: null, sourceEpisodeEnd: null },
  }).kind, "delete");
  const replacement = change({
    sheetName: MAPPED_SHEET, rowKey: "mapped-1", bangumiId: 2, snapshot,
    edited: { sourceItemId: "200", sourceEpisodeStart: 2, sourceEpisodeEnd: null },
  });
  assert.equal(replacement.kind, "replace");
  assert.equal(replacement.oldMapping.sourceItemId, "100");
  assert.equal(replacement.newMapping.sourceItemId, "200");
});

test("row detection rejects invalid intervals and changed identities with stable codes", () => {
  const cases = [
    [{ edited: { sourceItemId: null, sourceEpisodeStart: 1, sourceEpisodeEnd: 2 } }, "source_item_required"],
    [{ edited: { sourceItemId: "100", sourceEpisodeStart: null, sourceEpisodeEnd: 2 } }, "invalid_interval"],
    [{ edited: { sourceItemId: "100", sourceEpisodeStart: 3, sourceEpisodeEnd: 2 } }, "invalid_interval"],
    [{ bangumiId: 9 }, "readonly_identity_changed"],
    [{ rowKey: "changed" }, "readonly_identity_changed"],
    [{ sheetName: MAPPED_SHEET }, "readonly_identity_changed"],
  ];
  for (const [overrides, code] of cases) {
    assert.throws(() => change(overrides), (error) => error instanceof WorkbookRowError && error.code === code);
  }
});

function groupedChange(rowKey, bangumiId, oldId, newId, sheetName = MAPPED_SHEET) {
  return {
    kind: oldId ? "replace" : "create",
    bangumiId,
    rowRef: { sheetName, rowNumber: Number(rowKey.at(-1)) + 1, rowKey },
    oldMapping: oldId ? { bangumiId, sourceItemId: oldId } : null,
    newMapping: newId ? { bangumiId, sourceItemId: newId } : null,
  };
}

test("dependency grouping computes stable transitive closure", () => {
  const rows = [
    groupedChange("row-a1", 1, "100", "200"),
    groupedChange("row-b2", 2, "200", "300"),
    groupedChange("row-c3", 3, null, "300", PENDING_SHEET),
    groupedChange("row-d4", 4, "900", "901"),
  ];
  const expected = [["row-c3", "row-a1", "row-b2"], ["row-d4"]];
  assert.deepEqual(groupWorkbookChanges(rows).map((group) => group.map((row) => row.rowRef.rowKey)), expected);
  assert.deepEqual(groupWorkbookChanges([...rows].reverse()).map((group) => group.map((row) => row.rowRef.rowKey)), expected);

  const invalid = {
    kind: "invalid",
    bangumiId: 9,
    rowRef: { sheetName: PENDING_SHEET, rowNumber: 8, rowKey: "invalid" },
    dependencySourceItemId: "300",
    oldMapping: null,
  };
  assert.equal(groupWorkbookChanges([...rows, invalid])[0].some((row) => row.rowRef.rowKey === "invalid"), true);
});
