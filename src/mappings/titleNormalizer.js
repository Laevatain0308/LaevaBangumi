import he from "he";
import * as OpenCC from "opencc-js";

const toSimplified = OpenCC.Converter({ from: "t", to: "cn" });
const PUNCTUATION = /[\s"'`‘’“”「」『』（）()【】\[\]《》<>〈〉:：!！?？.。・·_—–-]+/g;
const SOURCE_NOISE = /(?:更新至|更至)\s*\d+\s*集|(?:已)?完结|高清|\b(?:bd|hd)\b/gi;
const COLLECTION_SUFFIX = /(?:合集|全集)$/;
const ROMAN_NUMERALS = Object.freeze({ Ⅰ: "1", Ⅱ: "2", Ⅲ: "3", Ⅳ: "4", Ⅴ: "5", Ⅵ: "6", Ⅶ: "7", Ⅷ: "8", Ⅸ: "9", Ⅹ: "10" });

const SEASON_PATTERNS = [
  /第\s*(\d+)\s*(?:季|期)/gi,
  /第\s*([一二三四五六七八九十]+)\s*(?:季|期)/gi,
  /\bseason\s*(\d+)\b/gi,
  /\bs\s*(\d+)\b/gi,
];
const PART_PATTERNS = [
  /第\s*(\d+)\s*(?:部分|部|クール)/gi,
  /第\s*([一二三四五六七八九十]+)\s*(?:部分|部)/gi,
  /\b(?:part|cour)\s*(\d+)\b/gi,
];
const FORM_PATTERNS = Object.freeze([
  ["movie", /剧场版|劇場版|\bmovie\b/i],
  ["ova", /\bova\b|\boad\b/i],
  ["special", /特别篇|特別篇|\bspecial\b|(?:^|\s)sp(?:\s|$)/i],
]);

function normalizedText(value) {
  return toSimplified(he.decode(String(value ?? "")).normalize("NFKC").toLowerCase())
    .replace(SOURCE_NOISE, "")
    .replace(PUNCTUATION, "")
    .trim();
}

function romanVariants(text) {
  const variants = [];
  for (const [roman, arabic] of Object.entries(ROMAN_NUMERALS)) {
    if (!text.includes(roman.toLowerCase())) continue;
    variants.push(text.replaceAll(roman.toLowerCase(), arabic));
  }
  return variants;
}

function chineseNumber(value) {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  const [left, right] = value.split("十");
  if (right !== undefined) return (digits[left] ?? 1) * 10 + (digits[right] ?? 0);
  return digits[value] ?? Number.NaN;
}

function collectNumbers(input, patterns, target) {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of input.matchAll(pattern)) {
      const number = chineseNumber(match[1]);
      if (Number.isInteger(number)) target.add(number);
    }
  }
}

function comparisonCore(text) {
  return text
    .replace(/第\d+(?:季|期|部分|部|クール)/g, "")
    .replace(/(?:season|part|cour|s)\d+/g, "")
    .replace(/剧场版|ova|oad|特别篇|special/g, "");
}

export function buildTitlePool({ primaryTitles = [], aliases = [] } = {}) {
  const variants = [];
  const byText = new Map();
  const seasons = new Set();
  const parts = new Set();
  const forms = new Set();

  function add(raw, role) {
    const decoded = toSimplified(he.decode(String(raw ?? "")).toLowerCase());
    const original = decoded.normalize("NFKC");
    if (!original.trim()) return;
    collectNumbers(original, SEASON_PATTERNS, seasons);
    collectNumbers(original, PART_PATTERNS, parts);
    for (const [form, pattern] of FORM_PATTERNS) {
      if (pattern.test(original)) forms.add(form);
    }

    const exactWeight = role === "primary" ? 1 : 0.96;
    const fuzzyWeight = role === "primary" ? 1 : 0.92;
    const candidates = [normalizedText(original)];
    for (const [roman, arabic] of Object.entries(ROMAN_NUMERALS)) {
      if (decoded.includes(roman.toLowerCase())) {
        candidates.push(normalizedText(decoded.replaceAll(roman.toLowerCase(), arabic)));
      }
    }
    for (const value of [...candidates]) candidates.push(...romanVariants(value));
    if (COLLECTION_SUFFIX.test(candidates[0])) candidates.push(candidates[0].replace(COLLECTION_SUFFIX, ""));
    for (const text of candidates.filter(Boolean)) {
      const existing = byText.get(text);
      if (existing && existing.exactWeight >= exactWeight) continue;
      const value = Object.freeze({ text, role, exactWeight, fuzzyWeight });
      if (existing) variants.splice(variants.indexOf(existing), 1, value);
      else variants.push(value);
      byText.set(text, value);
    }
  }

  primaryTitles.forEach((title) => add(title, "primary"));
  aliases.forEach((title) => add(title, "alias"));
  const coreTitles = [...new Set(variants.map(({ text }) => comparisonCore(text)).filter(Boolean))];
  return Object.freeze({
    variants: Object.freeze(variants),
    seasons,
    parts,
    forms,
    coreTitles: Object.freeze(coreTitles),
  });
}
