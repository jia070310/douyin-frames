#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { initProxy } from './lib/proxy.js';
import { runExtractJob } from './lib/pipeline.js';
import { pushResolvedToRemote } from './lib/remotePush.js';
import { ensureFfmpeg } from './lib/deps.js';

await initProxy();

try {
  const dataDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'DouyinFrames',
    'runtime',
  );
  await ensureFfmpeg({ dataDir });
} catch (err) {
  console.warn('[ffmpeg] 未就绪:', err?.message || err);
}

function printHelp() {
  console.log(`
抖音视频 → 逐帧图片

用法:
  npm run cli -- <抖音链接> [选项]
  npm run cli -- --file <本地视频> [选项]
  npm run cli -- <抖音链接> --remote <服务器地址> [选项]

选项:
  --file <path>               直接处理本地视频（跳过抖音下载）
  --remote <baseUrl>          本机解析后推到远程服务器抽帧（开发用）
  --mode <every|fps|seconds>  采样方式，默认 every（逐帧）
  --fps <n>                   mode=fps 时每秒抽几帧，默认 1
  --interval <n>              mode=seconds 时间隔秒数，默认 1
  --format <jpg|png|webp>     图片格式，默认 jpg
  --quality <n>               jpg 质量 2-31（越小越好，默认 2）
  --help                      显示帮助

说明:
  本机工具：纯 HTTP 解析（可选 yt-dlp）+ FFmpeg 抽帧，无 Chromium。
  解析失败时可上传本地视频，或安装 yt-dlp 后重试。

示例:
  npm run cli -- --file ./demo.mp4 --mode fps --fps 1
  npm run cli -- "https://v.douyin.com/xxxx"
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--remote') args.remote = argv[++i];
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--fps') args.fps = Number(argv[++i]);
    else if (a === '--interval') args.interval = Number(argv[++i]);
    else if (a === '--format') args.format = argv[++i];
    else if (a === '--quality') args.quality = Number(argv[++i]);
    else if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    else args._.push(a);
  }
  return args;
}

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function readJson(res) {
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(res.ok ? '服务器返回了无法解析的响应' : `HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }
}

async function pollRemoteJob(baseUrl, jobId) {
  const labels = {
    queued: '排队中…',
    resolve: '正在解析…',
    download: '正在下载原视频…',
    probe: '正在读取视频信息…',
    frames: '正在导出帧图片…',
  };

  for (;;) {
    await sleep(900);
    const res = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || '查询失败');
    process.stdout.write(`\r[${data.stage}] ${data.message || labels[data.stage] || data.stage}          `);
    if (data.stage === 'done') {
      process.stdout.write('\n');
      return data.result;
    }
    if (data.stage === 'error') {
      process.stdout.write('\n');
      throw new Error(data.message || '远程任务失败');
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.file && args._.length === 0)) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  if (args.remote) {
    const baseUrl = stripTrailingSlash(args.remote);
    const url = args._[0];
    if (!url) throw new Error('--remote 模式需要提供抖音链接');
    console.log('链接:', url);
    console.log('远程:', baseUrl);
    const created = await pushResolvedToRemote({
      url,
      remoteBase: baseUrl,
      mode: args.mode || 'every',
      fps: args.fps ?? 1,
      interval: args.interval ?? 1,
      format: args.format || 'jpg',
      quality: args.quality ?? 2,
      prefer: 'auto',
      onProgress: (msg) => console.log(`[remote] ${msg}`),
    });
    console.log(`[job] ${created.jobId} via=${created.via}`);
    const result = await pollRemoteJob(baseUrl, created.jobId);
    console.log('\n完成');
    console.log('作者:', result.meta?.author || '未知');
    console.log('描述:', result.meta?.desc || '（无）');
    console.log('帧数量:', result.frames?.count);
    console.log('原视频:', `${baseUrl}${result.videoUrl}`);
    console.log('结果 JSON:', `${baseUrl}${result.resultUrl}`);
    return;
  }

  const url = args._[0];
  if (url) console.log('链接:', url);
  if (args.file) console.log('本地文件:', args.file);

  const result = await runExtractJob({
    url,
    localVideo: args.file,
    allowServerResolve: true,
    allowUrlResolve: true,
    mode: args.mode || 'every',
    fps: args.fps ?? 1,
    interval: args.interval ?? 1,
    format: args.format || 'jpg',
    quality: args.quality ?? 2,
    onEvent: ({ stage, message }) => {
      console.log(`[${stage}] ${message || ''}`);
    },
  });

  console.log('\n完成');
  console.log('视频:', result.video.path);
  console.log('帧目录:', result.frames.dir);
  console.log('帧数量:', result.frames.count);
  console.log('结果 JSON:', path.join(path.dirname(result.video.path), 'result.json'));
}

main().catch((err) => {
  console.error('\n失败:', err.message || err);
  process.exit(1);
});
