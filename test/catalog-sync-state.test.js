import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { syncCatalogCategory } from "../src/services/catalog.js";

const SOURCE = "catalog_state";
const SCOPE = "2";
const KEY = `resource:${SOURCE}:${SCOPE}`;

function resetSyncState() {
  initDb();
  sqlite.prepare("DELETE FROM sync_state WHERE key = ?").run(KEY);
  sqlite.prepare("DELETE FROM resource_items WHERE source = ?").run(SOURCE);
  sqlite.prepare("DELETE FROM resource_sources WHERE source = ?").run(SOURCE);
}

test("syncCatalogCategory records running and failed sync_state transitions", async () => {
  resetSyncState();

  await assert.rejects(
    () => syncCatalogCategory({
      source: SOURCE,
      t: SCOPE,
      fetchCatalog: async () => {
        throw new Error("catalog unavailable");
      },
    }),
    /catalog unavailable/,
  );

  const failed = sqlite.prepare(`
    SELECT status, last_started_at, last_error, last_success_at
    FROM sync_state
    WHERE key = ?
  `).get(KEY);

  assert.equal(failed.status, "error");
  assert.ok(failed.last_started_at);
  assert.match(failed.last_error, /catalog unavailable/);
  assert.equal(failed.last_success_at, null);
});

test("syncCatalogCategory records successful sync_state after catalog save", async () => {
  resetSyncState();

  const stats = await syncCatalogCategory({
    source: SOURCE,
    t: SCOPE,
    incremental: false,
    hydrateDetails: false,
    sourceConfig: {
      key: SOURCE,
      name: "Catalog State Source",
      enabled: true,
      apiEndpoint: "https://example.invalid/catalog-state",
      priority: 42,
    },
    fetchCatalog: async () => [{
      id: 123,
      name: "Catalog State Item",
      last: "2026-06-03 02:00:00",
    }],
  });

  assert.equal(stats.saved, 1);
  const state = sqlite.prepare(`
    SELECT status, last_started_at, last_error, last_success_at, last_seen_at
    FROM sync_state
    WHERE key = ?
  `).get(KEY);
  assert.equal(state.status, "success");
  assert.ok(state.last_started_at);
  assert.equal(state.last_error, null);
  assert.ok(state.last_success_at);
  assert.equal(state.last_seen_at, "2026-06-03 02:00:00");
  assert.deepEqual(sqlite.prepare(`
    SELECT name, enabled, base_url, priority
    FROM resource_sources
    WHERE source = ?
  `).get(SOURCE), {
    name: "Catalog State Source",
    enabled: 1,
    base_url: "https://example.invalid/catalog-state",
    priority: 42,
  });
});
