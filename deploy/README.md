# 部署到二级域名（无端口访问）

## 架构

```
用户 → https://frames.example.com (443)
         ↓ Nginx / Caddy
       127.0.0.1:3780 (Node，仅本机)
```

外网只开 80/443，**不要**开放 3780。

## 最短步骤

1. DNS：`frames` → 服务器 IP  
2. 服务器：`npm install` + Playwright + FFmpeg  
3. `pm2 start deploy/ecosystem.config.cjs`  
4. 启用 `deploy/nginx.frames.example.com.conf`（把 `example.com` 换成你的域名）  
5. `certbot --nginx -d frames.你的域名`

详细说明见项目根目录 `README.md`「部署到二级域名」。

若要用别的二级域名（如 `video.example.com`），改 DNS 主机记录，并把 Nginx `server_name`、Caddyfile、PM2 里的 `ALLOWED_ORIGINS` 一并改掉。
