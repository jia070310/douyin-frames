/**
 * 轻量便携包：系统 Edge/Chrome + Node，不打包 Chromium/Electron/Tauri。
 *
 * 用法：
 *   node scripts/pack-lite.mjs
 *   node scripts/pack-lite.mjs --with-node   # 额外下载便携 Node（更大，免系统安装）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'DouyinFrames-lite');
const withNode = process.argv.includes('--with-node');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...opts.env },
      stdio: 'inherit',
      // Windows 上 npm.cmd 需要 shell
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
}

async function copyDir(src, dest, { filter } = {}) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (filter && !filter(from, ent)) continue;
    if (ent.isDirectory()) await copyDir(from, to, { filter });
    else await fsp.copyFile(from, to);
  }
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib
      .get(url, { headers: { 'User-Agent': 'douyin-frames-pack' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 8) return reject(new Error('redirect loop'));
          res.resume();
          return resolve(httpGet(res.headers.location, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function download(url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await httpGet(url);
  await pipeline(res, createWriteStream(dest));
}

async function fetchJson(url) {
  const res = await httpGet(url);
  let raw = '';
  for await (const chunk of res) raw += chunk;
  return JSON.parse(raw);
}

async function ensurePortableNode(destRoot) {
  const nodeDir = path.join(destRoot, 'tools', 'node');
  const exe = path.join(nodeDir, 'node.exe');
  if (fs.existsSync(exe)) {
    console.log('[pack] portable node exists');
    return;
  }
  console.log('[pack] downloading portable Node (win-x64)…');
  const index = await fetchJson('https://nodejs.org/dist/index.json');
  const lts = index.find((x) => x.lts);
  const ver = lts?.version || 'v22.14.0';
  const zipName = `node-${ver}-win-x64.zip`;
  const zipUrl = `https://nodejs.org/dist/${ver}/${zipName}`;
  const zipPath = path.join(destRoot, '.tmp', zipName);
  await download(zipUrl, zipPath);

  const extractTo = path.join(destRoot, '.tmp', 'node-extract');
  await rmrf(extractTo);
  await fsp.mkdir(extractTo, { recursive: true });
  await new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractTo.replace(/'/g, "''")}' -Force`,
      ],
      { windowsHide: true },
    );
    ps.on('error', reject);
    ps.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`unzip ${c}`))));
  });

  const extracted = path.join(extractTo, `node-${ver}-win-x64`);
  await fsp.mkdir(nodeDir, { recursive: true });
  for (const name of ['node.exe', 'LICENSE', 'README.md']) {
    const from = path.join(extracted, name);
    if (fs.existsSync(from)) await fsp.copyFile(from, path.join(nodeDir, name));
  }
  await rmrf(path.join(destRoot, '.tmp'));
  console.log('[pack] portable node ready:', exe);
}

async function main() {
  console.log('[pack] out =', OUT);
  await rmrf(OUT);
  await fsp.mkdir(OUT, { recursive: true });

  const copyRoots = ['src', 'public', 'packaging/lite'];
  for (const rel of copyRoots) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    if (rel === 'packaging/lite') {
      // launchers to package root
      for (const name of await fsp.readdir(src)) {
        await fsp.copyFile(path.join(src, name), path.join(OUT, name));
      }
    } else {
      await copyDir(src, path.join(OUT, path.basename(rel)));
    }
  }

  // slim package.json：不带 FFmpeg 预编译包（~145MB），首次运行按需下载到 %APPDATA%
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.dependencies['@ffmpeg-installer/ffmpeg'];
  delete pkg.dependencies['@ffprobe-installer/ffprobe'];
  pkg.scripts = {
    start: 'node src/server.js',
    desktop: 'node src/desktop.js',
    cli: 'node src/cli.js',
  };
  // 禁止 postinstall 拉 Chromium
  delete pkg.postinstall;
  await fsp.writeFile(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2));
  // 不用根目录 lock（依赖已裁剪）
  if (fs.existsSync(path.join(ROOT, 'README.md'))) {
    await fsp.copyFile(path.join(ROOT, 'README.md'), path.join(OUT, 'README.md'));
  }

  console.log('[pack] npm install (production, no ffmpeg binaries, skip playwright browsers)…');
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: OUT,
    env: {
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    },
  });

  // 删掉可能误下的 playwright 浏览器缓存（若有）
  await rmrf(path.join(OUT, 'node_modules', 'playwright', '.local-browsers'));
  await rmrf(path.join(OUT, 'node_modules', 'playwright-core', '.local-browsers'));
  // 双保险：若仍装上了 ffmpeg 安装器，去掉非本机平台包
  const nm = path.join(OUT, 'node_modules');
  for (const name of ['@ffmpeg-installer', '@ffprobe-installer']) {
    await rmrf(path.join(nm, name));
  }

  if (withNode) {
    await ensurePortableNode(OUT);
  }

  // 体积统计
  async function du(dir) {
    let total = 0;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries = [];
      try {
        entries = await fsp.readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else {
          try {
            total += (await fsp.stat(full)).size;
          } catch {
            // ignore
          }
        }
      }
    }
    return total;
  }

  const bytes = await du(OUT);
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  console.log(`[pack] done: ${OUT}`);
  console.log(`[pack] size ≈ ${mb} MB${withNode ? ' (含便携 Node)' : ' (需系统 Node)'}`);
  console.log('[pack] 启动: 双击 DouyinFrames.vbs');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
