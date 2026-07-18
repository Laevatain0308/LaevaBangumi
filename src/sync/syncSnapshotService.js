function timestamp(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).getTime();
}

export function createSyncSnapshotService({
  syncRepository,
  summaryRepository,
  ensureMetadata = () => {},
  clock = () => new Date(),
  logger = {},
}) {
  const writeError = logger.error ?? (() => {});

  function build(accountId) {
    const watchRows = syncRepository.listWatchRecords(accountId);
    const progressRows = syncRepository.listWatchProgress(accountId);
    const collectionRows = syncRepository.listCollectionRecords(accountId);
    const allIds = [...new Set([
      ...watchRows.map(({ bangumiId }) => bangumiId),
      ...collectionRows.map(({ bangumiId }) => bangumiId),
    ])].sort((left, right) => left - right);
    const summaries = summaryRepository.findByIds(allIds);
    const progresses = new Map();
    for (const row of progressRows) {
      if (!progresses.has(row.bangumiId)) progresses.set(row.bangumiId, {});
      progresses.get(row.bangumiId)[String(row.episode)] = {
        episode: row.episode,
        road: row.road,
        progressMs: row.progressMs,
        version: row.progressVersion,
      };
    }

    const snapshot = {
      generatedAt: timestamp(clock),
      watch: {
        clearVersion: syncRepository.findWatchClearVersion(accountId),
        records: watchRows.map((row) => ({
          bangumiId: row.bangumiId,
          lastWatchEpisode: row.lastWatchEpisode,
          lastWatchTime: row.lastWatchTime,
          lastWatchEpisodeName: row.lastWatchEpisodeName,
          recordVersion: row.recordVersion,
          progresses: progresses.get(row.bangumiId) ?? {},
          subject: summaries.get(row.bangumiId) ?? null,
        })),
      },
      collection: {
        clearVersion: syncRepository.findCollectionClearVersion(accountId),
        records: collectionRows.map((row) => ({
          bangumiId: row.bangumiId,
          type: row.type,
          collectedAt: row.collectedAt,
          updatedAt: row.updatedAt,
          recordVersion: row.recordVersion,
          subject: summaries.get(row.bangumiId) ?? null,
        })),
      },
    };

    if (allIds.length > 0) {
      try {
        ensureMetadata(allIds);
      } catch (error) {
        writeError("sync-snapshot-metadata-ensure", "metadata registration failed", {
          message: error?.message ?? String(error),
        });
      }
    }
    return snapshot;
  }

  return { build };
}
