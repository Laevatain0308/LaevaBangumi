# Anime Resource Mapping Workbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide one server-side XLSX export/import command for reviewing unmapped Bangumi subjects and authoritatively editing existing resource mappings without exposing candidates, scores, or an HTTP administration API.

**Architecture:** Extend the mapping repository with two read-only review projections, keep XLSX layout/parsing in `mappingWorkbookService`, and isolate change parsing plus dependency grouping in a pure module. Hidden row keys and a `veryHidden` snapshot sheet let import detect user edits and pass optimistic expectations into the transactional `mappingService`; unrelated dependency groups commit independently.

**Tech Stack:** Node.js ESM, better-sqlite3, ExcelJS, node:test, existing mapping repository/service/matcher.

---

## Execution Notes

- Work in `/Users/laevatain/Documents/Code/LaevaBangumi` after completing `docs/superpowers/plans/2026-07-24-anime-resource-mapping-core.md`.
- Preserve the unrelated working-tree changes listed in the core plan. Do not stage them with this work.
- Do not import, query, migrate, or write legacy `resource_mappings`, `retry_state`, or `manual_resource_state`.
- Do not replace the old CSV commands in this phase; add the new isolated `npm run mapping -- ...` command only.
- All automated tests use temporary databases and temporary workbooks. Never import a test workbook into `data/anime.db`.
- `exceljs` is the production dependency because the CLI must run independently on the user's server and must preserve text identifiers, styles, filters, frozen panes, and a `veryHidden` sheet.

## File Map

New production files:

- `src/mappings/workbookFormat.js`: fixed sheet/header/version constants and strict editable-cell normalization.
- `src/mappings/workbookChanges.js`: snapshot diff detection and transitive dependency grouping with no database or XLSX dependency.
- `src/mappings/mappingWorkbookService.js`: review projection, XLSX generation/parsing, metadata validation, grouped import, and reporting.
- `src/mappings/mappingCli.js`: pure command parsing and dependency-injected command execution without opening the production database.
- `src/scripts/mapping.js`: thin executable that validates arguments before dynamically opening the database and resource registry.

Modified production files:

- `src/mappings/mappingRepository.js`: adds normalized-only review queries.
- `package.json`, `package-lock.json`: add ExcelJS and the `mapping` command.

New tests and support:

- `test/mapping-workbook-query.test.js`: review filters, titles, airing visibility, reasons, and mapped projection.
- `test/mapping-workbook-format.test.js`: visible column order, styles, text IDs, hidden keys, and metadata.
- `test/mapping-workbook-changes.test.js`: edit parsing, diff detection, and dependency closure.
- `test/mapping-workbook-import.test.js`: optimistic conflicts and row/group transaction isolation.
- `test/mapping-cli.test.js`: command parsing, default source, output, import report, and exit codes.
- `test/helpers/writeMappingWorkbookQaFixture.js`: writes two deterministic QA workbooks with different active sheets for visual inspection.

## Task 1: Review Projections and Filters

**Files:**
- Modify: `src/mappings/mappingRepository.js`
- Create: `test/mapping-workbook-query.test.js`

- [ ] **Step 1: Write the failing normalized review-query tests**

Seed completed and incomplete Bangumi rows, aired/future/partial dates, mapped/unmapped subjects, and source titles. Use the repository APIs below:

```js
const unmapped = repository.listUnmappedReviewSubjects({
  sourceKey: "ffzy",
  name: "摇滚",
  year: "2026",
  bangumiId: null,
});
assert.deepEqual(unmapped, [{
  bangumiId: 1,
  title: "孤独摇滚！",
  airDate: "2026-01-01",
}]);

const mapped = repository.listMappedReviewRows({
  sourceKey: "ffzy",
  name: null,
  year: null,
  bangumiId: 2,
});
assert.deepEqual(mapped, [{
  bangumiId: 2,
  title: "赛马娘 第三季",
  airDate: "2023-10-05",
  sourceItemId: "9007199254740993",
  sourceTitle: "赛马娘第三季",
  sourceEpisodeStart: null,
  sourceEpisodeEnd: null,
}]);
```

Assert both queries:

- require `bangumi_subject_refresh_state.last_succeeded_at IS NOT NULL`;
- read only `bangumi_*`, `source_*`, and `bangumi_resource_mappings`;
- use `name_cn`, falling back to `name`;
- apply case-insensitive containment to both `name_cn` and `name` for `name`;
- interpret `year` as the four-character `air_date` prefix;
- sort by numeric Bangumi ID;
- omit mapped subjects from the unmapped projection.

Assert a future-dated existing mapping is still returned by `listMappedReviewRows()`; airing visibility is applied by export only to the pending sheet, never to the authoritative mapped edit/delete sheet.

- [ ] **Step 2: Run the query test and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-workbook-query.test.js
```

Expected: FAIL because `listUnmappedReviewSubjects` and `listMappedReviewRows` are not defined.

- [ ] **Step 3: Implement parameterized review SQL**

Build one `reviewWhere()` helper that emits SQL fragments and bound parameters rather than interpolating user input:

```js
function reviewWhere({ sourceKey, name, year, bangumiId }, { mapped }) {
  const clauses = [
    "r.last_succeeded_at IS NOT NULL",
    mapped
      ? "m.source_key = @sourceKey"
      : "NOT EXISTS (SELECT 1 FROM bangumi_resource_mappings x WHERE x.bangumi_id = s.bangumi_id AND x.source_key = @sourceKey)",
  ];
  const params = { sourceKey };
  if (name) {
    clauses.push("(instr(lower(COALESCE(s.name_cn, '')), lower(@name)) > 0 OR instr(lower(s.name), lower(@name)) > 0)");
    params.name = name;
  }
  if (year) {
    clauses.push("substr(s.air_date, 1, 4) = @year");
    params.year = year;
  }
  if (bangumiId) {
    clauses.push("s.bangumi_id = @bangumiId");
    params.bangumiId = bangumiId;
  }
  return { sql: clauses.join(" AND "), params };
}
```

Map snake-case rows into the exact camel-case objects asserted in Step 1. The mapped query joins `source_items` on both `source_key` and `source_item_id`; it must not read the old resource catalog.

- [ ] **Step 4: Run focused repository tests**

```bash
node --import ./test/setup.js --test test/mapping-workbook-query.test.js test/mapping-repository.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the review projections**

```bash
git add src/mappings/mappingRepository.js test/mapping-workbook-query.test.js
git commit -m "feat: query mapping workbook rows"
```

## Task 2: Workbook Contract and Export

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/mappings/workbookFormat.js`
- Create: `src/mappings/mappingWorkbookService.js`
- Create: `test/mapping-workbook-format.test.js`

- [ ] **Step 1: Install ExcelJS without upgrading existing packages**

```bash
npm install exceljs
```

Expected: `exceljs` appears in `package.json` and `package-lock.json`; existing direct dependency versions remain unchanged.

- [ ] **Step 2: Write the failing workbook contract test**

Use a temporary output path, an injected deterministic `rowKeyFactory`, and stub review facts:

```js
const service = createMappingWorkbookService({
  repository: {
    listUnmappedReviewSubjects: () => [{ bangumiId: 1, title: "孤独摇滚！", airDate: "2022-10-09" }],
    listMappedReviewRows: () => [{
      bangumiId: 2,
      title: "赛马娘 第三季",
      airDate: "2023-10-05",
      sourceItemId: "9007199254740993",
      sourceTitle: "赛马娘第三季",
      sourceEpisodeStart: 1,
      sourceEpisodeEnd: 13,
    }],
  },
  explainSubject: () => ({ reason: "name_score_low" }),
  mappingService: { applyManualGroup() { throw new Error("not used"); } },
  clock: () => new Date("2026-07-24T04:00:00.000Z"),
  rowKeyFactory: (() => { let value = 0; return () => `row-${++value}`; })(),
});

const result = await service.exportWorkbook({
  sourceKey: "ffzy",
  outputPath,
  filters: { includeUpcoming: false, name: null, year: null, bangumiId: null, limit: null },
});
assert.deepEqual(result, { outputPath, sourceKey: "ffzy", pending: 1, mapped: 1 });
```

Reopen the file with ExcelJS and assert:

```js
assert.deepEqual(pending.getRow(1).values.slice(1, 8), [
  "Bangumi ID", "番剧名称", "放送日期", "采集站 ID", "始集", "末集", "未自动映射原因",
]);
assert.deepEqual(mapped.getRow(1).values.slice(1, 8), [
  "Bangumi ID", "番剧名称", "放送日期", "采集站 ID", "采集站标题", "始集", "末集",
]);
assert.equal(mapped.getCell("D2").value, "9007199254740993");
assert.equal(mapped.getCell("D2").numFmt, "@");
assert.equal(pending.getCell("H2").value, "row-1");
assert.equal(pending.getColumn(8).hidden, true);
assert.equal(metadata.state, "veryHidden");
assert.equal(metadata.getCell("B1").value, "laeva-mapping-v1");
assert.equal(metadata.getCell("B2").value, "ffzy");
```

Also assert frozen first rows, `A1:Gn` auto-filters, positive-integer validation on episode columns, the specified widths, wrapped title cells, distinct editable/reference fills, and metadata snapshots for both rows. The metadata layout is fixed: keys `format_version`, `source_key`, and `exported_at` occupy A1:B3; `SNAPSHOT_HEADERS` occupy A5:G5; snapshot data starts at row 6.

- [ ] **Step 3: Run the format test and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-workbook-format.test.js
```

Expected: FAIL because the workbook modules do not exist.

- [ ] **Step 4: Define the fixed workbook format**

Create `src/mappings/workbookFormat.js` with these exported constants:

```js
export const WORKBOOK_FORMAT_VERSION = "laeva-mapping-v1";
export const PENDING_SHEET = "待人工匹配";
export const MAPPED_SHEET = "已有映射";
export const METADATA_SHEET = "_laeva_mapping_metadata";
export const PENDING_HEADERS = Object.freeze([
  "Bangumi ID", "番剧名称", "放送日期", "采集站 ID", "始集", "末集", "未自动映射原因",
]);
export const MAPPED_HEADERS = Object.freeze([
  "Bangumi ID", "番剧名称", "放送日期", "采集站 ID", "采集站标题", "始集", "末集",
]);
export const SNAPSHOT_HEADERS = Object.freeze([
  "row_key", "sheet_name", "exported_row_number", "bangumi_id",
  "source_item_id", "source_episode_start", "source_episode_end",
]);
export const REASON_TEXT = Object.freeze({
  source_uninitialized: "采集站尚未初始化",
  no_resource: "尚无可用资源",
  name_score_low: "名称相似度不足",
  candidate_ambiguous: "候选不唯一",
  year_conflict: "年份冲突",
  season_conflict: "季度冲突",
  part_ambiguous: "Part/Cour 信息不明确",
  form_conflict: "作品形态冲突",
  episode_overflow: "采集站分集数超过 Bangumi 总集数",
  excluded: "候选已被人工排除",
});
```

Export `reasonText(code)` that returns the mapped Chinese text and returns `"尚无可用资源"` for unknown unmatched codes. Do not expose candidates or scores.

- [ ] **Step 5: Implement deterministic export and styling**

In `createMappingWorkbookService(...)`, expose:

```js
return Object.freeze({ exportWorkbook, importWorkbook });
```

`exportWorkbook()` must:

1. query both review projections;
2. classify each `airDate` with `classifyAirDate(airDate, clock())`;
3. omit non-`aired` rows from the pending sheet unless `includeUpcoming` is true; always include existing mappings because the mapped sheet is an authoritative edit/delete surface;
4. apply `limit` after eligibility filtering and Bangumi-ID ordering, independently to each sheet;
5. for pending `aired` rows call `explainSubject({ bangumiId, sourceKey })`; for included future/unknown rows set the visible reason directly to `"尚未放送"` or `"放送日期不足以判断"` without asking the automatic matcher;
6. write visible columns A:G and a hidden row key in H;
7. write source IDs as strings with `numFmt = "@"` and dates as text to preserve partial dates;
8. write a `veryHidden` metadata sheet with version/source/export time and one snapshot per visible row.

Use these layout constants:

```js
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
```

Freeze row 1, hide gridlines, filter A:G, wrap long names and reasons, use a dark header, light-gray reference cells, and light-yellow editable cells. Do not protect sheets or add candidates, scores, aliases, years, or episode counts.

- [ ] **Step 6: Run export tests and commit**

```bash
node --import ./test/setup.js --test test/mapping-workbook-format.test.js test/mapping-workbook-query.test.js
git add package.json package-lock.json src/mappings/workbookFormat.js src/mappings/mappingWorkbookService.js test/mapping-workbook-format.test.js
git commit -m "feat: export mapping review workbooks"
```

Expected: both tests PASS and the commit contains only workbook export work.

## Task 3: Strict Workbook Parsing and Change Detection

**Files:**
- Create: `src/mappings/workbookChanges.js`
- Modify: `src/mappings/mappingWorkbookService.js`
- Create: `test/mapping-workbook-changes.test.js`

- [ ] **Step 1: Write the failing cell-normalization and diff tests**

Test the pure normalizers with values that ExcelJS can return:

```js
assert.equal(parseSourceItemId(" 00123 "), "00123");
assert.equal(parseSourceItemId(123), "123");
assert.throws(() => parseSourceItemId(9007199254740992), /unsafe numeric identifier/);
assert.equal(parseEpisodeIndex("12", { column: "始集" }), 12);
assert.equal(parseEpisodeIndex("", { column: "末集" }), null);
assert.throws(() => parseEpisodeIndex("1.5", { column: "始集" }), /positive integer/);
assert.throws(() => parseEpisodeIndex({ formula: "=1+1", result: 2 }, { column: "始集" }), /formulas are not allowed/);
```

Then test these exact row diffs:

```js
assert.deepEqual(detectWorkbookChange({
  sheetName: "待人工匹配",
  rowNumber: 2,
  rowKey: "pending-1",
  bangumiId: 1,
  edited: { sourceItemId: "100", sourceEpisodeStart: null, sourceEpisodeEnd: null },
  snapshot: { sourceItemId: null, sourceEpisodeStart: null, sourceEpisodeEnd: null },
}), {
  kind: "create",
  rowRef: { sheetName: "待人工匹配", rowNumber: 2, rowKey: "pending-1" },
  expectedMapping: null,
  oldMapping: null,
  newMapping: { bangumiId: 1, sourceItemId: "100", sourceEpisodeStart: null, sourceEpisodeEnd: null },
});
```

Also assert:

- an untouched pending row is `ignore`;
- a pending row with only episode cells filled fails `source_item_required`;
- an untouched mapped row is `ignore` even if reference cells changed;
- clearing mapped source ID with empty episode cells creates `delete`;
- clearing mapped source ID while retaining episode cells fails `source_item_required`;
- changing ID/range creates `replace` with old/new mappings;
- an end without a start fails `invalid_interval`;
- start greater than end fails `invalid_interval`;
- Bangumi ID and hidden row key changes fail `readonly_identity_changed`.

- [ ] **Step 2: Run the change test and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-workbook-changes.test.js
```

Expected: FAIL because `workbookChanges.js` does not exist.

- [ ] **Step 3: Implement strict scalar parsing**

Export these pure functions from `workbookChanges.js`:

```js
export function cellScalar(value, { column }) {
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
```

`parseSourceItemId()` accepts blank, strings, safe non-negative integer numbers, and rich text; it trims but never strips leading zeroes from strings. `parseEpisodeIndex()` accepts blank or a positive safe integer. `parseBangumiId()` requires a positive safe integer equal to the snapshot ID.

- [ ] **Step 4: Implement snapshot-driven row changes**

Export:

```js
export class WorkbookRowError extends Error {
  constructor(code, message, rowRef = null) {
    super(message);
    this.name = "WorkbookRowError";
    this.code = code;
    this.rowRef = rowRef;
  }
}

export function detectWorkbookChange(input)
```

The declaration above returns `ignore`, `create`, `replace`, or `delete` according to the complete decision table from Step 1. Build `expectedMapping` from the hidden snapshot, never from editable/reference visible cells. A mapped replacement contains one removal for its snapshot mapping and one upsert for its edited mapping. Reference-only edits to title, air date, source title, or reason are deliberately ignored.

- [ ] **Step 5: Parse and validate workbook-level metadata before returning rows**

Add a private `readWorkbook(path)` to `mappingWorkbookService` that loads ExcelJS and rejects the entire import before mapping calls when any of these conditions hold:

```text
unsupported_workbook_version
metadata_sheet_missing
visible_sheet_missing
source_key_missing
duplicate_row_key
snapshot_missing
invalid_visible_headers
```

These are workbook-structure failures and abort before any database call. Require exact visible headers A:G. For every non-empty visible row, read hidden H and resolve exactly one snapshot. Match by stable row key and original sheet, but deliberately allow the current physical row to differ from `exported_row_number` so Excel sorting remains usable. The original row number is audit metadata only; reports use the row's current physical number. Ignore completely blank rows below the used area.

Return `{ sourceKey, rows }`. A blank/unknown hidden row key is `snapshot_missing` and aborts the workbook because no trustworthy identity or dependency group can be recovered. With a valid snapshot, a sheet mismatch or changed Bangumi ID is a row-level `readonly_identity_changed` failure so unrelated intact groups remain importable. A valid row contains its detected change. An invalid row contains `{ kind: "invalid", bangumiId, rowRef, error, oldMapping, dependencySourceItemId }`, preserving the snapshot identity/old mapping and any source ID that was parsed before validation failed. This information lets Task 4 keep a malformed segment in the same atomic dependency group as related valid rows.

- [ ] **Step 6: Run parsing tests and commit**

```bash
node --import ./test/setup.js --test test/mapping-workbook-changes.test.js test/mapping-workbook-format.test.js
git add src/mappings/workbookChanges.js src/mappings/mappingWorkbookService.js test/mapping-workbook-changes.test.js
git commit -m "feat: detect mapping workbook edits"
```

Expected: all tests PASS.

## Task 4: Transitive Dependency Groups

**Files:**
- Modify: `src/mappings/workbookChanges.js`
- Modify: `test/mapping-workbook-changes.test.js`

- [ ] **Step 1: Write failing grouping tests**

Create changes where row A moves from source ID `100` to `200`, row B moves `200` to `300`, and row C adds another segment to `300`. Assert all three are one group, while an edit involving only `900` is separate:

```js
const groups = groupWorkbookChanges([move100To200, move200To300, addSegmentTo300, edit900]);
assert.deepEqual(groups.map((group) => group.map((change) => change.rowRef.rowKey)), [
  ["row-a", "row-b", "row-c"],
  ["row-d"],
]);
```

Also assert:

- two changes for the same Bangumi ID are grouped even when their source IDs differ;
- a delete and create linked by the old source ID are grouped;
- input order does not affect group membership or stable output order;
- ignored rows are not passed into grouping;
- an invalid interval with parseable source ID `300` joins the valid `300` segment group;
- an invalid mapped replacement still joins by its snapshot's old source ID.

- [ ] **Step 2: Run grouping tests and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-workbook-changes.test.js
```

Expected: FAIL because `groupWorkbookChanges` is missing.

- [ ] **Step 3: Implement union-find dependency closure**

Each change owns dependency keys:

```js
function dependencyKeys(change) {
  const bangumiId = change.newMapping?.bangumiId ?? change.oldMapping?.bangumiId ?? change.bangumiId;
  const keys = new Set([`bangumi:${bangumiId}`]);
  if (change.oldMapping) keys.add(`source:${change.oldMapping.sourceItemId}`);
  if (change.newMapping) keys.add(`source:${change.newMapping.sourceItemId}`);
  if (change.dependencySourceItemId) keys.add(`source:${change.dependencySourceItemId}`);
  return [...keys];
}
```

`detectWorkbookChange()` copies the validated snapshot identity into `change.bangumiId`, including invalid pending rows without an `oldMapping`. Union indexes sharing any key, then sort changes inside a component by sheet order (`待人工匹配`, `已有映射`) and row number; sort components by their earliest row key tuple. This computes the required transitive closure without querying the database.

- [ ] **Step 4: Run tests and commit**

```bash
node --import ./test/setup.js --test test/mapping-workbook-changes.test.js
git add src/mappings/workbookChanges.js test/mapping-workbook-changes.test.js
git commit -m "feat: group dependent workbook edits"
```

Expected: all change and grouping tests PASS.

## Task 5: Transactional Import and Optimistic Conflicts

**Files:**
- Modify: `src/mappings/mappingWorkbookService.js`
- Create: `test/mapping-workbook-import.test.js`

- [ ] **Step 1: Write failing row/group isolation tests**

Build real temporary schemas/repository/service and export a workbook. Edit it with ExcelJS, then import it and assert this report shape:

```js
assert.deepEqual(report, {
  sourceKey: "ffzy",
  created: 1,
  replaced: 1,
  deleted: 1,
  ignored: 2,
  conflicts: 1,
  failed: 1,
  issues: [
    { sheet: "已有映射", row: 3, kind: "conflict", code: "mapping_changed", reason: "数据库映射已在导出后发生变化" },
    { sheet: "待人工匹配", row: 4, kind: "failed", code: "missing_reference", reason: "采集站 ID 不存在" },
  ],
});
```

Cover all of these database outcomes:

- unrelated valid rows commit even when another row conflicts or fails;
- a pending row already mapped after export reports `mapping_changed`;
- an existing mapping changed or deleted after export reports `mapping_changed`;
- a group containing overlapping segments rejects every changed row in that group and writes none;
- a group containing one syntactically invalid segment rejects its otherwise valid related rows and writes none;
- a valid unrelated group still commits;
- replacing an old one-to-one occupant with several non-overlapping segments succeeds atomically;
- clearing an existing source ID deletes it and follows the mapping service's exclusion lifecycle;
- reference-field-only edits remain ignored.

- [ ] **Step 2: Run the import test and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-workbook-import.test.js
```

Expected: FAIL because `importWorkbook()` does not apply parsed changes.

- [ ] **Step 3: Convert each dependency group into one service call**

For a group, build deduplicated arrays by `(bangumiId, sourceKey)`:

```js
const expectedMappings = group.map((change) => ({
  bangumiId: change.expectedMapping?.bangumiId ?? change.newMapping.bangumiId,
  sourceKey,
  mapping: change.expectedMapping == null
    ? null
    : { ...change.expectedMapping, sourceKey },
}));
const removals = group.flatMap((change) => change.oldMapping
  ? [{ ...change.oldMapping, sourceKey }]
  : []);
const upserts = group.flatMap((change) => change.newMapping
  ? [{ ...change.newMapping, sourceKey }]
  : []);

mappingService.applyManualGroup({ expectedMappings, removals, upserts });
```

Do not compare expected mappings separately in the workbook service; the core service performs the comparison inside its write transaction.

- [ ] **Step 4: Map failures to every physical row in the failed group**

Use fixed Chinese messages rather than exposing SQLite details:

```js
const IMPORT_REASON_TEXT = Object.freeze({
  mapping_changed: "数据库映射已在导出后发生变化",
  readonly_identity_changed: "只读标识已被修改",
  dependent_row_invalid: "关联修改组中存在无效行",
  source_item_required: "填写分集范围时必须填写采集站 ID",
  invalid_interval: "分集范围必须为正整数，且末集不得小于始集",
  missing_reference: "Bangumi ID 或采集站 ID 不存在",
  interval_overlap: "同一采集站 ID 的分段发生重叠",
  open_segment_not_last: "开放分段必须唯一且位于最后",
  source_item_one_to_one_conflict: "一对一映射不能与其他映射共享采集站 ID",
  source_item_segment_conflict: "共享采集站 ID 时每条映射都必须填写始集",
  database_error: "数据库写入失败",
});
```

Before calling the service, if a dependency group contains any `kind: "invalid"` row, reject the whole group without a database call. Each invalid row keeps its own parse code/reason; each otherwise valid row in that group receives `dependent_row_invalid` / `"关联修改组中存在无效行"`. If a service call rejects a valid group, add one conflict or failure issue for every changed workbook row in that group, all with the same stable code/reason; unexpected database errors use `database_error` without exposing SQL. Sort issues by sheet order and row number. `ignored` counts untouched rows only; it does not count invalid or dependency-rejected rows.

- [ ] **Step 5: Run import and core service tests**

```bash
node --import ./test/setup.js --test test/mapping-workbook-import.test.js test/mapping-workbook-changes.test.js test/mapping-service.test.js
```

Expected: all tests PASS; failed groups leave mapping and exclusion tables unchanged.

- [ ] **Step 6: Commit the import workflow**

```bash
git add src/mappings/mappingWorkbookService.js test/mapping-workbook-import.test.js
git commit -m "feat: import mapping review workbooks"
```

## Task 6: Server CLI and Default Source Selection

**Files:**
- Create: `src/mappings/mappingCli.js`
- Create: `src/scripts/mapping.js`
- Modify: `package.json`
- Create: `test/mapping-cli.test.js`

- [ ] **Step 1: Write failing CLI argument tests**

Export a pure parser from `src/mappings/mappingCli.js` and assert:

```js
assert.deepEqual(parseMappingCommand([
  "export", "--source", "ffzy", "--name", "摇滚", "--year", "2022",
  "--bangumi-id", "253", "--limit", "50", "--include-upcoming",
  "--output", "data/manual/mapping.xlsx",
]), {
  action: "export",
  sourceKey: "ffzy",
  outputPath: "data/manual/mapping.xlsx",
  filters: { name: "摇滚", year: "2022", bangumiId: 253, limit: 50, includeUpcoming: true },
});

assert.deepEqual(parseMappingCommand(["import", "review.xlsx"]), {
  action: "import",
  inputPath: "review.xlsx",
});
```

Assert rejection of unknown actions/options, missing import path, invalid year, non-positive Bangumi ID/limit, import-side `--source`, and the removed reason filter. Assert default export path is `data/manual/mapping-review.xlsx`.

- [ ] **Step 2: Run CLI tests and verify RED**

```bash
node --import ./test/setup.js --test test/mapping-cli.test.js
```

Expected: FAIL because `src/mappings/mappingCli.js` does not exist.

- [ ] **Step 3: Implement strict parsing and dependency injection**

Export `parseMappingCommand(argv)` and `runMappingCommand({ command, sqlite, registry, logger })` from `src/mappings/mappingCli.js`.

Use `parseCliArgs()` for tokenization, then reject option keys outside the action's allow-list. For export, resolve the source as:

```js
const registered = registry.list().map(({ sourceKey }) => sourceKey);
const sourceKey = command.sourceKey ?? registered[0];
if (!sourceKey) throw new Error("no registered resource source");
if (!registered.includes(sourceKey)) throw new Error(`unknown resource source: ${sourceKey}`);
```

Create repository/service/matcher/workbook service from the injected SQLite connection. Call `importWorkbook({ inputPath, allowedSourceKeys: registered })`; the service derives `sourceKey` from workbook metadata and rejects an unregistered source before parsing rows into mapping calls.

- [ ] **Step 4: Add the executable entrypoint and stable report output**

Keep static imports in `src/scripts/mapping.js` limited to `pathToFileURL`, logger functions, and `parseMappingCommand`. Parse first, then dynamically import database and registry modules so invalid usage cannot open the production database:

```js
async function main() {
  const command = parseMappingCommand(process.argv.slice(2));
  const [{ initDb, sqlite }, { loadResourceSourceRegistry }, { runMappingCommand }] = await Promise.all([
    import("../db/index.js"),
    import("../resourceSources/pluginRegistry.js"),
    import("../mappings/mappingCli.js"),
  ]);
  initDb();
  const registry = await loadResourceSourceRegistry({
    manifestPath: new URL("../../config/resource-sources.json", import.meta.url),
    db: sqlite,
    logger: { log, warn, error },
  });
  return runMappingCommand({ command, sqlite, registry, logger: { log, error } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(printMappingResult).catch((cause) => {
    console.error(cause.message ?? String(cause));
    process.exitCode = 1;
  });
}
```

Print export path/source/pending/mapped counts. Print import created/replaced/deleted/ignored/conflicts/failed counts followed by one line per issue:

```text
[冲突] 已有映射!3 mapping_changed 数据库映射已在导出后发生变化
[失败] 待人工匹配!4 missing_reference Bangumi ID 或采集站 ID 不存在
```

Conflicts and row failures are an expected batch result and keep exit code 0; malformed/unsupported workbook metadata or CLI usage exits 1.

When export succeeds, `exportWorkbook()` creates `dirname(outputPath)` recursively before writing. Import requires an existing `.xlsx` path and never modifies that workbook.

- [ ] **Step 5: Add the package script and run CLI tests**

Add:

```json
"mapping": "node src/scripts/mapping.js"
```

Run:

```bash
node --import ./test/setup.js --test test/mapping-cli.test.js
```

Expected: all tests PASS, including first-registered-source fallback.

- [ ] **Step 6: Commit the CLI**

```bash
git add src/mappings/mappingCli.js src/scripts/mapping.js package.json test/mapping-cli.test.js
git commit -m "feat: add mapping workbook CLI"
```

## Task 7: XLSX Round-Trip and Visual QA

**Files:**
- Create: `test/helpers/writeMappingWorkbookQaFixture.js`
- Modify: `test/mapping-workbook-format.test.js`
- Modify: `test/mapping-workbook-import.test.js`

- [ ] **Step 1: Add a binary round-trip contract test**

Export a workbook with long Chinese/Japanese titles, partial/full dates, a 16-digit text source ID, a pending reason, a one-to-one mapping, a closed segment, and an open segment. Reopen, edit, save, import, and assert:

- the 16-digit ID remains exact;
- leading-zero string IDs remain exact;
- both visible sheet names and headers survive;
- the metadata sheet remains `veryHidden`;
- the edited closed/open segments reach the real mapping service;
- no formula cells exist in visible tables;
- no unexpected third visible sheet exists.

- [ ] **Step 2: Run round-trip tests**

```bash
node --import ./test/setup.js --test test/mapping-workbook-format.test.js test/mapping-workbook-import.test.js
```

Expected: all tests PASS.

- [ ] **Step 3: Create a deterministic QA fixture writer**

The helper accepts an output directory, creates two otherwise identical files, and changes only which visible sheet is active:

```js
await writeMappingWorkbookQaFixture({ outputDir, activeSheet: "待人工匹配" });
await writeMappingWorkbookQaFixture({ outputDir, activeSheet: "已有映射" });
```

Use at least 12 rows per sheet with the longest expected title/reason values, blank editable cells, a 16-digit source ID, closed/open ranges, and enough rows to exercise filters/frozen headers.

- [ ] **Step 4: Generate Quick Look previews and inspect both sheets**

Run in a temporary directory:

```bash
qa_dir=$(mktemp -d)
node test/helpers/writeMappingWorkbookQaFixture.js "$qa_dir"
qlmanage -t -s 1800 -o "$qa_dir/previews" "$qa_dir/pending-active.xlsx" "$qa_dir/mapped-active.xlsx"
find "$qa_dir/previews" -type f -maxdepth 1 -print
```

Expected: the helper prints both workbook paths and `qlmanage` produces one preview per workbook. Open each preview with the local image viewer available to the coding environment and verify:

- all seven headers are visible and not clipped;
- long Bangumi/source titles and reasons wrap legibly;
- source IDs display as full text, not scientific notation;
- editable yellow columns and gray reference columns are distinguishable;
- no blank default sheet, hidden metadata, or content outside the visible table appears.

If Quick Look does not render workbook content on the host, open each QA workbook once in a spreadsheet application and perform the same checklist; do not treat binary round-trip tests alone as visual verification.

- [ ] **Step 5: Correct only observed layout defects and rerun tests**

Adjust `WIDTHS`, wrapping, row heights, fills, or borders in `mappingWorkbookService.js` based on the preview. Then run:

```bash
node --import ./test/setup.js --test test/mapping-workbook-format.test.js test/mapping-workbook-import.test.js test/mapping-cli.test.js
```

Expected: all tests PASS after the final visual correction.

- [ ] **Step 6: Commit the QA checkpoint**

```bash
git add src/mappings/mappingWorkbookService.js test/helpers/writeMappingWorkbookQaFixture.js test/mapping-workbook-format.test.js test/mapping-workbook-import.test.js
git commit -m "test: verify mapping workbook round trip"
```

## Task 8: Full Mapping Workflow Verification

**Files:**
- No files; this task verifies the already committed mapping implementation.

- [ ] **Step 1: Run all new mapping tests**

```bash
node --import ./test/setup.js --test test/mapping-*.test.js test/auto-matcher.test.js test/air-date-eligibility.test.js test/mapping-cli.test.js
```

Expected: all mapping-domain tests PASS.

- [ ] **Step 2: Run the complete server suite**

```bash
npm test
```

Expected: the complete suite PASS; old CSV behavior remains unchanged and isolated.

- [ ] **Step 3: Exercise CLI help failures without touching production data**

```bash
npm run mapping -- unknown
npm run mapping -- import
```

Expected: both commands exit 1 with concise usage/error text before opening or writing a workbook. Do not run a real import against `data/anime.db` during verification.

- [ ] **Step 4: Check the final diff and dependency surface**

```bash
git diff --check
git status --short
npm ls exceljs he opencc-js
rg -n "resource_mappings|retry_state|manual_resource_state" src/mappings src/scripts/mapping.js test/mapping-*.test.js test/mapping-cli.test.js
```

Expected:

- no whitespace errors;
- only the intentional unrelated user changes remain unstaged;
- all three direct libraries resolve;
- the legacy-table scan prints no matches.

- [ ] **Step 5: Route any failure back to its owning task**

If Step 1 or 2 fails, stop this checkpoint and return to the earlier task that owns the failing file and its exact test/commit instructions. Repeat this verification task only after that focused task passes. If no correction is required, do not create a commit.

## Workbook Completion Checkpoint

Before using the command on a personal database, verify:

```bash
git status --short
git log -8 --oneline
npm test
```

Expected:

- the full suite passes;
- the new CLI only reads/writes the normalized mapping domain;
- an unsupported or damaged workbook cannot partially write the database;
- valid unrelated rows/groups remain independently importable;
- existing unrelated working-tree changes remain preserved.
