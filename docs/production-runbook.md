# LaevaBangumi 生产运行手册

本文档是 LaevaBangumi 服务端在生产环境的运维指南，覆盖依赖安装、环境变量、
首次启动、PM2 日常运维、账号与映射工作簿、日志、升级、备份恢复与常见故障。

服务端只处理动漫（anime）：公开 API 的 `type` 仅接受 `anime`，缺省即为
`anime`；`tv`、`movie`、`variety` 等其余取值一律返回 HTTP 400
（`invalid_query`）。采集端当前只启用 FFZY 的日韩动漫分类（`tid=30`）。

## 1. 环境与依赖

- Node.js 20+（项目为 ESM，`package.json` 中 `"type": "module"`）。
- SQLite 由 better-sqlite3 内嵌，无需单独安装数据库服务。
- 全局安装 PM2：`npm i -g pm2`。
- 安装依赖：在仓库根目录执行 `npm ci`（首次或锁文件变更后）或 `npm install`。
- 目录准备：PM2 会自动创建 `logs/`；数据库目录 `data/` 需存在或可写（首次启动
  会自动创建 `data/anime.db`）。

## 2. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3002` | HTTP 监听端口 |
| `LAEVA_DB_PATH` | `data/anime.db` | SQLite 数据库文件路径 |
| `BANGUMI_PROXY_URL` | 空 | 访问 Bangumi 使用的 HTTP(S) 代理地址 |
| `COVER_PROXY_BASE` | 空 | 封面代理服务地址（可选） |
| `COVER_PROXY_SECRET` | 空 | 封面代理签名密钥（可选） |

`BANGUMI_PROXY_URL` 示例：

- 生产环境：`http://proxy.example.com:8080`（按实际部署替换为真实代理地址）。
- 本地开发：`http://127.0.0.1:7897`（仅作为本机代理示例，不要照搬到生产）。

`ecosystem.config.cjs` 会从启动 PM2 时所在的 shell 透传以上变量；生产环境建议
在启动前先 `export`，或直接修改 `ecosystem.config.cjs` 的 `env` 段。

## 3. 与运行相关的目录

- `src/index.js`：服务入口。
- `ecosystem.config.cjs`：PM2 应用配置。
- `data/anime.db`：SQLite 数据库（已 git 忽略）。
- `logs/`：PM2 日志输出目录。

## 4. 首次启动（空数据库）

1. 安装依赖并配置环境变量（尤其是 `BANGUMI_PROXY_URL`）。
2. 启动 HTTP 服务：`npm start`（等价 `node src/index.js`）。日志显示
   `database initialized` 与 `server started` 即服务已就绪。
3. 触发 FFZY 首次全量采集：`npm run start:sync`（等价
   `node src/index.js --sync`）。该命令会执行资源源全量初始化（目录 + 详情）。
4. 观察日志确认 FFZY `initialize` 成功、`failedItems` 为 0。
5. 健康检查：`curl http://localhost:3002/api/health`，返回
   `{"status":"ok","uptime":...}`。

`start:sync` 是前台命令；生产环境通过 PM2 运行时，用
`pm2 start ecosystem.config.cjs -- --sync` 传入该参数。

## 5. 正常启动、停止与重启

```bash
pm2 start ecosystem.config.cjs
pm2 restart LaevaBangumi
pm2 stop LaevaBangumi
pm2 delete LaevaBangumi
pm2 save
```

手动运行：`npm start`。启动后应确认健康检查通过，再接入反代/负载均衡。

## 6. 健康检查与探活

```bash
curl http://localhost:3002/api/health
```

`/api/health` 返回进程存活状态，供 PM2、Nginx、K8s 探活使用。在线人数
heartbeat（`/api/heartbeat`）已彻底移除，不要依赖该接口。

## 7. 账号与追番同步

账号只能由服务端后台脚本维护（无邀请码、无注册接口）：

```bash
npm run account -- add --username <用户名> --password <密码>
npm run account -- set-password --username <用户名> --password <新密码>
npm run account -- delete --username <用户名>
npm run account -- list
```

客户端通过 `/api/account` 与 `/api/sync` 使用这些账号做追番记录同步。

## 8. 映射 XLSX 工作簿

导出待人工确认的映射工作簿：

```bash
npm run mapping -- export --source ffzy --output data/manual/mapping-review.xlsx
```

人工修改后导入：

```bash
npm run mapping -- import --input data/manual/mapping-review.xlsx
```

阈值分析：

```bash
npm run mapping:analyze -- <参数>
```

具体参数以 `src/scripts/mapping.js` 与 `src/mappings/mappingCli.js` 的实现为准。

## 9. 采集与调度范围

- Bangumi 元数据：按 `src/bangumi/scheduler.js` 的 cron 计划同步日历、详情与
  搜索补全；请求固定使用动画主题类型（Bangumi `type=2`）。
- FFZY 资源源：当前只采集 `tid=30`（日韩动漫）。如未来需要扩充分类，修改
  `src/resourceSources/ffzy/FFZYSource.js` 的 `CATEGORY_IDS`，不要通过恢复非动漫
  公开类型实现。
- 失败详情采用指数退避：6h → 12h → 24h，之后固定 24h；新目录再次出现该 ID 时
  无视退避时间立即尝试详情补全。

## 10. 日志

```bash
pm2 logs LaevaBangumi
pm2 logs LaevaBangumi --lines 200
```

错误日志：`logs/error.log`；标准输出：`logs/out.log`。

## 11. 升级

```bash
git pull
npm ci
pm2 restart LaevaBangumi --update-env
```

升级后检查 `/api/health` 与日志，确认无启动错误。

## 12. SQLite 备份与恢复

备份（SQLite 官方 `.backup`，对 WAL 模式安全）：

```bash
mkdir -p /backup
sqlite3 data/anime.db ".backup '/backup/anime-$(date +%F).db'"
```

恢复：先 `pm2 stop LaevaBangumi`，用备份文件替换 `data/anime.db`，再
`pm2 start LaevaBangumi`。

## 13. 常见故障

- **Bangumi 请求失败**：确认 `BANGUMI_PROXY_URL` 已配置且代理可达；错误信息中
  会包含 `proxy=enabled/disabled` 与代理地址。
- **第三方配额（如 HTTP 402）**：外部服务配额耗尽，等待配额恢复后重试；详情
  采集按退避策略自动重试。
- **FFZY 目录/详情失败**：确认资源站可达、返回 XML 中 `tid` 属于
  `CATEGORY_IDS`；不属于允许分类的条目会被防御性拒绝。
- **封面代理异常**：检查 `COVER_PROXY_BASE`/`COVER_PROXY_SECRET` 与封面代理
  服务日志；未配置时返回 Bangumi 原始封面地址。
- **数据库写入失败**：对应生命周期失败且不推进状态/水位，重启后安全重跑；已
  提交的短事务保持幂等。
- **映射异常**：工作簿导入前确认 `sourceKey` 已注册；分析阈值用
  `npm run mapping:analyze`。
- **端口被占用**：修改 `PORT` 或 `ecosystem.config.cjs` 中的端口后重启。

## 14. 封面代理部署（LaevaCoverProxy）

封面代理是独立服务（`cover-proxy-service/`），部署在高带宽机器上，校验主站
签名的封面 URL 后从 Bangumi 图片源拉取并缓存。

### 14.1 两个 PM2 应用

主站与封面代理是两套 PM2 应用，需要分别启动：

```bash
# 主站（仓库根目录）
pm2 start ecosystem.config.cjs

# 封面代理（cover-proxy-service 目录）
cd cover-proxy-service
npm ci
COVER_PROXY_SECRET='同一段随机密钥' \
COVER_UPSTREAM_PROXY_URL='http://127.0.0.1:7890' \
pm2 start ecosystem.config.cjs
pm2 save
```

两者必须使用**同一段 `COVER_PROXY_SECRET`**。

### 14.2 封面代理环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `COVER_PROXY_SECRET` | 空（必填） | 与主站一致的签名密钥 |
| `COVER_UPSTREAM_PROXY_URL` | 空 | 访问 Bangumi 图片源的上游代理 |
| `COVER_CACHE_DIR` | `/var/cache/laeva-covers` | 本地图片缓存目录（需提前创建并授权） |
| `COVER_ALLOWED_HOSTS` | `lain.bgm.tv,bgm.tv,bangumi.tv,chii.in` | 允许的图片源域名白名单 |
| `COVER_FETCH_TIMEOUT_MS` | `15000` | 上游拉取超时；代理较慢时建议调大（如 `30000`） |
| `PORT` | `3010` | 只监听 `127.0.0.1`，公网由 Nginx 反代 |

### 14.3 主站配置

```bash
COVER_PROXY_BASE='https://img.laevatain.top' \
COVER_PROXY_SECRET='同一段随机密钥' \
pm2 restart LaevaBangumi --update-env
```

配置后公开 API 的 `coverUrl` 会指向 `COVER_PROXY_BASE` 下的签名地址；未配置
`COVER_PROXY_BASE`/`COVER_PROXY_SECRET` 时回退为 Bangumi 原始封面地址。

### 14.4 Nginx 反代

```nginx
server {
    listen 443 ssl http2;
    server_name img.laevatain.top;

    ssl_certificate     /etc/nginx/ssl/img.laevatain.top.pem;
    ssl_certificate_key /etc/nginx/ssl/img.laevatain.top.key;

    location /cover/ {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering on;
    }

    location /health {
        proxy_pass http://127.0.0.1:3010;
        access_log off;
    }
}
```

### 14.5 验证

```bash
curl https://img.laevatain.top/health
curl "https://img.laevatain.top$(curl -s http://localhost:3002/api/detail?id=<番剧ID> | jq -r .data.coverUrl)"
```

首次请求响应头 `X-Cover-Cache: miss`，第二次同 URL 为 `hit`。
