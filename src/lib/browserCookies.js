import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 从本机 Edge/Chrome 复制 Cookie 库到临时目录，供 yt-dlp --cookies-from-browser 使用。
 * 解决浏览器占用导致 “Could not copy Chrome cookie database” 的问题。
 * 访客 Cookie 即可，不要求登录账号。
 */

function edgeUserData() {
  return path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
}

function chromeUserData() {
  return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
}

async function copyFileSafe(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.copyFile(src, dest);
    return true;
  } catch {
    // 浏览器锁定时：用 powershell 再试一次（有时比 node 拷贝更稳）
    try {
      await new Promise((resolve, reject) => {
        const ps = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Copy-Item -LiteralPath '${src.replace(/'/g, "''")}' -Destination '${dest.replace(/'/g, "''")}' -Force`,
          ],
          { windowsHide: true },
        );
        ps.on('error', reject);
        ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`copy ${code}`))));
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * @param {'edge'|'chrome'} browser
 * @returns {Promise<string|null>} 临时 User Data 根目录，供 yt-dlp 的 PROFILE 路径
 */
export async function materializeBrowserProfile(browser = 'edge') {
  if (process.platform !== 'win32') return null;

  const userData = browser === 'chrome' ? chromeUserData() : edgeUserData();
  const localState = path.join(userData, 'Local State');
  const cookiesCandidates = [
    path.join(userData, 'Default', 'Network', 'Cookies'),
    path.join(userData, 'Default', 'Cookies'),
  ];
  const cookiesSrc = cookiesCandidates.find((p) => fs.existsSync(p));
  if (!cookiesSrc || !fs.existsSync(localState)) return null;

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const root = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'DouyinFrames',
    'browser-cookie-profile',
    `${browser}-${stamp}`,
  );
  const profileDir = path.join(root, 'Default');
  const networkDir = path.join(profileDir, 'Network');
  await fsp.mkdir(networkDir, { recursive: true });

  const okState = await copyFileSafe(localState, path.join(root, 'Local State'));
  const cookiesDest = cookiesSrc.includes(`${path.sep}Network${path.sep}`)
    ? path.join(networkDir, 'Cookies')
    : path.join(profileDir, 'Cookies');
  const okCookies = await copyFileSafe(cookiesSrc, cookiesDest);

  // journal 可选
  const journal = `${cookiesSrc}-journal`;
  if (fs.existsSync(journal)) {
    await copyFileSafe(journal, `${cookiesDest}-journal`);
  }

  if (!okState || !okCookies) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    return null;
  }

  // yt-dlp：PROFILE 可为用户数据目录路径
  return root;
}

export async function cleanupProfile(root) {
  if (!root) return;
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}
