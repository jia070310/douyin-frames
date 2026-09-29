import { randomBytes } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runExtractJob } from './lib/pipeline.js';
import { OUTPUT_ROOT, jobDir, ensureDir } from './lib/paths.js';
import { getCleanupConfig, startCleanupScheduler, releaseJob, releaseJobs, purgeCache } from './lib/cleanup.js';
import { initProxy, getProxyDisplay } from './lib/proxy.js';
import { extractAwemeId, extractDouyinUrl, normalizeDouyinInput, resolveDouyinLight } from './lib/douyin.js';
import { ensureFfmpeg } from './lib/deps.js';
import { hydrateCookieEnv, loadCookieHeader, saveCookieHeader, cookieNetscapePath } from './lib/cookies.js';

await initProxy();
await hydrateCookieEnv();

// 启动时只检测已有 FFmpeg（不自动下载；桌面启动页 / CLI 再按需安装）
try {
  const dataDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'DouyinFrames',
    'runtime',
  );
  const found = await ensureFfmpeg({
    dataDir,
    autoDownload: false,
    onProgress: (msg) => console.log(`[ffmpeg] ${msg}`),
  });
  if (found?.source === 'missing') {
    console.warn('[ffmpeg] 未安装。可在启动页选择自动下载，或手动安装：');
    for (const u of found.manual?.urls || []) {
      console.warn(`  - ${u.label}: ${u.url}`);
    }
  }
} catch (err) {
  console.warn('[ffmpeg] 未就绪:', err?.message || err);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DOUYIN_FRAMES_ROOT
  ? path.resolve(process.env.DOUYIN_FRAMES_ROOT)
  : path.resolve(__dirname, '..');
const IS_PROD = process.env.NODE_ENV === 'production';

/** @type {Map<string, object>} */
const jobs = new Map();

const app = express();
if (IS_PROD) {
  app.set('trust proxy', 1);
}

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors(
    allowedOrigins.length
      ? {
          origin(origin, cb) {
            // 同域 / 无 Origin（curl、部分浏览器导航）放行；拒绝时不要 throw，否则整请求 500
            if (!origin || allowedOrigins.includes(origin)) cb(null, true);
            else cb(null, false);
          },
        }
      : undefined,
  ),
);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(OUTPUT_ROOT));

const PKG = JSON.parse(
  await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8').catch(() => '{}'),
);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    name: 'Douyin Frames',
    version: PKG.version || '1.2.0',
    cleanup: getCleanupConfig(),
    proxy: getProxyDisplay(),
  });
});

app.get('/api/cookies', async (_req, res) => {
  const header = await loadCookieHeader();
  res.json({
    hasCookie: Boolean(header),
    length: header.length,
    netscapePath: cookieNetscapePath(),
    hint: '在 Edge 打开过 douyin.com（访客即可）→ F12 → Network → 复制 Request Headers 里的 Cookie',
  });
});

app.post('/api/cookies', async (req, res) => {
  try {
    const raw = String(req.body?.cookie || req.body?.header || '');
    const result = await saveCookieHeader(raw);
    res.json({
      ok: true,
      ...result,
      hasCookie: result.saved,
    });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.delete('/api/cookies', async (_req, res) => {
  try {
    await saveCookieHeader('');
    delete process.env.DOUYIN_COOKIES;
    if (process.env.YT_DLP_COOKIES?.includes('DouyinFrames')) {
      delete process.env.YT_DLP_COOKIES;
    }
    res.json({ ok: true, hasCookie: false });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * 仅规范化短链 / 提取 awemeId
 * 供浏览器端解析流程使用
 */
app.post('/api/normalize', async (req, res) => {
  const input = String(req.body?.url || '').trim();
  if (!input) return res.status(400).json({ error: '缺少 url' });
  try {
    const extracted = extractDouyinUrl(input);
    let url = extracted;
    try {
      url = await normalizeDouyinInput(input);
    } catch {
      url = extracted;
    }
    let awemeId = null;
    try {
      awemeId = extractAwemeId(url);
    } catch {
      try {
        awemeId = extractAwemeId(input);
      } catch {
        awemeId = null;
      }
    }
    res.json({
      url,
      awemeId,
      pageUrl: awemeId ? `https://www.douyin.com/video/${awemeId}` : url,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

const ALLOWED_FETCH_HOSTS = new Set([
  'v.douyin.com',
  'www.douyin.com',
  'douyin.com',
  'www.iesdouyin.com',
  'iesdouyin.com',
  'aweme.snssdk.com',
  'www.snssdk.com',
]);

function assertAllowedFetchUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('非法 URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http/https');
  }
  const host = u.hostname.toLowerCase();
  const ok =
    ALLOWED_FETCH_HOSTS.has(host) ||
    host.endsWith('.douyin.com') ||
    host.endsWith('.iesdouyin.com') ||
    host.endsWith('.snssdk.com') ||
    host.endsWith('.byteicdn.com') ||
    host.endsWith('.douyinvod.com');
  if (!ok) throw new Error(`不允许代理该域名: ${host}`);
  return u.href;
}

/**
 * 同源拉页代理：浏览器因跨域无法直连抖音，由本站代拉 HTML，解析仍在浏览器完成。
 * POST { url }
 */
app.post('/api/proxy-fetch', async (req, res) => {
  const input = String(req.body?.url || '').trim();
  if (!input) return res.status(400).json({ error: '缺少 url' });
  try {
    const target = assertAllowedFetchUrl(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const upstream = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://www.douyin.com/',
      },
    }).finally(() => clearTimeout(timer));

    const text = await upstream.text();
    res.json({
      ok: upstream.ok,
      status: upstream.status,
      finalUrl: upstream.url || target,
      text: text.length > 1_500_000 ? text.slice(0, 1_500_000) : text,
    });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

/**
 * 轻量解析（无 Playwright）：短链展开 + 分享页 HTML 抽取直链
 * 浏览器解析失败时的同源兜底
 */
app.post('/api/resolve-light', async (req, res) => {
  const input = String(req.body?.url || '').trim();
  if (!input) return res.status(400).json({ error: '缺少 url' });
  try {
    const data = await resolveDouyinLight(input);
    res.json(data);
  } catch (err) {
    res.status(422).json({ error: err.message || String(err) });
  }
});

/**
 * 本地视频文件上传后抽帧
 * POST /api/jobs/with-video
 * Content-Type: application/octet-stream
 * X-Job-Meta: JSON 字符串（mode/fps/meta/sourceUrl 等）
 * body: 视频二进制
 */
app.post(
  '/api/jobs/with-video',
  express.raw({ type: 'application/octet-stream', limit: '512mb' }),
  async (req, res) => {
    let jobMeta = {};
    try {
      jobMeta = JSON.parse(String(req.headers['x-job-meta'] || '{}'));
    } catch {
      return res.status(400).json({ error: 'X-Job-Meta 不是合法 JSON' });
    }

    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 1024) {
      return res.status(400).json({ error: '视频内容过小或缺失' });
    }

    const toRelease = [
      ...(Array.isArray(jobMeta.releaseJobIds) ? jobMeta.releaseJobIds : []),
      jobMeta.releaseJobId,
    ].filter(Boolean);
    if (toRelease.length) {
      releaseJobs(toRelease, { reason: 'replaced_by_new_job', jobs }).catch(() => {});
    }

    const jobId = randomBytes(6).toString('hex');
    const base = jobDir(jobId);
    await ensureDir(base);
    const videoPath = path.join(base, 'source.mp4');
    await fsp.writeFile(videoPath, buf);

    jobs.set(jobId, { stage: 'queued', message: '排队中', updatedAt: Date.now() });
    res.status(202).json({
      jobId,
      statusUrl: `/api/jobs/${jobId}`,
      cleanup: getCleanupConfig(),
    });

    runExtractJob({
      localVideo: videoPath,
      meta: {
        ...(jobMeta.meta || {}),
        sourceUrl: jobMeta.sourceUrl || jobMeta.meta?.sourceUrl || '',
        via: jobMeta.meta?.via || 'local-upload',
      },
      jobId,
      mode: jobMeta.mode || 'every',
      fps: jobMeta.fps ?? 1,
      interval: jobMeta.interval ?? 1,
      format: jobMeta.format || 'jpg',
      quality: jobMeta.quality ?? 2,
      onEvent: (evt) => {
        jobs.set(jobId, { ...jobs.get(jobId), ...evt, updatedAt: Date.now() });
      },
    })
      .then((result) => {
        jobs.set(jobId, {
          stage: 'done',
          message: '完成',
          result: enrichResult(result),
          updatedAt: Date.now(),
        });
      })
      .catch((err) => {
        console.error(err);
        jobs.set(jobId, {
          stage: 'error',
          message: err.message || String(err),
          updatedAt: Date.now(),
        });
      });
  },
);

/**
 * 同步提取（适合短视频 / CLI 调试）
 * POST /api/extract
 */
app.post('/api/extract', async (req, res) => {
  const { url, videoUrl, meta, mode, fps, interval, format, quality } = req.body || {};
  if ((!url || typeof url !== 'string') && (!videoUrl || typeof videoUrl !== 'string')) {
    return res.status(400).json({ error: '缺少 url 或 videoUrl 字段' });
  }

  try {
    const result = await runExtractJob({
      url,
      videoUrl,
      meta,
      mode: mode || 'every',
      fps: fps ?? 1,
      interval: interval ?? 1,
      format: format || 'jpg',
      quality: quality ?? 2,
    });

    res.json(enrichResult(result));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

/**
 * 异步任务（本机网页推荐：先返回 jobId，再轮询）
 * POST /api/jobs
 * GET  /api/jobs/:id
 *
 * body 支持：
 * - { url } 本机解析抖音链接后下载抽帧
 * - { videoUrl, meta } 已有直链，只下载+抽帧
 */
app.post('/api/jobs', async (req, res) => {
  const {
    url,
    videoUrl,
    meta,
    mode,
    fps,
    interval,
    format,
    quality,
    releaseJobId,
    releaseJobIds,
  } = req.body || {};
  if ((!url || typeof url !== 'string') && (!videoUrl || typeof videoUrl !== 'string')) {
    return res.status(400).json({ error: '缺少 url 或 videoUrl 字段' });
  }

  // 开新任务：把旧任务标记为延迟清理
  const toRelease = [
    ...(Array.isArray(releaseJobIds) ? releaseJobIds : []),
    releaseJobId,
  ].filter(Boolean);
  if (toRelease.length) {
    releaseJobs(toRelease, { reason: 'replaced_by_new_job', jobs }).catch((err) => {
      console.warn('[cleanup] 释放旧任务失败:', err.message || err);
    });
  }

  const jobId = randomBytes(6).toString('hex');
  jobs.set(jobId, { stage: 'queued', message: '排队中', updatedAt: Date.now() });
  res.status(202).json({
    jobId,
    statusUrl: `/api/jobs/${jobId}`,
    cleanup: getCleanupConfig(),
  });

  runExtractJob({
    url,
    videoUrl,
    meta,
    jobId,
    mode: mode || 'every',
    fps: fps ?? 1,
    interval: interval ?? 1,
    format: format || 'jpg',
    quality: quality ?? 2,
    onEvent: (evt) => {
      jobs.set(jobId, { ...jobs.get(jobId), ...evt, updatedAt: Date.now() });
    },
  })
    .then((result) => {
      jobs.set(jobId, {
        stage: 'done',
        message: '完成',
        result: enrichResult(result),
        updatedAt: Date.now(),
      });
    })
    .catch((err) => {
      console.error(err);
      jobs.set(jobId, {
        stage: 'error',
        message: err.message || String(err),
        updatedAt: Date.now(),
      });
    });
});

/** 关闭任务：延迟清理 */
app.post('/api/jobs/:id/release', async (req, res) => {
  try {
    const reason = req.body?.reason || 'closed';
    const result = await releaseJob(req.params.id, { reason, jobs });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

/** 取消延迟清理（用户刷新回来继续看） */
app.post('/api/jobs/:id/keep', async (req, res) => {
  try {
    const dir = jobDir(req.params.id);
    const marker = path.join(dir, '.release.json');
    await fsp.rm(marker, { force: true });
    const prev = jobs.get(req.params.id);
    if (prev) {
      const { releaseAt, released, releaseReason, ...rest } = prev;
      jobs.set(req.params.id, { ...rest, updatedAt: Date.now() });
    }
    res.json({ ok: true, jobId: req.params.id, kept: true });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});
app.get('/api/jobs/:id', async (req, res) => {
  let job = jobs.get(req.params.id);
  if (!job) {
    // 本机进程重启后内存任务会丢：若磁盘仍有 result.json 则恢复为已完成
    try {
      const raw = await fsp.readFile(path.join(jobDir(req.params.id), 'result.json'), 'utf8');
      const parsed = JSON.parse(raw);
      job = {
        stage: 'done',
        message: '完成',
        result: enrichResult(parsed),
        updatedAt: Date.now(),
        revived: true,
      };
      jobs.set(req.params.id, job);
    } catch {
      return res.status(404).json({ error: '任务不存在' });
    }
  }
  res.json(job);
});

app.get('/api/jobs/:id/frames', async (req, res) => {
  const dir = path.join(jobDir(req.params.id), 'frames');
  try {
    const names = (await fsp.readdir(dir))
      .filter((n) => /^frame_\d+\.(jpg|png|webp)$/i.test(n))
      .sort();
    res.json({
      count: names.length,
      frames: names.map((name) => ({
        name,
        url: `/output/${req.params.id}/frames/${name}`,
      })),
    });
  } catch {
    res.status(404).json({ error: '帧目录不存在' });
  }
});

/** 查看清理策略 */
app.get('/api/cleanup', (_req, res) => {
  res.json(getCleanupConfig());
});

/** 立即清空本机抽帧缓存与上传临时文件 */
app.post('/api/cleanup', async (_req, res) => {
  try {
    const result = await purgeCache({ jobs });
    res.json({
      ok: true,
      removed: result.removed.length,
      freedBytes: result.freedBytes,
      remaining: result.remaining,
      items: result.removed,
      config: result.config,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

function enrichResult(result) {
  const isImages = result.contentType === 'images' || result.meta?.contentType === 'images';
  return {
    ...result,
    contentType: isImages ? 'images' : result.contentType || 'video',
    videoUrl: isImages ? null : `/output/${result.jobId}/source.mp4`,
    framesUrlPrefix: `/output/${result.jobId}/frames/`,
    resultUrl: `/output/${result.jobId}/result.json`,
  };
}

await ensureDir(OUTPUT_ROOT);
startCleanupScheduler({ jobs });

/**
 * 启动本机 HTTP 服务（`npm start` / desktop / Tauri 共用）
 * @param {{ port?: number, host?: string }} [opts]
 */
export async function startServer(opts = {}) {
  // port=0 表示系统分配空闲端口；不能用 `|| 3780`（0 会被当成假值）
  let port;
  if (opts.port !== undefined && opts.port !== null && opts.port !== '') {
    port = Number(opts.port);
    if (!Number.isFinite(port) || port < 0) port = 3780;
  } else if (process.env.PORT) {
    port = Number(process.env.PORT) || 3780;
  } else {
    port = 3780;
  }
  // Electron / 本机：默认只听 127.0.0.1；可用 HOST=0.0.0.0 放开
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const realPort = typeof address === 'object' && address ? address.port : port;
      console.log(`抖音逐帧工具（本机）: http://127.0.0.1:${realPort}`);
      if (host === '0.0.0.0' || host === '::') {
        console.log(`也可打开: http://localhost:${realPort}`);
      }
      console.log(`CLI: npm run cli -- "<抖音链接>"`);
      resolve({ app, server, port: realPort, host });
    });
    server.on('error', reject);
  });
}

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] && path.resolve(process.argv[1]);
    return entry === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  await startServer();
}