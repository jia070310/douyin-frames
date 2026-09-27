# 抖音视频 → 逐帧图片

Node.js 工具：从抖音链接解析并下载原视频，再用 FFmpeg 导出帧图片。提供 CLI、Express API 与简易网页，方便后期挂到网站。

## 环境

- Node.js >= 18
- 系统已安装 [FFmpeg](https://ffmpeg.org/download.html)（`ffmpeg` / `ffprobe` 在 PATH 中）
- 首次安装会下载 Playwright Chromium（用于打开抖音网页版拿直链）

## 安装

```bash
npm install
npx playwright install chromium
```

## 快速开始

### 命令行

```bash
# 逐帧（你给的示例链接）
npm run cli -- "https://www.douyin.com/video/7596637348747106985"

# 每秒抽 2 帧（网站场景更推荐）
npm run cli -- "https://www.douyin.com/video/7596637348747106985" --mode fps --fps 2

# 本地视频直接抽帧
npm run cli -- --file ./demo.mp4 --mode every --format png
```

输出在 `output/<jobId>/`：

| 文件 | 说明 |
|------|------|
| `source.mp4` | 原视频 |
| `frames/frame_000001.jpg` | 帧图 |
| `result.json` | 元数据 |

### 本地网站

```bash
npm start
```

打开 http://localhost:3780

## HTTP API（部署用）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/jobs` | 异步任务，返回 `{ jobId }` |
| `GET` | `/api/jobs/:id` | 查状态 / 结果 |
| `GET` | `/api/jobs/:id/frames` | 帧列表 |
| `POST` | `/api/extract` | 同步执行 |

```json
{
  "url": "https://www.douyin.com/video/7596637348747106985",
  "mode": "fps",
  "fps": 1,
  "format": "jpg"
}
```

`mode`：`every`（逐帧）| `fps` | `seconds`

## 部署到二级域名（无端口）

目标访问形式：`https://frames.example.com`（把 `example.com` 换成你的域名；不要再用 `:3780`）。

原理：Node 只在服务器本机 `127.0.0.1:3780` 监听，由 Nginx/Caddy 用 **80/443** 反代出去。

### 1. DNS

在域名面板添加：

| 类型 | 主机记录 | 值 |
|------|----------|-----|
| A | `frames` | 你的服务器公网 IP |

生效后 `frames.你的域名` 应能解析到该 IP。若想用别的名字（如 `video`），同步改 Nginx/`server_name` 即可。

### 2. 服务器准备

```bash
# 依赖
sudo apt update
sudo apt install -y nginx ffmpeg
# Node 18+、git 自行安装

cd /var/www/douyin-frames   # 按你实际路径
npm install
npx playwright install chromium --with-deps

# 用 PM2 常驻（只绑本机端口，不对外开放 3780）
npm i -g pm2
# 先编辑 deploy/ecosystem.config.cjs 里的 ALLOWED_ORIGINS
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup
```

### 3. Nginx 反代

```bash
# 先把配置文件里的 example.com 改成你的域名
sudo cp deploy/nginx.frames.example.com.conf /etc/nginx/sites-available/frames.example.com
sudo ln -sf /etc/nginx/sites-available/frames.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS（推荐）：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d frames.example.com
```

也可用 Caddy：见 `deploy/Caddyfile`（自动证书）。

### 4. 防火墙

只放行 80/443，**不要**放行 3780：

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
```

### 5. 验证

浏览器打开：`https://frames.example.com`  
健康检查：`https://frames.example.com/api/health`

---

## 部署建议（摘要）

1. 服务器安装 Node.js、FFmpeg、Playwright Chromium  
2. PM2 启动，`HOST=127.0.0.1 PORT=3780`  
3. Nginx/Caddy 反代二级域名到该端口  
4. 长视频默认用 `fps` / `seconds`，并开启自动清理  

### 自动清理 `output/`

| 场景 | 默认行为 |
|------|----------|
| 点击「关闭任务」 | 约 **10 分钟**后删除该任务数据 |
| 开始新任务 | 旧任务同样约 **10 分钟**后清理 |
| 关闭/离开网页 | 自动标记，约 **10 分钟**后清理 |
| 兜底 | 超过 **24 小时**仍会清理 |

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `CLEANUP_AFTER_RELEASE_MIN` | `10` | 关闭/换任务后延迟清理（分钟），`0`=立即删 |
| `CLEANUP_TTL_HOURS` | `24` | 兜底保留时长，`0` 关闭 |
| `CLEANUP_INTERVAL_MIN` | `30` | 定期扫描间隔 |
| `CLEANUP_MAX_MB` | `0` | 体积上限 MB，`0` 不限 |

```bash
# 例如：关闭后 5 分钟清，最多留 2GB
set CLEANUP_AFTER_RELEASE_MIN=5
set CLEANUP_MAX_MB=2048
npm start
```

也可手动：

```bash
npm run cleanup
# 或 POST http://localhost:3780/api/cleanup
# 或 POST http://localhost:3780/api/jobs/<id>/release
```

## 说明

- 仅处理你有权使用的内容，请遵守抖音条款与版权要求。
- 解析依赖 Playwright 打开 `douyin.com` 网页版；移动分享页常提示「请在抖音内观看」，桌面站更稳。
- 若平台风控加强导致失败，可用 `--file` 先手动下载再抽帧。
