import { sqliteTable, integer, real, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const anime = sqliteTable("anime", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  nameCn: text("name_cn"),
  aliases: text("aliases"),
  platform: text("platform"),
  airDate: text("air_date"),
  airWeekday: integer("air_weekday"),
  calendarWeekday: integer("calendar_weekday"),
  eps: integer("eps"),
  totalEpisodes: integer("total_episodes"),
  summary: text("summary"),
  coverUrl: text("cover_url"),
  hasCover: integer("has_cover").default(0),
  ratingScore: real("rating_score"),
  rank: integer("rank"),
  tags: text("tags"),
  sourcesJson: text("sources_json"),
  detailFetchedAt: text("detail_fetched_at"),
  createdAt: text("created_at").default("(datetime('now'))").notNull(),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
});

export const episodes = sqliteTable("episodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  animeId: integer("anime_id").notNull().references(() => anime.id),
  sourceName: text("source_name").notNull(),
  sourceAid: integer("source_aid").notNull(),
  epIndex: integer("ep_index").notNull(),
  sourceEpIndex: integer("source_ep_index"),
  epName: text("ep_name"),
  videoUrl: text("video_url").notNull(),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  uniqueEp: uniqueIndex("idx_ep_unique").on(table.animeId, table.sourceName, table.sourceAid, table.epIndex),
}));

export const bangumiCstationMap = sqliteTable("bangumi_cstation_map", {
  animeId: integer("anime_id").notNull(),
  source: text("source").notNull().default("ffzy"),
  cstationId: integer("cstation_id").notNull(),
  sourceEpStart: integer("source_ep_start"),
  sourceEpEnd: integer("source_ep_end"),
  displayEpOffset: integer("display_ep_offset").notNull().default(0),
  score: real("score"),
  matchedBgName: text("matched_bg_name"),
  matchedCsName: text("matched_cs_name"),
  matchedAt: text("matched_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_map_unique").on(table.animeId, table.source),
}));

export const matchRetryState = sqliteTable("match_retry_state", {
  animeId: integer("anime_id").notNull().references(() => anime.id),
  source: text("source").notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  retryAt: text("retry_at"),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_match_retry_state_unique").on(table.animeId, table.source),
}));

export const manualMatchState = sqliteTable("manual_match_state", {
  animeId: integer("anime_id").notNull().references(() => anime.id),
  source: text("source").notNull(),
  status: text("status").notNull(),
  note: text("note"),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_manual_match_state_unique").on(table.animeId, table.source),
}));

export const cstationCatalog = sqliteTable("cstation_catalog", {
  source: text("source").notNull(),
  id: integer("id").notNull(),
  category: text("category"),
  name: text("name").notNull(),
  subname: text("subname"),
  year: text("year"),
  last: text("last"),
  detailFetchedAt: text("detail_fetched_at"),
}, (table) => ({
  pk: uniqueIndex("idx_catalog_unique").on(table.source, table.id),
}));

export const sourceSyncState = sqliteTable("source_sync_state", {
  source: text("source").notNull(),
  category: text("category").notNull(),
  lastSeenAt: text("last_seen_at"),
  lastSuccessAt: text("last_success_at"),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_source_sync_unique").on(table.source, table.category),
}));

// 非番剧类型（小说、其他等），仅存储，不参与定时更新
export const animeOther = sqliteTable("anime_other", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  nameCn: text("name_cn"),
  aliases: text("aliases"),
  platform: text("platform"),
  summary: text("summary"),
  coverUrl: text("cover_url"),
  tags: text("tags"),
  createdAt: text("created_at").default("(datetime('now'))").notNull(),
});

/** 允许进入 anime 表的 platform 值 */
export const ANIME_PLATFORMS = new Set(["TV", "WEB", "OVA", "剧场版"]);
