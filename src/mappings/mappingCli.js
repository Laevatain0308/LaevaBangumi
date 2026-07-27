import { parseCliArgs } from "../lib/cliArgs.js";
import { createMappingRepository } from "./mappingRepository.js";
import { createMappingService } from "./mappingService.js";
import { createAutoMatcher } from "./autoMatcher.js";
import { createMappingWorkbookService } from "./mappingWorkbookService.js";

const DEFAULT_OUTPUT = "data/manual/mapping-review.xlsx";
const EXPORT_OPTIONS = new Set([
  "source", "name", "year", "bangumi-id", "limit", "include-upcoming", "output",
]);

function positiveInteger(value, option) {
  if (value == null) return null;
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${option} must be a positive integer`);
  }
  return Number(value);
}

function booleanValue(value, option) {
  if (value == null) return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${option} must be a boolean`);
}

export function parseMappingCommand(argv) {
  const [action, ...rest] = argv;
  if (action === "export") {
    const parsed = parseCliArgs(rest);
    if (parsed.positionals.length > 0) throw new Error(`unexpected argument: ${parsed.positionals[0]}`);
    for (const key of Object.keys(parsed.options)) {
      if (!EXPORT_OPTIONS.has(key)) throw new Error(`unknown export option: --${key}`);
    }
    const year = parsed.options.year ?? null;
    if (year != null && !/^\d{4}$/.test(year)) throw new Error("--year must be YYYY");
    return {
      action: "export",
      sourceKey: parsed.options.source ?? null,
      outputPath: parsed.options.output ?? DEFAULT_OUTPUT,
      filters: {
        name: parsed.options.name ?? null,
        year,
        bangumiId: positiveInteger(parsed.options["bangumi-id"] ?? null, "--bangumi-id"),
        limit: positiveInteger(parsed.options.limit ?? null, "--limit"),
        includeUpcoming: booleanValue(parsed.options["include-upcoming"] ?? null, "--include-upcoming"),
      },
    };
  }
  if (action === "import") {
    const parsed = parseCliArgs(rest);
    if (Object.keys(parsed.options).length > 0) {
      throw new Error(`unknown import option: --${Object.keys(parsed.options)[0]}`);
    }
    if (parsed.positionals.length !== 1) throw new Error("import requires one .xlsx path");
    if (!parsed.positionals[0].toLowerCase().endsWith(".xlsx")) {
      throw new Error("import path must be an .xlsx workbook");
    }
    return { action: "import", inputPath: parsed.positionals[0] };
  }
  throw new Error("Usage: mapping <export|import> [options]");
}

function productionService(sqlite) {
  const repository = createMappingRepository({ sqlite });
  const mappingService = createMappingService({ repository });
  const matcher = createAutoMatcher({ repository, mappingService });
  return createMappingWorkbookService({
    repository,
    explainSubject: matcher.explainSubject,
    mappingService,
  });
}

export async function runMappingCommand({
  command,
  sqlite,
  registry,
  dependencies = { createService: productionService },
} = {}) {
  const registered = registry.list().map(({ sourceKey }) => sourceKey);
  const service = dependencies.createService(sqlite);
  if (command.action === "export") {
    const sourceKey = command.sourceKey ?? registered[0];
    if (!sourceKey) throw new Error("no registered resource source");
    if (!registered.includes(sourceKey)) throw new Error(`unknown resource source: ${sourceKey}`);
    return service.exportWorkbook({
      sourceKey,
      outputPath: command.outputPath,
      filters: command.filters,
    });
  }
  return service.importWorkbook({ inputPath: command.inputPath, allowedSourceKeys: registered });
}

export function printMappingResult(result, writeLine = console.log) {
  if (Object.hasOwn(result, "outputPath")) {
    writeLine(`采集站=${result.sourceKey} 待人工=${result.pending} 已映射=${result.mapped} 文件=${result.outputPath}`);
    return;
  }
  writeLine(
    `采集站=${result.sourceKey} 新建=${result.created} 替换=${result.replaced} 删除=${result.deleted} `
    + `忽略=${result.ignored} 冲突=${result.conflicts} 失败=${result.failed}`,
  );
  for (const issue of result.issues) {
    const label = issue.kind === "conflict" ? "冲突" : "失败";
    writeLine(`[${label}] ${issue.sheet}!${issue.row} ${issue.code} ${issue.reason}`);
  }
}
