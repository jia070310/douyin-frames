import { resolveDouyinVideo } from './douyin.js';

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function readJson(res) {
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(
      res.ok ? '服务器返回了无法解析的响应' : `HTTP ${res.status}: ${raw.slice(0, 200)}`,
    );
  }
}

/**
 * 本机解析抖音链接，再把直链（或视频字节）交给远程服务器抽帧。
 *
 * @param {object} opts
 * @param {string} opts.remoteBase 远程站点根地址
 * @param {string} opts.url 抖音分享/作品链接
 * @param {string} [opts.mode]
 * @param {number} [opts.fps]
 * @param {number} [opts.interval]
 * @param {string} [opts.format]
 * @param {number} [opts.quality]
 * @param {string} [opts.releaseJobId]
 * @param {'auto'|'url'|'upload'} [opts.prefer]
 *   auto: 有字节优先上传（更稳）；url: 只交直链让服务器下载；upload: 强制上传字节
 * @param {(msg:string)=>void} [opts.onProgress]
 */
export async function pushResolvedToRemote(opts) {
  const remoteBase = stripTrailingSlash(opts.remoteBase);
  const url = String(opts.url || '').trim();
  if (!remoteBase) throw new Error('缺少 remoteBase');
  if (!url) throw new Error('缺少抖音链接');

  const prefer = opts.prefer || 'auto';
  const onProgress = opts.onProgress || (() => {});

  onProgress('本机解析抖音视频地址…');
  const meta = await resolveDouyinVideo(url);

  const jobMeta = {
    mode: opts.mode || 'every',
    fps: opts.fps ?? 1,
    interval: opts.interval ?? 1,
    format: opts.format || 'jpg',
    quality: opts.quality ?? 2,
    sourceUrl: meta.sourceUrl || url,
    releaseJobId: opts.releaseJobId || undefined,
    meta: {
      awemeId: meta.awemeId || '',
      desc: meta.desc || '',
      author: meta.author || '',
      pageUrl: meta.pageUrl || '',
      sourceUrl: meta.sourceUrl || url,
      via: 'client-resolve',
    },
  };

  const hasBuffer =
    meta.videoBuffer && Buffer.isBuffer(meta.videoBuffer) && meta.videoBuffer.length > 1024;
  const hasUrl = Boolean(meta.videoUrl);

  let mode = prefer;
  if (prefer === 'auto') {
    mode = hasBuffer ? 'upload' : 'url';
  }

  let created;
  let via;

  if (mode === 'url' && hasUrl) {
    onProgress('已解析直链，提交服务器下载…');
    const res = await fetch(`${remoteBase}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoUrl: meta.videoUrl,
        meta: jobMeta.meta,
        mode: jobMeta.mode,
        fps: jobMeta.fps,
        interval: jobMeta.interval,
        format: jobMeta.format,
        quality: jobMeta.quality,
        releaseJobId: jobMeta.releaseJobId,
      }),
    });
    created = await readJson(res);
    if (!res.ok) throw new Error(created.error || `创建任务失败 HTTP ${res.status}`);
    via = 'videoUrl';
  } else if (hasBuffer) {
    onProgress(
      `上传已下载视频（${(meta.videoBuffer.length / 1024 / 1024).toFixed(2)} MB）到服务器…`,
    );
    const res = await fetch(`${remoteBase}/api/jobs/with-video`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Job-Meta': JSON.stringify(jobMeta),
      },
      body: meta.videoBuffer,
    });
    created = await readJson(res);
    if (!res.ok) throw new Error(created.error || `上传失败 HTTP ${res.status}`);
    via = 'upload';
  } else if (hasUrl) {
    onProgress('已解析直链，提交服务器下载…');
    const res = await fetch(`${remoteBase}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoUrl: meta.videoUrl,
        meta: jobMeta.meta,
        mode: jobMeta.mode,
        fps: jobMeta.fps,
        interval: jobMeta.interval,
        format: jobMeta.format,
        quality: jobMeta.quality,
        releaseJobId: jobMeta.releaseJobId,
      }),
    });
    created = await readJson(res);
    if (!res.ok) throw new Error(created.error || `创建任务失败 HTTP ${res.status}`);
    via = 'videoUrl';
  } else {
    throw new Error('本机解析成功但既无视频直链也无视频字节');
  }

  return {
    jobId: created.jobId,
    statusUrl: created.statusUrl || `/api/jobs/${created.jobId}`,
    cleanup: created.cleanup,
    via,
    videoUrl: meta.videoUrl || null,
    meta: jobMeta.meta,
  };
}

/**
 * 仅本机解析，返回可交给服务器的直链与元信息（不含巨大 buffer）。
 */
export async function resolveForClient(url) {
  const meta = await resolveDouyinVideo(url);
  return {
    videoUrl: meta.videoUrl || null,
    hasBuffer: Boolean(meta.videoBuffer && meta.videoBuffer.length > 1024),
    bufferBytes: meta.videoBuffer?.length || 0,
    meta: {
      awemeId: meta.awemeId || '',
      desc: meta.desc || '',
      author: meta.author || '',
      pageUrl: meta.pageUrl || '',
      sourceUrl: meta.sourceUrl || url,
      via: 'client-resolve',
    },
  };
}
