import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseMappingCommand,
  printMappingResult,
  runMappingCommand,
} from "../src/mappings/mappingCli.js";

test("mapping CLI parses strict export and import commands", () => {
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
  assert.deepEqual(parseMappingCommand(["export"]), {
    action: "export",
    sourceKey: null,
    outputPath: "data/manual/mapping-review.xlsx",
    filters: { name: null, year: null, bangumiId: null, limit: null, includeUpcoming: false },
  });
  assert.deepEqual(parseMappingCommand(["import", "review.xlsx"]), {
    action: "import",
    inputPath: "review.xlsx",
  });
});

test("mapping CLI rejects undocumented or malformed options", () => {
  for (const argv of [
    [], ["unknown"], ["import"], ["import", "review.xlsx", "--source", "ffzy"],
    ["export", "--year", "22"], ["export", "--bangumi-id", "0"],
    ["export", "--limit", "-1"], ["export", "--reason", "no_resource"],
    ["export", "--include-upcoming", "maybe"], ["import", "review.csv"],
  ]) assert.throws(() => parseMappingCommand(argv));
});

test("mapping CLI uses the first registered source and delegates workbook operations", async () => {
  const calls = [];
  const dependencies = {
    createService() {
      return {
        exportWorkbook(input) { calls.push(["export", input]); return { sourceKey: input.sourceKey, pending: 1, mapped: 2 }; },
        importWorkbook(input) { calls.push(["import", input]); return { sourceKey: "ffzy", created: 1, replaced: 0, deleted: 0, ignored: 0, conflicts: 0, failed: 0, issues: [] }; },
      };
    },
  };
  const registry = { list: () => [{ sourceKey: "ffzy" }, { sourceKey: "other" }] };
  const exported = await runMappingCommand({
    command: parseMappingCommand(["export"]), sqlite: {}, registry, dependencies,
  });
  assert.equal(exported.sourceKey, "ffzy");
  await runMappingCommand({
    command: parseMappingCommand(["import", "review.xlsx"]), sqlite: {}, registry, dependencies,
  });
  assert.deepEqual(calls, [
    ["export", {
      sourceKey: "ffzy",
      outputPath: "data/manual/mapping-review.xlsx",
      filters: { name: null, year: null, bangumiId: null, limit: null, includeUpcoming: false },
    }],
    ["import", { inputPath: "review.xlsx", allowedSourceKeys: ["ffzy", "other"] }],
  ]);
});

test("mapping result printer emits stable Chinese batch summaries", () => {
  const lines = [];
  printMappingResult({
    sourceKey: "ffzy", created: 1, replaced: 1, deleted: 0, ignored: 2, conflicts: 1, failed: 1,
    issues: [
      { sheet: "已有映射", row: 3, kind: "conflict", code: "mapping_changed", reason: "数据库映射已在导出后发生变化" },
      { sheet: "待人工匹配", row: 4, kind: "failed", code: "missing_reference", reason: "采集站 ID 不存在" },
    ],
  }, (line) => lines.push(line));
  assert.deepEqual(lines, [
    "采集站=ffzy 新建=1 替换=1 删除=0 忽略=2 冲突=1 失败=1",
    "[冲突] 已有映射!3 mapping_changed 数据库映射已在导出后发生变化",
    "[失败] 待人工匹配!4 missing_reference 采集站 ID 不存在",
  ]);
});

test("mapping executable parses before dynamically loading the production database", async () => {
  const source = await readFile(new URL("../src/scripts/mapping.js", import.meta.url), "utf8");
  assert.match(source, /parseMappingCommand\(process\.argv\.slice\(2\)\)/);
  assert.doesNotMatch(source, /^import .*db\/index/m);
  assert.match(source, /import\("\.\.\/db\/index\.js"\)/);
});
