import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  resolveDouyinVideo,
  downloadVideo,
  BROWSER_DOWNLOAD_HEADERS,
  looksLikeNoteInput,
} from './douyin.js';
import { extractFrames, probeVideo } from './frames.js';
import { ensureDir, jobDir, OUTPUT_ROOT } from './paths.js';

/**
 * @typedef {object} ExtractOptions
 * @property {string} [url] 抖音分享/作品链接（本机解析）
 * @property {string} [videoUrl] 已解析的视频直链（跳过解析，直接下载）
 * @property {object} [meta] 与 videoUrl 配套的元信息
 * @property {string} [localVideo] 本地视频路径（跳过抖音下载）
 * @property {'every'|'fps'|'seconds'} [mode]
 * @property {number} [fps]
 * @property {number} [interval]
 * @property {'jpg'|'png'|'webp'} [format]
 * @property {number} [quality]
 * @property {string} [jobId]
 * @property {boolean} [allowUrlResolve] 是否允许仅凭分享链本机解析（默认开；ALLOW_URL_RESOLVE=0 关闭）
 * @property {(evt:{stage:string,message?:string,progress?:object})=>void} [onEvent]
 */

/**
 * 完整流水线（本机工具）：
 * - videoUrl / localVideo → 下载或复制 → FFmpeg 抽帧
 * - url → 本机解析 → 视频抽帧，或图文直接下载图片展示
 */
export async function runExtractJob(options) {
  const {
    url,
    videoUrl,
    meta: inputMeta,
    localVideo,
    mode = 'every',
    fps = 1,
    interval = 1,
    format = 'jpg',
    quality = 2,
    jobId = crypto.randomBytes(6).toString('hex'),
    onEvent,
    allowUrlResolve = process.env.ALLOW_URL_RESOLVE !== '0' &&
      process.env.ALLOW_SERVER_RESOLVE !== '0',
  } = options;

  if (!url && !localVideo && !videoUrl) {
    throw new Error('请提供抖音链接、videoUrl 直链，或 localVideo 本地文件');
  }

  const emit = (stage, message, progress) =>
    onEvent?.({ stage, message, progress, jobId });

  await ensureDir(OUTPUT_ROOT);
  const base = jobDir(jobId);
  const videoPath = path.join(base, 'source.mp4');
  const framesPath = path.join(base, 'frames');
  await ensureDir(base);
  await ensureDir(framesPath);

  let meta = {
    awemeId: inputMeta?.awemeId || '',
    desc: inputMeta?.desc || '',
    author: inputMeta?.author || '',
    pageUrl: inputMeta?.pageUrl || '',
    sourceUrl: inputMeta?.sourceUrl || url || videoUrl || localVideo,
    via: inputMeta?.via || '',
    contentType: inputMeta?.contentType || '',
    images: Array.isArray(inputMeta?.images) ? inputMeta.images : [],
  };

  if (localVideo) {
    emit('download', '正在复制本地视频…');
    await fsp.copyFile(localVideo, videoPath);
    const stat = await fsp.stat(videoPath);
    if (stat.size < 1024) throw new Error('本地视频文件过小或无效');
  } else if (videoUrl) {
    emit('download', '正在按直链下载原视频…');
    meta.via = meta.via || 'direct-url';
    await downloadVideo(videoUrl, videoPath);
  } else if (allowUrlResolve && url) {
    emit('resolve', '本机正在解析抖音作品…');
    meta = await resolveDouyinVideo(url);

    // 图文 note：直接下载图片，跳过 FFmpeg（勿把配乐当视频）
    const preferImages =
      Array.isArray(meta.images) &&
      meta.images.length > 0 &&
      (meta.contentType === 'images' ||
        looksLikeNoteInput(url) ||
        looksLikeNoteInput(meta.pageUrl || '') ||
        looksLikeNoteInput(meta.sourceUrl || '') ||
        (!meta.videoUrl && !meta.videoBuffer));

    if (preferImages) {
      return await finishAsNoteImages({
        meta,
        url,
        jobId,
        base,
        framesPath,
        mode,
        fps,
        interval,
        format,
        quality,
        emit,
      });
    }

    emit('download', '本机正在下载原视频…');
    if (meta.videoBuffer && Buffer.isBuffer(meta.videoBuffer)) {
      await fsp.writeFile(videoPath, meta.videoBuffer);
      delete meta.videoBuffer;
    } else {
      await downloadVideo(meta.videoUrl, videoPath);
    }
  } else {
    throw new Error('未开启链接解析。请提供 videoUrl 直链，或上传/指定本地视频文件。');
  }

  const downloaded = await fsp.stat(videoPath);

  emit('probe', '正在读取视频信息…');
  let probe = null;
  try {
    probe = await probeVideo(videoPath);
  } catch {
    probe = null;
  }

  // 下载到的是纯音频（图文配乐）时：若还能拿到图片则改走图文
  if (probe?.audioOnly || (!probe?.hasVideo && probe?.hasAudio)) {
    try {
      if (allowUrlResolve && url) {
        const again = await resolveDouyinVideo(url);
        if (Array.isArray(again.images) && again.images.length) {
          emit('download', '检测到非视频文件，改为下载图文图片…');
          return await finishAsNoteImages({
            meta: { ...meta, ...again, contentType: 'images' },
            url,
            jobId,
            base,
            framesPath,
            mode,
            fps,
            interval,
            format,
            quality,
            emit,
          });
        }
      }
    } catch {
      // fall through
    }
    throw new Error(
      '下载到的文件没有视频画面（可能是图文配乐）。请确认链接是视频作品，或粘贴 /note/ 图文链接重试。',
    );
  }

  if (!probe?.hasVideo) {
    throw new Error('文件中未检测到视频流，无法抽帧。若是图文作品请使用 /note/ 链接。');
  }

  const tip =
    mode === 'every'
      ? '正在逐帧导出图片（视频较长时可能较慢）…'
      : mode === 'fps'
        ? `正在按 ${fps} fps 采样导出…`
        : `正在按每 ${interval} 秒一帧导出…`;

  emit('frames', tip);
  const frames = await extractFrames({
    videoPath,
    outDir: framesPath,
    mode,
    fps,
    interval,
    format,
    quality,
    onLog: () => {},
    onProgress: (p) => emit('frames', tip, p),
  });

  const result = {
    jobId,
    contentType: 'video',
    meta: {
      awemeId: meta.awemeId,
      desc: meta.desc,
      author: meta.author,
      pageUrl: meta.pageUrl,
      sourceUrl: meta.sourceUrl || url || localVideo,
      contentType: 'video',
    },
    video: {
      path: videoPath,
      size: downloaded.size,
      ...probe,
    },
    frames: {
      count: frames.count,
      format: frames.format,
      dir: framesPath,
      names: frames.files.map((f) => path.basename(f)),
    },
    options: { mode, fps, interval, format, quality },
  };

  await fsp.writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  emit('done', `完成：导出 ${frames.count} 张图片`, { done: frames.count });
  return result;
}

async function finishAsNoteImages({
  meta,
  url,
  jobId,
  base,
  framesPath,
  mode,
  fps,
  interval,
  format,
  quality,
  emit,
}) {
  emit('download', `正在下载图文图片（${meta.images.length} 张）…`);
  const saved = await downloadNoteImages(meta.images, framesPath, {
    onProgress: (p) => emit('download', `正在下载图文图片（${p.done}/${p.total}）…`, p),
  });
  const result = {
    jobId,
    contentType: 'images',
    meta: {
      awemeId: meta.awemeId,
      desc: meta.desc,
      author: meta.author,
      pageUrl: meta.pageUrl,
      sourceUrl: meta.sourceUrl || url,
      contentType: 'images',
    },
    video: {
      path: null,
      size: 0,
      width: null,
      height: null,
      duration: null,
    },
    frames: {
      count: saved.count,
      format: saved.format,
      dir: framesPath,
      names: saved.names,
    },
    options: { mode, fps, interval, format, quality },
  };
  await fsp.writeFile(path.join(base, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  emit('done', `完成：图文 ${saved.count} 张图片`, { done: saved.count });
  return result;
}

/**
 * 下载图文图片到 frames 目录，命名与抽帧一致：frame_000001.ext
 */
async function downloadNoteImages(urls, outDir, { onProgress } = {}) {
  await ensureDir(outDir);
  const names = [];
  let format = 'jpg';
  let i = 0;
  for (const url of urls) {
    i += 1;
    const { ext, buf } = await fetchImageBuffer(url);
    if (i === 1) format = ext;
    const name = `frame_${String(i).padStart(6, '0')}.${ext}`;
    await fsp.writeFile(path.join(outDir, name), buf);
    names.push(name);
    onProgress?.({ done: i, total: urls.length });
  }
  if (!names.length) throw new Error('图文图片下载失败：未保存任何文件');
  return { count: names.length, format, names };
}

async function fetchImageBuffer(imageUrl, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        ...BROWSER_DOWNLOAD_HEADERS,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 256) throw new Error('图片过小，可能无效');
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    let ext = 'jpg';
    if (ct.includes('png') || /\.png(\?|$)/i.test(imageUrl)) ext = 'png';
    else if (ct.includes('webp') || /\.webp(\?|$)/i.test(imageUrl)) ext = 'webp';
    else if (ct.includes('jpeg') || ct.includes('jpg') || /\.jpe?g(\?|$)/i.test(imageUrl))
      ext = 'jpg';
    else if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png';
    else if (buf[0] === 0xff && buf[1] === 0xd8) ext = 'jpg';
    else if (buf.slice(0, 4).toString('ascii') === 'RIFF') ext = 'webp';
    return { ext, buf };
  } finally {
    clearTimeout(timer);
  }
}
