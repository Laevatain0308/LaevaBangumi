import Database from "better-sqlite3";
import { initAccountSyncSchema } from "./accountSyncSchema.js";
import { initBangumiMetadataSchema } from "./bangumiMetadataSchema.js";
import { initMappingSchema } from "./mappingSchema.js";
import { initResourceSourceSchema } from "./resourceSourceSchema.js";

const DEFAULT_DB_PATH = new URL("../../data/anime.db", import.meta.url).pathname;

export function openDatabase(path = process.env.LAEVA_DB_PATH || DEFAULT_DB_PATH) {
  const connection = new Database(path);
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  connection.pragma("busy_timeout = 5000");
  return connection;
}

export const sqlite = openDatabase();

export function initDb(connection = sqlite) {
  initResourceSourceSchema(connection);
  initBangumiMetadataSchema(connection);
  initMappingSchema(connection);
  initAccountSyncSchema(connection);
}
