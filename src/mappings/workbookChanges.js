import { MAPPED_SHEET, PENDING_SHEET } from "./workbookFormat.js";

export class WorkbookRowError extends Error {
  constructor(code, message, rowRef = null) {
    super(message);
    this.name = "WorkbookRowError";
    this.code = code;
    this.rowRef = rowRef;
  }
}

export function cellScalar(value, { column = "单元格" } = {}) {
  if (value == null) return null;
  if (typeof value === "object") {
    if (Object.hasOwn(value, "formula") || Object.hasOwn(value, "sharedFormula")) {
      throw new WorkbookRowError("formula_not_allowed", `${column} formulas are not allowed`);
    }
    if (Array.isArray(value.richText)) return value.richText.map(({ text }) => text).join("");
    if (Object.hasOwn(value, "text")) return value.text;
    throw new WorkbookRowError("invalid_cell_type", `${column} has an unsupported cell type`);
  }
  return value;
}

export function parseSourceItemId(value, options = {}) {
  const scalar = cellScalar(value, { column: options.column ?? "采集站 ID" });
  if (scalar == null || (typeof scalar === "string" && scalar.trim() === "")) return null;
  if (typeof scalar === "number") {
    if (!Number.isSafeInteger(scalar) || scalar < 0) {
      throw new WorkbookRowError("invalid_source_item_id", "unsafe numeric identifier");
    }
    return String(scalar);
  }
  if (typeof scalar !== "string") {
    throw new WorkbookRowError("invalid_source_item_id", "采集站 ID must be text or a safe integer");
  }
  return scalar.trim();
}

export function parseEpisodeIndex(value, { column = "分集" } = {}) {
  const scalar = cellScalar(value, { column });
  if (scalar == null || (typeof scalar === "string" && scalar.trim() === "")) return null;
  const numeric = typeof scalar === "string" && /^\d+$/.test(scalar.trim())
    ? Number(scalar.trim())
    : scalar;
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new WorkbookRowError("invalid_interval", `${column} must be a positive integer`);
  }
  return numeric;
}

export function parseBangumiId(value, { column = "Bangumi ID" } = {}) {
  const scalar = cellScalar(value, { column });
  const numeric = typeof scalar === "string" && /^\d+$/.test(scalar.trim())
    ? Number(scalar.trim())
    : scalar;
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new WorkbookRowError("readonly_identity_changed", `${column} must be a positive integer`);
  }
  return numeric;
}

function sameMapping(left, right) {
  if (left == null || right == null) return left === right;
  return left.bangumiId === right.bangumiId
    && left.sourceItemId === right.sourceItemId
    && left.sourceEpisodeStart === right.sourceEpisodeStart
    && left.sourceEpisodeEnd === right.sourceEpisodeEnd;
}

function mapping(bangumiId, values) {
  return {
    bangumiId,
    sourceItemId: values.sourceItemId,
    sourceEpisodeStart: values.sourceEpisodeStart,
    sourceEpisodeEnd: values.sourceEpisodeEnd,
  };
}

function validateInterval(values, rowRef) {
  if (values.sourceItemId == null) {
    if (values.sourceEpisodeStart != null || values.sourceEpisodeEnd != null) {
      throw new WorkbookRowError(
        "source_item_required",
        "source item is required when an episode range is present",
        rowRef,
      );
    }
    return;
  }
  if (values.sourceEpisodeStart == null && values.sourceEpisodeEnd != null) {
    throw new WorkbookRowError("invalid_interval", "episode end requires episode start", rowRef);
  }
  if (
    values.sourceEpisodeStart != null
    && values.sourceEpisodeEnd != null
    && values.sourceEpisodeEnd < values.sourceEpisodeStart
  ) {
    throw new WorkbookRowError("invalid_interval", "episode end precedes episode start", rowRef);
  }
}

export function detectWorkbookChange({
  sheetName,
  rowNumber,
  rowKey,
  bangumiId,
  edited,
  snapshot,
}) {
  const rowRef = { sheetName, rowNumber, rowKey };
  if (
    rowKey !== snapshot.rowKey
    || sheetName !== snapshot.sheetName
    || bangumiId !== snapshot.bangumiId
    || ![PENDING_SHEET, MAPPED_SHEET].includes(sheetName)
  ) {
    throw new WorkbookRowError("readonly_identity_changed", "read-only row identity was changed", rowRef);
  }
  validateInterval(edited, rowRef);
  const oldMapping = snapshot.sourceItemId == null ? null : mapping(snapshot.bangumiId, snapshot);
  const newMapping = edited.sourceItemId == null ? null : mapping(snapshot.bangumiId, edited);

  const common = { bangumiId: snapshot.bangumiId, rowRef };
  if (sameMapping(oldMapping, newMapping)) return { kind: "ignore", ...common };
  if (oldMapping == null) {
    return {
      kind: "create",
      ...common,
      expectedMapping: null,
      oldMapping: null,
      newMapping,
    };
  }
  if (newMapping == null) {
    return {
      kind: "delete",
      ...common,
      expectedMapping: oldMapping,
      oldMapping,
      newMapping: null,
    };
  }
  return {
    kind: "replace",
    ...common,
    expectedMapping: oldMapping,
    oldMapping,
    newMapping,
  };
}

const SHEET_ORDER = new Map([[PENDING_SHEET, 0], [MAPPED_SHEET, 1]]);

function changeOrder(left, right) {
  return (SHEET_ORDER.get(left.rowRef.sheetName) ?? 99) - (SHEET_ORDER.get(right.rowRef.sheetName) ?? 99)
    || left.rowRef.rowNumber - right.rowRef.rowNumber
    || left.rowRef.rowKey.localeCompare(right.rowRef.rowKey);
}

function dependencyKeys(change) {
  const bangumiId = change.newMapping?.bangumiId ?? change.oldMapping?.bangumiId ?? change.bangumiId;
  const keys = new Set([`bangumi:${bangumiId}`]);
  if (change.oldMapping) keys.add(`source:${change.oldMapping.sourceItemId}`);
  if (change.newMapping) keys.add(`source:${change.newMapping.sourceItemId}`);
  if (change.dependencySourceItemId) keys.add(`source:${change.dependencySourceItemId}`);
  return [...keys];
}

export function groupWorkbookChanges(changes) {
  const rows = changes.filter(({ kind }) => kind !== "ignore");
  const parents = rows.map((_, index) => index);
  function find(index) {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  }
  function union(left, right) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  }
  const owners = new Map();
  rows.forEach((row, index) => {
    for (const key of dependencyKeys(row)) {
      if (owners.has(key)) union(index, owners.get(key));
      else owners.set(key, index);
    }
  });
  const components = new Map();
  rows.forEach((row, index) => {
    const root = find(index);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(row);
  });
  return [...components.values()]
    .map((group) => group.sort(changeOrder))
    .sort((left, right) => changeOrder(left[0], right[0]));
}
