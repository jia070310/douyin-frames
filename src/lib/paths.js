import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const OUTPUT_ROOT = path.join(ROOT, 'output');
export const UPLOADS_ROOT = path.join(ROOT, 'uploads');

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
