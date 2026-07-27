import { classifyAirDate } from "./airDateEligibility.js";
import { buildTitlePool } from "./titleNormalizer.js";
import { AUTO_MATCH_MIN_GAP, AUTO_MATCH_MIN_NAME_SCORE } from "./config.js";

function ngrams(value, size) {
  const characters = [...value];
  if (characters.length <= size) return new Set([value]);
  return new Set(Array.from(
    { length: characters.length - size + 1 },
    (_, index) => characters.slice(index, index + size).join(""),
  ));
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function levenshteinRatio(left, right) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array(right.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    for (let index = 0; index <= right.length; index += 1) previous[index] = current[index];
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function rawNameScore(left, right) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  const containment = longer.includes(shorter) ? shorter.length / longer.length : 0;
  const gramSize = Math.min(3, Math.max(1, Math.min(left.length, right.length)));
  return Math.max(
    containment * 0.98,
    jaccard(ngrams(left, gramSize), ngrams(right, gramSize)) * 0.94,
    levenshteinRatio(left, right) * 0.96,
  );
}

function intersect(left, right) {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function setsConflict(left, right) {
  return left.size > 0 && right.size > 0 && !intersect(left, right);
}

function fullTitleExact(left, right) {
  return left.variants.some((leftVariant) => (
    right.variants.some((rightVariant) => leftVariant.text === rightVariant.text)
  ));
}

function year(value) {
  const match = String(value ?? "").match(/^\d{4}/);
  return match && match[0] !== "0000" ? Number(match[0]) : null;
}

function subjectPool(subject) {
  return buildTitlePool({
    primaryTitles: [subject.nameCn, subject.name].filter(Boolean),
    aliases: subject.aliases,
  });
}

function resourcePool(resource) {
  return buildTitlePool({ primaryTitles: [resource.title], aliases: resource.aliases });
}

export function createAutoMatcher({
  repository,
  mappingService,
  clock = () => new Date(),
  minNameScore = AUTO_MATCH_MIN_NAME_SCORE,
  minGap = AUTO_MATCH_MIN_GAP,
} = {}) {
  if (!repository || !mappingService) throw new TypeError("auto matcher requires repository and mapping service");
  if (typeof minNameScore !== "number" || minNameScore < 0 || minNameScore > 1) {
    throw new TypeError("minNameScore must be between 0 and 1");
  }
  if (typeof minGap !== "number" || minGap < 0 || minGap > 1) {
    throw new TypeError("minGap must be between 0 and 1");
  }

  function gapIsClear(ranked) {
    return ranked.length < 2 || ranked[0].score - ranked[1].score >= minGap;
  }

  function scoreNamePools(left, right) {
    let best = 0;
    for (const leftVariant of left.variants) {
      for (const rightVariant of right.variants) {
        const raw = rawNameScore(leftVariant.text, rightVariant.text);
        const roleWeight = raw === 1
          ? leftVariant.exactWeight * rightVariant.exactWeight
          : leftVariant.fuzzyWeight * rightVariant.fuzzyWeight;
        best = Math.max(best, raw * roleWeight);
      }
    }
    return Number(best.toFixed(6));
  }

  function pairEvaluation(subject, resource) {
    const left = subjectPool(subject);
    const right = resourcePool(resource);
    if (repository.hasExclusion({
      bangumiId: subject.bangumiId,
      sourceKey: resource.sourceKey,
      sourceItemId: resource.sourceItemId,
    })) return { ok: false, reason: "excluded" };

    const subjectYear = year(subject.airDate);
    const resourceYear = year(resource.year);
    if (subjectYear != null && resourceYear != null && subjectYear !== resourceYear) {
      return { ok: false, reason: "year_conflict" };
    }
    if ((subjectYear == null || resourceYear == null) && !fullTitleExact(left, right)) {
      return { ok: false, reason: "name_score_low" };
    }
    if (setsConflict(left.seasons, right.seasons)) return { ok: false, reason: "season_conflict" };
    if (
      setsConflict(left.parts, right.parts)
      || (left.parts.size === 0) !== (right.parts.size === 0)
    ) return { ok: false, reason: "part_ambiguous" };
    if (setsConflict(left.forms, right.forms)) return { ok: false, reason: "form_conflict" };
    if (
      Number.isInteger(subject.totalEpisodes)
      && subject.totalEpisodes > 0
      && resource.episodeCount > subject.totalEpisodes
    ) return { ok: false, reason: "episode_overflow" };

    const score = scoreNamePools(left, right);
    if (score < minNameScore) return { ok: false, reason: "name_score_low" };
    return { ok: true, score };
  }

  function eligibleSubject(bangumiId, sourceKey) {
    if (!repository.isSourceInitialized(sourceKey)) return { reason: "source_uninitialized" };
    const item = repository.findSubjectForMatching(bangumiId);
    if (!item || !item.detailCompleted) return { reason: "detail_incomplete" };
    if (repository.findMapping({ bangumiId, sourceKey })) return { reason: "bangumi_mapped" };
    const airing = classifyAirDate(item.airDate, clock());
    if (airing.kind === "scheduled") return { reason: "not_aired" };
    if (airing.kind !== "aired") return { reason: "air_date_unknown" };
    return { item };
  }

  function eligibleResources(sourceKey) {
    return repository.listSourceItemsForMatching({ sourceKey }).filter((item) => (
      item.detailCompleted
      && item.episodeCount > 0
      && !repository.hasSourceItemMapping({ sourceKey, sourceItemId: item.sourceItemId })
    ));
  }

  function eligibleSubjects(sourceKey) {
    return repository.listSubjectsForMatching().filter((item) => {
      if (!item.detailCompleted) return false;
      if (repository.findMapping({ bangumiId: item.bangumiId, sourceKey })) return false;
      return classifyAirDate(item.airDate, clock()).kind === "aired";
    });
  }

  function rankedResources(item, sourceKey) {
    const candidates = eligibleResources(sourceKey);
    if (candidates.length === 0) return { ranked: [], reason: "no_resource" };
    const evaluations = candidates.map((resource) => ({ resource, ...pairEvaluation(item, resource) }));
    const ranked = evaluations.filter(({ ok }) => ok)
      .sort((left, right) => right.score - left.score || left.resource.sourceItemId.localeCompare(right.resource.sourceItemId));
    if (ranked.length > 0) return { ranked, reason: null };
    return { ranked, reason: evaluations[0]?.reason ?? "no_resource" };
  }

  function rankedSubjects(resource) {
    const candidates = eligibleSubjects(resource.sourceKey);
    const evaluations = candidates.map((item) => ({ subject: item, ...pairEvaluation(item, resource) }));
    return evaluations.filter(({ ok }) => ok)
      .sort((left, right) => right.score - left.score || left.subject.bangumiId - right.subject.bangumiId);
  }

  function selectionForSubject(bangumiId, sourceKey) {
    const eligibility = eligibleSubject(bangumiId, sourceKey);
    if (!eligibility.item) return { reason: eligibility.reason };
    const forward = rankedResources(eligibility.item, sourceKey);
    if (forward.ranked.length === 0) return { reason: forward.reason };
    if (!gapIsClear(forward.ranked)) return { reason: "candidate_ambiguous" };
    const selected = forward.ranked[0].resource;
    const reverse = rankedSubjects(selected);
    if (
      reverse[0]?.subject.bangumiId !== bangumiId
      || !gapIsClear(reverse)
    ) return { reason: "candidate_ambiguous" };
    return { subject: eligibility.item, resource: selected };
  }

  function selectionForResource(sourceKey, sourceItemId) {
    if (!repository.isSourceInitialized(sourceKey)) return { reason: "source_uninitialized" };
    if (repository.hasSourceItemMapping({ sourceKey, sourceItemId })) return { reason: "source_item_mapped" };
    const item = repository.findSourceItemForMatching({ sourceKey, sourceItemId });
    if (!item?.detailCompleted || item.episodeCount <= 0) return { reason: "no_resource" };
    const reverse = rankedSubjects(item);
    if (reverse.length === 0) return { reason: "no_resource" };
    if (!gapIsClear(reverse)) return { reason: "candidate_ambiguous" };
    const selected = reverse[0].subject;
    const forward = rankedResources(selected, sourceKey);
    if (
      forward.ranked[0]?.resource.sourceItemId !== sourceItemId
      || !gapIsClear(forward.ranked)
    ) return { reason: "candidate_ambiguous" };
    return { subject: selected, resource: item };
  }

  function writeSelection(selection) {
    if (!selection.resource) return { status: "unmatched", reason: selection.reason };
    const input = {
      bangumiId: selection.subject.bangumiId,
      sourceKey: selection.resource.sourceKey,
      sourceItemId: selection.resource.sourceItemId,
    };
    const write = mappingService.createAutomaticMapping(input);
    if (write.status !== "created") return { status: "skipped", reason: write.reason };
    return { status: "mapped", ...input };
  }

  function matchSubject({ bangumiId, sourceKey }) {
    return writeSelection(selectionForSubject(bangumiId, sourceKey));
  }

  function matchSourceItem({ sourceKey, sourceItemId }) {
    return writeSelection(selectionForResource(sourceKey, sourceItemId));
  }

  function explainSubject({ bangumiId, sourceKey }) {
    const selection = selectionForSubject(bangumiId, sourceKey);
    return { reason: selection.resource ? "automatic_match_available" : selection.reason };
  }

  return Object.freeze({ matchSubject, matchSourceItem, explainSubject, scoreNamePools });
}
