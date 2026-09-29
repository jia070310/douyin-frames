import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveDouyinVideo, downloadVideo } from './douyin.js';
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
 * - url → 本机解析（Playwright）→ 下载 → 抽帧
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
    emit('resolve', '本机正在解析抖音视频地址…');
    meta = await resolveDouyinVideo(url);

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
    meta: {
      awemeId: meta.awemeId,
      desc: meta.desc,
      author: meta.author,
      pageUrl: meta.pageUrl,
      sourceUrl: meta.sourceUrl || url || localVideo,
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
