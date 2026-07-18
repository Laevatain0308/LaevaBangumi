export function createMetadataRefreshWorker({ detailRefresher, batchSize = 100, logger = {} }) {
  const writeError = logger.error ?? (() => {});
  let activePromise = null;
  let wakeRequested = false;

  async function runLoop() {
    let result;
    do {
      wakeRequested = false;
      result = await detailRefresher.runDueBatch();
    } while (
      wakeRequested
      || (result.due === batchSize && result.settled > 0)
    );
    return result;
  }

  function startDrain() {
    let flight;
    flight = Promise.resolve()
      .then(runLoop)
      .finally(() => {
        if (activePromise !== flight) return;
        activePromise = null;
        if (wakeRequested) {
          startDrain().catch((error) => {
            writeError("bangumi-detail-refresh", "automatic restart failed", {
              message: error.message ?? String(error),
            });
          });
        }
      });
    activePromise = flight;
    return flight;
  }

  function wake() {
    wakeRequested = true;
    return activePromise ?? startDrain();
  }

  return {
    wake,
    drain: wake,
    state() {
      return { running: activePromise !== null, wakeRequested };
    },
  };
}
