#!/usr/bin/env node
import path from 'node:path';
import { initProxy } from './lib/proxy.js';
import { runExtractJob } from './lib/pipeline.js';

await initProxy();

function printHelp() {
  console.log(`
抖音视频 → 逐帧图片

用法:
  npm run cli -- <抖音链接> [选项]
  npm run cli -- --file <本地视频> [选项]

选项:
  --file <path>               直接处理本地视频（跳过抖音下载）
  --mode <every|fps|seconds>  采样方式，默认 every（逐帧）
  --fps <n>                   mode=fps 时每秒抽几帧，默认 1
  --interval <n>              mode=seconds 时间隔秒数，默认 1
  --format <jpg|png|webp>     图片格式，默认 jpg
  --quality <n>               jpg 质量 2-31（越小越好，默认 2）
  --help                      显示帮助

示例:
  npm run cli -- "https://www.douyin.com/video/7596637348747106985"
  npm run cli -- "https://www.douyin.com/video/7596637348747106985" --mode fps --fps 2
  npm run cli -- --file ./demo.mp4 --mode every --format png
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--file') args.file = argv[++i];
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.file && args._.length === 0)) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const url = args._[0];
  if (url) console.log('链接:', url);
  if (args.file) console.log('本地文件:', args.file);

  const result = await runExtractJob({
    url,
    localVideo: args.file,
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
