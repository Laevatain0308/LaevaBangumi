import { normalizeSubject } from "./normalizer.js";
import { validateAnimeSubject, validateCalendarPayload } from "./validation.js";

const CALENDAR_STALE_MS = 24 * 60 * 60 * 1000;

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function createBangumiCalendarService({
  client,
  repository,
  clock = () => new Date(),
  logger = {},
}) {
  const writeLog = logger.log ?? (() => {});
  const writeError = logger.error ?? (() => {});

  async function sync() {
    const now = iso(clock());
    writeLog("bangumi-calendar", "sync started", { attemptedAt: now });
    try {
      const response = await client.getCalendar();
      const days = validateCalendarPayload(response);
      const entries = [];
      let received = 0;
      let filtered = 0;
      let rejected = 0;

      for (const day of days) {
        for (const item of day.items) {
          received += 1;
          if (typeof item?.type === "number" && item.type !== 2) {
            filtered += 1;
            continue;
          }
          try {
            validateAnimeSubject(item);
            entries.push({ metadata: normalizeSubject(item, { weekday: day.weekday }), weekday: day.weekday });
          } catch (error) {
            rejected += 1;
            writeError("bangumi-calendar", "item rejected", {
              id: item?.id ?? null,
              path: error.path ?? null,
              message: error.message,
            });
          }
        }
      }

      repository.replaceCalendarSnapshot(entries, { now });
      const result = {
        received,
        persisted: entries.length,
        filtered,
        rejected,
        members: entries.length,
      };
      writeLog("bangumi-calendar", "sync completed", result);
      return result;
    } catch (error) {
      repository.recordCalendarSyncFailure({ now, error: error.message ?? String(error) });
      writeError("bangumi-calendar", "sync failed", { message: error.message ?? String(error) });
      throw error;
    }
  }

  function isStale(now = clock()) {
    const state = repository.findCalendarSyncState();
    if (!state?.lastSucceededAt) return true;
    return new Date(now).getTime() - new Date(state.lastSucceededAt).getTime() >= CALENDAR_STALE_MS;
  }

  return { sync, isStale };
}
