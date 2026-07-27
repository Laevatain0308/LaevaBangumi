import { classifyAirDate } from "./airDateEligibility.js";

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function shanghaiToday(now) {
  return shanghaiDateFormatter.format(now);
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function createScheduleService({
  repository,
  matchSubject,
  sourceKeys = [],
  clock = () => new Date(),
} = {}) {
  if (!repository || typeof matchSubject !== "function") {
    throw new TypeError("schedule service requires a repository and matchSubject");
  }
  const sources = Object.freeze([...new Set(sourceKeys)].sort());

  function reconcilePair({ subject, sourceKey }) {
    const identity = { bangumiId: subject?.bangumiId, sourceKey };
    if (!subject?.detailCompleted) {
      repository.deleteSchedule(identity);
      return { status: "detail_incomplete" };
    }
    if (repository.findMapping(identity)) {
      repository.deleteSchedule(identity);
      return { status: "skipped", reason: "already_mapped" };
    }

    const airing = classifyAirDate(subject.airDate, clock());
    if (airing.kind === "scheduled") {
      repository.upsertSchedule({ ...identity, eligibleOn: airing.eligibleOn });
      return { status: "scheduled", eligibleOn: airing.eligibleOn };
    }
    if (airing.kind !== "aired") {
      repository.deleteSchedule(identity);
      return { status: "unknown" };
    }
    if (!repository.isSourceInitialized(sourceKey)) {
      return { status: "deferred", reason: "source_uninitialized" };
    }

    try {
      const result = matchSubject(identity);
      if (!["mapped", "unmatched", "skipped"].includes(result?.status)) {
        throw new Error("matcher returned an invalid status");
      }
      repository.deleteSchedule(identity);
      return result;
    } catch (cause) {
      return { status: "failed", error: errorMessage(cause) };
    }
  }

  function reconcileSubject({ bangumiId }) {
    const subject = repository.findSubjectForMatching(bangumiId);
    const results = sources.map((sourceKey) => ({
      sourceKey,
      ...reconcilePair({ subject: subject ?? { bangumiId, detailCompleted: false }, sourceKey }),
    }));
    return { bangumiId, sources: results };
  }

  function reconcileSource({ sourceKey }) {
    if (!sources.includes(sourceKey)) throw new TypeError(`unknown source key: ${sourceKey}`);
    const subjects = repository.listSubjectsForMatching()
      .slice()
      .sort((left, right) => left.bangumiId - right.bangumiId)
      .map((subject) => ({
        bangumiId: subject.bangumiId,
        ...reconcilePair({ subject, sourceKey }),
      }));
    return { sourceKey, subjects };
  }

  function runDue({ sourceKey = null } = {}) {
    if (sourceKey != null && !sources.includes(sourceKey)) {
      throw new TypeError(`unknown source key: ${sourceKey}`);
    }
    const due = repository.listDueSchedules({ sourceKey, today: shanghaiToday(clock()) });
    const results = due.map((row) => ({
      ...row,
      ...reconcilePair({
        subject: repository.findSubjectForMatching(row.bangumiId)
          ?? { bangumiId: row.bangumiId, detailCompleted: false },
        sourceKey: row.sourceKey,
      }),
    }));
    return { processed: due.length, results };
  }

  return Object.freeze({ reconcileSubject, reconcileSource, runDue });
}
