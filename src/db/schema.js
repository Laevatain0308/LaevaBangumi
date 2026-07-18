import { sql } from "drizzle-orm";
import { sqliteTable, integer, real, text, uniqueIndex, primaryKey, index, foreignKey, check } from "drizzle-orm/sqlite-core";

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
  mediaType: text("media_type").notNull().default("anime"),
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
  mediaType: text("media_type").notNull().default("anime"),
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

export const accounts = sqliteTable("accounts", {
  accountId: integer("account_id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  passwordChangedAt: text("password_changed_at").notNull(),
});

export const accountDevices = sqliteTable("account_devices", {
  accountId: integer("account_id").notNull().references(() => accounts.accountId, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),
  deviceName: text("device_name"),
  platform: text("platform"),
  appVersion: text("app_version"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [primaryKey({ columns: [table.accountId, table.deviceId] })]);

export const accountTokens = sqliteTable("account_tokens", {
  tokenId: integer("token_id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id").notNull(),
  deviceId: text("device_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
}, (table) => [
  foreignKey({
    columns: [table.accountId, table.deviceId],
    foreignColumns: [accountDevices.accountId, accountDevices.deviceId],
  }).onDelete("cascade"),
  uniqueIndex("idx_account_tokens_active_device")
    .on(table.accountId, table.deviceId)
    .where(sql`${table.revokedAt} IS NULL`),
]);

export const syncEvents = sqliteTable("sync_events", {
  accountId: integer("account_id").notNull().references(() => accounts.accountId, { onDelete: "cascade" }),
  eventId: text("event_id").notNull(),
  deviceId: text("device_id").notNull(),
  seq: integer("seq").notNull(),
  domain: text("domain").notNull(),
  operation: text("operation").notNull(),
  bangumiId: integer("bangumi_id"),
  updatedAtMs: integer("updated_at_ms").notNull(),
  version: text("version").notNull(),
  payloadJson: text("payload_json").notNull(),
  receivedAt: text("received_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.eventId] }),
  check("sync_events_seq_check", sql`${table.seq} >= 0`),
  check("sync_events_domain_check", sql`${table.domain} IN ('watch', 'collection')`),
  check("sync_events_updated_at_ms_check", sql`${table.updatedAtMs} >= 0`),
  index("idx_sync_events_account_domain_version").on(table.accountId, table.domain, table.version),
  index("idx_sync_events_account_device_seq").on(table.accountId, table.deviceId, table.seq),
]);

export const watchRecords = sqliteTable("watch_records", {
  accountId: integer("account_id").notNull().references(() => accounts.accountId, { onDelete: "cascade" }),
  bangumiId: integer("bangumi_id").notNull(),
  lastWatchEpisode: integer("last_watch_episode").notNull(),
  lastWatchTimeMs: integer("last_watch_time_ms").notNull(),
  lastWatchEpisodeName: text("last_watch_episode_name").notNull(),
  recordVersion: text("record_version").notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.bangumiId] }),
  check("watch_records_bangumi_id_check", sql`${table.bangumiId} > 0`),
  check("watch_records_last_watch_episode_check", sql`${table.lastWatchEpisode} >= 1`),
  check("watch_records_last_watch_time_ms_check", sql`${table.lastWatchTimeMs} >= 0`),
]);

export const watchProgress = sqliteTable("watch_progress", {
  accountId: integer("account_id").notNull().references(() => accounts.accountId, { onDelete: "cascade" }),
  bangumiId: integer("bangumi_id").notNull(),
  episode: integer("episode").notNull(),
  road: integer("road").notNull(),
  progressMs: integer("progress_ms").notNull(),
  progressVersion: text("progress_version").notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.bangumiId, table.episode] }),
  check("watch_progress_bangumi_id_check", sql`${table.bangumiId} > 0`),
  check("watch_progress_episode_check", sql`${table.episode} >= 1`),
  check("watch_progress_road_check", sql`${table.road} >= 0`),
  check("watch_progress_progress_ms_check", sql`${table.progressMs} >= 0`),
]);

export const watchTombstones = sqliteTable("watch_tombstones", {
  accountId: integer("account_id").notNull().references(() => accounts.accountId, { onDelete: "cascade" }),
  bangumiId: integer("bangumi_id").notNull(),
  deletedVersion: text("deleted_version").notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.bangumiId] }),
  check("watch_tombstones_bangumi_id_check", sql`${table.bangumiId} > 0`),
]);

export const watchState = sqliteTable("watch_state", {
  accountId: integer("account_id").primaryKey().references(() => accounts.accountId, { onDelete: "cascade" }),
  clearVersion: text("clear_version"),
});

export const collectionRecords = sqliteTable("collection_records", {
  accountId: integer("account_id").notNull().references(() => accounts.accountId, { onDelete: "cascade" }),
  bangumiId: integer("bangumi_id").notNull(),
  type: integer("type").notNull(),
  collectedAtMs: integer("collected_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  recordVersion: text("record_version").notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.bangumiId] }),
  check("collection_records_bangumi_id_check", sql`${table.bangumiId} > 0`),
  check("collection_records_type_check", sql`${table.type} BETWEEN 1 AND 5`),
  check("collection_records_collected_at_ms_check", sql`${table.collectedAtMs} >= 0`),
  check("collection_records_updated_at_ms_check", sql`${table.updatedAtMs} >= 0`),
]);

export const collectionTombstones = sqliteTable("collection_tombstones", {
  accountId: integer("account_id").notNull().references(() => accounts.accountId, { onDelete: "cascade" }),
  bangumiId: integer("bangumi_id").notNull(),
  deletedVersion: text("deleted_version").notNull(),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.bangumiId] }),
  check("collection_tombstones_bangumi_id_check", sql`${table.bangumiId} > 0`),
]);

export const collectionState = sqliteTable("collection_state", {
  accountId: integer("account_id").primaryKey().references(() => accounts.accountId, { onDelete: "cascade" }),
  clearVersion: text("clear_version"),
});

export const bangumiSubjects = sqliteTable("bangumi_subjects", {
  bangumiId: integer("bangumi_id").primaryKey(),
  name: text("name").notNull(),
  nameCn: text("name_cn"),
  summary: text("summary"),
  airDate: text("air_date"),
  airWeekday: integer("air_weekday"),
  platform: text("platform"),
  eps: integer("eps"),
  totalEpisodes: integer("total_episodes"),
  volumes: integer("volumes"),
  series: integer("series", { mode: "boolean" }),
  locked: integer("locked", { mode: "boolean" }),
  nsfw: integer("nsfw", { mode: "boolean" }),
  discoveredAt: text("discovered_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const bangumiSubjectImages = sqliteTable("bangumi_subject_images", {
  bangumiId: integer("bangumi_id").primaryKey().references(() => bangumiSubjects.bangumiId),
  largeUrl: text("large_url"),
  commonUrl: text("common_url"),
  mediumUrl: text("medium_url"),
  smallUrl: text("small_url"),
  gridUrl: text("grid_url"),
});

export const bangumiSubjectRating = sqliteTable("bangumi_subject_rating", {
  bangumiId: integer("bangumi_id").primaryKey().references(() => bangumiSubjects.bangumiId),
  score: real("score"),
  rank: integer("rank"),
  total: integer("total"),
  count1: integer("count_1").notNull().default(0),
  count2: integer("count_2").notNull().default(0),
  count3: integer("count_3").notNull().default(0),
  count4: integer("count_4").notNull().default(0),
  count5: integer("count_5").notNull().default(0),
  count6: integer("count_6").notNull().default(0),
  count7: integer("count_7").notNull().default(0),
  count8: integer("count_8").notNull().default(0),
  count9: integer("count_9").notNull().default(0),
  count10: integer("count_10").notNull().default(0),
});

export const bangumiSubjectCollection = sqliteTable("bangumi_subject_collection", {
  bangumiId: integer("bangumi_id").primaryKey().references(() => bangumiSubjects.bangumiId),
  wish: integer("wish").notNull().default(0),
  collect: integer("collect").notNull().default(0),
  doing: integer("doing").notNull().default(0),
  onHold: integer("on_hold").notNull().default(0),
  dropped: integer("dropped").notNull().default(0),
});

export const bangumiSubjectTags = sqliteTable("bangumi_subject_tags", {
  bangumiId: integer("bangumi_id").notNull().references(() => bangumiSubjects.bangumiId),
  position: integer("position").notNull(),
  name: text("name").notNull(),
  count: integer("count").notNull(),
  totalCount: integer("total_count").notNull(),
}, (table) => [
  primaryKey({ columns: [table.bangumiId, table.position] }),
  index("idx_bangumi_subject_tags_name").on(table.name),
]);

export const bangumiSubjectMetaTags = sqliteTable("bangumi_subject_meta_tags", {
  bangumiId: integer("bangumi_id").notNull().references(() => bangumiSubjects.bangumiId),
  position: integer("position").notNull(),
  name: text("name").notNull(),
}, (table) => [primaryKey({ columns: [table.bangumiId, table.position] })]);

export const bangumiSubjectInfoboxEntries = sqliteTable("bangumi_subject_infobox_entries", {
  bangumiId: integer("bangumi_id").notNull().references(() => bangumiSubjects.bangumiId),
  entryPosition: integer("entry_position").notNull(),
  key: text("key").notNull(),
  valueKind: text("value_kind").notNull(),
}, (table) => [primaryKey({ columns: [table.bangumiId, table.entryPosition] })]);

export const bangumiSubjectInfoboxValues = sqliteTable("bangumi_subject_infobox_values", {
  bangumiId: integer("bangumi_id").notNull(),
  entryPosition: integer("entry_position").notNull(),
  valuePosition: integer("value_position").notNull(),
  label: text("label"),
  value: text("value").notNull(),
}, (table) => [
  primaryKey({ columns: [table.bangumiId, table.entryPosition, table.valuePosition] }),
  foreignKey({
    columns: [table.bangumiId, table.entryPosition],
    foreignColumns: [bangumiSubjectInfoboxEntries.bangumiId, bangumiSubjectInfoboxEntries.entryPosition],
  }).onDelete("cascade"),
]);

export const bangumiSubjectRefreshState = sqliteTable("bangumi_subject_refresh_state", {
  bangumiId: integer("bangumi_id").primaryKey(),
  lastSucceededAt: text("last_succeeded_at"),
  nextRefreshAt: text("next_refresh_at").notNull(),
  lastAttemptedAt: text("last_attempted_at"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_bangumi_subject_refresh_due").on(table.nextRefreshAt)]);

export const bangumiCalendarSubjects = sqliteTable("bangumi_calendar_subjects", {
  bangumiId: integer("bangumi_id").primaryKey().references(() => bangumiSubjects.bangumiId),
  weekday: integer("weekday").notNull(),
}, (table) => [index("idx_bangumi_calendar_subjects_weekday").on(table.weekday)]);

export const bangumiCalendarSyncState = sqliteTable("bangumi_calendar_sync_state", {
  singletonId: integer("singleton_id").primaryKey(),
  lastSucceededAt: text("last_succeeded_at"),
  lastAttemptedAt: text("last_attempted_at").notNull(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
});

/** 允许进入 subjects 表并参与番剧同步的 platform 值 */
export const ANIME_PLATFORMS = new Set(["TV", "WEB", "OVA", "剧场版"]);
