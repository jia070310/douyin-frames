import { randomBytes } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runExtractJob } from './lib/pipeline.js';
import { OUTPUT_ROOT, jobDir, ensureDir } from './lib/paths.js';
import { cleanupOutput, getCleanupConfig, startCleanupScheduler, releaseJob, releaseJobs } from './lib/cleanup.js';
import { initProxy, getProxyDisplay } from './lib/proxy.js';

await initProxy();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3780;
const HOST = process.env.HOST || '0.0.0.0';
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

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    cleanup: getCleanupConfig(),
    proxy: getProxyDisplay(),
  });
});

/**
 * 同步提取（适合短视频 / CLI 调试）
 * POST /api/extract
 */
app.post('/api/extract', async (req, res) => {
  const { url, mode, fps, interval, format, quality } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '缺少 url 字段' });
  }

  try {
    const result = await runExtractJob({
      url,
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
 * 异步任务（网站部署推荐：先返回 jobId，再轮询）
 * POST /api/jobs
 * GET  /api/jobs/:id
 */
app.post('/api/jobs', async (req, res) => {
  const { url, mode, fps, interval, format, quality, releaseJobId, releaseJobIds } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '缺少 url 字段' });
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
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
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

/** 立即执行一次清理 */
app.post('/api/cleanup', async (_req, res) => {
  try {
    const result = await cleanupOutput({ jobs });
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
  return {
    ...result,
    videoUrl: `/output/${result.jobId}/source.mp4`,
    framesUrlPrefix: `/output/${result.jobId}/frames/`,
    resultUrl: `/output/${result.jobId}/result.json`,
  };
}

await ensureDir(OUTPUT_ROOT);
startCleanupScheduler({ jobs });

app.listen(PORT, HOST, () => {
  console.log(`抖音逐帧工具: http://${HOST}:${PORT}`);
  if (IS_PROD) {
    console.log('生产模式：请用 Nginx/Caddy 反代到二级域名（勿对外暴露端口）');
  } else {
    console.log(`本地访问: http://localhost:${PORT}`);
  }
  const proxy = getProxyDisplay();
  if (proxy) console.log(`抖音出口代理: ${proxy}`);
  else if (IS_PROD) {
    console.log('提示：机房 IP 易被抖音风控，建议配置 DOUYIN_PROXY（住宅/移动代理）');
  }
  console.log(`CLI: npm run cli -- "<抖音链接>"`);
});
