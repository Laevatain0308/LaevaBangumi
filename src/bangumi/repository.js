const SUBJECT_COLUMNS = {
  name: "name",
  nameCn: "name_cn",
  summary: "summary",
  airDate: "air_date",
  airWeekday: "air_weekday",
  platform: "platform",
  eps: "eps",
  totalEpisodes: "total_episodes",
  volumes: "volumes",
  series: "series",
  locked: "locked",
  nsfw: "nsfw",
};

const DETAIL_OWNED_SUBJECT_FIELDS = [
  "nameCn",
  "summary",
  "airDate",
  "platform",
  "eps",
  "totalEpisodes",
  "volumes",
  "series",
  "locked",
  "nsfw",
];

const IMAGE_COLUMNS = {
  largeUrl: "large_url",
  commonUrl: "common_url",
  mediumUrl: "medium_url",
  smallUrl: "small_url",
  gridUrl: "grid_url",
};

const COLLECTION_COLUMNS = {
  wish: "wish",
  collect: "collect",
  doing: "doing",
  onHold: "on_hold",
  dropped: "dropped",
};

function databaseValue(key, value) {
  if (["series", "locked", "nsfw"].includes(key) && value !== null) return value ? 1 : 0;
  return value;
}

function upsertSubject(sqlite, subject, now) {
  const values = { bangumi_id: subject.bangumiId, discovered_at: now, updated_at: now };
  for (const [key, column] of Object.entries(SUBJECT_COLUMNS)) {
    if (Object.hasOwn(subject, key)) values[column] = databaseValue(key, subject[key]);
  }

  const columns = Object.keys(values);
  const updateColumns = columns.filter((column) => !["bangumi_id", "discovered_at"].includes(column));
  sqlite.prepare(`
    INSERT INTO bangumi_subjects (${columns.join(", ")})
    VALUES (${columns.map((column) => `@${column}`).join(", ")})
    ON CONFLICT(bangumi_id) DO UPDATE SET
      ${updateColumns.map((column) => `${column} = excluded.${column}`).join(", ")}
  `).run(values);
}

function upsertPartialOneToOne(sqlite, { table, bangumiId, value, columns }) {
  if (value === null) {
    sqlite.prepare(`DELETE FROM ${table} WHERE bangumi_id = ?`).run(bangumiId);
    return;
  }
  const row = { bangumi_id: bangumiId };
  for (const [key, column] of Object.entries(columns)) {
    if (Object.hasOwn(value, key)) row[column] = value[key];
  }
  const names = Object.keys(row);
  const updates = names.filter((name) => name !== "bangumi_id");
  const conflict = updates.length > 0
    ? `DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(", ")}`
    : "DO NOTHING";
  sqlite.prepare(`
    INSERT INTO ${table} (${names.join(", ")})
    VALUES (${names.map((name) => `@${name}`).join(", ")})
    ON CONFLICT(bangumi_id) ${conflict}
  `).run(row);
}

function writeImages(sqlite, bangumiId, images) {
  upsertPartialOneToOne(sqlite, {
    table: "bangumi_subject_images",
    bangumiId,
    value: images,
    columns: IMAGE_COLUMNS,
  });
}

function writeRating(sqlite, bangumiId, rating) {
  if (rating === null) {
    sqlite.prepare("DELETE FROM bangumi_subject_rating WHERE bangumi_id = ?").run(bangumiId);
    return;
  }
  const value = { ...rating };
  delete value.counts;
  const columns = { score: "score", rank: "rank", total: "total" };
  if (Object.hasOwn(rating, "counts")) {
    rating.counts.forEach((count, index) => {
      const key = `count${index + 1}`;
      value[key] = count;
      columns[key] = `count_${index + 1}`;
    });
  }
  upsertPartialOneToOne(sqlite, {
    table: "bangumi_subject_rating",
    bangumiId,
    value,
    columns,
  });
}

function writeCollection(sqlite, bangumiId, collection) {
  upsertPartialOneToOne(sqlite, {
    table: "bangumi_subject_collection",
    bangumiId,
    value: collection,
    columns: COLLECTION_COLUMNS,
  });
}

function replaceTags(sqlite, bangumiId, tags) {
  sqlite.prepare("DELETE FROM bangumi_subject_tags WHERE bangumi_id = ?").run(bangumiId);
  if (!Array.isArray(tags)) return;
  const insert = sqlite.prepare(`
    INSERT INTO bangumi_subject_tags (bangumi_id, position, name, count, total_count)
    VALUES (@bangumiId, @position, @name, @count, @totalCount)
  `);
  for (const tag of tags) insert.run({ bangumiId, ...tag });
}

function replaceMetaTags(sqlite, bangumiId, tags) {
  sqlite.prepare("DELETE FROM bangumi_subject_meta_tags WHERE bangumi_id = ?").run(bangumiId);
  if (!Array.isArray(tags)) return;
  const insert = sqlite.prepare(`
    INSERT INTO bangumi_subject_meta_tags (bangumi_id, position, name)
    VALUES (@bangumiId, @position, @name)
  `);
  for (const tag of tags) insert.run({ bangumiId, ...tag });
}

function replaceInfobox(sqlite, bangumiId, infobox) {
  sqlite.prepare("DELETE FROM bangumi_subject_infobox_entries WHERE bangumi_id = ?").run(bangumiId);
  if (!Array.isArray(infobox)) return;
  const insertEntry = sqlite.prepare(`
    INSERT INTO bangumi_subject_infobox_entries (bangumi_id, entry_position, key, value_kind)
    VALUES (@bangumiId, @entryPosition, @key, @valueKind)
  `);
  const insertValue = sqlite.prepare(`
    INSERT INTO bangumi_subject_infobox_values (
      bangumi_id, entry_position, value_position, label, value
    ) VALUES (@bangumiId, @entryPosition, @valuePosition, @label, @value)
  `);
  for (const entry of infobox) {
    insertEntry.run({ bangumiId, ...entry });
    for (const value of entry.values) insertValue.run({ bangumiId, entryPosition: entry.entryPosition, ...value });
  }
}

function mergeSummaryInternal(sqlite, metadata, now) {
  const bangumiId = metadata.subject.bangumiId;
  upsertSubject(sqlite, metadata.subject, now);
  if (metadata.images !== undefined) writeImages(sqlite, bangumiId, metadata.images);
  if (metadata.rating !== undefined) writeRating(sqlite, bangumiId, metadata.rating);
  if (metadata.collection !== undefined) writeCollection(sqlite, bangumiId, metadata.collection);
  if (metadata.tags !== undefined) replaceTags(sqlite, bangumiId, metadata.tags);
  if (metadata.metaTags !== undefined) replaceMetaTags(sqlite, bangumiId, metadata.metaTags);
  if (metadata.infobox !== undefined) replaceInfobox(sqlite, bangumiId, metadata.infobox);
}

function detailSubject(metadata) {
  const subject = { bangumiId: metadata.subject.bangumiId, name: metadata.subject.name };
  for (const key of DETAIL_OWNED_SUBJECT_FIELDS) {
    subject[key] = Object.hasOwn(metadata.subject, key) ? metadata.subject[key] : null;
  }
  if (Object.hasOwn(metadata.subject, "airWeekday")) subject.airWeekday = metadata.subject.airWeekday;
  return subject;
}

function replaceDetailInternal(sqlite, metadata, { now, nextRefreshAt }) {
  const bangumiId = metadata.subject.bangumiId;
  upsertSubject(sqlite, detailSubject(metadata), now);
  writeImages(sqlite, bangumiId, metadata.images ?? null);
  writeRating(sqlite, bangumiId, metadata.rating ?? null);
  writeCollection(sqlite, bangumiId, metadata.collection ?? null);
  replaceTags(sqlite, bangumiId, metadata.tags ?? []);
  replaceMetaTags(sqlite, bangumiId, metadata.metaTags ?? []);
  replaceInfobox(sqlite, bangumiId, metadata.infobox ?? []);
  sqlite.prepare(`
    INSERT INTO bangumi_subject_refresh_state (
      bangumi_id, last_succeeded_at, next_refresh_at, last_attempted_at,
      consecutive_failures, last_error
    ) VALUES (?, ?, ?, ?, 0, NULL)
    ON CONFLICT(bangumi_id) DO UPDATE SET
      last_succeeded_at = excluded.last_succeeded_at,
      next_refresh_at = excluded.next_refresh_at,
      last_attempted_at = excluded.last_attempted_at,
      consecutive_failures = 0,
      last_error = NULL
  `).run(bangumiId, now, nextRefreshAt, now);
}

function subjectFromRow(row) {
  return {
    bangumiId: row.bangumi_id,
    name: row.name,
    nameCn: row.name_cn,
    summary: row.summary,
    airDate: row.air_date,
    airWeekday: row.air_weekday,
    platform: row.platform,
    eps: row.eps,
    totalEpisodes: row.total_episodes,
    volumes: row.volumes,
    series: row.series === null ? null : row.series === 1,
    locked: row.locked === null ? null : row.locked === 1,
    nsfw: row.nsfw === null ? null : row.nsfw === 1,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  };
}

function imagesFromRow(row) {
  if (!row) return null;
  return {
    largeUrl: row.large_url,
    commonUrl: row.common_url,
    mediumUrl: row.medium_url,
    smallUrl: row.small_url,
    gridUrl: row.grid_url,
  };
}

function ratingFromRow(row) {
  if (!row) return null;
  return {
    score: row.score,
    rank: row.rank,
    total: row.total,
    counts: Array.from({ length: 10 }, (_, index) => row[`count_${index + 1}`]),
  };
}

function collectionFromRow(row) {
  if (!row) return null;
  return {
    wish: row.wish,
    collect: row.collect,
    doing: row.doing,
    onHold: row.on_hold,
    dropped: row.dropped,
  };
}

function refreshStateFromRow(row) {
  if (!row) return null;
  return {
    bangumiId: row.bangumi_id,
    lastSucceededAt: row.last_succeeded_at,
    nextRefreshAt: row.next_refresh_at,
    lastAttemptedAt: row.last_attempted_at,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
  };
}

export function createBangumiRepository(sqlite) {
  const mergeSummaryTransaction = sqlite.transaction((metadata, { now }) => {
    mergeSummaryInternal(sqlite, metadata, now);
  });
  const mergeSearchTransaction = sqlite.transaction((items, { now }) => {
    for (const metadata of items) mergeSummaryInternal(sqlite, metadata, now);
  });
  const replaceDetailTransaction = sqlite.transaction((metadata, options) => {
    replaceDetailInternal(sqlite, metadata, options);
  });
  const replaceCalendarTransaction = sqlite.transaction((entries, { now }) => {
    for (const entry of entries) mergeSummaryInternal(sqlite, entry.metadata, now);
    sqlite.prepare("DELETE FROM bangumi_calendar_subjects").run();
    const insert = sqlite.prepare(`
      INSERT INTO bangumi_calendar_subjects (bangumi_id, weekday) VALUES (?, ?)
    `);
    for (const entry of entries) insert.run(entry.metadata.subject.bangumiId, entry.weekday);
    sqlite.prepare(`
      INSERT INTO bangumi_calendar_sync_state (
        singleton_id, last_succeeded_at, last_attempted_at, consecutive_failures, last_error
      ) VALUES (1, ?, ?, 0, NULL)
      ON CONFLICT(singleton_id) DO UPDATE SET
        last_succeeded_at = excluded.last_succeeded_at,
        last_attempted_at = excluded.last_attempted_at,
        consecutive_failures = 0,
        last_error = NULL
    `).run(now, now);
  });

  function findById(bangumiId) {
    const subjectRow = sqlite.prepare("SELECT * FROM bangumi_subjects WHERE bangumi_id = ?").get(bangumiId);
    if (!subjectRow) return null;
    const infoboxEntries = sqlite.prepare(`
      SELECT entry_position, key, value_kind
      FROM bangumi_subject_infobox_entries
      WHERE bangumi_id = ? ORDER BY entry_position
    `).all(bangumiId);
    const infoboxValues = sqlite.prepare(`
      SELECT entry_position, value_position, label, value
      FROM bangumi_subject_infobox_values
      WHERE bangumi_id = ? ORDER BY entry_position, value_position
    `).all(bangumiId);
    return {
      subject: subjectFromRow(subjectRow),
      images: imagesFromRow(sqlite.prepare("SELECT * FROM bangumi_subject_images WHERE bangumi_id = ?").get(bangumiId)),
      rating: ratingFromRow(sqlite.prepare("SELECT * FROM bangumi_subject_rating WHERE bangumi_id = ?").get(bangumiId)),
      collection: collectionFromRow(sqlite.prepare("SELECT * FROM bangumi_subject_collection WHERE bangumi_id = ?").get(bangumiId)),
      tags: sqlite.prepare(`
        SELECT position, name, count, total_count FROM bangumi_subject_tags
        WHERE bangumi_id = ? ORDER BY position
      `).all(bangumiId).map((row) => ({
        position: row.position,
        name: row.name,
        count: row.count,
        totalCount: row.total_count,
      })),
      metaTags: sqlite.prepare(`
        SELECT position, name FROM bangumi_subject_meta_tags
        WHERE bangumi_id = ? ORDER BY position
      `).all(bangumiId),
      infobox: infoboxEntries.map((entry) => ({
        entryPosition: entry.entry_position,
        key: entry.key,
        valueKind: entry.value_kind,
        values: infoboxValues
          .filter((value) => value.entry_position === entry.entry_position)
          .map((value) => ({
            valuePosition: value.value_position,
            label: value.label,
            value: value.value,
          })),
      })),
      refreshState: refreshStateFromRow(sqlite.prepare(`
        SELECT * FROM bangumi_subject_refresh_state WHERE bangumi_id = ?
      `).get(bangumiId)),
    };
  }

  function findCalendarSyncState() {
    const row = sqlite.prepare(`
      SELECT * FROM bangumi_calendar_sync_state WHERE singleton_id = 1
    `).get();
    if (!row) return null;
    return {
      lastSucceededAt: row.last_succeeded_at,
      lastAttemptedAt: row.last_attempted_at,
      consecutiveFailures: row.consecutive_failures,
      lastError: row.last_error,
    };
  }

  return {
    mergeSummary(metadata, options) {
      mergeSummaryTransaction(metadata, options);
      return findById(metadata.subject.bangumiId);
    },
    mergeSearchResults(items, options) {
      mergeSearchTransaction(items, options);
      return items.length;
    },
    replaceDetail(metadata, options) {
      replaceDetailTransaction(metadata, options);
      return findById(metadata.subject.bangumiId);
    },
    findById,
    hasCompletedDetail(bangumiId) {
      return !!sqlite.prepare(`
        SELECT 1 FROM bangumi_subject_refresh_state WHERE bangumi_id = ?
      `).get(bangumiId);
    },
    listDueRefreshIds({ now, limit }) {
      return sqlite.prepare(`
        SELECT bangumi_id, consecutive_failures
        FROM bangumi_subject_refresh_state
        WHERE next_refresh_at <= ?
        ORDER BY next_refresh_at, bangumi_id
        LIMIT ?
      `).all(now, limit).map((row) => ({
        bangumiId: row.bangumi_id,
        consecutiveFailures: row.consecutive_failures,
      }));
    },
    recordDetailRefreshFailure({ bangumiId, now, nextRefreshAt, error }) {
      sqlite.prepare(`
        UPDATE bangumi_subject_refresh_state SET
          last_attempted_at = ?,
          next_refresh_at = ?,
          consecutive_failures = consecutive_failures + 1,
          last_error = ?
        WHERE bangumi_id = ?
      `).run(now, nextRefreshAt, String(error), bangumiId);
      return refreshStateFromRow(sqlite.prepare(`
        SELECT * FROM bangumi_subject_refresh_state WHERE bangumi_id = ?
      `).get(bangumiId));
    },
    replaceCalendarSnapshot(entries, options) {
      replaceCalendarTransaction(entries, options);
      return entries.length;
    },
    findCalendarSyncState,
    recordCalendarSyncFailure({ now, error }) {
      sqlite.prepare(`
        INSERT INTO bangumi_calendar_sync_state (
          singleton_id, last_succeeded_at, last_attempted_at, consecutive_failures, last_error
        ) VALUES (1, NULL, ?, 1, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          last_attempted_at = excluded.last_attempted_at,
          consecutive_failures = bangumi_calendar_sync_state.consecutive_failures + 1,
          last_error = excluded.last_error
      `).run(now, String(error));
      return findCalendarSyncState();
    },
    listCalendarSubjects() {
      return sqlite.prepare(`
        SELECT bangumi_id, weekday FROM bangumi_calendar_subjects
        ORDER BY weekday, bangumi_id
      `).all().map((row) => ({
        weekday: row.weekday,
        ...findById(row.bangumi_id),
      }));
    },
  };
}
