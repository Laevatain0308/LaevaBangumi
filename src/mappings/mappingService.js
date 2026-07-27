export class MappingValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MappingValidationError";
    this.code = code;
  }
}

export class MappingConflictError extends Error {
  constructor(code = "mapping_changed", message = "mapping changed after it was read") {
    super(message);
    this.name = "MappingConflictError";
    this.code = code;
  }
}

function sameMapping(left, right) {
  if (left == null || right == null) return left === right;
  return left.bangumiId === right.bangumiId
    && left.sourceKey === right.sourceKey
    && left.sourceItemId === right.sourceItemId
    && left.sourceEpisodeStart === right.sourceEpisodeStart
    && left.sourceEpisodeEnd === right.sourceEpisodeEnd;
}

function normalizeMapping(value) {
  return {
    bangumiId: value.bangumiId,
    sourceKey: value.sourceKey,
    sourceItemId: value.sourceItemId,
    sourceEpisodeStart: value.sourceEpisodeStart ?? null,
    sourceEpisodeEnd: value.sourceEpisodeEnd ?? null,
  };
}

function validateInterval(mapping) {
  const { sourceEpisodeStart: start, sourceEpisodeEnd: end } = mapping;
  const oneToOne = start == null && end == null;
  const segmented = Number.isInteger(start)
    && start >= 1
    && (end == null || (Number.isInteger(end) && end >= start));
  if (!oneToOne && !segmented) {
    throw new MappingValidationError("invalid_interval", "invalid source episode interval");
  }
}

function validateFinalSourceItem(rows) {
  if (rows.length <= 1) return;
  if (rows.some((row) => row.sourceEpisodeStart == null)) {
    throw new MappingValidationError(
      "source_item_one_to_one_conflict",
      "one-to-one mapping cannot share a source item",
    );
  }
  const sorted = [...rows].sort((left, right) => (
    left.sourceEpisodeStart - right.sourceEpisodeStart || left.bangumiId - right.bangumiId
  ));
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (current.sourceEpisodeEnd == null) {
      throw new MappingValidationError(
        "open_segment_not_last",
        "open source episode segment must be last",
      );
    }
    if (next.sourceEpisodeStart <= current.sourceEpisodeEnd) {
      throw new MappingValidationError("interval_overlap", "source episode intervals overlap");
    }
  }
}

export function createMappingService({ repository } = {}) {
  if (!repository?.transaction) throw new TypeError("mapping service requires a repository");

  function assertReference(mapping) {
    if (!repository.findSubjectForMatching(mapping.bangumiId)) {
      throw new MappingValidationError("missing_reference", "Bangumi subject does not exist");
    }
    if (!repository.findSourceItemForMatching({
      sourceKey: mapping.sourceKey,
      sourceItemId: mapping.sourceItemId,
    })) {
      throw new MappingValidationError("missing_reference", "resource source item does not exist");
    }
  }

  function clearStaleExclusions(mapping) {
    repository.deleteExclusionsForSubject({
      bangumiId: mapping.bangumiId,
      sourceKey: mapping.sourceKey,
    });
    repository.deleteExclusionsForSourceItem({
      sourceKey: mapping.sourceKey,
      sourceItemId: mapping.sourceItemId,
    });
  }

  function createAutomaticMapping({ bangumiId, sourceKey, sourceItemId }) {
    return repository.transaction(() => {
      if (repository.findMapping({ bangumiId, sourceKey })) {
        return { status: "skipped", reason: "bangumi_mapped" };
      }
      if (repository.hasSourceItemMapping({ sourceKey, sourceItemId })) {
        return { status: "skipped", reason: "source_item_mapped" };
      }
      if (repository.hasExclusion({ bangumiId, sourceKey, sourceItemId })) {
        return { status: "skipped", reason: "excluded" };
      }
      const mapping = normalizeMapping({ bangumiId, sourceKey, sourceItemId });
      assertReference(mapping);
      repository.insertMapping(mapping);
      clearStaleExclusions(mapping);
      return { status: "created" };
    });
  }

  function applyManualGroup({ expectedMappings = [], removals = [], upserts = [] }) {
    const normalizedUpserts = upserts.map(normalizeMapping);
    normalizedUpserts.forEach(validateInterval);
    const bangumiKeys = new Set();
    for (const mapping of normalizedUpserts) {
      const key = `${mapping.sourceKey}\0${mapping.bangumiId}`;
      if (bangumiKeys.has(key)) {
        throw new MappingValidationError("invalid_interval", "manual group has duplicate Bangumi mappings");
      }
      bangumiKeys.add(key);
    }

    return repository.transaction(() => {
      for (const expected of expectedMappings) {
        const current = repository.findMapping({
          bangumiId: expected.bangumiId,
          sourceKey: expected.sourceKey,
        });
        const normalizedExpected = expected.mapping == null ? null : normalizeMapping(expected.mapping);
        if (!sameMapping(current, normalizedExpected)) throw new MappingConflictError();
      }

      const removedPairs = new Map();
      const affectedSourceItems = new Map();
      const rememberSourceItem = ({ sourceKey, sourceItemId }) => {
        affectedSourceItems.set(`${sourceKey}\0${sourceItemId}`, { sourceKey, sourceItemId });
      };
      const removeCurrent = ({ bangumiId, sourceKey }) => {
        const current = repository.findMapping({ bangumiId, sourceKey });
        if (!current) return;
        repository.deleteMapping({ bangumiId, sourceKey });
        removedPairs.set(
          `${current.bangumiId}\0${current.sourceKey}\0${current.sourceItemId}`,
          current,
        );
        rememberSourceItem(current);
      };

      for (const removal of removals) removeCurrent(removal);
      for (const mapping of normalizedUpserts) {
        assertReference(mapping);
        removeCurrent(mapping);
        rememberSourceItem(mapping);

        const occupants = repository.listMappingsForSourceItem({
          sourceKey: mapping.sourceKey,
          sourceItemId: mapping.sourceItemId,
        });
        if (mapping.sourceEpisodeStart == null && occupants.some((row) => row.sourceEpisodeStart != null)) {
          throw new MappingValidationError(
            "source_item_segment_conflict",
            "one-to-one mapping cannot replace segmented mappings",
          );
        }
        const oneToOneOccupants = occupants.filter((row) => row.sourceEpisodeStart == null);
        for (const occupant of oneToOneOccupants) removeCurrent(occupant);
        repository.insertMapping(mapping);
      }

      for (const sourceItem of affectedSourceItems.values()) {
        validateFinalSourceItem(repository.listMappingsForSourceItem(sourceItem));
      }

      for (const removed of removedPairs.values()) {
        const pairStillExists = repository.listMappingsForSourceItem({
          sourceKey: removed.sourceKey,
          sourceItemId: removed.sourceItemId,
        }).some((mapping) => mapping.bangumiId === removed.bangumiId);
        const subjectFree = repository.findMapping({
          bangumiId: removed.bangumiId,
          sourceKey: removed.sourceKey,
        }) == null;
        const sourceFree = !repository.hasSourceItemMapping({
          sourceKey: removed.sourceKey,
          sourceItemId: removed.sourceItemId,
        });
        if (!pairStillExists && subjectFree && sourceFree) repository.insertExclusion(removed);
      }
      for (const mapping of normalizedUpserts) clearStaleExclusions(mapping);

      return {
        status: "applied",
        removed: removals.length,
        upserted: normalizedUpserts.length,
      };
    });
  }

  return Object.freeze({ createAutomaticMapping, applyManualGroup });
}
