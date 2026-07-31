import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const RUNBOOK_URL = new URL("../docs/production-runbook.md", import.meta.url);

test("production runbook documents the supported operational workflow", async () => {
  const runbook = await readFile(RUNBOOK_URL, "utf8");
  for (const required of [
    "pm2 start",
    "BANGUMI_PROXY_URL",
    "start:sync",
    "npm run account",
    "npm run mapping",
    "/api/health",
    ".backup",
    "anime",
    "tid=30",
  ]) {
    assert.ok(runbook.includes(required), `runbook must mention ${required}`);
  }
});
