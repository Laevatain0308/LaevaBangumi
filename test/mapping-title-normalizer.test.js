import test from "node:test";
import assert from "node:assert/strict";
import { buildTitlePool } from "../src/mappings/titleNormalizer.js";

function texts(pool) {
  return pool.variants.map(({ text }) => text);
}

test("normalizes HTML Unicode punctuation and traditional Chinese without losing roles", () => {
  const pool = buildTitlePool({
    primaryTitles: ["幼女戰記Ⅱ", "Let&#039;s Go 怪奇组"],
    aliases: ["幼女战记 Season 2", "幼女戦記 第2期"],
  });
  assert.ok(texts(pool).includes("幼女战记2"));
  assert.ok(texts(pool).includes("letsgo怪奇组"));
  assert.ok(pool.variants.some(({ text, role, exactWeight, fuzzyWeight }) => (
    text === "幼女战记season2"
    && role === "alias"
    && exactWeight === 0.96
    && fuzzyWeight === 0.92
  )));
  assert.deepEqual([...pool.seasons], [2]);
});

test("extracts seasons parts and forms while preserving formal title semantics", () => {
  const pool = buildTitlePool({
    primaryTitles: ["鎧真傳 第2クール", "孤独摇滚总集篇", "剧场版 少女歌剧"],
    aliases: [],
  });
  assert.deepEqual([...pool.parts], [2]);
  assert.ok(texts(pool).some((value) => value.includes("总集篇")));
  assert.ok(pool.forms.has("movie"));

  const collection = buildTitlePool({ primaryTitles: ["某某动画 全集"], aliases: [] });
  assert.ok(texts(collection).includes("某某动画全集"));
  assert.ok(texts(collection).includes("某某动画"));
});

test("creates safe Roman numeral variants without rewriting ordinary Chinese numbers", () => {
  const roman = buildTitlePool({ primaryTitles: ["魔法少女奈叶 Ⅱ"], aliases: [] });
  assert.ok(texts(roman).includes("魔法少女奈叶2"));

  const ordinary = buildTitlePool({
    primaryTitles: ["一念永恒", "十万个冷笑话"],
    aliases: [],
  });
  assert.deepEqual(texts(ordinary), ["一念永恒", "十万个冷笑话"]);
});

test("deduplicates variants without accumulating alias evidence", () => {
  const pool = buildTitlePool({
    primaryTitles: ["葬送的芙莉莲"],
    aliases: ["葬送的芙莉蓮", "葬送的芙莉莲"],
  });
  assert.equal(texts(pool).filter((value) => value === "葬送的芙莉莲").length, 1);
  assert.equal(Object.isFrozen(pool), true);
  assert.equal(Object.isFrozen(pool.variants), true);
});
