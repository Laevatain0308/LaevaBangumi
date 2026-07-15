# 账号与追番记录同步重构设计

> 日期：2026-07-16
>
> 范围：只重构 LaevaBangumi 服务端的账号密码、设备令牌、观看记录、分集进度、收藏状态、多设备同步以及这些记录引用的 Bangumi 元数据补全。Aslan 客户端暂不修改。

## 目标

- 用服务端后台命令管理个人账号密码，不提供公开注册、邀请码或公开改密接口。
- 使用账号密码登录并签发与设备绑定、可撤销的长期 Token；后续请求不再携带密码。
- 同步观看记录和收藏状态，保持原有多设备离线合并、事件幂等、删除墓碑和全量清除水位语义。
- 统一以 `bangumiId` 作为观看、分集进度和收藏的业务键。
- 私人同步域不复制 Bangumi 标题、封面、评分等元数据，也不保存采集站播放 URL。
- 同步记录可以引用尚未进入 Calendar 或尚无本地元数据的 Bangumi ID，并异步补全、周期刷新其元数据。
- 采用职责一致、语义明确的全新表和模块边界。

## 非目标与切换前提

- 不修改 Aslan 或其他客户端。本次上线后，旧客户端在完成后续适配前不能使用账号或同步 API。
- 不保留旧 `/api/sync/*` 协议适配层。
- 不读取、迁移、导出、导入、转换或删除任何旧账号与同步表内容。
- 不实现迁移 JSON/XML、旧事件账本迁移或旧密码哈希迁移。
- 不识别旧私有同步 schema，也不提供旧表清理命令。
- 部署前由维护者直接删除旧数据库；新版只需支持全新数据库初始化。
- 不提供邀请、注册、账号禁用、后台创建 Token、后台按 Token ID 撤销、登录失败限流或 Token 自动过期。
- 不改变 FFZY 采集、Bangumi 与资源匹配、播放映射等其他业务规则。

## 已选方案

采用“不可变事件账本 + 规范化当前状态”方案：

1. `sync_events` 永久保存服务端已接收的事件，用于重复上传去重和问题追踪。
2. 每次合并在同一事务中按版本顺序将新事件应用到观看、进度、收藏、墓碑和清除水位表。
3. 快照直接读取规范化当前状态，不在请求时重放全部事件。
4. Bangumi 元数据属于公共域，快照只按 `bangumiId` 关联当前公共数据。

未采用以下方案：

- 仅保存事件并在读取时重放：事件永久增长后读取成本持续增加，规则变化也可能改变历史重放结果。
- 仅保存当前状态：无法可靠识别设备重试的重复事件，也难以保持离线删除和清空语义。
- 在私人表保存完整 Bangumi JSON：会产生过时的标题、封面和评分副本，并扩大事件负载。

## 总体架构

```text
account CLI
  -> accountService
       -> accountRepository
            -> accounts / account_devices / account_tokens

/api/account/*
  -> accountService

/api/sync/*
  -> account authentication
  -> syncEventValidator
  -> syncMergeService
       -> syncRepository
            -> sync_events + normalized tracking tables
  -> syncSnapshotService
       -> Bangumi metadata repository (local read only)
  -> metadataEnsureService (post-commit, persistent due state)
       -> Bangumi detail refresh worker
```

模块职责：

- `src/accounts/accountRepository.js`：只执行账号、设备和 Token SQL。
- `src/accounts/password.js`：账号规范化、密码哈希与校验。
- `src/accounts/accountService.js`：后台账号管理、登录、Token 轮换、注销和认证。
- `src/sync/syncEventValidator.js`：严格校验新版事件 DTO 并生成冲突版本。
- `src/sync/syncRepository.js`：事件记账、当前状态、墓碑和水位 SQL。
- `src/sync/syncMergeService.js`：单事务排序和应用事件，不访问网络。
- `src/sync/syncSnapshotService.js`：构建快照并批量关联 Bangumi 新元数据域。
- `src/bangumi/metadataEnsureService.js`：按 `bangumiId` 幂等确保详情补全任务存在。
- `src/routes/accountRoutes.js`：新版账号 HTTP API。
- `src/routes/syncRoutes.js`：新版追番同步 HTTP API。
- `src/scripts/account.js`：后台账号管理命令。

路由和服务不得直接拼接 SQL。账号与同步模块不得依赖旧私有同步服务、旧 `subjects` 表或旧资源表。

## 数据模型

所有本地时间使用 UTC ISO 8601 文本；客户端业务时间和冲突版本中的时间使用非负整数 Unix 毫秒。

### `accounts`

- `account_id INTEGER PRIMARY KEY AUTOINCREMENT`
- `username TEXT NOT NULL UNIQUE`
- `password_hash TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `password_changed_at TEXT NOT NULL`

`username` 在服务边界去除首尾空格并转为小写，登录大小写不敏感。数据库只保存规范化值。账号名长度为 1–64 个字符。

密码长度为 8–256 个字符，继续使用带随机盐的 scrypt 哈希。数据库和 API 永不保存或返回明文密码。

### `account_devices`

- `account_id INTEGER NOT NULL`
- `device_id TEXT NOT NULL`
- `device_name TEXT`
- `platform TEXT`
- `app_version TEXT`
- `first_seen_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`
- 主键：`(account_id, device_id)`
- 外键：`account_id -> accounts`，账号删除时级联删除

`device_id` 是客户端生成的稳定设备标识，长度为 1–128 个字符。设备名称、平台和版本各不超过 128 个字符。登录和合并请求更新 `last_seen_at`；设备首次登录设置 `first_seen_at`。

### `account_tokens`

- `token_id INTEGER PRIMARY KEY AUTOINCREMENT`
- `account_id INTEGER NOT NULL`
- `device_id TEXT NOT NULL`
- `token_hash TEXT NOT NULL UNIQUE`
- `created_at TEXT NOT NULL`
- `last_used_at TEXT`
- `revoked_at TEXT`
- 复合外键：`(account_id, device_id) -> account_devices`，设备或账号删除时级联删除
- 部分唯一索引：同一 `(account_id, device_id)` 只能有一个 `revoked_at IS NULL` 的 Token

原始 Token 只在登录成功响应中返回一次，使用固定前缀和高熵随机字节生成。数据库只保存 SHA-256 哈希。Token 不自动过期。

同设备重新登录时，在单事务内先撤销该设备现有有效 Token，再签发新 Token；其他设备不受影响。修改密码时撤销该账号全部有效 Token。

### `sync_events`

- `account_id INTEGER NOT NULL`
- `event_id TEXT NOT NULL`
- `device_id TEXT NOT NULL`
- `seq INTEGER NOT NULL CHECK (seq >= 0)`
- `domain TEXT NOT NULL CHECK (domain IN ('watch', 'collection'))`
- `operation TEXT NOT NULL`
- `bangumi_id INTEGER`
- `updated_at_ms INTEGER NOT NULL`
- `version TEXT NOT NULL`
- `payload_json TEXT NOT NULL`
- `received_at TEXT NOT NULL`
- 主键：`(account_id, event_id)`
- 外键：`account_id -> accounts`，账号删除时级联删除

事件账本永久保留，不实现压缩、归档或清理任务。`payload_json` 只保存新版操作所需的最小业务字段，不包含 Bangumi 元数据、播放 URL 或旧协议字段。

### `watch_records`

- `account_id INTEGER NOT NULL`
- `bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0)`
- `last_watch_episode INTEGER NOT NULL CHECK (last_watch_episode >= 1)`
- `last_watch_time_ms INTEGER NOT NULL CHECK (last_watch_time_ms >= 0)`
- `last_watch_episode_name TEXT NOT NULL`
- `record_version TEXT NOT NULL`
- 主键：`(account_id, bangumi_id)`
- 外键：`account_id -> accounts`，账号删除时级联删除

不对 `bangumi_id` 建立外键。该 ID 可以暂时不存在于 `bangumi_subjects`。

### `watch_progress`

- `account_id INTEGER NOT NULL`
- `bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0)`
- `episode INTEGER NOT NULL CHECK (episode >= 1)`
- `road INTEGER NOT NULL CHECK (road >= 0)`
- `progress_ms INTEGER NOT NULL CHECK (progress_ms >= 0)`
- `progress_version TEXT NOT NULL`
- 主键：`(account_id, bangumi_id, episode)`
- 外键：`account_id -> accounts`，账号删除时级联删除

分集进度独立版本化；两台设备更新不同集数时互不覆盖。

### `watch_tombstones`

- `account_id INTEGER NOT NULL`
- `bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0)`
- `deleted_version TEXT NOT NULL`
- 主键：`(account_id, bangumi_id)`
- 外键：`account_id -> accounts`，账号删除时级联删除

删除观看记录时同时删除该番剧全部分集进度，并写入墓碑。更新版本的新 upsert 可以恢复记录并清除墓碑；旧 upsert 不能复活记录。

### `watch_state`

- `account_id INTEGER PRIMARY KEY`
- `clear_version TEXT`
- 外键：`account_id -> accounts`，账号删除时级联删除

`watch.clear` 删除当前观看记录、分集进度和旧墓碑，并写入清除水位。水位之前或相同版本的离线事件不得重新创建记录。

### `collection_records`

- `account_id INTEGER NOT NULL`
- `bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0)`
- `type INTEGER NOT NULL CHECK (type BETWEEN 1 AND 5)`
- `collected_at_ms INTEGER NOT NULL CHECK (collected_at_ms >= 0)`
- `updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)`
- `record_version TEXT NOT NULL`
- 主键：`(account_id, bangumi_id)`
- 外键：`account_id -> accounts`，账号删除时级联删除

收藏类型继续使用客户端既有 1–5 语义，不在本次服务端重构中重新定义枚举含义。

### `collection_tombstones`

- `account_id INTEGER NOT NULL`
- `bangumi_id INTEGER NOT NULL CHECK (bangumi_id > 0)`
- `deleted_version TEXT NOT NULL`
- 主键：`(account_id, bangumi_id)`
- 外键：`account_id -> accounts`，账号删除时级联删除

### `collection_state`

- `account_id INTEGER PRIMARY KEY`
- `clear_version TEXT`
- 外键：`account_id -> accounts`，账号删除时级联删除

收藏删除、恢复和清除的版本语义与观看记录一致。

## 全新数据库初始化

新增独立的账号同步 schema 初始化器，并在 `initDb()` 中调用。它只创建本设计列出的新版表、索引和约束。

从现有数据库初始化代码中移除以下旧私有表 DDL 和 Drizzle 定义：

- `sync_users`
- `sync_credentials`
- `sync_invites`
- `sync_tokens`
- `sync_devices`
- 旧 `sync_events`
- `watch_history_items`
- 旧 `watch_progress`
- `watch_deleted_items`
- `watch_clear_state`
- `collection_items`
- `collection_deleted_items`
- `collection_clear_state`

初始化器不执行 `DROP TABLE`，不检查以上表是否存在，也不读取其内容。测试和生产部署都以全新数据库为前提。

## 账号生命周期

### 后台命令

新增脚本入口：

```bash
npm run account -- add --username alice --password password
npm run account -- set-password --username alice --password new-password
npm run account -- delete --username alice
npm run account -- list
```

命令规则：

- `add`：规范化账号名，校验账号与密码，在单事务中创建账号。
- `set-password`：账号必须存在；生成新 scrypt 哈希、更新时间，并在同一事务撤销该账号全部有效 Token。
- `delete`：账号必须存在；级联硬删除账号、设备、Token、事件和全部私人追番状态。公共 Bangumi 元数据不受影响。
- `list`：按账号名排序，只输出 `username、createdAt、passwordChangedAt、deviceCount`。

命令允许通过 `--password` 接收明文密码，不实现隐藏输入或二次确认。删除旧 `sync:user` 命令中的创建用户/Token、撤销 Token、禁用用户和创建邀请码分支，以新的 `account` 命令替代。

### 登录和设备 Token

`POST /api/account/login` 请求：

```json
{
  "username": "alice",
  "password": "password",
  "deviceId": "device-a",
  "deviceName": "MacBook",
  "platform": "macos",
  "appVersion": "1.0.0"
}
```

成功响应数据：

```json
{
  "account": { "username": "alice" },
  "deviceId": "device-a",
  "token": "<raw token>"
}
```

登录事务执行：校验密码、upsert 设备、撤销同设备旧 Token、创建新 Token。登录失败统一返回 HTTP 401 与 `invalid_credentials`，不区分账号不存在和密码错误。不实现失败次数限流。

### 鉴权、状态和注销

- Bearer Token 鉴权直接按 `token_hash` 查询有效 Token、账号和绑定设备，不扫描全部 Token。
- 每次成功鉴权更新 Token `last_used_at`；合并请求同时更新设备 `last_seen_at`。
- `GET /api/account/status` 返回账号名、当前设备和账号全部设备列表，不返回密码哈希、Token 哈希或原始 Token。
- `POST /api/account/logout` 只撤销当前 Token。

## HTTP 路由

新版公开路由只有：

- `POST /api/account/login`
- `POST /api/account/logout`
- `GET /api/account/status`
- `POST /api/sync/merge`
- `GET /api/sync/snapshot`

删除以下旧行为：

- 邀请注册
- `/api/sync/login`、`/api/sync/logout`、`/api/sync/status`
- `/api/sync/register-device`
- `/api/sync/clear`
- 任何旧同步 DTO 兼容解析

账号路由与同步路由继续使用统一 API envelope 和稳定错误码。

## 新版同步事件

### 公共事件字段

每个事件必须包含：

```json
{
  "eventId": "device-a:42",
  "deviceId": "device-a",
  "seq": 42,
  "domain": "watch",
  "op": "watch.upsertProgress",
  "updatedAt": 1784131200000,
  "bangumiId": 123,
  "payload": {}
}
```

规则：

- 单次合并最多 100 个事件。
- `eventId` 和 `deviceId` 长度为 1–128；`seq` 是非负整数。
- `updatedAt` 是非负安全整数 Unix 毫秒。
- 事件 `deviceId` 必须与当前 Token 绑定设备完全一致。
- `updatedAt` 与服务端接收时间的绝对差不得超过 24 小时；恰好 24 小时允许。
- 版本为左侧补零至 16 位的十进制 `updatedAt`、分隔符 `|` 和 `eventId`。
- 相同时间由 `eventId` 字典序稳定决胜。
- `(account_id, event_id)` 已存在时视为重复事件，不再次应用，并在响应中列入 `duplicateEventIds`。
- 已存在于当前账号事件账本中的 `eventId` 在确认设备与 Token 绑定设备一致后直接记为重复，不再次校验业务负载或 24 小时时钟偏差；因此响应丢失后的迟延重传仍保持幂等。
- 任一未接收过的新事件字段、负载或时钟偏差非法时，整批拒绝。

### `watch.upsertProgress`

```json
{
  "bangumiId": 123,
  "payload": {
    "episode": 3,
    "lastWatchEpisode": 3,
    "road": 0,
    "progressMs": 120000,
    "lastWatchTime": 1784131200000,
    "lastWatchEpisodeName": "第 3 集"
  }
}
```

- `bangumiId、episode、lastWatchEpisode` 必须为正整数。
- `road、progressMs、lastWatchTime` 必须为非负整数。
- 集标题是字符串，最长 256 个字符，可为空字符串。
- 事件版本若不早于当前 `watch_records.record_version`，更新最近观看状态。
- 同一事件版本若不早于对应集的 `progress_version`，更新该集线路和播放位置。
- 事件必须晚于观看清除水位和该番剧删除墓碑。
- 合法的新事件可以清除墓碑并恢复观看记录。

### `watch.delete`

要求正整数 `bangumiId`，负载为空对象。若版本不早于当前记录和墓碑且晚于清除水位，则删除该番剧观看记录及全部分集进度，并写入/更新墓碑。

### `watch.clear`

`bangumiId` 必须省略，负载为空对象。若版本晚于当前清除水位，则删除账号的全部观看记录、分集进度和旧墓碑，并更新清除水位。

### `collection.upsert`

```json
{
  "bangumiId": 123,
  "payload": {
    "type": 2,
    "collectedAt": 1784131200000
  }
}
```

`bangumiId` 为正整数，`type` 为 1–5 的整数，`collectedAt` 为非负整数。`updated_at_ms` 取事件 `updatedAt`。版本、墓碑、恢复和清除水位规则与观看记录一致。

### `collection.delete` 与 `collection.clear`

语义分别对应单条收藏删除和全部收藏清空，版本规则与观看领域一致。

## 合并事务

`POST /api/sync/merge` 请求只包含 `events`，不再在请求顶层重复提交设备 ID。

处理流程：

1. 鉴权并取得 `accountId + deviceId`。
2. 在事务外校验请求容器和事件基本身份字段，并固定本次服务端接收时间；所有事件设备都必须匹配 Token 绑定设备。
3. 开启一个 SQLite 事务，并按 `(account_id, event_id)` 查询/插入事件账本以区分新事件和重复事件。
4. 对未接收过的新事件严格校验业务负载和 24 小时时钟偏差；重复事件不重新校验已经处理过的时间与负载。
5. 任一新事件非法时回滚本批插入；否则按 `version` 升序应用全部新事件。
6. 更新设备 `last_seen_at` 并提交。
7. 事务提交后收集本批新观看/收藏事件引用的 `bangumiId`，调用幂等 `ensureMetadata()`。
8. 构建并返回完整最新快照。

任何校验或数据库写入失败都不得产生部分事件或部分状态。Bangumi 补全登记或网络失败不回滚已经成功的私人同步事务。

成功响应包含：

```json
{
  "acceptedEventIds": ["device-a:42"],
  "duplicateEventIds": [],
  "snapshot": {}
}
```

## 同步快照

快照结构：

```json
{
  "generatedAt": 1784131200000,
  "watch": {
    "clearVersion": null,
    "records": [
      {
        "bangumiId": 123,
        "lastWatchEpisode": 3,
        "lastWatchTime": 1784131200000,
        "lastWatchEpisodeName": "第 3 集",
        "recordVersion": "...",
        "progresses": {
          "3": {
            "episode": 3,
            "road": 0,
            "progressMs": 120000,
            "version": "..."
          }
        },
        "subject": null
      }
    ]
  },
  "collection": {
    "clearVersion": null,
    "records": [
      {
        "bangumiId": 123,
        "type": 2,
        "collectedAt": 1784131200000,
        "updatedAt": 1784131200000,
        "recordVersion": "...",
        "subject": null
      }
    ]
  }
}
```

快照服务一次收集所有唯一 `bangumiId`，批量查询 `bangumi_subjects` 及其图片、评分和标签，避免逐条 N+1 查询。`subject` 使用 Bangumi 新元数据域的规范化公共摘要；本地无元数据时严格返回 `null`。

快照只访问本地数据库，不同步访问 Bangumi。构建后可将缺失、摘要或过期 ID 交给 `ensureMetadata()`，该操作幂等且不改变本次返回内容。

## Bangumi 元数据确保与刷新

### 持久化状态

全新数据库中的 `bangumi_subject_refresh_state` 调整为既能表示首次待补全，也能表示成功刷新和失败退避：

- `bangumi_id INTEGER PRIMARY KEY CHECK (bangumi_id > 0)`
- `last_succeeded_at TEXT`
- `next_refresh_at TEXT NOT NULL`
- `last_attempted_at TEXT`
- `consecutive_failures INTEGER NOT NULL DEFAULT 0`
- `last_error TEXT`
- `updated_at TEXT NOT NULL`

该表不再对 `bangumi_subjects` 建外键，从而允许先为未知 ID 登记持久化待办。详情成功后写入/更新公共元数据并将 `next_refresh_at` 设置为 7 天后。

### `ensureMetadata(ids)`

对去重后的正整数 ID 批量执行：

- 无刷新状态行：插入 `next_refresh_at = now` 的待办。
- 已有成功详情且 `next_refresh_at > now`：不修改。
- 失败且尚未到 `next_refresh_at`：不修改。
- 已到期：保持/设置为立即可执行，不创建重复行。

主键确保同一 ID 只有一个待办。该方法只写本地状态，不执行网络请求。

以下发现路径都调用同一个确保入口：

- Calendar 摘要成功持久化后。
- Bangumi 搜索结果成功持久化后，包括不在 Calendar 的番剧。
- 观看或收藏合并事务提交后。
- 同步快照发现元数据缺失或过期时。
- 显式 Bangumi 详情读取发现详情未完成或已过期时。

### 后台刷新 worker

- 服务启动时扫描所有 `next_refresh_at <= now` 的 ID。
- 新待办写入后以进程内单飞唤醒信号触发扫描；持久化状态保证服务重启后不会丢失。
- 每批最多 100 个；若本批结束后仍有到期项，继续下一批，直到当前没有到期项。
- 最多并发 2 个请求，相邻请求开始时间至少间隔 500ms。
- 单个 ID 成功或失败不阻止其他 ID。
- 第 1、2、3 次及以后连续失败分别等待 6 小时、24 小时、72 小时；之后固定 72 小时。
- 成功后清零失败次数、清除错误并设置 7 天刷新时间。
- 进程崩溃时无需持久化 `running` 状态；尚未成功的到期行在下次启动继续处理。

同步合并和快照绝不等待该 worker，也不因其失败返回错误。

## 错误语义

- 登录字段非法：HTTP 400，`invalid_query`。
- 账号不存在或密码错误：HTTP 401，`invalid_credentials`。
- Token 缺失、无效或已撤销：HTTP 401，`unauthorized`。
- 同步事件结构非法：HTTP 400，`invalid_sync_event`。
- 事件设备与 Token 不匹配：HTTP 400，`device_mismatch`。
- 任一事件时间偏差超过 24 小时：HTTP 400，`clock_skew`。
- 未知 `bangumiId`：不是错误；私人记录照常保存，快照 `subject: null`。
- SQLite 事务失败：HTTP 500，整批回滚。
- Bangumi 确保登记或详情请求失败：记录日志/退避，不改变同步 API 成功结果。

错误响应不暴露密码、哈希、Token、SQL、完整事件负载或 Bangumi 原始响应。

## 测试设计

### Schema

- 全新数据库的账号/同步私有域只创建本设计的 11 张新版表；Bangumi、资源源等其他独立域仍创建各自表。
- 主键、唯一索引、CHECK、账号级联删除正确。
- 观看和收藏的 `bangumi_id` 不对公共元数据建立外键。
- 旧 13 张私有表不会由全新初始化创建。
- `bangumi_subject_refresh_state` 可以在 `bangumi_subjects` 缺少 ID 时创建待办。

### 账号与后台命令

- `add` 规范化账号名并仅保存 scrypt 哈希。
- 大小写不同的重复账号被拒绝。
- 登录正确密码成功，错误密码统一失败。
- 同一设备重新登录撤销旧 Token；另一设备 Token 保持有效。
- Token 数据库只保存 SHA-256 哈希，鉴权直接按哈希查询。
- `set-password` 撤销账号全部 Token，新密码有效、旧密码失效。
- `delete` 级联删除全部私人数据但不删除 Bangumi 公共数据。
- `list` 不暴露密码或 Token 信息。
- 账号 API 不包含注册、邀请、公开改密和失败限流。

### 同步合并

- 相同 `eventId` 重传只记账/应用一次。
- 同账号事件按 `updatedAt + eventId` 排序；同毫秒稳定决胜。
- 不同分集进度独立合并。
- 删除墓碑阻止旧事件，更新事件可以恢复。
- 清除水位阻止清空前离线事件复活。
- 观看和收藏可以独立删除/清空。
- 收藏类型只允许 1–5。
- Token 设备与事件设备必须一致。
- 新事件的 24 小时边界接受，超过 1 毫秒整批拒绝；已处理事件的迟延重传仍报告为重复。
- 单批超过 100、字段过长、负数或非整数、未知领域/操作均整批拒绝。
- 任一数据库写入失败时事件账本与当前状态一起回滚。

### 快照

- 只从规范化状态表生成，事件账本不参与重放。
- 关联 Bangumi 新元数据域，不读取旧 `subjects`。
- 同一 ID 在观看和收藏同时出现时只批量读取一次。
- 元数据缺失返回 `subject: null`，且请求不访问网络。
- 快照不包含 `bangumiItem、entityKey、adapterName、lastSrc`。

### 元数据确保

- 未知 ID、Calendar 摘要、搜索摘要和私人记录引用都创建一个待办。
- 同一 ID 重复确保不创建重复行或提前突破退避。
- 到期 ID 在单飞 worker 中按每批 100、并发 2、500ms 间隔处理。
- 首次详情成功进入 7 天刷新；失败按 6h/24h/72h 退避。
- Bangumi 失败不回滚同步记录。
- 服务重启后持久化待办仍可继续。

### API 与边界

- 只存在已定义的五个账号/同步端点。
- 旧 `/api/sync/register`、旧登录/状态/注销、设备注册和清空端点返回 404。
- 静态检查新模块不导入旧私有同步服务或旧 `subjects` 仓储。
- 默认测试使用临时 SQLite，不读取或修改 `data/anime.db`，也不访问真实 Bangumi 网络。

## 验收标准

- 删除数据库后首次启动能创建全新账号/同步 schema，且不创建旧私有表。
- `npm run account -- add` 可创建账号，账号密码可登录并取得设备 Token。
- 同设备重新登录使旧 Token 失效，其他设备不受影响。
- 两台设备离线产生乱序、重复、删除和清除事件后，最终快照稳定且可重复。
- 超过 24 小时时钟偏差的批次不会产生任何写入。
- 私人表和事件负载不保存 Bangumi 元数据副本、旧业务键或播放 URL。
- 未知和非 Calendar 番剧不阻止同步，并能异步获得完整详情及每 7 天刷新。
- 不存在邀请注册、旧协议、迁移工具或旧数据兼容逻辑。
- 完整自动测试通过，不修改生产数据库。
