import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureFfmpeg,
  findExistingFfmpeg,
  MANUAL_DOWNLOADS,
  runtimeDataDir,
} from './lib/deps.js';
import { startServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** @type {{
 *   stage: string,
 *   message: string,
 *   percent: number,
 *   error?: string,
 *   ready: boolean,
 *   port?: number,
 *   needDeps?: boolean,
 *   deps?: object,
 * }} */
const bootState = {
  stage: 'init',
  message: '正在启动…',
  percent: 0,
  ready: false,
  needDeps: false,
};

/** @type {((v: boolean) => void) | null} */
let resolveDepsGate = null;
/** @type {Promise<boolean> | null} */
let depsGate = null;

function setBoot(partial) {
  Object.assign(bootState, partial);
}

function resetDepsGate() {
  depsGate = new Promise((resolve) => {
    resolveDepsGate = resolve;
  });
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

function openExternalUrl(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // ignore
  }
}

async function main() {
  process.env.DOUYIN_FRAMES_ROOT = ROOT;
  const dataHome = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'DouyinFrames',
  );
  const dataDir = runtimeDataDir();
  process.env.DOUYIN_FRAMES_OUTPUT = path.join(dataHome, 'output');
  process.env.DOUYIN_FRAMES_UPLOADS = path.join(dataHome, 'uploads');
  await fsp.mkdir(process.env.DOUYIN_FRAMES_OUTPUT, { recursive: true });
  await fsp.mkdir(process.env.DOUYIN_FRAMES_UPLOADS, { recursive: true });

  setBoot({ stage: 'server', message: '正在启动本机服务…', percent: 10 });
  const { server, port, app } = await startServer({ port: 0, host: '127.0.0.1' });

  app.get('/api/boot', (_req, res) => {
    res.json({ ...bootState, port, manuals: MANUAL_DOWNLOADS });
  });

  app.post('/api/boot/deps', async (req, res) => {
    try {
      const action = String(req.body?.action || '');
      if (action === 'open-url') {
        const url = String(req.body?.url || '');
        if (!/^https?:\/\//i.test(url)) {
          return res.status(400).json({ error: '无效地址' });
        }
        openExternalUrl(url);
        return res.json({ ok: true });
      }

      if (action === 'auto') {
        setBoot({
          stage: 'deps',
          message: '正在自动下载 FFmpeg…',
          percent: 20,
          needDeps: true,
          ready: false,
          error: undefined,
        });
        await ensureFfmpeg({
          dataDir,
          autoDownload: true,
          onProgress: (message, percent) => {
            setBoot({
              stage: 'deps',
              message: message || '准备依赖…',
              percent:
                typeof percent === 'number' ? 20 + Math.round(percent * 0.7) : bootState.percent,
              needDeps: true,
              ready: false,
            });
          },
        });
        setBoot({
          stage: 'done',
          message: '就绪',
          percent: 100,
          ready: true,
          needDeps: false,
          deps: undefined,
        });
        resolveDepsGate?.(true);
        return res.json({ ok: true, ready: true });
      }

      if (action === 'recheck') {
        const found = await findExistingFfmpeg({ dataDir });
        if (found) {
          process.env.FFMPEG_PATH = found.ffmpeg;
          process.env.FFPROBE_PATH = found.ffprobe;
          setBoot({
            stage: 'done',
            message: '已检测到 FFmpeg，就绪',
            percent: 100,
            ready: true,
            needDeps: false,
            deps: undefined,
          });
          resolveDepsGate?.(true);
          return res.json({ ok: true, ready: true, source: found.source });
        }
        return res.json({
          ok: false,
          ready: false,
          error: '仍未检测到 FFmpeg。请完成手动安装后重试，或改选自动下载。',
          deps: { ffmpeg: MANUAL_DOWNLOADS.ffmpeg },
        });
      }

      if (action === 'skip') {
        // 允许先进入界面（抽帧时再提示缺依赖）
        setBoot({
          stage: 'done',
          message: '已跳过依赖安装（抽帧前请自行装好 FFmpeg）',
          percent: 100,
          ready: true,
          needDeps: false,
        });
        resolveDepsGate?.(true);
        return res.json({ ok: true, ready: true, skipped: true });
      }

      return res.status(400).json({ error: '未知 action' });
    } catch (err) {
      const message = err?.message || String(err);
      setBoot({
        stage: 'need_deps',
        message: `自动安装失败：${message}`,
        percent: 0,
        error: message,
        needDeps: true,
        ready: false,
        deps: { ffmpeg: MANUAL_DOWNLOADS.ffmpeg },
      });
      res.status(500).json({ error: message, deps: { ffmpeg: MANUAL_DOWNLOADS.ffmpeg } });
    }
  });

  const bootUrl = `http://127.0.0.1:${port}/boot.html?shell=1`;
  process.stdout.write(`__DOUYIN_FRAMES_PORT__=${port}\n`);
  console.log(`[desktop] 窗口: ${bootUrl}`);

  const noBrowser = process.env.DOUYIN_FRAMES_NO_BROWSER === '1';
  /** @type {import('node:child_process').ChildProcess | null} */
  let win = null;
  if (!noBrowser) {
    win = openAppWindow(bootUrl);
  }

  const existing = await findExistingFfmpeg({ dataDir });
  if (existing) {
    process.env.FFMPEG_PATH = existing.ffmpeg;
    process.env.FFPROBE_PATH = existing.ffprobe;
    setBoot({
      stage: 'done',
      message: '就绪',
      percent: 100,
      ready: true,
      port,
      needDeps: false,
    });
  } else {
    resetDepsGate();
    setBoot({
      stage: 'need_deps',
      message: '未检测到 FFmpeg，请选择安装方式',
      percent: 15,
      ready: false,
      needDeps: true,
      port,
      deps: { ffmpeg: MANUAL_DOWNLOADS.ffmpeg, node: MANUAL_DOWNLOADS.node },
    });
    // 等用户在 boot 页选择（自动 / 手动后重检 / 跳过）
    await depsGate;
  }

  const shutdown = () => {
    try {
      server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  if (noBrowser) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {});
    return;
  }

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
