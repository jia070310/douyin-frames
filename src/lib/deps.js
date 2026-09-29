import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 轻量依赖：只处理 FFmpeg（精简体积）。
 * 不再下载 Chromium / Playwright。
 *
 * 策略：PATH → @ffmpeg-installer 内置 → userData 缓存 → 首次下载精简包
 */

function whichSync(cmd) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        // continue
      }
    }
  }
  return null;
}

function tryRequireInstaller(name) {
  try {
    const mod = require(name);
    const p = mod?.path;
    if (p && fs.existsSync(p)) return p;
  } catch {
    // not installed / wrong platform
  }
  return null;
}

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib
      .get(url, { headers: { 'User-Agent': 'douyin-frames-desktop' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 8) return reject(new Error('下载重定向过多'));
          res.resume();
          return resolve(httpGet(res.headers.location, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function downloadFile(url, dest, onProgress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await httpGet(url);
  const total = Number(res.headers['content-length'] || 0);
  let done = 0;
  res.on('data', (chunk) => {
    done += chunk.length;
    if (total) onProgress?.(Math.min(99, Math.round((done / total) * 100)));
  });
  await pipeline(res, createWriteStream(tmp));
  await fsp.rename(tmp, dest);
  onProgress?.(100);
}

async function extractZip(zipPath, outDir) {
  await fsp.mkdir(outDir, { recursive: true });
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
        ],
        { windowsHide: true },
      );
      let err = '';
      ps.stderr.on('data', (b) => (err += b.toString()));
      ps.on('error', reject);
      ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `解压失败 ${code}`))));
    });
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-o', zipPath, '-d', outDir], { windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip ${code}`))));
  });
}

async function findBinInDir(root, names) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (names.includes(ent.name.toLowerCase())) return full;
    }
  }
  return null;
}

/**
 * @param {{ dataDir: string, onProgress?: (msg:string, pct?:number)=>void }} opts
 */
export async function ensureFfmpeg(opts) {
  const { dataDir, onProgress } = opts;
  const report = (msg, pct) => onProgress?.(msg, pct);

  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && (await fileExists(fromEnv))) {
    process.env.FFMPEG_PATH = fromEnv;
    process.env.FFPROBE_PATH =
      process.env.FFPROBE_PATH || fromEnv.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    report('已使用环境变量中的 FFmpeg', 100);
    return { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH, source: 'env' };
  }

  const pathFfmpeg = whichSync('ffmpeg');
  const pathFfprobe = whichSync('ffprobe');
  if (pathFfmpeg && pathFfprobe) {
    process.env.FFMPEG_PATH = pathFfmpeg;
    process.env.FFPROBE_PATH = pathFfprobe;
    report('已检测到系统 FFmpeg', 100);
    return { ffmpeg: pathFfmpeg, ffprobe: pathFfprobe, source: 'path' };
  }

  const bundledFfmpeg = tryRequireInstaller('@ffmpeg-installer/ffmpeg');
  const bundledFfprobe = tryRequireInstaller('@ffprobe-installer/ffprobe');
  if (bundledFfmpeg && bundledFfprobe) {
    process.env.FFMPEG_PATH = bundledFfmpeg;
    process.env.FFPROBE_PATH = bundledFfprobe;
    report('已使用内置精简 FFmpeg', 100);
    return { ffmpeg: bundledFfmpeg, ffprobe: bundledFfprobe, source: 'bundled' };
  }

  const binDir = path.join(dataDir, 'ffmpeg');
  const localFfmpeg = path.join(binDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const localFfprobe = path.join(binDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if ((await fileExists(localFfmpeg)) && (await fileExists(localFfprobe))) {
    process.env.FFMPEG_PATH = localFfmpeg;
    process.env.FFPROBE_PATH = localFfprobe;
    report('已使用本机缓存 FFmpeg', 100);
    return { ffmpeg: localFfmpeg, ffprobe: localFfprobe, source: 'cache' };
  }

  if (process.platform !== 'win32') {
    throw new Error('未找到 FFmpeg，请先安装 ffmpeg/ffprobe 并加入 PATH');
  }

  // 精简 essentials 包（比 shared 全量小很多）
  report('正在下载精简 FFmpeg（首次）…', 0);
  const zipUrl =
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  const zipPath = path.join(dataDir, 'ffmpeg-essentials.zip');
  const extractTo = path.join(dataDir, 'ffmpeg-extract');
  try {
    await downloadFile(zipUrl, zipPath, (pct) => report(`下载 FFmpeg ${pct}%`, pct));
  } catch {
    // 备用源
    const alt =
      'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip';
    await downloadFile(alt, zipPath, (pct) => report(`下载 FFmpeg(备用) ${pct}%`, pct));
  }
  report('正在解压 FFmpeg…', 0);
  await extractZip(zipPath, extractTo);
  const foundFfmpeg = await findBinInDir(extractTo, ['ffmpeg.exe']);
  const foundFfprobe = await findBinInDir(extractTo, ['ffprobe.exe']);
  if (!foundFfmpeg || !foundFfprobe) throw new Error('FFmpeg 解压后未找到可执行文件');
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.copyFile(foundFfmpeg, localFfmpeg);
  await fsp.copyFile(foundFfprobe, localFfprobe);
  await fsp.rm(zipPath, { force: true }).catch(() => {});
  await fsp.rm(extractTo, { recursive: true, force: true }).catch(() => {});

  process.env.FFMPEG_PATH = localFfmpeg;
  process.env.FFPROBE_PATH = localFfprobe;
  report('FFmpeg 已就绪', 100);
  return { ffmpeg: localFfmpeg, ffprobe: localFfprobe, source: 'downloaded' };
}

/**
 * @param {{ dataDir: string, onProgress?: (msg:string, pct?:number)=>void }} opts
 */
export async function ensureRuntimeDeps(opts) {
  const ffmpeg = await ensureFfmpeg(opts);
  return { ffmpeg };
}

export function projectRoot() {
  return path.resolve(__dirname, '../..');
}
