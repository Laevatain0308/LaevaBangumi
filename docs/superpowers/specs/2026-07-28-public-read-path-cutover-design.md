# LaevaBangumi 公开读取链路统一切换设计

> 日期：2026-07-28
>
> 范围：仅 LaevaBangumi 服务端。把 Search、Calendar、Detail、Play、Updates 从旧运行表切换到 Bangumi 元数据域、ResourceSource 域和番剧映射域，并删除旧运行链路。
>
> 非范围：客户端修改、旧数据迁移、旧协议兼容、新后台管理 HTTP API、长期匹配状态表。

## 1. 目标

本阶段完成整个服务端重构的最后一次运行链路切换：

- `bangumi_subjects` 及其子表是公开番剧元数据的唯一事实来源。
- `source_items`、`source_item_aliases`、`source_episodes` 是公开采集站资源的唯一事实来源。
- `bangumi_resource_mappings` 是公开资源关系的唯一事实来源。
- 公开 API 保持现有路径和 DTO 字段，不修改 Aslan 客户端。
- 公开读取只组合三个事实域，不创建聚合表、不复制分集、不触发自动匹配。
- 全新数据库启动时不创建、读取或写入旧 `subjects`、`resource_mappings`、`episodes` 等运行表。
- 删除不再使用的旧采集、匹配、重试、人工状态和旧 CSV/AI 管理链路。

## 2. 选择的切换方式

采用直接切换，不建立旧行结构适配层，也不建立专用 API 读模型表。

```text
bangumi_subjects + images/rating/tags/infobox
                         |
bangumi_resource_mappings
                         |
source_items + source_episodes
                         v
               public read repository
                         v
        search/calendar/detail/play/updates
```

直接切换的理由：

- 三个新域已各自稳定持久化，读侧不需要再维护第四份数据。
- 单机 SQLite 联查规模可控，额外同步机制只会增加一致性风险。
- 删除旧表和旧字段语义后，生产运行路径与映射设计保持一致。

## 3. 架构边界

### 3.1 事实域

- Bangumi 仓库只负责 Bangumi 元数据及 Calendar 成员关系。
- ResourceSource 仓库只负责采集站条目、别名、原始分集和采集状态。
- Mapping 仓库只负责映射、一次性放送计划和精确排除关系。

三个写入域不为了公开 API 互相调用，也不双写聚合结果。

### 3.2 公开读取域

新增只读的公开投影仓库和公开 API runtime：

- 投影仓库可以联查三个事实域，但不得执行 `INSERT`、`UPDATE` 或 `DELETE`。
- 分集区间投影是纯函数，服务层和测试均复用同一实现。
- API runtime 暴露 `search`、`calendar`、`detail`、`play`、`updates` 五个用例。
- `server.js` 不再静态导入旧 `services/anime.js`，而由 `src/index.js` 注入公开 API runtime。
- 测试用内存数据库创建同一 runtime，不使用生产数据库单例或旧仓库。

### 3.3 采集站元数据

每个 `ResourceSource` 子类声明两项只读静态元数据：

```js
static get sourceKey() { return "ffzy"; }
static get displayName() { return "非凡资源"; }
```

注册表校验两个字段，并让源实例持有只读 `sourceKey` 和 `displayName`。现有
`registry.list()` 仍按 `config/resource-sources.json` 的加载顺序返回源实例，不改变调度器接口：

```js
registry.list().map((source) => ({
  sourceKey: source.sourceKey,
  displayName: source.displayName,
}))
```

- `sourceKey` 是稳定数据库标识。
- `displayName` 仅用于公开 DTO。
- 不新增采集站信息表。
- 新运行链路不再读取旧 `config/cstations.json`。
- 播放线路、资源状态和更新的采集站优先级均使用注册顺序。

## 4. Bangumi 公开投影

### 4.1 主体字段

公开主体字段映射：

| DTO 字段 | 新域来源 |
|---|---|
| `id` | `bangumi_subjects.bangumi_id` |
| `title` | `name_cn`，为空时使用 `name` |
| `name` / `nameCn` | `name` / `name_cn` |
| `summary` | `summary` |
| `airDate` / `airWeekday` | `air_date` / `air_weekday` |
| `platform` | `platform` |
| `eps` / `totalEpisodes` | `eps` / `total_episodes` |
| `coverUrl` | images 按 `large`、`common`、`medium`、`small`、`grid` 顺序取首个值，再使用现有签名代理转换 |
| `ratingScore` / `rank` / `votes` | `bangumi_subject_rating` |
| `votesCount` | `count_1` 到 `count_10` |
| `tags` | `bangumi_subject_tags`，保留 `name/count/totalCount` |

公开 `mediaType` 继续返回 `anime`。新 Bangumi 域只接收 `type=2` 动画，当前没有必要在表内重复保存媒体类型。

### 4.2 别名

新 Bangumi 域不保存单独的旧 `subject_aliases` 表。Detail 的 `aliases` 从 Infobox 中与名称同义的条目值提取，至少覆盖：

- `别名`
- `中文名`
- `日文名`
- `英文名`
- `原名`
- `罗马字`

值按 Infobox 原始顺序展开，去空、去重，并排除与 `name`、`name_cn` 完全相同的值。Search、Calendar 和 Updates 不输出别名，避免为卡片查询额外展开 Infobox。

### 4.3 搜索

- 关键词在本地匹配 `name`、`name_cn`、Infobox 名称值和 Bangumi 标签名称。
- Tag 搜索精确匹配 `bangumi_subject_tags.name`。
- 结果按现有 DTO 返回，使用稳定顺序：评分人数降序、评分降序、Bangumi ID 升序。
- 远端搜索仍由现有异步队列触发；远端结果只写新 Bangumi 域，并登记详情补全。
- 当前只支持 `type=anime` 的新域结果；其他已接受的类型参数返回空数组，不改变请求校验协议。

### 4.4 Calendar

- 成员关系读取 `bangumi_calendar_subjects`。
- 元数据读取新 Bangumi 域。
- `latestEp` 和 `lastUpdated` 由映射后的可播放分集投影计算。
- Calendar 为空时沿用现有空数据响应，不在请求内同步 Bangumi。

### 4.5 Detail 的本地优先行为

- 只要 `bangumi_subjects` 存在摘要，就立即返回 Detail。
- 尚未补全的评分、标签、别名等返回 `null`、`0` 或空数组，不把摘要条目误判为 404。
- 每次合法 Detail 请求都调用现有幂等 `metadataEnsureService.ensure([id])`。
- 数据库完全没有该 ID 时返回 404，但该 ensure 已经登记异步获取，稍后请求可命中。
- Detail 的 `freshness`：详情曾成功补全为 `cache`；仅摘要或已有详情当前到期为 `stale`。到期刷新仍由 Bangumi runtime 处理，公开读取不直接发网络请求。

## 5. 映射与分集投影

### 5.1 映射语义

每个 `(bangumi_id, source_key)` 最多一条映射，因此每个采集站最多生成一条播放线路。

- 一对一映射：`source_episode_start` 和 `source_episode_end` 均为空，包含采集站当前全部分集。
- 封闭分段：只包含 `start <= source episode <= end`。
- 开放分段：只包含 `source episode >= start`。

空档合法，重叠由映射写入约束阻止。投影读取不会推断或填补空档。

### 5.2 编号与标题

一对一映射：

```text
displayIndex = sourceEpisodeIndex
sourceIndex = sourceEpisodeIndex
```

分段映射：

```text
displayIndex = sourceEpisodeIndex - sourceEpisodeStart + 1
sourceIndex = sourceEpisodeIndex
```

- DTO `index` 和 `playUrl.ep` 使用 `displayIndex`。
- DTO `sourceIndex` 保留源编号。
- DTO `name` 原样保留采集站 `source_episodes.title`，即使标题仍写“第13集”也不改写。
- DTO `updatedAt` 使用 `source_episodes.updated_at`。

### 5.3 线路排序

- 按 `config/resource-sources.json` 的插件注册顺序固定排序。
- 没有映射的采集站不生成线路。
- 映射范围内没有可播放分集的采集站不生成空线路。
- `ch` 是过滤空线路后的 1-based 位置；Detail 与 Play 必须调用同一投影函数，避免位置漂移。
- 线路 ID 保持 `${sourceKey}:${sourceItemId}`。
- FFZY 的 `sourceAid` 对外转为数字；无法安全转换的未来采集站 ID 暂时输出 `null`，不在本阶段扩展客户端契约。

### 5.4 Play

`GET /api/play?id=&ch=&ep=` 先按与 Detail 完全相同的线路顺序选中 `ch`，再将显示集数反解为源集数：

```text
sourceEpisodeIndex = oneToOne
  ? requestedDisplayIndex
  : sourceEpisodeStart + requestedDisplayIndex - 1
```

读取对应 `source_episodes.video_url`。不存在映射、不在封闭区间内、分集不存在或 URL 为空时统一返回当前 `episode_not_found` 404；成功 DTO 继续使用 `videoUrl`。

## 6. Updates 投影

### 6.1 更新来源

- 更新窗口使用 `source_episodes.updated_at`；没有分集变化但采集站条目时间变化时，不伪造番剧剧集更新。
- 一条 Bangumi 映射只有在其投影范围内存在更新窗口内的分集时才成为候选。
- 每部 Bangumi 只返回一条卡片；多个采集站同时更新时，按最新时间优先，时间相同按插件注册顺序优先。

### 6.2 共享条目的季度归属

对于同一采集站条目的多段映射，只把条目当前最新源分集归给包含它的分段：

- 封闭旧分段的末集小于当前最新源分集时，该旧季度不再产生后续更新。
- 当前最新源分集位于某个封闭分段内时，归给该分段。
- 最后一个开放分段持续接收其起始集之后的更新。
- 当前最新源分集落在合法空档时，不归给任何 Bangumi ID。

返回的 `latestEp` 是季度内显示集数，`latestEpisode` 继续为 `更新至第NN集`。`source` 和 `sourceAid` 保持现有字段。

## 7. 公开资源状态

新架构不创建长期匹配状态表。每个已注册采集站的状态只从当前事实推导：

- `ready`：存在映射，且映射范围内至少有一条可播放分集。
- `wait_airing`：没有 `ready`，且完整 `air_date` 明确晚于 Asia/Shanghai 当天。
- `no_data`：其余情况，包括已开播未映射、日期精度不足、映射存在但范围内没有可播放分集。

不再输出 `matching`、`retrying` 或 `fetching`，因为它们在新机制中只是短暂内部执行过程，没有可靠持久事实。

Detail `meta.resourceSources` 按插件注册顺序包含所有已注册采集站：

```json
{
  "source": "ffzy",
  "name": "非凡资源",
  "status": "ready",
  "sourceAid": 123,
  "note": null
}
```

聚合 `meta.resourceStatus` 优先级为 `ready`、`wait_airing`、`no_data`。当前只有一个采集站，但规则支持多个插件。

## 8. 旧链路删除范围

公开 API 全部通过新 runtime 后删除：

- `initLegacySchema()`、`initLegacyDb()` 和 `initDb(..., { legacy })` 分支。
- 旧 `subjects`、`subject_aliases`、`tags`、`subject_tags`、`resource_sources`、`resource_items`、`resource_mappings`、`episodes`、`sync_state`、`retry_state`、`manual_resource_state`、`anime_other` 的 schema 声明和初始化。
- 旧 Source Client、旧资源匹配、旧分集刷新、旧 retry/manual state、旧 catalog 服务。
- 旧 CSV 人工审核和 AI match pack 命令；人工管理只保留新的 `npm run mapping -- export|import` XLSX 流程。
- `config/cstations.json` 与其读取模块。
- 只服务于旧表的 repository、normalizer、service 和测试。
- `services/anime.js` 兼容 facade；公开路由直接依赖注入的新 runtime。

保留：

- 新 Bangumi runtime 与其详情补全/Calendar 定时任务。
- ResourceSource 插件、FFZY 采集和定时增量更新。
- Mapping runtime、XLSX CLI 和阈值分析工具。
- 账号、令牌和追番同步域。
- 现有公开 API 路径和 DTO 字段。
- Heartbeat、Health、封面代理 URL 生成和 Bangumi 代理配置。

删除旧代码必须以导入图和测试证明不再被生产入口引用为前提，按批次执行，不做一次性盲删。

## 9. 数据库启动与旧数据库政策

- `initDb()` 只初始化四个新域：Bangumi、ResourceSource、Mapping、Account/Sync。
- 不探测、不迁移、不读取、不删除旧表；用户会使用全新数据库。
- 代码测试使用内存数据库或临时 SQLite 文件，不修改 `data/anime.db`。
- 正式冷启动验证使用单独的临时数据库路径和测试端口，不覆盖当前本地数据库。

## 10. 错误与一致性

- 投影查询是只读操作，不跨域开启写事务。
- Detail 与 Play 的线路/分集计算必须共享纯函数，避免 `ch` 或 `ep` 不一致。
- 注册表顺序是线路顺序的唯一来源，不依赖 SQLite 无序结果。
- 缺失子表行按空字段处理，不使整个主体查询失败。
- 悬空映射由外键阻止；查询仍使用内连接忽略无法解析的资源项。
- 非法或无法安全转换的公开 FFZY ID 不影响内部字符串查询，只使 `sourceAid` 为 `null`。
- 路由继续使用现有错误 envelope 和 HTTP 状态码。

## 11. 分批实施

1. 为 ResourceSource 增加 `displayName`，让注册表暴露稳定有序的公开采集站描述。
2. 建立公共主体、搜索、Calendar 的新域只读投影与 DTO 适配。
3. 建立映射分集纯投影及 Detail/Play 查询。
4. 建立 Updates 投影和事实推导资源状态。
5. 组合 `publicApiRuntime` 并注入 `server.js`，切换所有公开路由。
6. 删除旧初始化、旧服务、旧配置和旧命令。
7. 运行完整单元/契约测试和静态旧链路扫描。
8. 使用全新临时数据库完成首次 Bangumi/FFZY 启动及 Detail/Play/Updates 端到端验证。

每批先写失败测试，再实现最小切换，保持可独立提交和回滚。

## 12. 验收标准

- 全新数据库只包含四个新域的表，不包含任何旧运行表。
- Search 和 Calendar 只读取新 Bangumi 域。
- Detail 只组合新 Bangumi、映射和采集站域，并正确返回摘要级条目。
- 一对一、封闭分段、开放分段和空档均产生正确 Detail/Play 投影。
- 分段标题保持原文，`index` 从 1 开始，`sourceIndex` 保留源编号。
- Updates 只归属包含当前最新源分集的季度。
- 资源状态只出现 `ready`、`wait_airing`、`no_data`。
- 公开 DTO 和 Aslan 现有解析契约不变。
- 生产入口和 `package.json` 不引用旧服务、旧配置或旧管理命令。
- 完整测试通过，`git diff --check` 通过。
- 临时全新数据库完成服务启动、一次 Bangumi 元数据获取、一次 FFZY 初始化/增量过程和公开 API 请求验证；若测试代理或外部服务不可用，报告外部失败证据，但本地初始化与错误隔离必须通过。

## 13. 明确不做

- 不迁移旧数据库。
- 不保留旧表兼容读取或双写。
- 不修改 Aslan 或其他客户端。
- 不建立长期 `no_resource`、`wait`、重试次数或匹配历史表。
- 不自动创建分段映射。
- 不重写采集站分集标题。
- 不让公开读取请求直接访问 Bangumi 或采集站。
- 不新增后台管理页面或 HTTP 管理接口。
