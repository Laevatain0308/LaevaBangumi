import Database from "better-sqlite3";
import { initBangumiMetadataSchema } from "../../src/db/bangumiMetadataSchema.js";
import { initResourceSourceSchema } from "../../src/db/resourceSourceSchema.js";

export function createTestDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  initResourceSourceSchema(sqlite);
  initBangumiMetadataSchema(sqlite);
  return { sqlite, close: () => sqlite.close() };
}
