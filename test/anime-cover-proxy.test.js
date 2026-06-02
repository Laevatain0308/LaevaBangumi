import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { initDb, db } from "../src/db/index.js";
import { anime } from "../src/db/schema.js";
import { getAnimeDetail, searchAnime } from "../src/services/anime.js";

const ANIME_ID = 999910001;
const COVER_URL = "https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg";

initDb();

function cleanup() {
  db.delete(anime).where(eq(anime.id, ANIME_ID)).run();
}

test.beforeEach(() => {
  cleanup();
  process.env.COVER_PROXY_BASE = "https://img.example.test";
  process.env.COVER_PROXY_SECRET = "anime-cover-secret";
  db.insert(anime)
    .values({
      id: ANIME_ID,
      name: "Proxy Cover Test",
      nameCn: "封面代理测试",
      coverUrl: COVER_URL,
      hasCover: 0,
      detailFetchedAt: new Date().toISOString(),
      updatedAt: "2026-06-01 00:00:00",
    })
    .run();
});

test.afterEach(() => {
  cleanup();
  delete process.env.COVER_PROXY_BASE;
  delete process.env.COVER_PROXY_SECRET;
});

test("searchAnime returns signed external cover proxy URL when configured", async () => {
  const result = await searchAnime("封面代理测试");
  const row = result.data.find((item) => item.id === ANIME_ID);

  assert.ok(row);
  assert.match(row.coverUrl, /^https:\/\/img\.example\.test\/cover\/999910001-[a-f0-9]{12}\.jpg\?/);
  assert.ok(new URL(row.coverUrl).searchParams.get("sig"));
});

test("searchAnime exposes the Bangumi subject id as id without a duplicate bangumiId field", async () => {
  const result = await searchAnime("封面代理测试");
  const row = result.data.find((item) => item.id === ANIME_ID);

  assert.ok(row);
  assert.equal(row.id, ANIME_ID);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "bangumiId"), false);
});

test("getAnimeDetail returns signed external cover proxy URL when configured", async () => {
  const result = await getAnimeDetail(ANIME_ID);

  assert.match(result.data.coverUrl, /^https:\/\/img\.example\.test\/cover\/999910001-[a-f0-9]{12}\.jpg\?/);
  assert.ok(new URL(result.data.coverUrl).searchParams.get("u"));
});

test("external cover proxy URL is built from normalized HTTPS source even for legacy database rows", async () => {
  db.update(anime)
    .set({ coverUrl: "http://lain.bgm.tv/r/400/pic/cover/l/13/c5/400602_ZI8Y9.jpg" })
    .where(eq(anime.id, ANIME_ID))
    .run();

  const result = await getAnimeDetail(ANIME_ID);
  const encoded = new URL(result.data.coverUrl).searchParams.get("u");
  const sourceUrl = Buffer.from(encoded, "base64url").toString("utf8");

  assert.equal(sourceUrl, "https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg");
});
