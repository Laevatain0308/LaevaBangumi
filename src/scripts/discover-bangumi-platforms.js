import { searchSubjects } from "../clients/bangumiClient.js";
import { assertMediaType } from "../lib/mediaTypes.js";
import { pathToFileURL } from "node:url";

const DEFAULT_KEYWORDS = [
  "星际之门",
  "星际穿越",
  "甄嬛传",
  "权力的游戏",
  "流浪地球",
  "孤独的美食家",
  "奔跑吧",
  "非诚勿扰",
  "红白歌会",
  "The Big Bang Theory",
];

export function parseDiscoveryArgs(argv) {
  const args = { keywords: DEFAULT_KEYWORDS, maxResults: 10, mediaType: "tv" };
  for (const arg of argv) {
    if (arg.startsWith("--keywords=")) {
      args.keywords = arg.slice("--keywords=".length).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg.startsWith("--max-results=")) {
      const parsed = Number.parseInt(arg.slice("--max-results=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) args.maxResults = parsed;
    } else if (arg.startsWith("--media-type=")) {
      args.mediaType = assertMediaType(arg.slice("--media-type=".length));
    }
  }
  return args;
}

async function main() {
  const args = parseDiscoveryArgs(process.argv.slice(2));
  const platforms = new Map();

  for (const keyword of args.keywords) {
    const result = await searchSubjects(keyword, {
      mediaType: args.mediaType,
      maxResults: args.maxResults,
      maxPages: 1,
    });
    for (const item of result.data || []) {
      const platform = item.platform || "";
      if (!platform) continue;
      if (!platforms.has(platform)) platforms.set(platform, []);
      platforms.get(platform).push({
        keyword,
        id: item.id,
        title: item.name_cn || item.name,
      });
    }
  }

  const rows = [...platforms.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "zh-Hans-CN"))
    .map(([platform, samples]) => ({
      platform,
      samples: samples.slice(0, 5),
    }));

  console.log(JSON.stringify(rows, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
