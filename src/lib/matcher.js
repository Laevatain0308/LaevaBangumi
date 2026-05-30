const TITLE_SPLIT_RE = /[\/／|｜、,，;；\n\r]+/g;
const PUNCT_RE = /[\s"'`‘’“”「」『』（）()【】\[\]《》<>〈〉:：!！?？.。・·_-]+/g;
const NOISE_RE = /(先行上映|僅限港澳台地區|仅限港澳台地区|第\d+季合集|全集|合集|更至\d+集|更新至\d+集|完结|高清|BD|HD)/gi;
const GENERIC_TITLE_RE = /(19|20)\d{2}|(?:第?[0-9一二三四五六七八九十]+(?:季|期|部|章|シリーズ))|(?:第(?:一|二|三|四|五|六|七|八|九|十)季)|(?:season[0-9]+)|(?:(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|[0-9]+(?:st|nd|rd|th)?)season)|(?:动画版|動畫版|剧场版|劇場版|特别版|特別版|年番|合集|ova|web|tv|tva)/g;
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff]/;

export function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(NOISE_RE, "")
    .replace(PUNCT_RE, "")
    .trim();
}

export function splitTitleList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(splitTitleList);
  const raw = String(value).trim();
  if (!raw) return [];
  return [raw, ...raw.split(TITLE_SPLIT_RE)]
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

export function collectBangumiTitles(item) {
  const titles = [];
  if (item.nameCn) titles.push(item.nameCn);
  if (item.name_cn) titles.push(item.name_cn);
  if (item.name) titles.push(item.name);
  titles.push(...splitTitleList(item.aliases));

  if (item.infobox) {
    for (const box of item.infobox) {
      const key = String(box.key || "");
      if (!/(别名|中文名|英文名|日文名|原名|罗马字|放送译名)/.test(key)) continue;
      const val = box.value;
      if (Array.isArray(val)) titles.push(...val.map((v) => v.v || v.value || v));
      else titles.push(val);
    }
  }

  return uniqueTitles(titles);
}

export function collectSourceTitles(video) {
  return uniqueTitles([
    video.name,
    ...splitTitleList(video.subname),
  ]);
}

function uniqueTitles(titles) {
  const seen = new Set();
  const result = [];
  for (const title of titles.flatMap(splitTitleList)) {
    const normalized = normalizeTitle(title);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(title.trim());
  }
  return result;
}

function ngrams(s, n) {
  const chars = [...s];
  if (chars.length <= n) return new Set([s]);
  const set = new Set();
  for (let i = 0; i <= chars.length - n; i++) set.add(chars.slice(i, i + n).join(""));
  return set;
}

function lcsLength(a, b) {
  if (!a || !b) return 0;
  const prev = Array(b.length + 1).fill(0);
  const cur = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function hasCjk(value) {
  return CJK_RE.test(value);
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function rawScore(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;

  const short = a.length <= b.length ? a : b;
  const long = a.length > b.length ? a : b;
  const contains = long.includes(short) ? short.length / long.length : 0;
  const gramSize = Math.min(3, Math.max(1, Math.min(a.length, b.length)));
  const gramScore = jaccard(ngrams(a, gramSize), ngrams(b, gramSize));
  const editScore = levenshteinRatio(a, b);
  const lcs = lcsLength(a, b);
  const lcsCoverage = short.length ? lcs / short.length : 0;
  const lcsScore = hasCjk(short) && short.length >= 3 && lcsCoverage >= 0.9
    ? Math.min(0.94, 0.74 + Math.min(short.length, 20) / 100)
    : 0;
  return Math.max(contains * 0.98, gramScore * 0.94, editScore * 0.96, lcsScore);
}

function coreTitle(value) {
  return normalizeTitle(value).replace(GENERIC_TITLE_RE, "");
}

function levenshteinRatio(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }

  const distance = prev[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

function extractSeason(value) {
  const s = String(value || "").normalize("NFKC").toLowerCase();
  const m = s.match(/(?:第|season\s*|s)(\d+)(?:季|期)?/i);
  if (m) return parseInt(m[1], 10);
  if (/第二季|2nd/.test(s)) return 2;
  if (/第三季|3rd/.test(s)) return 3;
  if (/第四季|4th/.test(s)) return 4;
  return null;
}

function scorePair(left, right, year) {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return 0;

  let score = rawScore(a, b);
  const coreA = coreTitle(left);
  const coreB = coreTitle(right);
  if (coreA && coreB) {
    const coreScore = rawScore(coreA, coreB);
    if (coreScore < 0.28) score = Math.min(score, 0.24);
    else score = Math.max(score, coreScore * 0.98);
  }

  const leftSeason = extractSeason(left);
  const rightSeason = extractSeason(right);
  if (leftSeason && rightSeason && leftSeason !== rightSeason) score *= 0.72;
  if (leftSeason && rightSeason && leftSeason === rightSeason) score += 0.03;

  if (year?.queryYear && year?.videoYear) {
    const diff = Math.abs(year.queryYear - year.videoYear);
    if (diff === 0) score += 0.04;
    else if (diff === 1) score -= 0.03;
    else score *= 0.35;
  }

  return Math.max(0, Math.min(score, 1));
}

/**
 * 对 Bangumi 标题集合与采集站标题集合做全局评分。
 * @returns {{ video: object, score: number, matchedName: string, matchedSourceName: string, confidence: string } | null}
 */
export function matchOne(names, bangumiYear, videos) {
  const best = rankMatches(names, bangumiYear, videos, { limit: 1 })[0] || null;
  return best && best.score >= 0.8 ? best : null;
}

export function rankMatches(names, bangumiYear, videos, { limit = 20, minScore = 0 } = {}) {
  const queryTitles = Array.isArray(names) ? uniqueTitles(names) : uniqueTitles([names]);
  const ranked = [];

  for (const video of videos) {
    const sourceTitles = collectSourceTitles(video);
    const videoYear = video.year ? parseInt(String(video.year), 10) : null;
    let bestForVideo = null;

    for (const queryTitle of queryTitles) {
      for (const sourceTitle of sourceTitles) {
        const score = scorePair(queryTitle, sourceTitle, { queryYear: bangumiYear, videoYear });
        if (!bestForVideo || score > bestForVideo.score) {
          bestForVideo = {
            video,
            score,
            matchedName: queryTitle,
            matchedSourceName: sourceTitle,
            confidence: confidenceOf(score),
          };
        }
      }
    }

    if (bestForVideo && bestForVideo.score >= minScore) ranked.push(bestForVideo);
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function confidenceOf(score) {
  if (score >= 0.92) return "high";
  if (score >= 0.84) return "medium";
  return "low";
}
