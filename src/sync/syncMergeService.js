import {
  compareSyncVersions,
  normalizeEventIdentity,
  normalizeNewEvent,
  validateBatchContainer,
} from "./syncEventValidator.js";

function timestamp(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).getTime();
}

export function createSyncMergeService({
  repository,
  ensureMetadata = () => {},
  snapshotService = null,
  clock = () => new Date(),
  logger = {},
}) {
  const writeError = logger.error ?? (() => {});

  function merge({ accountId, deviceId, events }) {
    const receivedAtMs = timestamp(clock);
    const batch = validateBatchContainer(events);
    const identities = batch.map((event) => normalizeEventIdentity(event, {
      expectedDeviceId: deviceId,
    }));
    let acceptedEventIds;
    let duplicateEventIds;
    let acceptedEvents;

    repository.transaction(() => {
      const existing = repository.findExistingEventIds(
        accountId,
        identities.map(({ eventId }) => eventId),
      );
      const seen = new Set(existing);
      acceptedEventIds = [];
      duplicateEventIds = [];
      acceptedEvents = [];

      for (let index = 0; index < batch.length; index += 1) {
        const { eventId } = identities[index];
        if (seen.has(eventId)) {
          duplicateEventIds.push(eventId);
          continue;
        }
        const normalized = normalizeNewEvent(batch[index], { expectedDeviceId: deviceId, receivedAtMs });
        repository.insertEvent(accountId, normalized);
        seen.add(eventId);
        acceptedEventIds.push(eventId);
        acceptedEvents.push(normalized);
      }

      acceptedEvents.sort((left, right) => compareSyncVersions(left.version, right.version));
      for (const event of acceptedEvents) repository.applyEvent(accountId, event);
      repository.touchDevice(accountId, deviceId);
    });

    const metadataIds = [];
    const seenMetadataIds = new Set();
    for (const event of acceptedEvents) {
      if (event.bangumiId !== null && !seenMetadataIds.has(event.bangumiId)) {
        seenMetadataIds.add(event.bangumiId);
        metadataIds.push(event.bangumiId);
      }
    }
    if (metadataIds.length > 0) {
      try {
        ensureMetadata(metadataIds);
      } catch (error) {
        writeError("sync-metadata-ensure", "metadata registration failed", {
          message: error?.message ?? String(error),
        });
      }
    }

    const result = { acceptedEventIds, duplicateEventIds };
    if (snapshotService) result.snapshot = snapshotService.build(accountId);
    return result;
  }

  return { merge };
}
