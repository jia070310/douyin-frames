import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 源码根目录；打包后可由 DOUYIN_FRAMES_ROOT 覆盖 */
export const ROOT = process.env.DOUYIN_FRAMES_ROOT
  ? path.resolve(process.env.DOUYIN_FRAMES_ROOT)
  : path.resolve(__dirname, '../..');

/** 输出目录；桌面端建议指到 userData/output */
export const OUTPUT_ROOT = process.env.DOUYIN_FRAMES_OUTPUT
  ? path.resolve(process.env.DOUYIN_FRAMES_OUTPUT)
  : path.join(ROOT, 'output');

export const UPLOADS_ROOT = process.env.DOUYIN_FRAMES_UPLOADS
  ? path.resolve(process.env.DOUYIN_FRAMES_UPLOADS)
  : path.join(ROOT, 'uploads');

export function jobDir(jobId) {
  return path.join(OUTPUT_ROOT, jobId);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}
