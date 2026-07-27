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

export function reasonText(code) {
  return REASON_TEXT[code] ?? REASON_TEXT.no_resource;
}
