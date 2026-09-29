import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRuntimeDeps } from './lib/deps.js';
import { startServer } from './server.js';

/**
 * Tauri 后端桥：启动 Express、准备精简 FFmpeg，并把端口写给 Rust 壳。
 * 约定：向 stdout 打印一行 __DOUYIN_FRAMES_PORT__=<port>
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const bootState = {
  stage: 'init',
  message: '正在启动…',
  percent: 0,
  ready: false,
};

function setBoot(partial) {
  Object.assign(bootState, partial);
}

function dataHome() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'DouyinFrames',
  );
}

async function main() {
  process.env.DOUYIN_FRAMES_ROOT = process.env.DOUYIN_FRAMES_ROOT || ROOT;
  const home = dataHome();
  process.env.DOUYIN_FRAMES_OUTPUT = path.join(home, 'output');
  process.env.DOUYIN_FRAMES_UPLOADS = path.join(home, 'uploads');
  await fsp.mkdir(process.env.DOUYIN_FRAMES_OUTPUT, { recursive: true });
  await fsp.mkdir(process.env.DOUYIN_FRAMES_UPLOADS, { recursive: true });

  setBoot({ stage: 'server', message: '正在启动本机服务…', percent: 10 });
  const preferred = Number(process.env.DOUYIN_FRAMES_PORT || 0) || 0;
  const { app, port } = await startServer({ port: preferred, host: '127.0.0.1' });

  app.get('/api/boot', (_req, res) => {
    res.json({ ...bootState, port });
  });

  // 给 Rust 读端口（stdout + 文件双通道）
  const portFile = path.join(home, 'run', 'port');
  await fsp.mkdir(path.dirname(portFile), { recursive: true });
  await fsp.writeFile(portFile, String(port), 'utf8');
  process.stdout.write(`__DOUYIN_FRAMES_PORT__=${port}\n`);

  try {
    setBoot({ stage: 'deps', message: '正在检测本机依赖…', percent: 20 });
    await ensureRuntimeDeps({
      dataDir: path.join(home, 'runtime'),
      onProgress: (message, percent) => {
        setBoot({
          stage: 'deps',
          message: message || '准备依赖…',
          percent: typeof percent === 'number' ? 20 + Math.round(percent * 0.7) : bootState.percent,
        });
      },
    });
    setBoot({ stage: 'done', message: '就绪', percent: 100, ready: true });
  } catch (err) {
    const message = err?.message || String(err);
    setBoot({ stage: 'error', message, percent: 0, error: message, ready: false });
    console.error('[tauri-bridge] deps failed:', message);
  }

  // 保持进程，直到 Tauri 退出时杀掉
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
