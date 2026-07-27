import { join } from "node:path";
import ExcelJS from "exceljs";
import { createMappingWorkbookService } from "../../src/mappings/mappingWorkbookService.js";
import { MAPPED_SHEET, PENDING_SHEET } from "../../src/mappings/workbookFormat.js";

function pendingRows() {
  const reasons = [
    "名称相似度不足，需要在 Bangumi 与采集站网站上进行人工比对",
    "候选不唯一，同年份存在多个名称高度相似的资源",
    "Part/Cour 信息不明确",
    "采集站分集数超过 Bangumi 总集数",
  ];
  return Array.from({ length: 12 }, (_, index) => ({
    bangumiId: 100001 + index,
    title: index === 0
      ? "这是一个用于验证自动换行和列宽的很长中文番剧名称／日本語の非常に長いアニメーション作品タイトル"
      : `待人工匹配番剧 ${index + 1}`,
    airDate: index % 3 === 0 ? "2024" : index % 3 === 1 ? "2024-10" : "2024-10-01",
    reason: reasons[index % reasons.length],
  }));
}

function mappedRows() {
  return Array.from({ length: 12 }, (_, index) => ({
    bangumiId: 200001 + index,
    title: index === 0
      ? "已有映射的超长番剧名称，用于确认辅助信息可以完整显示而不会覆盖可编辑单元格"
      : `已有映射番剧 ${index + 1}`,
    airDate: index % 2 === 0 ? "2023-07-01" : "2023",
    sourceItemId: index === 0 ? "9007199254740993" : String(700000 + index).padStart(8, "0"),
    sourceTitle: index === 0
      ? "采集站中的超长资源标题／全季度合集资源名称显示测试"
      : `采集站资源 ${index + 1}`,
    sourceEpisodeStart: index === 0 ? 1 : index === 1 ? 14 : null,
    sourceEpisodeEnd: index === 0 ? 12 : null,
  }));
}

export async function writeMappingWorkbookQaFixture({ outputDir, activeSheet }) {
  let rowKey = 0;
  const pending = pendingRows();
  const mapped = mappedRows();
  const reasons = new Map(pending.map((row) => [row.bangumiId, row.reason]));
  const service = createMappingWorkbookService({
    repository: {
      listUnmappedReviewSubjects: () => pending,
      listMappedReviewRows: () => mapped,
    },
    explainSubject({ bangumiId }) {
      const reason = reasons.get(bangumiId);
      if (reason.startsWith("候选")) return { reason: "candidate_ambiguous" };
      if (reason.startsWith("Part")) return { reason: "part_ambiguous" };
      if (reason.startsWith("采集站分集")) return { reason: "episode_overflow" };
      return { reason: "name_score_low" };
    },
    mappingService: { applyManualGroup() {} },
    clock: () => new Date("2026-07-25T04:00:00.000Z"),
    rowKeyFactory: () => `qa-row-${++rowKey}`,
  });
  const filename = activeSheet === PENDING_SHEET ? "pending-active.xlsx" : "mapped-active.xlsx";
  const outputPath = join(outputDir, filename);
  await service.exportWorkbook({
    sourceKey: "ffzy",
    outputPath,
    filters: { includeUpcoming: true },
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  workbook.views = [{ activeTab: activeSheet === PENDING_SHEET ? 0 : 1 }];
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}
