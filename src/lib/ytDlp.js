import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/**
 * 可选：用本机 yt-dlp 解析直链（零浏览器）。
 * 未安装时可按需下载到 tools/yt-dlp/（仅 Windows 自动下载）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

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

export function localYtDlpPath() {
  return path.join(
    PROJECT_ROOT,
    'tools',
    'yt-dlp',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
  );
}

export function findYtDlp() {
  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    return process.env.YT_DLP_PATH;
  }
  const local = localYtDlpPath();
  if (fs.existsSync(local)) return local;
  return whichSync('yt-dlp') || whichSync('yt-dlp.exe');
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib
      .get(url, { headers: { 'User-Agent': 'douyin-frames' } }, (res) => {
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

/**
 * 若本机没有 yt-dlp，尝试下载官方 Windows 可执行文件到 tools/yt-dlp/
 * @returns {Promise<string|null>} 可执行路径
 */
export async function ensureYtDlp({ onProgress } = {}) {
  const existing = findYtDlp();
  if (existing) return existing;

  if (process.platform !== 'win32') {
    onProgress?.('未找到 yt-dlp，请手动安装并加入 PATH');
    return null;
  }

  const dest = localYtDlpPath();
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  onProgress?.('正在下载 yt-dlp（首次，约 20MB）…');
  try {
    const res = await httpGet('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
    await pipeline(res, createWriteStream(tmp));
    await fsp.rename(tmp, dest);
    onProgress?.('yt-dlp 已就绪');
    return dest;
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    onProgress?.(`yt-dlp 下载失败: ${err?.message || err}`);
    return null;
  }
}

/**
 * @param {string} pageUrl 抖音作品页/短链
 * @returns {Promise<{videoUrl?:string, title?:string, uploader?:string, via?:string, errorHint?:string}|null>}
 */
export async function resolveViaYtDlp(pageUrl, { timeoutMs = 90_000, autoInstall = true } = {}) {
  let bin = findYtDlp();
  if (!bin && autoInstall) {
    bin = await ensureYtDlp();
  }
  if (!bin) return { errorHint: '未安装 yt-dlp' };

  // 确保本机已保存的 Cookie 写入 netscape 文件
  try {
    const { hydrateCookieEnv, cookieNetscapePath } = await import('./cookies.js');
    await hydrateCookieEnv();
    const p = cookieNetscapePath();
    if (p && fs.existsSync(p)) process.env.YT_DLP_COOKIES = p;
  } catch {
    // ignore
  }

  const cookieFile = process.env.YT_DLP_COOKIES;
  const attempts = [];
  if (cookieFile && fs.existsSync(cookieFile)) {
    attempts.push(['--cookies', cookieFile]);
  }

  // 先把 Edge/Chrome Cookie 库拷到临时目录（避开浏览器文件锁）
  const tempProfiles = [];
  try {
    const { materializeBrowserProfile, cleanupProfile } = await import('./browserCookies.js');
    for (const browser of ['edge', 'chrome']) {
      const root = await materializeBrowserProfile(browser);
      if (root) {
        tempProfiles.push(root);
        // PROFILE = User Data 根路径
        attempts.push(['--cookies-from-browser', `${browser}:${root}`]);
      }
    }
  } catch {
    // ignore
  }

  attempts.push(['--cookies-from-browser', 'edge:Default']);
  attempts.push(['--cookies-from-browser', 'chrome:Default']);
  attempts.push([]);

  let lastHint = '';
  let sawDpapi = false;
  let sawNeedCookies = false;
  let sawCopyFail = false;
  try {
    for (const extra of attempts) {
      const result = await runYtDlp(bin, pageUrl, extra, timeoutMs);
      if (result?.videoUrl) return result;
      if (result?.errorHint) {
        if (/DPAPI|无法读取浏览器|decrypt/i.test(result.errorHint)) sawDpapi = true;
        if (/Could not copy|拷贝 Cookie/i.test(result.errorHint)) sawCopyFail = true;
        if (/需要浏览器 cookies|Fresh cookies|反爬/i.test(result.errorHint)) sawNeedCookies = true;
        lastHint = result.errorHint;
      }
    }
  } finally {
    const { cleanupProfile } = await import('./browserCookies.js').catch(() => ({ cleanupProfile: null }));
    for (const root of tempProfiles) {
      await cleanupProfile?.(root);
    }
  }

  if (sawNeedCookies || sawDpapi || sawCopyFail) {
    return {
      errorHint:
        '抖音反爬需要浏览器访客 Cookie（不必登录）。可先在 Edge 打开该视频页，再点解析；或在「高级」粘贴 Cookie；或改用本地视频',
    };
  }
  return lastHint ? { errorHint: lastHint } : null;
}

function runYtDlp(bin, pageUrl, extraArgs, timeoutMs) {
  const args = [
    '-g',
    '-f',
    'bv*+ba/b',
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    ...extraArgs,
    String(pageUrl),
  ];

  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ errorHint: 'yt-dlp 超时' });
    }, timeoutMs);

    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err += b.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ errorHint: '无法启动 yt-dlp' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s));
      const preferred =
        lines.find((u) => /\.mp4|\/video\/|aweme|zjcdn|douyinvod/i.test(u)) || lines[0];
      if (code === 0 && preferred) {
        resolve({
          videoUrl: preferred.replace(/playwm/g, 'play'),
          via: 'yt-dlp',
        });
        return;
      }
      const msg = err || out;
      let errorHint = '解析失败';
      if (/Fresh cookies|cookies .*needed/i.test(msg)) {
        errorHint = '需要浏览器访客 Cookie（不必登录账号）';
      } else if (/DPAPI|decrypt/i.test(msg)) {
        errorHint = '无法读取浏览器 cookies（权限/DPAPI）';
      } else if (/Could not copy Chrome cookie database/i.test(msg)) {
        errorHint = '无法拷贝浏览器 Cookie 库（请先打开过该视频页，或暂时关闭 Edge 后再试）';
      } else if (/Unsupported URL|Unable to extract/i.test(msg)) {
        errorHint = '该链接暂不支持';
      }
      resolve({ errorHint });
    });
  });
}
