import { parseAirDate } from "../lib/airDate.js";

const INFOBOX_ALIAS_KEY = /别名|中文名|英文名|日文名|原名|罗马字|放送译名/;

function mappingFromRow(row) {
  if (!row) return null;
  return {
    bangumiId: row.bangumi_id,
    sourceKey: row.source_key,
    sourceItemId: row.source_item_id,
    sourceEpisodeStart: row.source_episode_start,
    sourceEpisodeEnd: row.source_episode_end,
  };
}

function scheduleFromRow(row) {
  return {
    bangumiId: row.bangumi_id,
    sourceKey: row.source_key,
    eligibleOn: row.eligible_on,
  };
}

function unique(values) {
  return [...new Set(values)];
}

export function createMappingRepository({ sqlite } = {}) {
  if (!sqlite?.prepare || !sqlite?.transaction) {
    throw new TypeError("mapping repository requires a better-sqlite3 connection");
  }

  const runTransaction = sqlite.transaction((callback) => callback());
  const findMappingStatement = sqlite.prepare(`
    SELECT * FROM bangumi_resource_mappings
    WHERE bangumi_id = ? AND source_key = ?
  `);
  const insertMappingStatement = sqlite.prepare(`
    INSERT INTO bangumi_resource_mappings (
      bangumi_id, source_key, source_item_id,
      source_episode_start, source_episode_end
    ) VALUES (
      @bangumiId, @sourceKey, @sourceItemId,
      @sourceEpisodeStart, @sourceEpisodeEnd
    )
  `);
  const deleteMappingStatement = sqlite.prepare(`
    DELETE FROM bangumi_resource_mappings
    WHERE bangumi_id = ? AND source_key = ?
  `);
  const hasSourceItemMappingStatement = sqlite.prepare(`
    SELECT 1 FROM bangumi_resource_mappings
    WHERE source_key = ? AND source_item_id = ? LIMIT 1
  `);
  const findSubjectStatement = sqlite.prepare(`
    SELECT
      s.bangumi_id, s.name, s.name_cn, s.air_date, s.platform,
      s.total_episodes, r.last_succeeded_at
    FROM bangumi_subjects s
    LEFT JOIN bangumi_subject_refresh_state r
      ON r.bangumi_id = s.bangumi_id
    WHERE s.bangumi_id = ?
  `);
  const subjectAliasesStatement = sqlite.prepare(`
    SELECT e.key, v.value
    FROM bangumi_subject_infobox_entries e
    JOIN bangumi_subject_infobox_values v
      ON v.bangumi_id = e.bangumi_id
      AND v.entry_position = e.entry_position
    WHERE e.bangumi_id = ?
    ORDER BY e.entry_position, v.value_position
  `);
  const findSourceItemStatement = sqlite.prepare(`
    SELECT i.*, COUNT(e.episode_index) AS episode_count
    FROM source_items i
    LEFT JOIN source_episodes e
      ON e.source_key = i.source_key
      AND e.source_item_id = i.source_item_id
    WHERE i.source_key = ? AND i.source_item_id = ?
    GROUP BY i.source_key, i.source_item_id
  `);
  const sourceAliasesStatement = sqlite.prepare(`
    SELECT alias FROM source_item_aliases
    WHERE source_key = ? AND source_item_id = ?
    ORDER BY rowid
  `);
  const hasExclusionStatement = sqlite.prepare(`
    SELECT 1 FROM auto_match_exclusions
    WHERE bangumi_id = ? AND source_key = ? AND source_item_id = ?
  `);
  const insertExclusionStatement = sqlite.prepare(`
    INSERT INTO auto_match_exclusions (bangumi_id, source_key, source_item_id)
    VALUES (@bangumiId, @sourceKey, @sourceItemId)
    ON CONFLICT(bangumi_id, source_key, source_item_id) DO NOTHING
  `);
  const upsertScheduleStatement = sqlite.prepare(`
    INSERT INTO auto_match_schedule (bangumi_id, source_key, eligible_on)
    VALUES (@bangumiId, @sourceKey, @eligibleOn)
    ON CONFLICT(bangumi_id, source_key) DO UPDATE SET
      eligible_on = excluded.eligible_on
  `);

  function transaction(callback) {
    if (typeof callback !== "function") throw new TypeError("mapping transaction requires a callback");
    return runTransaction(callback);
  }

  function findMapping({ bangumiId, sourceKey }) {
    return mappingFromRow(findMappingStatement.get(bangumiId, sourceKey));
  }

  function listMappingsForSource(sourceKey) {
    return sqlite.prepare(`
      SELECT * FROM bangumi_resource_mappings
      WHERE source_key = ?
      ORDER BY bangumi_id
    `).all(sourceKey).map(mappingFromRow);
  }

  function listMappingsForSourceItem({ sourceKey, sourceItemId }) {
    return sqlite.prepare(`
      SELECT * FROM bangumi_resource_mappings
      WHERE source_key = ? AND source_item_id = ?
      ORDER BY source_episode_start IS NULL, source_episode_start, bangumi_id
    `).all(sourceKey, sourceItemId).map(mappingFromRow);
  }

  function hasSourceItemMapping({ sourceKey, sourceItemId }) {
    return !!hasSourceItemMappingStatement.get(sourceKey, sourceItemId);
  }

  function insertMapping(mapping) {
    return insertMappingStatement.run({
      ...mapping,
      sourceEpisodeStart: mapping.sourceEpisodeStart ?? null,
      sourceEpisodeEnd: mapping.sourceEpisodeEnd ?? null,
    }).changes;
  }

  function deleteMapping({ bangumiId, sourceKey }) {
    return deleteMappingStatement.run(bangumiId, sourceKey).changes;
  }

  function subjectFromRow(row) {
    if (!row) return null;
    const aliases = subjectAliasesStatement.all(row.bangumi_id)
      .filter(({ key }) => INFOBOX_ALIAS_KEY.test(key))
      .map(({ value }) => value)
      .filter(Boolean);
    return {
      bangumiId: row.bangumi_id,
      name: row.name,
      nameCn: row.name_cn,
      aliases: unique(aliases),
      airDate: row.air_date,
      platform: row.platform,
      totalEpisodes: row.total_episodes,
      detailCompleted: row.last_succeeded_at != null,
    };
  }

  function findSubjectForMatching(bangumiId) {
    return subjectFromRow(findSubjectStatement.get(bangumiId));
  }

  function listSubjectsForMatching() {
    return sqlite.prepare(`
      SELECT s.bangumi_id
      FROM bangumi_subjects s
      ORDER BY s.bangumi_id
    `).all().map(({ bangumi_id: bangumiId }) => findSubjectForMatching(bangumiId));
  }

  function sourceItemFromRow(row) {
    if (!row) return null;
    const episodeCount = Number(row.episode_count);
    return {
      sourceKey: row.source_key,
      sourceItemId: row.source_item_id,
      title: row.title,
      aliases: sourceAliasesStatement.all(row.source_key, row.source_item_id).map(({ alias }) => alias),
      year: row.year,
      episodeCount,
      detailCompleted: row.detail_fetched_at != null && episodeCount > 0,
    };
  }

  function findSourceItemForMatching({ sourceKey, sourceItemId }) {
    return sourceItemFromRow(findSourceItemStatement.get(sourceKey, sourceItemId));
  }

  function listSourceItemsForMatching({ sourceKey }) {
    return sqlite.prepare(`
      SELECT source_item_id FROM source_items
      WHERE source_key = ? ORDER BY source_item_id
    `).all(sourceKey).map(({ source_item_id: sourceItemId }) => (
      findSourceItemForMatching({ sourceKey, sourceItemId })
    ));
  }

  function isSourceInitialized(sourceKey) {
    return !!sqlite.prepare(`
      SELECT 1 FROM source_sync_state
      WHERE source_key = ? AND initialized = 1
    `).get(sourceKey);
  }

  function hasExclusion({ bangumiId, sourceKey, sourceItemId }) {
    return !!hasExclusionStatement.get(bangumiId, sourceKey, sourceItemId);
  }

  function insertExclusion(exclusion) {
    return insertExclusionStatement.run(exclusion).changes;
  }

  function deleteExclusionsForSubject({ bangumiId, sourceKey }) {
    return sqlite.prepare(`
      DELETE FROM auto_match_exclusions
      WHERE bangumi_id = ? AND source_key = ?
    `).run(bangumiId, sourceKey).changes;
  }

  function deleteExclusionsForSourceItem({ sourceKey, sourceItemId }) {
    return sqlite.prepare(`
      DELETE FROM auto_match_exclusions
      WHERE source_key = ? AND source_item_id = ?
    `).run(sourceKey, sourceItemId).changes;
  }

  function upsertSchedule(schedule) {
    const parsed = parseAirDate(schedule.eligibleOn);
    if (!parsed || parsed.precision !== "day" || parsed.value !== schedule.eligibleOn) {
      throw new TypeError("eligible_on must be a canonical complete date");
    }
    return upsertScheduleStatement.run(schedule).changes;
  }

  function deleteSchedule({ bangumiId, sourceKey }) {
    return sqlite.prepare(`
      DELETE FROM auto_match_schedule
      WHERE bangumi_id = ? AND source_key = ?
    `).run(bangumiId, sourceKey).changes;
  }

  function listDueSchedules({ sourceKey = null, today }) {
    const rows = sourceKey == null
      ? sqlite.prepare(`
        SELECT * FROM auto_match_schedule
        WHERE eligible_on <= ?
        ORDER BY eligible_on, source_key, bangumi_id
      `).all(today)
      : sqlite.prepare(`
        SELECT * FROM auto_match_schedule
        WHERE source_key = ? AND eligible_on <= ?
        ORDER BY eligible_on, bangumi_id
      `).all(sourceKey, today);
    return rows.map(scheduleFromRow);
  }

  function listSchedulesForSubject(bangumiId) {
    return sqlite.prepare(`
      SELECT * FROM auto_match_schedule
      WHERE bangumi_id = ? ORDER BY source_key
    `).all(bangumiId).map(scheduleFromRow);
  }

  return Object.freeze({
    transaction,
    findMapping,
    listMappingsForSource,
    listMappingsForSourceItem,
    hasSourceItemMapping,
    insertMapping,
    deleteMapping,
    findSubjectForMatching,
    listSubjectsForMatching,
    findSourceItemForMatching,
    listSourceItemsForMatching,
    isSourceInitialized,
    hasExclusion,
    insertExclusion,
    deleteExclusionsForSubject,
    deleteExclusionsForSourceItem,
    upsertSchedule,
    deleteSchedule,
    listDueSchedules,
    listSchedulesForSubject,
  });
}
