#!/usr/bin/env node
/**
 * 本机客户端：解析抖音地址 → 把直链交给远程服务器下载抽帧。
 *
 * 用法:
 *   1. 设置 AGENT_REMOTE（远程站点，如 http://frames.example.com）
 *   2. npm run agent
 *   3. 浏览器打开 http://127.0.0.1:3791  （必须用这个本地页，不要用远程站解析）
 */
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProxy } from './lib/proxy.js';
import { pushResolvedToRemote, resolveForClient } from './lib/remotePush.js';

await initProxy();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.AGENT_PORT) || 3791;
const HOST = process.env.AGENT_HOST || '127.0.0.1';
const REMOTE_BASE = String(
  process.env.AGENT_REMOTE || process.env.REMOTE_BASE || '',
)
  .trim()
  .replace(/\/+$/, '');

if (!REMOTE_BASE) {
  console.error(
    '请先设置 AGENT_REMOTE（远程抽帧站点），例如：\n  set AGENT_REMOTE=http://frames.example.com\n  npm run agent',
  );
  process.exit(1);
}

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Access-Control-Request-Private-Network'],
  }),
);
app.use(express.json({ limit: '1mb' }));
app.options('*', (_req, res) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.sendStatus(204);
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    role: 'client-resolve-agent',
    host: HOST,
    port: PORT,
    remoteBase: REMOTE_BASE,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    mode: 'client-local',
    remoteBase: REMOTE_BASE,
    prefer: 'url',
  });
});

app.post('/api/resolve', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url' });
  try {
    const data = await resolveForClient(url);
    if (!data.videoUrl && !data.hasBuffer) {
      return res.status(422).json({ error: '未能解析到视频地址' });
    }
    res.json(data);
  } catch (err) {
    console.error('[agent resolve]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/push', async (req, res) => {
  const {
    url,
    remoteBase,
    mode,
    fps,
    interval,
    format,
    quality,
    releaseJobId,
    prefer,
  } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '缺少 url' });
  }

  const target = String(remoteBase || REMOTE_BASE).replace(/\/+$/, '');
  if (!target) return res.status(400).json({ error: '缺少 remoteBase' });

  try {
    console.log(`[push] 本机解析 → ${target}`);
    const result = await pushResolvedToRemote({
      url,
      remoteBase: target,
      mode,
      fps,
      interval,
      format,
      quality,
      releaseJobId,
      prefer: prefer || 'url',
      onProgress: (msg) => console.log(`[push] ${msg}`),
    });
    console.log(`[push] job ${result.jobId} via=${result.via}`);
    res.json({ ...result, remoteBase: target });
  } catch (err) {
    console.error('[agent push]', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.use(express.static(path.join(ROOT, 'public')));

app.listen(PORT, HOST, () => {
  console.log(`本机客户端: http://${HOST}:${PORT}`);
  console.log(`远程服务器: ${REMOTE_BASE}`);
  console.log('请用浏览器打开上面的本机地址（不要用远程站去解析）。');
  console.log('流程：本机解析直链 → 服务器下载视频并抽帧。');
});
