export function createMetadataEnsureService({ repository, clock = () => new Date(), wake = () => {} }) {
  return {
    ensure(ids) {
      const normalized = [...new Set(ids)]
        .filter((id) => Number.isInteger(id) && id > 0)
        .sort((a, b) => a - b);
      if (normalized.length === 0) {
        return { ensuredIds: [], newlyDueIds: [], dueIds: [] };
      }

      const result = repository.ensureRefreshIds(normalized, {
        now: clock().toISOString(),
      });
      if (result.dueIds.length > 0) wake();
      return result;
    },
  };
}
