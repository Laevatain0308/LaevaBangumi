import { getEnabledSources } from "../lib/cstationConfig.js";
import {
  listEpisodeSubjectSourceRows,
  listManualResourceStates,
  listManualResourceStatesForSubject,
  listResourceMappings,
  listResourceMappingsWithEpisodePresenceForSubject,
  listRetryStateForSubject,
  listRetryStatesByKind,
} from "../repositories/resourceRepository.js";
import {
  MANUAL_MATCH_BLOCKING_STATUSES,
  MANUAL_NO_DATA_STATUSES,
  MAX_RETRIES,
  now,
  retryStateRowToFacade,
} from "./animeShared.js";

export function getEnabledSourceKeys(sourceKeys = null) {
  if (sourceKeys) return sourceKeys;
  return getEnabledSources().map((source) => source.key);
}

export function enabledSourceSet(sourceKeys = null) {
  return new Set(getEnabledSourceKeys(sourceKeys));
}

export function mappedAnimeSourceKeys(sourceKeys) {
  const keys = new Set();
  for (const row of listResourceMappings({ sourceKeys })) {
    keys.add(`${row.bangumi_id}:${row.source}`);
  }
  return keys;
}

export function episodeAnimeSourceKeys(sourceKeys) {
  const keys = new Set();
  for (const row of listEpisodeSubjectSourceRows({ sourceKeys })) {
    keys.add(`${row.bangumi_id}:${row.source}`);
  }
  return keys;
}

export function retryStateByAnimeSource(sourceKeys) {
  return new Map(
    listRetryStatesByKind("mapping", { sourceKeys })
      .map(retryStateRowToFacade)
      .map((row) => [`${row.animeId}:${row.source}`, row])
  );
}

export function manualBlockingKeys(sourceKeys) {
  const stateByKey = new Map();
  for (const row of listManualResourceStates({ sourceKeys })) {
    stateByKey.set(`${row.bangumi_id}:${row.source}`, row.status);
  }
  return new Set(
    [...stateByKey.entries()]
      .filter(([, status]) => MANUAL_MATCH_BLOCKING_STATUSES.has(status))
      .map(([key]) => key)
  );
}

export function resourceSourceStatuses(id) {
  const mappings = listResourceMappingsWithEpisodePresenceForSubject(id);
  const retries = listRetryStateForSubject(id, "mapping");
  const manualRows = listManualResourceStatesForSubject(id);

  const mappedBySource = new Map(mappings.map((row) => [row.source, row]));
  const retryBySource = new Map(retries.map((row) => [row.source, row]));
  const manualBySource = new Map(
    manualRows
      .filter((row) => MANUAL_MATCH_BLOCKING_STATUSES.has(row.status))
      .map((row) => [row.source, row])
  );
  const nowTs = now();

  return getEnabledSources().map((source) => {
    const mapped = mappedBySource.get(source.key);
    const retry = retryBySource.get(source.key);
    const manual = manualBySource.get(source.key);
    const retryCount = retry?.retry_count ?? 0;
    const retrying = retry?.retry_at && retry.retry_at > nowTs;
    let status = "matching";
    if (mapped?.has_episodes) status = "ready";
    else if (!mapped && manual?.status === "wait_airing") status = "wait_airing";
    else if (!mapped && manual && MANUAL_NO_DATA_STATUSES.has(manual.status)) status = "no_data";
    else if (retryCount >= MAX_RETRIES) status = "no_data";
    else if (retrying) status = "retrying";
    else if (mapped) status = "fetching";

    const note = manual?.status === "wait_airing"
      ? manual.note
      : (manual && MANUAL_NO_DATA_STATUSES.has(manual.status)) || retryCount >= MAX_RETRIES
        ? "no mapping after retries"
        : null;

    return {
      source: source.key,
      name: source.name,
      status,
      sourceAid: mapped?.source_aid ?? null,
      note,
    };
  });
}
