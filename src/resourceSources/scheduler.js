export const RESOURCE_SOURCE_SYNC_CRON_EXPRESSION = "0 */6 * * *";

export function createResourceSourceScheduler({
  registry,
  cron,
  logger,
  onSynchronized = () => {},
} = {}) {
  if (!registry || typeof registry.list !== "function") {
    throw new TypeError("resource source scheduler requires a registry");
  }
  if (!cron || typeof cron.schedule !== "function") {
    throw new TypeError("resource source scheduler requires cron");
  }
  const writeLog = logger?.log ?? (() => {});
  const writeError = logger?.error ?? (() => {});
  const running = new Set();

  async function run(operation, trigger) {
    const results = [];
    for (const source of registry.list()) {
      const sourceKey = source.sourceKey;
      if (running.has(sourceKey)) {
        writeLog("resource-source", `${operation} skipped because source is running`, {
          sourceKey,
          trigger,
        });
        results.push({ sourceKey, status: "skipped", reason: "source_running" });
        continue;
      }

      running.add(sourceKey);
      writeLog("resource-source", `${operation} started`, { sourceKey, trigger });
      try {
        const value = await source[operation]();
        results.push({ sourceKey, status: "fulfilled", value });
        writeLog("resource-source", `${operation} completed`, { sourceKey, trigger, value });
        try {
          await onSynchronized({
            sourceKey,
            operation,
            changedItemIds: value?.changedItemIds ?? [],
          });
        } catch (error) {
          writeError("resource-source", "synchronization callback failed", {
            sourceKey,
            operation,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (error) {
        results.push({ sourceKey, status: "rejected", reason: error });
        writeError("resource-source", `${operation} failed`, {
          sourceKey,
          trigger,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        running.delete(sourceKey);
      }
    }
    return results;
  }

  function runInitializations(trigger = "manual") {
    return run("initialize", trigger);
  }

  function runUpdates(trigger = "scheduled") {
    return run("update", trigger);
  }

  function start() {
    const task = cron.schedule(RESOURCE_SOURCE_SYNC_CRON_EXPRESSION, async () => {
      try {
        await runUpdates("cron");
      } catch (error) {
        writeError("resource-source", "scheduled registry update failed", error);
      }
    });
    return [task];
  }

  function state() {
    return { runningSourceKeys: [...running] };
  }

  return Object.freeze({ start, runInitializations, runUpdates, state });
}
