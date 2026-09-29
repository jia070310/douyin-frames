/**
 * 便携 exe 包：DouyinFrames.exe + 便携 Node + 精简 FFmpeg + 应用代码
 *
 *   node scripts/pack-portable.mjs
 *
 * 产物：dist/DouyinFrames-portable/
 *   DouyinFrames.exe
 *   tools/node/node.exe
 *   tools/ffmpeg/ffmpeg.exe + ffprobe.exe
 *   src/ public/ node_modules/
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'DouyinFrames-portable');
const LAUNCHER_DIR = path.join(ROOT, 'packaging', 'launcher');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...opts.env },
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} => ${code}`))));
  });
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const ent of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDir(from, to);
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
          return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function download(url, dest, onProgress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await httpGet(url);
  const total = Number(res.headers['content-length'] || 0);
  let done = 0;
  res.on('data', (chunk) => {
    done += chunk.length;
    if (total && onProgress) onProgress(Math.min(99, Math.round((done / total) * 100)));
  });
  await pipeline(res, createWriteStream(tmp));
  await fsp.rename(tmp, dest);
  onProgress?.(100);
}

async function fetchJson(url) {
  const res = await httpGet(url);
  let raw = '';
  for await (const chunk of res) raw += chunk;
  return JSON.parse(raw);
}

async function expandZip(zipPath, outDir) {
  await fsp.mkdir(outDir, { recursive: true });
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
    ps.on('error', reject);
    ps.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`Expand-Archive ${c}`))));
  });
}

async function findFile(root, names) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents = [];
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (want.has(ent.name.toLowerCase())) return full;
    }
  }
  return null;
}

async function ensurePortableNode(destRoot) {
  const nodeDir = path.join(destRoot, 'tools', 'node');
  const exe = path.join(nodeDir, 'node.exe');
  if (fs.existsSync(exe)) {
    console.log('[pack] portable node OK');
    return;
  }
  console.log('[pack] downloading portable Node…');
  const index = await fetchJson('https://nodejs.org/dist/index.json');
  const lts = index.find((x) => x.lts) || index[0];
  const ver = lts.version;
  const zipName = `node-${ver}-win-x64.zip`;
  const zipUrl = `https://nodejs.org/dist/${ver}/${zipName}`;
  const tmp = path.join(destRoot, '.tmp');
  const zipPath = path.join(tmp, zipName);
  await download(zipUrl, zipPath, (p) => process.stdout.write(`\r[pack] node ${p}%   `));
  process.stdout.write('\n');
  const extractTo = path.join(tmp, 'node-extract');
  await rmrf(extractTo);
  await expandZip(zipPath, extractTo);
  const extracted = path.join(extractTo, `node-${ver}-win-x64`);
  await fsp.mkdir(nodeDir, { recursive: true });
  await fsp.copyFile(path.join(extracted, 'node.exe'), exe);
  await rmrf(tmp);
  console.log('[pack] node =>', exe);
}

function ffmpegLooksModern(ffmpegPath) {
  try {
    const out = execFileSync(ffmpegPath, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    // @ffmpeg-installer 仍是 2018 年代构建，不支持 -fps_mode 等；拒绝打包进便携版
    const m = out.match(/ffmpeg version\s+(\S+)/i);
    const ver = m?.[1] || '';
    if (/^N-\d+-g/i.test(ver)) {
      // 旧 git 构建号，N-9xxxx 约为 2018
      const n = Number(ver.match(/^N-(\d+)/i)?.[1] || 0);
      return n >= 100000;
    }
    const major = Number(String(ver).split('.')[0]);
    return Number.isFinite(major) && major >= 5;
  } catch {
    return false;
  }
}

async function ensureSlimFfmpeg(destRoot) {
  const binDir = path.join(destRoot, 'tools', 'ffmpeg');
  const ffmpeg = path.join(binDir, 'ffmpeg.exe');
  const ffprobe = path.join(binDir, 'ffprobe.exe');
  if (fs.existsSync(ffmpeg) && fs.existsSync(ffprobe) && ffmpegLooksModern(ffmpeg)) {
    console.log('[pack] slim ffmpeg OK');
    return;
  }
  if (fs.existsSync(ffmpeg)) {
    console.log('[pack] 现有 FFmpeg 过旧，改为下载 essentials…');
  }

  console.log('[pack] downloading slim FFmpeg essentials…');
  const tmp = path.join(destRoot, '.tmp-ffmpeg');
  await fsp.mkdir(tmp, { recursive: true });
  const zipPath = path.join(tmp, 'ffmpeg-essentials.zip');
  const urls = [
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    'https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip',
  ];
  let ok = false;
  for (const url of urls) {
    try {
      await download(url, zipPath, (p) => process.stdout.write(`\r[pack] ffmpeg ${p}%   `));
      process.stdout.write('\n');
      ok = true;
      break;
    } catch (e) {
      console.warn('[pack] ffmpeg mirror fail:', e.message);
    }
  }
  if (!ok) throw new Error('无法下载精简 FFmpeg');

  const extractTo = path.join(tmp, 'extract');
  await expandZip(zipPath, extractTo);
  const foundFfmpeg = await findFile(extractTo, ['ffmpeg.exe']);
  const foundFfprobe = await findFile(extractTo, ['ffprobe.exe']);
  if (!foundFfmpeg || !foundFfprobe) throw new Error('FFmpeg zip 内未找到可执行文件');
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.copyFile(foundFfmpeg, ffmpeg);
  await fsp.copyFile(foundFfprobe, ffprobe);
  await rmrf(tmp);
  console.log('[pack] ffmpeg =>', binDir);
}

async function buildLauncher(destRoot) {
  console.log('[pack] building DouyinFrames.exe…');
  const gcc = (() => {
    try {
      const winget = path.join(
        process.env.LOCALAPPDATA || '',
        'Microsoft',
        'WinGet',
        'Packages',
      );
      // best-effort: rely on PATH
      return null;
    } catch {
      return null;
    }
  })();
  void gcc;

  const targetDir = path.join(ROOT, 'dist', '.launcher-target');
  await fsp.mkdir(targetDir, { recursive: true });
  await run('cargo', ['build', '--release'], {
    cwd: LAUNCHER_DIR,
    env: {
      CARGO_TARGET_DIR: targetDir,
    },
  });

  const builtCandidates = [
    path.join(targetDir, 'x86_64-pc-windows-gnu', 'release', 'DouyinFrames.exe'),
    path.join(targetDir, 'release', 'DouyinFrames.exe'),
  ];
  const built = builtCandidates.find((p) => fs.existsSync(p));
  if (!built) {
    throw new Error('未找到 DouyinFrames.exe，请确认已安装 Rust + MinGW（与 Tauri 相同环境）');
  }
  await fsp.copyFile(built, path.join(destRoot, 'DouyinFrames.exe'));

  const iconIco = path.join(ROOT, 'packaging', 'icons', 'icon.ico');
  if (fs.existsSync(iconIco)) {
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      const { rcedit } = require('rcedit');
      await rcedit(path.join(destRoot, 'DouyinFrames.exe'), { icon: iconIco });
      console.log('[pack] exe icon OK');
    } catch (e) {
      console.warn('[pack] 写 exe 图标失败（可忽略）:', e.message);
    }
  }

  // wry / webview2-com 动态依赖 WebView2Loader.dll，需与 exe 同目录
  const findLoader = () => {
    const bundled = path.join(LAUNCHER_DIR, 'WebView2Loader.dll');
    if (fs.existsSync(bundled)) return bundled;

    const roots = [
      path.join(targetDir, 'x86_64-pc-windows-gnu', 'release', 'build'),
      path.join(targetDir, 'release', 'build'),
      path.join(process.env.USERPROFILE || '', '.cargo', 'registry', 'src'),
    ].filter((p) => p && fs.existsSync(p));

    for (const root of roots) {
      const stack = [root];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try {
          entries = fs.readdirSync(cur);
        } catch {
          continue;
        }
        for (const name of entries) {
          const full = path.join(cur, name);
          let st;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (
            name === 'WebView2Loader.dll' &&
            (cur.endsWith(`${path.sep}x64`) || full.includes(`${path.sep}x64${path.sep}`))
          ) {
            return full;
          }
        }
      }
    }
    return null;
  };

  const loader = findLoader();
  if (!loader) {
    throw new Error('未找到 WebView2Loader.dll（webview2-com-sys x64）');
  }
  await fsp.copyFile(loader, path.join(destRoot, 'WebView2Loader.dll'));
  // 缓存一份到 launcher 目录，下次打包免搜
  await fsp.copyFile(loader, path.join(LAUNCHER_DIR, 'WebView2Loader.dll')).catch(() => {});
  console.log('[pack] launcher OK (+ WebView2Loader.dll)');
}

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

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('便携 exe 包目前仅支持 Windows');
  }

  console.log('[pack] out =', OUT);
  await rmrf(OUT);
  await fsp.mkdir(OUT, { recursive: true });

  await copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src'));
  await copyDir(path.join(ROOT, 'public'), path.join(OUT, 'public'));

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  // 不装 npm 里的多平台 ffmpeg；改用 tools/ffmpeg 精简二进制
  delete pkg.dependencies['@ffmpeg-installer/ffmpeg'];
  delete pkg.dependencies['@ffprobe-installer/ffprobe'];
  delete pkg.postinstall;
  pkg.scripts = {
    start: 'node src/server.js',
    desktop: 'node src/desktop.js',
    cli: 'node src/cli.js',
  };
  await fsp.writeFile(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2));

  console.log('[pack] npm install…');
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: OUT,
    env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });
  await rmrf(path.join(OUT, 'node_modules', 'playwright', '.local-browsers'));
  await rmrf(path.join(OUT, 'node_modules', 'playwright-core', '.local-browsers'));

  await ensurePortableNode(OUT);
  await ensureSlimFfmpeg(OUT);
  await buildLauncher(OUT);

  await fsp.writeFile(
    path.join(OUT, '使用说明.txt'),
    [
      'Douyin Frames 便携版',
      '================',
      '',
      '双击 DouyinFrames.exe 启动（无边框本机窗口，不另开浏览器）。',
      '已内置：便携 Node、精简 FFmpeg、WebView2 启动器。',
      '需已安装 Microsoft Edge WebView2 运行时（多数 Win10/11 已自带）。',
      '无需安装 Electron；解析一般不必登录抖音账号。',
      '',
      '数据目录：%APPDATA%\\DouyinFrames',
      '',
    ].join('\r\n'),
    'utf8',
  );

  const mb = (await du(OUT) / (1024 * 1024)).toFixed(1);
  console.log(`[pack] done: ${OUT}`);
  console.log(`[pack] size ≈ ${mb} MB`);
  console.log('[pack] 启动: DouyinFrames.exe');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
