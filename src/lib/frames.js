import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function ffmpegBin() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function ffprobeBin() {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

function run(cmd, args, { onLog } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderr += text;
      onLog?.(text);
    });
    child.stdout.on('data', (buf) => onLog?.(buf.toString()));

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `未找到 ${cmd}。桌面版会自动检测/下载 FFmpeg；CLI 请安装并加入 PATH：https://ffmpeg.org/download.html`,
          ),
        );
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`${cmd} 退出码 ${code}\n${stderr.slice(-800)}`));
    });
  });
}

/**
 * @param {object} options
 * @param {string} options.videoPath
 * @param {string} options.outDir
 * @param {'every'|'fps'|'seconds'} [options.mode]  every=逐帧, fps=按帧率采样, seconds=按秒间隔
 * @param {number} [options.fps] mode=fps 时每秒抽几帧
 * @param {number} [options.interval] mode=seconds 时每隔几秒一帧
 * @param {'jpg'|'png'|'webp'} [options.format]
 * @param {number} [options.quality] jpg/webp 质量 2-31(ffmpeg qscale) 或 1-100
 * @param {(msg:string)=>void} [options.onLog]
 * @param {(p:{done:number,total?:number})=>void} [options.onProgress]
 */
export async function extractFrames({
  videoPath,
  outDir,
  mode = 'every',
  fps = 1,
  interval = 1,
  format = 'jpg',
  quality = 2,
  onLog,
  onProgress,
}) {
  await fs.mkdir(outDir, { recursive: true });

  const ext = format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpg';
  const pattern = path.join(outDir, `frame_%06d.${ext}`);

  // HEVC 等编码更稳的解码参数；逐帧时禁用丢帧，避免花屏
  const args = ['-y', '-hwaccel', 'auto', '-i', videoPath];

  if (mode === 'every') {
    // 用 -vsync 0（passthrough）兼容旧版 FFmpeg；-fps_mode 需较新版本
    args.push('-vsync', '0');
  } else if (mode === 'fps') {
    args.push('-vf', `fps=${Math.max(0.1, Number(fps) || 1)}`);
  } else if (mode === 'seconds') {
    const sec = Math.max(0.1, Number(interval) || 1);
    args.push('-vf', `fps=1/${sec}`);
  }

  if (ext === 'jpg') {
    args.push('-q:v', String(Math.min(31, Math.max(2, Number(quality) || 2))));
  } else if (ext === 'webp') {
    args.push('-quality', String(Math.min(100, Math.max(1, Number(quality) || 80))));
  }

  args.push(pattern);

  // 先探测总帧数（可选）
  let totalFrames;
  try {
    totalFrames = await probeFrameCount(videoPath);
  } catch {
    totalFrames = undefined;
  }

  // 用 progress 管道粗略估计进度：重新跑一遍带 -progress
  // 简化：直接执行，完成后统计文件数
  await run(ffmpegBin(), args, { onLog });

  const files = (await fs.readdir(outDir))
    .filter((f) => f.startsWith('frame_') && f.endsWith(`.${ext}`))
    .sort();

  onProgress?.({ done: files.length, total: totalFrames });

  return {
    count: files.length,
    format: ext,
    files: files.map((name) => path.join(outDir, name)),
    totalFrames,
  };
}

export async function probeVideo(videoPath) {
  const args = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    videoPath,
  ];

  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin(), args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err += b.toString()));
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        reject(new Error(`未找到 ${ffprobeBin()}，请安装 FFmpeg / ffprobe`));
      } else reject(e);
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: out });
      else reject(new Error(err || `ffprobe 失败 ${code}`));
    });
  });

  const info = JSON.parse(stdout);
  const videoStream = (info.streams || []).find((s) => s.codec_type === 'video');
  return {
    duration: Number(info.format?.duration || 0),
    size: Number(info.format?.size || 0),
    width: videoStream?.width,
    height: videoStream?.height,
    fps: parseFps(videoStream?.r_frame_rate || videoStream?.avg_frame_rate),
    codec: videoStream?.codec_name,
  };
}

async function probeFrameCount(videoPath) {
  const info = await probeVideo(videoPath);
  if (info.duration && info.fps) {
    return Math.round(info.duration * info.fps);
  }
  return undefined;
}

function parseFps(rate) {
  if (!rate) return null;
  if (typeof rate === 'number') return rate;
  const [a, b] = String(rate).split('/');
  const num = Number(a);
  const den = Number(b || 1);
  if (!num || !den) return null;
  return num / den;
}
