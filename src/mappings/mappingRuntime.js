import cronModule from "node-cron";
import { createMappingRepository } from "./mappingRepository.js";
import { createMappingService } from "./mappingService.js";
import { createAutoMatcher } from "./autoMatcher.js";
import { createScheduleService } from "./scheduleService.js";
import { AUTO_MATCH_SCHEDULE_CRON, AUTO_MATCH_TIMEZONE } from "./config.js";

function validBangumiIds(ids) {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
}

function validSourceItemIds(ids) {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
}

export function createMappingRuntime({
  sqlite,
  sourceKeys = [],
  cron = cronModule,
  clock = () => new Date(),
  logger = {},
  repository: repositoryOverride,
  mappingService: mappingServiceOverride,
  autoMatcher: autoMatcherOverride,
  scheduleService: scheduleServiceOverride,
} = {}) {
  const writeError = logger.error ?? (() => {});
  const sources = Object.freeze([...new Set(sourceKeys)].sort());
  const repository = repositoryOverride ?? createMappingRepository({ sqlite });
  const mappingService = mappingServiceOverride ?? createMappingService({ repository });
  const autoMatcher = autoMatcherOverride ?? createAutoMatcher({ repository, mappingService, clock });
  const scheduleService = scheduleServiceOverride ?? createScheduleService({
    repository,
    matchSubject: autoMatcher.matchSubject,
    sourceKeys: sources,
    clock,
  });

  async function onSubjectsPersisted(ids) {
    let failed = 0;
    const uniqueIds = validBangumiIds(Array.isArray(ids) ? ids : []);
    for (const bangumiId of uniqueIds) {
      try {
        await scheduleService.reconcileSubject({ bangumiId });
      } catch (error) {
        failed += 1;
        writeError("anime-resource-mapping", "subject reconciliation failed", {
          bangumiId,
          message: error.message ?? String(error),
        });
      }
    }
    return { processed: uniqueIds.length, failed };
  }

  function onDetailPersisted(bangumiId) {
    return onSubjectsPersisted([bangumiId]);
  }

  async function onSourceSynchronized({ sourceKey, operation, changedItemIds = [] }) {
    if (!sources.includes(sourceKey)) throw new TypeError(`unknown source key: ${sourceKey}`);
    if (operation === "initialize") {
      try {
        await scheduleService.reconcileSource({ sourceKey });
        return { sourceKey, operation, processed: 1, failed: 0 };
      } catch (error) {
        writeError("anime-resource-mapping", "source reconciliation failed", {
          sourceKey,
          message: error.message ?? String(error),
        });
        return { sourceKey, operation, processed: 1, failed: 1 };
      }
    }
    if (operation !== "update") throw new TypeError(`unknown source operation: ${operation}`);

    let failed = 0;
    const ids = validSourceItemIds(Array.isArray(changedItemIds) ? changedItemIds : []);
    for (const sourceItemId of ids) {
      try {
        await autoMatcher.matchSourceItem({ sourceKey, sourceItemId });
      } catch (error) {
        failed += 1;
        writeError("anime-resource-mapping", "source item matching failed", {
          sourceKey,
          sourceItemId,
          message: error.message ?? String(error),
        });
      }
    }
    return { sourceKey, operation, processed: ids.length, failed };
  }

  async function startup() {
    const due = await scheduleService.runDue();
    const initializedSources = [];
    for (const sourceKey of sources) {
      if (!repository.isSourceInitialized(sourceKey)) continue;
      await scheduleService.reconcileSource({ sourceKey });
      initializedSources.push(sourceKey);
    }
    return { due, initializedSources };
  }

  function start() {
    const task = cron.schedule(AUTO_MATCH_SCHEDULE_CRON, async () => {
      try {
        await scheduleService.runDue();
      } catch (error) {
        writeError("anime-resource-mapping", "scheduled due reconciliation failed", {
          message: error.message ?? String(error),
        });
      }
    }, { timezone: AUTO_MATCH_TIMEZONE });
    return [task];
  }

  return Object.freeze({
    repository,
    mappingService,
    autoMatcher,
    scheduleService,
    onSubjectsPersisted,
    onDetailPersisted,
    onSourceSynchronized,
    startup,
    start,
  });
}
