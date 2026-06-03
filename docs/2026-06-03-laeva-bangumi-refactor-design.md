# LaevaBangumi 数据与 API 重构设计

> 日期：2026-06-03
>
> 范围：LaevaBangumi 后端数据库、同步任务、检索、资源匹配、API DTO 输出，以及 Aslan / LaevaAnime 对这些 API 的消费契约。
>
> 结论：本次重构不做旧字段兼容。API 路径保持现状，字段契约按本文一次性切换。

## 目标

LaevaBangumi 要从“能给当前页面返回数据的后端”重构为“以 Bangumi subject 为主数据、以资源站资源为播放扩展、以 Aslan API 契约为输出规范”的后端。

核心目标：

- `bangumi_id` 是全库和全链路唯一番剧标识；对外 API 仍使用字段名 `id`，语义固定为 Bangumi subject ID。
- 数据库存储、同步、检索、API 输出分层清晰。
- Bangumi 元数据要完整沉淀到数据库，包括评分、评分人数、各评分段人数、Tag、别名、放送信息。
- 支持 Aslan 当前详情页、搜索、热门、时间线、播放所需字段。
- 支持 LaevaAnime 当前首页、搜索、详情、播放、在线人数所需字段。
- 支持未来其他后端或客户端按同一数据契约接入。
- 详情中的剧集播放入口返回代理入口，真实播放地址只由 `/api/play` 返回。

非目标：

- 不兼容旧 DTO 字段。
- 不保留 `bangumiId` 对外字段。
- 不在详情响应中返回真实播放 URL。
- 不把 Bangumi 原始 JSON 直接暴露给客户端。

## 当前消费者需求

### Aslan

Aslan 当前消费：

- `/api/search?q=keyword`
- `/api/search?tag=tagName`，需要新增
- `/api/updates?days=7&limit=24`
- `/api/calendar`
- `/api/detail?id=subjectId`
- `/api/play?id=subjectId&ch=channelIndex&ep=episodeIndex`

Aslan 详情页需要：

- 基础信息：`id`, `title`, `summary`, `coverUrl`, `airDate`, `platform`, `eps`, `totalEpisodes`
- 评分信息：`ratingScore`, `rank`, `votes`, `votesCount`
- Tag：至少 name；更完整时需要 count / totalCount
- 播放线路：线路名、资源站标识、资源站条目 ID、剧集列表、代理播放入口
- 资源状态：是否 ready / matching / fetching / retrying / wait_airing / no_data

### LaevaAnime

LaevaAnime 当前消费：

- 首页最近更新：`id`, `title`, `coverUrl`, `summary`, `latestEp`, `latestEpisode`, `updatedAt`
- 首页本周放送：weekday 分组、评分、最新集数、放送日期
- 搜索：`id`, `title`, `coverUrl`
- 详情：基础信息、播放线路、资源状态
- 播放：真实播放地址和是否直接播放
- Heartbeat：在线人数

## 架构边界

重构后服务端分为五层。

### 1. Source Client 层

负责访问外部服务，返回原始响应。

建议文件：

- `src/clients/bangumiClient.js`
- `src/clients/resourceClient.js`
- `src/clients/resourceSources/ffzyClient.js`

职责：

- HTTP 请求、超时、重试、限流。
- 不写数据库。
- 不输出 API DTO。
- 不处理业务匹配。

### 2. Normalizer 层

负责把外部原始响应转换为内部 domain input。

建议文件：

- `src/normalizers/bangumiSubjectNormalizer.js`
- `src/normalizers/bangumiCalendarNormalizer.js`
- `src/normalizers/resourceItemNormalizer.js`

职责：

- 解析 Bangumi subject、rating、tags、infobox、aliases、date、platform。
- 解析采集站 catalog item、resource detail、episode。
- 消除外部字段差异。
- 不写数据库。
- 不输出 API DTO。

### 3. Repository 层

负责数据库读写。

建议文件：

- `src/repositories/subjectRepository.js`
- `src/repositories/tagRepository.js`
- `src/repositories/resourceRepository.js`
- `src/repositories/episodeRepository.js`
- `src/repositories/syncRepository.js`

职责：

- 对表做 insert/update/select。
- 提供组合查询，例如 search、tag search、calendar、updates。
- 不访问外部 API。
- 不决定资源状态业务规则。

### 4. Service 层

负责业务流程。

建议文件：

- `src/services/subjectSyncService.js`
- `src/services/resourceMatchService.js`
- `src/services/episodeRefreshService.js`
- `src/services/detailService.js`
- `src/services/searchService.js`
- `src/services/updateService.js`
- `src/services/calendarService.js`
- `src/services/playService.js`

职责：

- 同步 Bangumi 数据。
- 刷新评分和 tags。
- 资源站匹配。
- 剧集刷新。
- 聚合详情状态。
- 触发后台任务。

### 5. DTO 层

负责把 domain object 输出为 API JSON。

建议文件：

- `src/dto/apiEnvelope.js`
- `src/dto/subjectDto.js`
- `src/dto/resourceDto.js`
- `src/dto/errorDto.js`

职责：

- 输出稳定字段名。
- 统一 null / 空数组策略。
- 统一 `updatedAt` 和 `meta`。
- 不查询数据库。
- 不访问外部 API。

## 数据库设计

### 命名规则

- 表内主标识字段统一叫 `bangumi_id`。
- 对外 API 统一叫 `id`。
- 资源站条目 ID 统一叫 `source_aid`。
- 资源站 key 统一叫 `source`。
- 时间字段统一 ISO 字符串或 SQLite datetime 文本，但同一库内必须统一。

### subjects

`subjects` 是 Bangumi subject 主表。

```sql
CREATE TABLE subjects (
  bangumi_id INTEGER PRIMARY KEY,
  type INTEGER NOT NULL DEFAULT 2,
  name TEXT NOT NULL,
  name_cn TEXT,
  summary TEXT,
  platform TEXT,
  air_date TEXT,
  air_weekday INTEGER,
  calendar_weekday INTEGER,
  eps INTEGER,
  total_episodes INTEGER,
  cover_url TEXT,

  rating_score REAL,
  rating_rank INTEGER,
  rating_total INTEGER,
  rating_distribution_json TEXT NOT NULL DEFAULT '[]',

  metadata_fetched_at TEXT,
  rating_fetched_at TEXT,
  calendar_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

#### created_at / updated_at 是否拆分

不建议把 `subjects.created_at` 和 `subjects.updated_at` 拆成独立表。

理由：

- 它们是 subject row 生命周期字段，读取、调试、迁移都依赖它们，放在主表最直接。
- 查询最近更新 subject 或排查同步问题时，主表字段足够高效。
- 拆到独立表会增加 join 和写入复杂度，但收益很低。

但建议增加更细粒度的业务更新时间字段：

- `metadata_fetched_at`：最近成功从 Bangumi subject 详情刷新元数据的时间。
- `rating_fetched_at`：最近成功刷新评分、评分分布的时间。
- `calendar_synced_at`：最近由 calendar 同步命中过的时间。

这比拆分 `created_at / updated_at` 更有性价比，因为业务判断关心的是“哪类数据是否新鲜”，不是 row 本身何时更新。

### subject_aliases

```sql
CREATE TABLE subject_aliases (
  bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  locale TEXT,
  source TEXT NOT NULL DEFAULT 'bangumi',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bangumi_id, alias)
);
```

用途：

- 搜索标题、中文名、别名。
- 避免把 aliases JSON 字符串用于 like 检索。

### tags

```sql
CREATE TABLE tags (
  tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### subject_tags

```sql
CREATE TABLE subject_tags (
  bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(tag_id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'bangumi',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bangumi_id, tag_id)
);
```

用途：

- Aslan 按 Tag 检索。
- 详情页显示 tag count。
- 后续支持 tag 聚合页。

### resource_sources

```sql
CREATE TABLE resource_sources (
  source TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  base_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### resource_items

资源站目录表，取代 `cstation_catalog`。

```sql
CREATE TABLE resource_items (
  source TEXT NOT NULL REFERENCES resource_sources(source),
  source_aid INTEGER NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  category TEXT,
  year TEXT,
  latest_text TEXT,
  detail_fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, source_aid)
);
```

### resource_mappings

取代 `bangumi_cstation_map`。

```sql
CREATE TABLE resource_mappings (
  bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
  source TEXT NOT NULL REFERENCES resource_sources(source),
  source_aid INTEGER NOT NULL,
  score REAL,
  matched_subject_title TEXT,
  matched_resource_title TEXT,
  source_ep_start INTEGER,
  source_ep_end INTEGER,
  display_ep_offset INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'matched',
  note TEXT,
  matched_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bangumi_id, source)
);
```

数据库层允许多个 Bangumi subject 映射到同一个 `source_aid`，用于人工手动分段匹配。
自动匹配仍必须在服务层检查已有 owner，避免一个资源站条目被多个 Bangumi subject 自动占用。

### episodes

```sql
CREATE TABLE episodes (
  episode_id INTEGER PRIMARY KEY AUTOINCREMENT,
  bangumi_id INTEGER NOT NULL REFERENCES subjects(bangumi_id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_aid INTEGER NOT NULL,
  ep_index INTEGER NOT NULL,
  source_ep_index INTEGER,
  title TEXT,
  raw_video_url TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE (bangumi_id, source, source_aid, ep_index),
  FOREIGN KEY (source, source_aid)
    REFERENCES resource_items(source, source_aid)
);
```

`episodes.updated_at` 表示资源站侧确认该剧集新增或变更的时间；不能用本地入库/刷新时间冒充。
资源站只给条目级更新时间时，只将该时间写到本次详情中最高 `source_ep_index` 的剧集。

### sync_state

```sql
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_started_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### retry_state

```sql
CREATE TABLE retry_state (
  bangumi_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bangumi_id, source, kind)
);
```

`kind` 可取：

- `mapping`
- `episode_fetch`
- `metadata_fetch`

### manual_resource_state

```sql
CREATE TABLE manual_resource_state (
  bangumi_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bangumi_id, source)
);
```

用于 `wait_airing`, `no_resource`, `source_already_mapped` 等人工状态。

### 索引

建议建立：

```sql
CREATE INDEX idx_subjects_calendar_weekday ON subjects(calendar_weekday);
CREATE INDEX idx_subjects_updated_at ON subjects(updated_at);
CREATE INDEX idx_subjects_rating_score ON subjects(rating_score);
CREATE INDEX idx_subject_aliases_alias ON subject_aliases(alias);
CREATE INDEX idx_subject_tags_tag_id ON subject_tags(tag_id);
CREATE INDEX idx_episodes_bangumi_source ON episodes(bangumi_id, source, source_aid);
CREATE INDEX idx_resource_items_title ON resource_items(title);
CREATE INDEX idx_retry_state_retry_at ON retry_state(retry_at);
```

如果 SQLite FTS 可接受，建议新增 `subject_search_fts`：

```sql
CREATE VIRTUAL TABLE subject_search_fts USING fts5(
  title,
  aliases,
  tags,
  content=''
);
```

否则第一版用 `LIKE` + alias/tag join 即可。

## API 响应规范

### 通用 Envelope

所有 API 除 `/api/heartbeat`, `/api/health` 外统一：

```json
{
  "data": {},
  "updatedAt": "2026-06-03T12:00:00.000Z",
  "meta": {
    "freshness": "cache",
    "warnings": []
  }
}
```

`freshness`：

- `cache`
- `refreshed`
- `stale`
- `empty`
- `error`

错误响应：

```json
{
  "data": null,
  "updatedAt": "2026-06-03T12:00:00.000Z",
  "meta": {
    "freshness": "error",
    "warnings": ["番剧不存在"],
    "error": "subject_not_found"
  }
}
```

### SubjectCard

用于 search、updates、calendar item。

```ts
interface SubjectCard {
  id: number;
  title: string;
  name: string;
  nameCn: string | null;
  coverUrl: string | null;
  summary: string | null;
  airDate: string | null;
  airWeekday: number | null;
  platform: string | null;
  eps: number | null;
  totalEpisodes: number | null;
  ratingScore: number | null;
  rank: number | null;
  votes: number | null;
  votesCount: number[];
  tags: SubjectTag[];
}
```

### SubjectTag

```ts
interface SubjectTag {
  name: string;
  count: number;
  totalCount: number;
}
```

### `/api/search`

请求：

- `/api/search?q=keyword`
- `/api/search?tag=tagName`

响应：

```json
{
  "data": [
    {
      "id": 456079,
      "title": "和班上第二可爱的女孩成为朋友",
      "name": "クラスで2番目に可愛い女の子と友だちになった",
      "nameCn": "和班上第二可爱的女孩成为朋友",
      "coverUrl": "https://...",
      "summary": null,
      "airDate": "2026-04-01",
      "airWeekday": 3,
      "platform": "TV",
      "eps": 12,
      "totalEpisodes": 12,
      "ratingScore": 7.1,
      "rank": 1234,
      "votes": 420,
      "votesCount": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      "tags": [
        { "name": "恋爱", "count": 20, "totalCount": 0 }
      ]
    }
  ],
  "updatedAt": "2026-06-03T12:00:00.000Z",
  "meta": {
    "freshness": "cache",
    "total": 1,
    "query": "keyword",
    "tag": null
  }
}
```

规则：

- `q` 和 `tag` 二选一；同时传时返回 400。
- `tag` search 只查本地 tag 表，不主动访问 Bangumi。
- `q` search 查 `subjects.name`, `subjects.name_cn`, `subject_aliases.alias`, `tags.name`。
- 搜索命中可后台 enqueue Bangumi search enrich，但响应只返回当前本地数据。

### `/api/updates`

响应：

```json
{
  "data": [
    {
      "id": 580133,
      "title": "欺诈游戏",
      "name": "ライアーゲーム",
      "nameCn": "欺诈游戏",
      "coverUrl": "https://...",
      "summary": "突然届けられた1億円と謎の招待状",
      "airDate": "2026-04-01",
      "airWeekday": 3,
      "platform": "TV",
      "eps": 12,
      "totalEpisodes": 12,
      "ratingScore": 7.6,
      "rank": 1000,
      "votes": 420,
      "votesCount": [0, 0, 1, 2, 3, 10, 20, 30, 5, 1],
      "tags": [],
      "latestEp": 9,
      "latestEpisode": "更新至第09集",
      "updatedAt": "2026-06-01T16:43:24.000Z",
      "source": "ffzy",
      "sourceAid": 123
    }
  ],
  "updatedAt": "2026-06-03T12:00:00.000Z",
  "meta": {
    "freshness": "cache",
    "total": 1,
    "days": 7
  }
}
```

规则：

- `updatedAt` 使用映射剧集的 `episodes.updated_at`，不使用 subject 入库时间或 `resource_items.updated_at`。
- closed range 映射默认不进入 updates，避免历史资源反复刷榜。
- closed range 映射如果刚好更新到 `source_ep_end` 对应的最后一集，仍可以进入 updates。
- `sourceUpdates` 不作为对外字段保留；如果后续需要多源更新详情，新增专门 endpoint。

### `/api/calendar`

响应：

```json
{
  "data": [
    {
      "weekday": { "en": "Mon", "cn": "星期一", "ja": "月曜日", "id": 1 },
      "items": [
        {
          "id": 377130,
          "title": "尖帽子的魔法工房",
          "name": "とんがり帽子のアトリエ",
          "nameCn": "尖帽子的魔法工房",
          "coverUrl": "https://...",
          "summary": null,
          "airDate": "2026-04-01",
          "airWeekday": 3,
          "platform": "TV",
          "eps": 12,
          "totalEpisodes": 12,
          "ratingScore": 7.6,
          "rank": 900,
          "votes": 300,
          "votesCount": [0, 1, 1, 2, 3, 20, 40, 60, 20, 3],
          "tags": [],
          "latestEp": 10,
          "lastUpdated": "2026-06-01T14:57:08.000Z"
        }
      ]
    }
  ],
  "updatedAt": "2026-06-03T12:00:00.000Z",
  "meta": {
    "freshness": "cache"
  }
}
```

### `/api/detail`

响应：

```json
{
  "data": {
    "id": 547888,
    "title": "标题",
    "name": "原名",
    "nameCn": "中文名",
    "summary": "简介",
    "coverUrl": "https://...",
    "airDate": "2026-04-01",
    "airWeekday": 3,
    "platform": "TV",
    "eps": 12,
    "totalEpisodes": 12,
    "ratingScore": 7.6,
    "rank": 1234,
    "votes": 420,
    "votesCount": [0, 0, 1, 2, 3, 10, 20, 30, 5, 1],
    "tags": [
      { "name": "原创", "count": 10, "totalCount": 0 }
    ],
    "aliases": ["别名1", "别名2"],
    "channels": [
      {
        "id": "ffzy:123",
        "name": "非凡资源",
        "source": "ffzy",
        "sourceAid": 123,
        "resourceTitle": "资源站标题",
        "episodes": [
          {
            "index": 1,
            "sourceIndex": 1,
            "name": "第01集",
            "playUrl": "/anime/api/play?id=547888&ch=1&ep=1",
            "updatedAt": "2026-06-01T16:43:24.000Z"
          }
        ]
      }
    ]
  },
  "updatedAt": "2026-06-03T12:00:00.000Z",
  "meta": {
    "freshness": "cache",
    "resourceStatus": "ready",
    "resourceSources": [
      {
        "source": "ffzy",
        "name": "非凡资源",
        "status": "ready",
        "sourceAid": 123,
        "note": null
      }
    ]
  }
}
```

规则：

- 不返回 `url` 兼容字段，只返回 `playUrl`。
- `playUrl` 永远是代理入口。
- `votesCount` 永远返回数组；没有数据时返回 `[]`。
- `tags` 永远返回对象数组；没有数据时返回 `[]`。
- `channels` 按 `resource_sources.priority` 排序，再按 source / source_aid 排序。

### `/api/play`

响应：

```json
{
  "data": {
    "videoUrl": "https://real-resource/video.m3u8",
    "directPlay": false,
    "headers": {},
    "expiresAt": null
  },
  "updatedAt": "2026-06-03T12:00:00.000Z",
  "meta": {
    "freshness": "cache"
  }
}
```

规则：

- 不返回 `videoURL`。
- 根据 `id/ch/ep` 到当前 enabled sources 下的 channel 排序结果中定位剧集。
- 如果未来 channel 使用 stable id，可新增 query：`/api/play?id=547888&channel=ffzy:123&ep=1`。本次先保留 `ch`，因为路径要求维持现状。

## 同步与更新任务

### sync-calendar

来源：Bangumi calendar。

写入：

- `subjects`
- `subject_aliases`
- `subject_tags`
- `calendar_weekday`
- `calendar_synced_at`

行为：

- 每日多次执行。
- 命中的 subject 入库或更新。
- 对新 subject enqueue `refresh-subject-metadata`。
- 对 calendar 中消失的 subject 只清空 `calendar_weekday`，不删除 subject。

### refresh-subject-metadata

来源：Bangumi subject detail。

写入：

- `subjects.metadata_fetched_at`
- `subjects.rating_*`
- `subjects.rating_distribution_json`
- `subject_aliases`
- `tags`
- `subject_tags`

行为：

- 对最近 calendar、updates、search、detail 访问过的 subject 优先刷新。
- 评分与 tags 同步属于 metadata refresh 的一部分，不再依赖详情页临时抓取。
- `rating_fetched_at` 可以和 `metadata_fetched_at` 同时更新；如果以后评分接口拆开，再独立更新。

### sync-resource-catalog

来源：采集站目录。

写入：

- `resource_items`
- `sync_state`

行为：

- 按 source 独立执行。
- 只更新资源站事实，不做 Bangumi 匹配。

### match-resources

输入：subject + resource_items。

写入：

- `resource_mappings`
- `retry_state(kind='mapping')`
- `manual_resource_state`

行为：

- 使用 title aliases + year 进行匹配。
- 自动匹配必须检查同一 `source_aid` 是否已有 owner；已有 owner 时写入 `source_already_mapped` 人工状态并停止自动占用。
- 人工手动分段匹配允许多个 Bangumi subject 共享同一个 `source_aid`。
- 匹配成功后 enqueue `refresh-episodes`。

### refresh-episodes

来源：资源站详情。

写入：

- `episodes`
- `resource_items.detail_fetched_at`
- `retry_state(kind='episode_fetch')`

行为：

- 应用 `source_ep_start`, `source_ep_end`, `display_ep_offset`。
- 删除当前 mapping 下已不存在的旧剧集。
- 保存真实播放地址到 `raw_video_url`。

### retry-pending

统一扫描 `retry_state.retry_at <= now()`。

行为：

- `mapping` 调用 match-resources。
- `episode_fetch` 调用 refresh-episodes。
- `metadata_fetch` 调用 refresh-subject-metadata。

## 检索设计

### 关键词搜索

查询范围：

- `subjects.name`
- `subjects.name_cn`
- `subject_aliases.alias`
- `tags.name`

返回：

- `SubjectCard[]`

后台行为：

- 如果本地结果不足，可 enqueue Bangumi search enrichment。
- 当前响应不等待 Bangumi search，以保证接口稳定快速。

### Tag 搜索

请求：

```txt
/api/search?tag=恋爱
```

查询：

- `tags.name = ?`
- join `subject_tags`
- join `subjects`

排序建议：

1. `subject_tags.count DESC`
2. `subjects.rating_score DESC`
3. `subjects.air_date DESC`

## 一次性重构实施边界

因为不需要兼容旧字段，本次可以一次性替换：

- 旧表：`anime`, `episodes`, `bangumi_cstation_map`, `match_retry_state`, `episode_fetch_retry_state`, `manual_match_state`, `cstation_catalog`, `source_sync_state`
- 新表：本文定义的新 schema
- 旧 DTO：全部删除，不保留 `videoURL`, `url`, `bangumiId`, string tags
- 新 DTO：按本文输出

建议仍保留一次数据迁移脚本，而不是直接丢弃旧库：

- `anime` -> `subjects`
- `anime.aliases` -> `subject_aliases`
- `anime.tags` -> `tags` + `subject_tags`
- `bangumi_cstation_map` -> `resource_mappings`
- `cstation_catalog` -> `resource_items`
- `episodes` -> `episodes`
- retry/manual state 对应迁移

如果迁移成本高于收益，可以提供 `--rebuild-db` 模式全量重建，但生产部署前要明确备份。

## 测试策略

### DTO 契约测试

必须先写 fixtures：

- `test/fixtures/bangumi-subject-detail.json`
- `test/fixtures/bangumi-calendar.json`
- `test/fixtures/resource-detail-ffzy.json`

测试：

- detail DTO 包含评分分布和 tag 对象。
- detail episodes 只返回 `playUrl`，不返回真实 URL。
- play DTO 返回 `videoUrl`，不返回 `videoURL`。
- search 不返回 `bangumiId`。
- tag search 可按 tag 命中 subject。

### Repository 测试

测试：

- upsert subject 会写入 rating distribution。
- upsert tags 会维护 `tags` 和 `subject_tags`。
- resource mapping unique 约束生效。
- episode refresh 会 prune 已消失剧集。

### Service 测试

测试：

- calendar sync 写入 subject 并更新 calendar weekday。
- metadata refresh 更新评分、tags、aliases。
- detail service 对 ready / matching / fetching / retrying / wait_airing / no_data 聚合正确。
- updates service 只返回时间窗口内资源更新。

### Client 集成测试

Aslan：

- `LaevaBangumiDetail` 改为读取 tag objects、votes、votesCount、playUrl、videoUrl。
- 详情页评分透视图在有 votesCount 时显示。
- Tag 点击进入 `/search/{tag}` 后调用 tag search。

LaevaAnime：

- TypeScript 类型与新 DTO 一致。
- Detail page 使用 `playUrl`。
- Play page 使用 `videoUrl`。

## 风险与取舍

### 一次性重构风险

- 旧数据迁移复杂。
- Aslan 与 LaevaAnime 必须同步改字段。
- 若 Bangumi 或采集站同步失败，初期页面可能空数据更多。

缓解：

- 先完成 schema + DTO + fixtures 测试。
- 提供一次迁移脚本和一次 rebuild 脚本。
- API 路径不变，部署切换点明确。

### created_at / updated_at 拆表取舍

不拆表。

保留主表 `created_at` / `updated_at`，并增加业务新鲜度字段，是性价比最高的方案。拆表只在以下场景才值得：

- 需要完整审计每次字段级变更。
- 需要保留历史版本。
- 多进程写入导致 updated_at 语义严重混乱。

当前需求主要是同步新鲜度、检索、详情展示，不需要 subject row 的历史审计，因此不拆。

## 最终建议

执行顺序应是：

1. 写 API contract 测试，锁定本文 DTO。
2. 建新 schema 和 migration/rebuild 脚本。
3. 拆 repository。
4. 拆 normalizer。
5. 拆 service。
6. 重写 server route 为薄路由。
7. 更新 Aslan 模型。
8. 更新 LaevaAnime 类型与页面。
9. 跑端到端验证。

这个顺序能最大限度避免一次性重构变成无边界的大改。
