import { sqliteTable, integer, real, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const episodes = sqliteTable("episodes", {
  episodeId: integer("episode_id").primaryKey({ autoIncrement: true }),
  bangumiId: integer("bangumi_id").notNull().references(() => subjects.bangumiId),
  source: text("source").notNull(),
  sourceAid: integer("source_aid").notNull(),
  epIndex: integer("ep_index").notNull(),
  sourceEpIndex: integer("source_ep_index"),
  title: text("title"),
  rawVideoUrl: text("raw_video_url").notNull(),
  updatedAt: text("updated_at"),
}, (table) => ({
  uniqueEp: uniqueIndex("idx_episodes_resource_unique").on(table.bangumiId, table.source, table.sourceAid, table.epIndex),
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

export const subjects = sqliteTable("subjects", {
  bangumiId: integer("bangumi_id").primaryKey(),
  type: integer("type").notNull().default(2),
  name: text("name").notNull(),
  nameCn: text("name_cn"),
  summary: text("summary"),
  platform: text("platform"),
  airDate: text("air_date"),
  airWeekday: integer("air_weekday"),
  calendarWeekday: integer("calendar_weekday"),
  eps: integer("eps"),
  totalEpisodes: integer("total_episodes"),
  coverUrl: text("cover_url"),
  ratingScore: real("rating_score"),
  ratingRank: integer("rating_rank"),
  ratingTotal: integer("rating_total"),
  ratingDistributionJson: text("rating_distribution_json").notNull().default("[]"),
  metadataFetchedAt: text("metadata_fetched_at"),
  ratingFetchedAt: text("rating_fetched_at"),
  calendarSyncedAt: text("calendar_synced_at"),
  createdAt: text("created_at").default("(datetime('now'))").notNull(),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
});

export const subjectAliases = sqliteTable("subject_aliases", {
  bangumiId: integer("bangumi_id").notNull().references(() => subjects.bangumiId),
  alias: text("alias").notNull(),
  locale: text("locale"),
  source: text("source").notNull().default("bangumi"),
  createdAt: text("created_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_subject_aliases_unique").on(table.bangumiId, table.alias),
}));

export const tags = sqliteTable("tags", {
  tagId: integer("tag_id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  createdAt: text("created_at").default("(datetime('now'))").notNull(),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
});

export const subjectTags = sqliteTable("subject_tags", {
  bangumiId: integer("bangumi_id").notNull().references(() => subjects.bangumiId),
  tagId: integer("tag_id").notNull().references(() => tags.tagId),
  count: integer("count").notNull().default(0),
  totalCount: integer("total_count").notNull().default(0),
  source: text("source").notNull().default("bangumi"),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_subject_tags_unique").on(table.bangumiId, table.tagId),
}));

export const resourceSources = sqliteTable("resource_sources", {
  source: text("source").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled").notNull().default(1),
  baseUrl: text("base_url"),
  priority: integer("priority").notNull().default(100),
  createdAt: text("created_at").default("(datetime('now'))").notNull(),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
});

export const resourceItems = sqliteTable("resource_items", {
  source: text("source").notNull().references(() => resourceSources.source),
  sourceAid: integer("source_aid").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  category: text("category"),
  year: text("year"),
  latestText: text("latest_text"),
  detailFetchedAt: text("detail_fetched_at"),
  createdAt: text("created_at").default("(datetime('now'))").notNull(),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_resource_items_unique").on(table.source, table.sourceAid),
}));

export const resourceMappings = sqliteTable("resource_mappings", {
  bangumiId: integer("bangumi_id").notNull().references(() => subjects.bangumiId),
  source: text("source").notNull().references(() => resourceSources.source),
  sourceAid: integer("source_aid").notNull(),
  sourceEpStart: integer("source_ep_start"),
  sourceEpEnd: integer("source_ep_end"),
  displayEpOffset: integer("display_ep_offset").notNull().default(0),
  score: real("score"),
  matchedSubjectTitle: text("matched_subject_title"),
  matchedResourceTitle: text("matched_resource_title"),
  status: text("status").notNull().default("matched"),
  note: text("note"),
  matchedAt: text("matched_at").default("(datetime('now'))").notNull(),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_resource_mappings_unique").on(table.bangumiId, table.source),
}));

export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  status: text("status").notNull().default("success"),
  lastStartedAt: text("last_started_at"),
  lastSeenAt: text("last_seen_at"),
  lastSuccessAt: text("last_success_at"),
  lastError: text("last_error"),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
});

export const retryState = sqliteTable("retry_state", {
  bangumiId: integer("bangumi_id").notNull().references(() => subjects.bangumiId),
  source: text("source").notNull(),
  kind: text("kind").notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  retryAt: text("retry_at"),
  lastError: text("last_error"),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_retry_state_unique").on(table.bangumiId, table.source, table.kind),
}));

export const manualResourceState = sqliteTable("manual_resource_state", {
  bangumiId: integer("bangumi_id").notNull().references(() => subjects.bangumiId),
  source: text("source").notNull(),
  status: text("status").notNull(),
  note: text("note"),
  updatedAt: text("updated_at").default("(datetime('now'))").notNull(),
}, (table) => ({
  pk: uniqueIndex("idx_manual_resource_state_unique").on(table.bangumiId, table.source),
}));

/** 允许进入 subjects 表并参与番剧同步的 platform 值 */
export const ANIME_PLATFORMS = new Set(["TV", "WEB", "OVA", "剧场版"]);
