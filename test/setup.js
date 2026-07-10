import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "laeva-bangumi-test-"));
process.env.LAEVA_DB_PATH = join(root, "anime.db");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const { initDb } = await import("../src/db/index.js");
initDb();
