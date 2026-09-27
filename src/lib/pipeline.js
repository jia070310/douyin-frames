import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveDouyinVideo, downloadVideo } from './douyin.js';
import { extractFrames, probeVideo } from './frames.js';
import { ensureDir, jobDir, OUTPUT_ROOT } from './paths.js';

/**
 * @typedef {object} ExtractOptions
 * @property {string} [url]
 * @property {string} [localVideo] 本地视频路径（跳过抖音下载）
 * @property {'every'|'fps'|'seconds'} [mode]
 * @property {number} [fps]
 * @property {number} [interval]
 * @property {'jpg'|'png'|'webp'} [format]
 * @property {number} [quality]
 * @property {string} [jobId]
 * @property {(evt:{stage:string,message?:string,progress?:object})=>void} [onEvent]
 */

/**
 * 完整流水线：解析 → 下载原视频 → 逐帧出图
 */
export async function runExtractJob(options) {
  const {
    url,
    localVideo,
    mode = 'every',
    fps = 1,
    interval = 1,
    format = 'jpg',
    quality = 2,
    jobId = crypto.randomBytes(6).toString('hex'),
    onEvent,
  } = options;

  if (!url && !localVideo) {
    throw new Error('请提供抖音 url 或 localVideo 本地视频路径');
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
    awemeId: '',
    desc: '',
    author: '',
    pageUrl: '',
    sourceUrl: url || localVideo,
  };

  if (localVideo) {
    emit('download', '正在复制本地视频…');
    await fsp.copyFile(localVideo, videoPath);
    const stat = await fsp.stat(videoPath);
    if (stat.size < 1024) throw new Error('本地视频文件过小或无效');
  } else {
    emit('resolve', '正在解析抖音视频地址…');
    meta = await resolveDouyinVideo(url);

    emit('download', '正在下载原视频…');
    if (meta.videoBuffer && Buffer.isBuffer(meta.videoBuffer)) {
      await fsp.writeFile(videoPath, meta.videoBuffer);
      // 不把巨大 buffer 写入 result.json
      delete meta.videoBuffer;
    } else {
      await downloadVideo(meta.videoUrl, videoPath);
    }
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
