import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureRuntimeDeps } from './lib/deps.js';
import { startServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** @type {{ stage: string, message: string, percent: number, error?: string, ready: boolean, port?: number }} */
const bootState = {
  stage: 'init',
  message: '正在启动…',
  percent: 0,
  ready: false,
};

function setBoot(partial) {
  Object.assign(bootState, partial);
}

function findBrowser() {
  const localApp = process.env.LOCALAPPDATA || '';
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(localApp, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function openAppWindow(url) {
  const browser = findBrowser();
  if (!browser) {
    // 兜底：系统默认浏览器
    const cmd =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    cmd.unref();
    return null;
  }

  const profileDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'DouyinFrames',
    'browser-profile',
  );
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=1440,920',
    '--disable-features=TranslateUI,MediaRouter',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--password-store=basic',
  ];

  return spawn(browser, args, {
    stdio: 'ignore',
    windowsHide: false,
  });
}

async function main() {
  process.env.DOUYIN_FRAMES_ROOT = ROOT;
  const dataHome = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'DouyinFrames',
  );
  process.env.DOUYIN_FRAMES_OUTPUT = path.join(dataHome, 'output');
  process.env.DOUYIN_FRAMES_UPLOADS = path.join(dataHome, 'uploads');
  await fsp.mkdir(process.env.DOUYIN_FRAMES_OUTPUT, { recursive: true });
  await fsp.mkdir(process.env.DOUYIN_FRAMES_UPLOADS, { recursive: true });

  setBoot({ stage: 'server', message: '正在启动本机服务…', percent: 10 });
  const { server, port, app } = await startServer({ port: 0, host: '127.0.0.1' });

  // 启动状态 API（给 boot 页轮询）
  app.get('/api/boot', (_req, res) => {
    res.json({ ...bootState, port });
  });

  const bootUrl = `http://127.0.0.1:${port}/boot.html?shell=1`;
  // 给无边框启动器读端口
  process.stdout.write(`__DOUYIN_FRAMES_PORT__=${port}\n`);
  console.log(`[desktop] 窗口: ${bootUrl}`);

  // 服务已起（含 FFmpeg 检测）；立刻放行 UI，避免卡在依赖页
  setBoot({
    stage: 'done',
    message: '就绪',
    percent: 100,
    ready: true,
    port,
  });

  // 后台再扫一遍缓存目录（多数情况瞬间完成）
  ensureRuntimeDeps({
    dataDir: path.join(dataHome, 'runtime'),
    onProgress: (message) => console.log(`[deps] ${message}`),
  }).catch((err) => {
    console.warn('[desktop] 依赖补充失败:', err?.message || err);
  });

  const shutdown = () => {
    try {
      server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  // 便携 exe / Tauri：由宿主窗口打开页面，不再另开 Edge
  const noBrowser = process.env.DOUYIN_FRAMES_NO_BROWSER === '1';
  if (noBrowser) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {});
    return;
  }

  const win = openAppWindow(bootUrl);

  if (win) {
    win.on('exit', shutdown);
    win.on('error', (err) => {
      console.error('[desktop] 浏览器启动失败:', err.message);
      console.log(`请手动打开: http://127.0.0.1:${port}/`);
    });
  } else {
    console.log('未找到 Edge/Chrome，已尝试用默认浏览器打开。关闭本窗口请 Ctrl+C。');
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
