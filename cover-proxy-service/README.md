# Laeva Cover Proxy

独立封面代理服务，部署在带宽较高的图片服务器上。主站生成带签名的封面 URL，本服务校验签名后从 Bangumi 图片源拉取封面，写入本地缓存并返回给浏览器。

## 环境变量

- `COVER_PROXY_SECRET`: 必填，必须与 LaevaBangumi 主站一致。
- `COVER_UPSTREAM_PROXY_URL`: 可选，用于访问 Bangumi 图片源，例如 `http://127.0.0.1:7890`。
- `COVER_CACHE_DIR`: 可选，默认 `/var/cache/laeva-covers`。
- `COVER_ALLOWED_HOSTS`: 可选，默认 `lain.bgm.tv,bgm.tv,bangumi.tv,chii.in`。
- `PORT`: 可选，默认 `3010`，只监听 `127.0.0.1`。

## 部署

```bash
cd /home/admin/cover-proxy-service
npm ci

mkdir -p /var/cache/laeva-covers
chown -R admin:admin /var/cache/laeva-covers

COVER_PROXY_SECRET='同一段随机密钥' \
COVER_UPSTREAM_PROXY_URL='http://127.0.0.1:7890' \
pm2 start ecosystem.config.cjs
```

主站 LaevaBangumi 需要配置同一个密钥：

```bash
COVER_PROXY_BASE='https://img.laevatain.top' \
COVER_PROXY_SECRET='同一段随机密钥' \
BANGUMI_PROXY_URL='http://127.0.0.1:7890' \
pm2 restart LaevaBangumi --update-env
```

## Nginx 示例

```nginx
server {
    listen 80;
    server_name img.laevatain.top;
    return 301 https://$host$request_uri;
}

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
