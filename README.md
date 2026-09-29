# 抖音视频 → 逐帧图片（本机轻量工具）

在自己电脑上解析抖音并抽帧。**一般不必登录**。默认用系统 Edge/Chrome，不附带 Electron。

## 解析策略

1. 纯 HTTP  
2. 可选 yt-dlp  
3. 本机 Edge/Chrome 无头打开作品页拦直链（访客即可）

## 环境

- Node.js >= 18  
- Edge 或 Chrome（Windows 通常已有）  
- FFmpeg（有 PATH 即用；否则首次自动准备精简版）

## 开发

```bash
npm install
npm start          # http://127.0.0.1:3780
npm run desktop    # 系统浏览器 --app 窗口（最轻）
npm run cli -- "https://www.douyin.com/video/数字ID"
```

## 打包（推荐：带依赖的 exe 便携包）

内置便携 Node + **精简 FFmpeg** + 小启动器，双击 `DouyinFrames.exe`：

```bash
npm run pack:portable
```

产物：`dist/DouyinFrames-portable/`

| 内容 | 说明 |
|------|------|
| `DouyinFrames.exe` | 无边框 WebView2 启动器（无 Electron） |
| `WebView2Loader.dll` | 与 exe 同目录，缺了会闪退 |
| `tools/node/` | 便携 Node |
| `tools/ffmpeg/` | 精简 ffmpeg + ffprobe |
| `src/` `public/` `node_modules/` | 应用与依赖 |

窗口为无边框本机壳（tao/wry + 系统 WebView2），不另开浏览器、不附带 Chromium。

### 安装包（推荐分发，更小）

不内置 Node / FFmpeg；首次运行自动检测，缺失则下载到 `%LOCALAPPDATA%\DouyinFrames\runtime\`：

```bash
npm run pack:setup
```

产物：`dist/DouyinFrames-setup/DouyinFrames-Setup-*.exe`（需本机有 Inno Setup 6，脚本也会尝试自动下载编译器）

更轻、不含 Node/FFmpeg 预置（需本机已装）：`npm run pack:lite`

## 说明

- 不作为公网零安装站点设计。  
- 解析失败时可上传本地视频，或用「高级」书签从已打开的作品页带回直链。
