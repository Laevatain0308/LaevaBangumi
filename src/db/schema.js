import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
