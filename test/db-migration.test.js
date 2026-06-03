import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";

const MIGRATION_SUBJECT_ID = 990547920;
const MIGRATION_SOURCE = "ffzy";
const MIGRATION_SOURCE_AID = 990547920;
const MIGRATION_SCOPE = "migration_scope_990547920";
const MIGRATION_TAGS = ["迁移Tag", "Legacy String Tag"];

function cleanupMigrationFixture() {
  initDb();
  sqlite.exec(`
    DELETE FROM episodes
    WHERE bangumi_id = ${MIGRATION_SUBJECT_ID}
       OR anime_id = ${MIGRATION_SUBJECT_ID}
       OR (source = '${MIGRATION_SOURCE}' AND source_aid = ${MIGRATION_SOURCE_AID})
       OR (source_name = '${MIGRATION_SOURCE}' AND source_aid = ${MIGRATION_SOURCE_AID});

    DELETE FROM resource_mappings
    WHERE bangumi_id = ${MIGRATION_SUBJECT_ID}
       OR (source = '${MIGRATION_SOURCE}' AND source_aid = ${MIGRATION_SOURCE_AID});
    DELETE FROM retry_state WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
    DELETE FROM manual_resource_state WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
    DELETE FROM sync_state WHERE source = '${MIGRATION_SOURCE}' AND scope = '${MIGRATION_SCOPE}';
    DELETE FROM subject_tags WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
    DELETE FROM subject_aliases WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
    DELETE FROM subjects WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};

    DELETE FROM resource_items
    WHERE source = '${MIGRATION_SOURCE}' AND source_aid = ${MIGRATION_SOURCE_AID};
    DELETE FROM cstation_catalog
    WHERE source = '${MIGRATION_SOURCE}' AND id = ${MIGRATION_SOURCE_AID};
    DELETE FROM bangumi_cstation_map
    WHERE anime_id = ${MIGRATION_SUBJECT_ID}
       OR (source = '${MIGRATION_SOURCE}' AND cstation_id = ${MIGRATION_SOURCE_AID});
    DELETE FROM match_retry_state
    WHERE anime_id = ${MIGRATION_SUBJECT_ID} AND source = '${MIGRATION_SOURCE}';
    DELETE FROM episode_fetch_retry_state
    WHERE anime_id = ${MIGRATION_SUBJECT_ID} AND source = '${MIGRATION_SOURCE}';
    DELETE FROM manual_match_state
    WHERE anime_id = ${MIGRATION_SUBJECT_ID} AND source = '${MIGRATION_SOURCE}';
    DELETE FROM source_sync_state
    WHERE source = '${MIGRATION_SOURCE}' AND category = '${MIGRATION_SCOPE}';
    DELETE FROM anime WHERE id = ${MIGRATION_SUBJECT_ID};
  `);

  const deleteTagIfOrphan = sqlite.prepare(`
    DELETE FROM tags
    WHERE name = ?
      AND NOT EXISTS (SELECT 1 FROM subject_tags WHERE subject_tags.tag_id = tags.tag_id)
  `);
  for (const tag of MIGRATION_TAGS) deleteTagIfOrphan.run(tag);
}

function seedLegacyRowsThenClearNormalizedRows() {
  cleanupMigrationFixture();
  sqlite.exec(`
    INSERT INTO anime (
      id, name, name_cn, aliases, platform, air_date, air_weekday,
      calendar_weekday, eps, total_episodes, summary, cover_url, has_cover,
      rating_score, rank, tags, detail_fetched_at, created_at, updated_at
    ) VALUES (
      ${MIGRATION_SUBJECT_ID},
      'Legacy Migration Raw',
      '迁移中文名',
      '["迁移别名","Alias Migration"]',
      'TV',
      '2026-04-03',
      5,
      5,
      13,
      13,
      'legacy migration summary',
      'https://example.invalid/migration-cover.jpg',
      0,
      7.2,
      2468,
      '["迁移Tag","Legacy String Tag"]',
      '2026-06-03 01:00:00',
      '2026-06-03 00:00:00',
      '2026-06-03 01:00:00'
    );

    INSERT INTO cstation_catalog (
      source, id, category, name, subname, year, last, detail_fetched_at
    ) VALUES (
      '${MIGRATION_SOURCE}',
      ${MIGRATION_SOURCE_AID},
      'TV',
      '迁移资源站标题',
      '迁移副标题',
      '2026',
      '第03集',
      '2026-06-03 02:00:00'
    );

    INSERT INTO bangumi_cstation_map (
      anime_id, source, cstation_id, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_bg_name, matched_cs_name, matched_at
    ) VALUES (
      ${MIGRATION_SUBJECT_ID},
      '${MIGRATION_SOURCE}',
      ${MIGRATION_SOURCE_AID},
      1,
      13,
      0,
      0.93,
      '迁移中文名',
      '迁移资源站标题',
      '2026-06-03 03:00:00'
    );

    INSERT INTO episodes (
      anime_id, source_name, source_aid, ep_index, source_ep_index, ep_name,
      video_url, updated_at
    ) VALUES (
      ${MIGRATION_SUBJECT_ID},
      '${MIGRATION_SOURCE}',
      ${MIGRATION_SOURCE_AID},
      3,
      3,
      '第03集',
      'https://example.invalid/migration-3.m3u8',
      '2026-06-03 04:00:00'
    );

    INSERT INTO match_retry_state (
      anime_id, source, retry_count, retry_at, updated_at
    ) VALUES (
      ${MIGRATION_SUBJECT_ID},
      '${MIGRATION_SOURCE}',
      2,
      '2026-06-03 05:00:00',
      '2026-06-03 04:30:00'
    );

    INSERT INTO episode_fetch_retry_state (
      anime_id, source, retry_count, retry_at, updated_at
    ) VALUES (
      ${MIGRATION_SUBJECT_ID},
      '${MIGRATION_SOURCE}',
      1,
      '2026-06-03 06:00:00',
      '2026-06-03 05:30:00'
    );

    INSERT INTO manual_match_state (
      anime_id, source, status, note, updated_at
    ) VALUES (
      ${MIGRATION_SUBJECT_ID},
      '${MIGRATION_SOURCE}',
      'wait_airing',
      'legacy manual note',
      '2026-06-03 06:30:00'
    );

    INSERT INTO source_sync_state (
      source, category, last_seen_at, last_success_at, updated_at
    ) VALUES (
      '${MIGRATION_SOURCE}',
      '${MIGRATION_SCOPE}',
      '2026-06-03 07:00:00',
      '2026-06-03 07:10:00',
      '2026-06-03 07:20:00'
    );

    UPDATE episodes
    SET bangumi_id = NULL,
        source = NULL
    WHERE anime_id = ${MIGRATION_SUBJECT_ID}
      AND source_name = '${MIGRATION_SOURCE}'
      AND source_aid = ${MIGRATION_SOURCE_AID};

    DELETE FROM resource_mappings WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
    DELETE FROM retry_state WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
    DELETE FROM manual_resource_state WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
    DELETE FROM sync_state WHERE source = '${MIGRATION_SOURCE}' AND scope = '${MIGRATION_SCOPE}';
    DELETE FROM subject_tags WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
    DELETE FROM subject_aliases WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
    DELETE FROM resource_items
    WHERE source = '${MIGRATION_SOURCE}' AND source_aid = ${MIGRATION_SOURCE_AID};
    DELETE FROM subjects WHERE bangumi_id = ${MIGRATION_SUBJECT_ID};
  `);

  const deleteTagIfOrphan = sqlite.prepare(`
    DELETE FROM tags
    WHERE name = ?
      AND NOT EXISTS (SELECT 1 FROM subject_tags WHERE subject_tags.tag_id = tags.tag_id)
  `);
  for (const tag of MIGRATION_TAGS) deleteTagIfOrphan.run(tag);
}

test.afterEach(() => {
  cleanupMigrationFixture();
});

test("initDb creates the normalized schema tables", () => {
  initDb();
  const tableNames = new Set(sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name));

  for (const table of [
    "subjects",
    "subject_aliases",
    "tags",
    "subject_tags",
    "resource_sources",
    "resource_items",
    "resource_mappings",
    "episodes",
    "sync_state",
    "retry_state",
    "manual_resource_state",
  ]) {
    assert.equal(tableNames.has(table), true, `${table} table should exist`);
  }

  const sourceColumns = new Set(sqlite.prepare("PRAGMA table_info(resource_sources)").all().map((row) => row.name));
  assert.equal(sourceColumns.has("priority"), true, "resource_sources.priority column should exist");
  assert.equal(sqlite.prepare("SELECT priority FROM resource_sources WHERE source = 'ffzy'").get().priority, 100);

  const retryColumns = new Set(sqlite.prepare("PRAGMA table_info(retry_state)").all().map((row) => row.name));
  assert.equal(retryColumns.has("last_error"), true, "retry_state.last_error column should exist");
});

test("initDb migrates legacy rows into normalized tables idempotently", () => {
  seedLegacyRowsThenClearNormalizedRows();

  initDb();
  initDb();

  const subject = sqlite.prepare(`
    SELECT bangumi_id, name, name_cn, summary, platform, air_date, air_weekday,
      calendar_weekday, eps, total_episodes, cover_url, has_cover,
      rating_score, rating_rank, metadata_fetched_at, created_at, updated_at
    FROM subjects
    WHERE bangumi_id = ?
  `).get(MIGRATION_SUBJECT_ID);
  assert.deepEqual(subject, {
    bangumi_id: MIGRATION_SUBJECT_ID,
    name: "Legacy Migration Raw",
    name_cn: "迁移中文名",
    summary: "legacy migration summary",
    platform: "TV",
    air_date: "2026-04-03",
    air_weekday: 5,
    calendar_weekday: 5,
    eps: 13,
    total_episodes: 13,
    cover_url: "https://example.invalid/migration-cover.jpg",
    has_cover: 0,
    rating_score: 7.2,
    rating_rank: 2468,
    metadata_fetched_at: "2026-06-03 01:00:00",
    created_at: "2026-06-03 00:00:00",
    updated_at: "2026-06-03 01:00:00",
  });

  assert.deepEqual(sqlite.prepare(`
    SELECT alias FROM subject_aliases
    WHERE bangumi_id = ?
    ORDER BY alias
  `).all(MIGRATION_SUBJECT_ID).map((row) => row.alias), [
    "Alias Migration",
    "迁移别名",
  ]);

  assert.deepEqual(sqlite.prepare(`
    SELECT t.name, st.count, st.total_count, st.source
    FROM subject_tags st
    JOIN tags t ON t.tag_id = st.tag_id
    WHERE st.bangumi_id = ?
    ORDER BY t.name
  `).all(MIGRATION_SUBJECT_ID), [
    { name: "Legacy String Tag", count: 0, total_count: 0, source: "legacy" },
    { name: "迁移Tag", count: 0, total_count: 0, source: "legacy" },
  ]);

  assert.deepEqual(sqlite.prepare(`
    SELECT bangumi_id, source, source_aid, source_ep_start, source_ep_end,
      display_ep_offset, score, matched_bg_name, matched_resource_name, matched_at
    FROM resource_mappings
    WHERE bangumi_id = ? AND source = ?
  `).get(MIGRATION_SUBJECT_ID, MIGRATION_SOURCE), {
    bangumi_id: MIGRATION_SUBJECT_ID,
    source: MIGRATION_SOURCE,
    source_aid: MIGRATION_SOURCE_AID,
    source_ep_start: 1,
    source_ep_end: 13,
    display_ep_offset: 0,
    score: 0.93,
    matched_bg_name: "迁移中文名",
    matched_resource_name: "迁移资源站标题",
    matched_at: "2026-06-03 03:00:00",
  });

  assert.deepEqual(sqlite.prepare(`
    SELECT source, source_aid, title, subtitle, category, year, latest_text, detail_fetched_at
    FROM resource_items
    WHERE source = ? AND source_aid = ?
  `).get(MIGRATION_SOURCE, MIGRATION_SOURCE_AID), {
    source: MIGRATION_SOURCE,
    source_aid: MIGRATION_SOURCE_AID,
    title: "迁移资源站标题",
    subtitle: "迁移副标题",
    category: "TV",
    year: "2026",
    latest_text: "第03集",
    detail_fetched_at: "2026-06-03 02:00:00",
  });

  assert.deepEqual(sqlite.prepare(`
    SELECT bangumi_id, source, source_aid, ep_index, source_ep_index, ep_name, video_url, updated_at
    FROM episodes
    WHERE anime_id = ? AND source_name = ? AND source_aid = ?
  `).get(MIGRATION_SUBJECT_ID, MIGRATION_SOURCE, MIGRATION_SOURCE_AID), {
    bangumi_id: MIGRATION_SUBJECT_ID,
    source: MIGRATION_SOURCE,
    source_aid: MIGRATION_SOURCE_AID,
    ep_index: 3,
    source_ep_index: 3,
    ep_name: "第03集",
    video_url: "https://example.invalid/migration-3.m3u8",
    updated_at: "2026-06-03 04:00:00",
  });

  assert.deepEqual(sqlite.prepare(`
    SELECT source, kind, retry_count, retry_at, updated_at
    FROM retry_state
    WHERE bangumi_id = ?
    ORDER BY kind
  `).all(MIGRATION_SUBJECT_ID), [
    {
      source: MIGRATION_SOURCE,
      kind: "episode_fetch",
      retry_count: 1,
      retry_at: "2026-06-03 06:00:00",
      updated_at: "2026-06-03 05:30:00",
    },
    {
      source: MIGRATION_SOURCE,
      kind: "mapping",
      retry_count: 2,
      retry_at: "2026-06-03 05:00:00",
      updated_at: "2026-06-03 04:30:00",
    },
  ]);

  assert.deepEqual(sqlite.prepare(`
    SELECT source, status, note, updated_at
    FROM manual_resource_state
    WHERE bangumi_id = ?
  `).get(MIGRATION_SUBJECT_ID), {
    source: MIGRATION_SOURCE,
    status: "wait_airing",
    note: "legacy manual note",
    updated_at: "2026-06-03 06:30:00",
  });

  assert.deepEqual(sqlite.prepare(`
    SELECT source, scope, last_seen_at, last_success_at, updated_at
    FROM sync_state
    WHERE source = ? AND scope = ?
  `).get(MIGRATION_SOURCE, MIGRATION_SCOPE), {
    source: MIGRATION_SOURCE,
    scope: MIGRATION_SCOPE,
    last_seen_at: "2026-06-03 07:00:00",
    last_success_at: "2026-06-03 07:10:00",
    updated_at: "2026-06-03 07:20:00",
  });
});

test("initDb does not overwrite existing normalized state with legacy state", () => {
  seedLegacyRowsThenClearNormalizedRows();
  sqlite.exec(`
    INSERT INTO subjects (bangumi_id, name, rating_distribution_json)
    VALUES (${MIGRATION_SUBJECT_ID}, 'Existing normalized subject', '[]');

    INSERT INTO retry_state (
      bangumi_id, source, kind, retry_count, retry_at, updated_at
    ) VALUES (
      ${MIGRATION_SUBJECT_ID},
      '${MIGRATION_SOURCE}',
      'mapping',
      9,
      '2026-06-03 09:00:00',
      '2026-06-03 09:10:00'
    );

    INSERT INTO manual_resource_state (
      bangumi_id, source, status, note, updated_at
    ) VALUES (
      ${MIGRATION_SUBJECT_ID},
      '${MIGRATION_SOURCE}',
      'no_resource',
      'normalized note',
      '2026-06-03 09:20:00'
    );

    INSERT INTO sync_state (
      source, scope, last_seen_at, last_success_at, updated_at
    ) VALUES (
      '${MIGRATION_SOURCE}',
      '${MIGRATION_SCOPE}',
      '2026-06-03 09:30:00',
      '2026-06-03 09:40:00',
      '2026-06-03 09:50:00'
    );
  `);

  initDb();

  assert.deepEqual(sqlite.prepare(`
    SELECT retry_count, retry_at, updated_at
    FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(MIGRATION_SUBJECT_ID, MIGRATION_SOURCE), {
    retry_count: 9,
    retry_at: "2026-06-03 09:00:00",
    updated_at: "2026-06-03 09:10:00",
  });

  assert.deepEqual(sqlite.prepare(`
    SELECT status, note, updated_at
    FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(MIGRATION_SUBJECT_ID, MIGRATION_SOURCE), {
    status: "no_resource",
    note: "normalized note",
    updated_at: "2026-06-03 09:20:00",
  });

  assert.deepEqual(sqlite.prepare(`
    SELECT last_seen_at, last_success_at, updated_at
    FROM sync_state
    WHERE source = ? AND scope = ?
  `).get(MIGRATION_SOURCE, MIGRATION_SCOPE), {
    last_seen_at: "2026-06-03 09:30:00",
    last_success_at: "2026-06-03 09:40:00",
    updated_at: "2026-06-03 09:50:00",
  });
});
