import { collectBangumiTitles, normalizeTitle, rankMatches } from "./matcher.js";

const DEFAULT_LIMIT = 20;
const MIN_RECALL_SCORE = 0.28;

function yearFromDate(value) {
  const match = String(value || "").match(/^(19|20)\d{2}/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function subjectTitles(subject) {
  return collectBangumiTitles({
    name: subject.name,
    name_cn: subject.nameCn ?? subject.name_cn,
    aliases: subject.aliases ?? [],
  });
}

function compactCore(value) {
  return normalizeTitle(value)
    .replace(/第?[0-9一二三四五六七八九十]+(?:季|期|部|章|部分|クール)/g, "")
    .replace(/(?:season|s)\s*\d+/gi, "")
    .replace(/(?:part|cour)\s*\d+/gi, "")
    .replace(/(?:第)?[0-9]+(?:st|nd|rd|th)?season/gi, "")
    .replace(/(?:ova|oad|sp|special|剧场版|劇場版|特别篇|特別篇|剪辑版|總集編|总集篇|合集|全集)/gi, "");
}

function titleTokens(values) {
  const tokens = new Set();
  for (const value of values) {
    const normalized = normalizeTitle(value);
    if (normalized.length >= 2) tokens.add(normalized);
    const core = compactCore(value);
    if (core.length >= 2) tokens.add(core);
    for (let i = 0; i < core.length - 1; i++) {
      const token = core.slice(i, i + Math.min(4, core.length - i));
      if (token.length >= 2) tokens.add(token);
    }
  }
  return tokens;
}

function collectSourceText(item) {
  return [item.name, item.title, item.subname, item.subtitle].filter(Boolean).join(" / ");
}

function boostForTokenOverlap(subject, item) {
  const titles = subjectTitles(subject);
  const tokens = titleTokens(titles);
  const sourceText = normalizeTitle(collectSourceText(item));
  if (!sourceText) return 0;
  let best = 0;
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (sourceText.includes(token)) best = Math.max(best, Math.min(0.24, token.length / 40));
  }
  return best;
}

function normalizeCandidateItem(item) {
  return {
    id: item.id ?? item.sourceAid ?? item.source_aid,
    sourceAid: item.sourceAid ?? item.source_aid ?? item.id,
    name: item.name ?? item.title,
    subname: item.subname ?? item.subtitle,
    year: item.year,
    category: item.category,
    last: item.last ?? item.latest_text,
    detailFetchedAt: item.detailFetchedAt ?? item.detail_fetched_at,
  };
}

export function recallResourceCandidates(subject, resourceItems, {
  limit = DEFAULT_LIMIT,
  minScore = MIN_RECALL_SCORE,
} = {}) {
  const normalizedItems = resourceItems.map(normalizeCandidateItem).filter((item) => item.sourceAid != null && item.name);
  const titles = subjectTitles(subject);
  const ranked = rankMatches(titles, yearFromDate(subject.airDate ?? subject.air_date), normalizedItems, {
    limit: Math.max(limit * 4, limit),
    minScore: 0,
  });
  const byAid = new Map();

  for (const match of ranked) {
    const boostedScore = Math.min(1, match.score + boostForTokenOverlap(subject, match.video));
    if (boostedScore < minScore) continue;
    byAid.set(match.video.sourceAid, {
      sourceAid: match.video.sourceAid,
      title: match.video.name,
      subtitle: match.video.subname ?? null,
      year: match.video.year ?? null,
      category: match.video.category ?? null,
      latestText: match.video.last ?? null,
      detailFetchedAt: match.video.detailFetchedAt ?? null,
      score: Number(boostedScore.toFixed(6)),
      baseScore: Number(match.score.toFixed(6)),
      matchedSubjectTitle: match.matchedName,
      matchedResourceTitle: match.matchedSourceName,
    });
  }

  return [...byAid.values()]
    .sort((a, b) => b.score - a.score || a.sourceAid - b.sourceAid)
    .slice(0, limit);
}

