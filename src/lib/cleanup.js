import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_ROOT, jobDir, ensureDir } from './paths.js';

const RELEASE_FILE = '.release.json';

/**
 * 环境变量：
 * - CLEANUP_TTL_HOURS           兜底保留时长（小时），默认 24；0=关闭
 * - CLEANUP_INTERVAL_MIN        定期扫描间隔（分钟），默认 30；0=仅启动时
 * - CLEANUP_MAX_MB              output 体积上限（MB），默认 0=不限
 * - CLEANUP_AFTER_RELEASE_MIN   关闭/换任务后延迟清理（分钟），默认 10；0=立即删
 */

export function getCleanupConfig() {
  const ttlHours = numEnv('CLEANUP_TTL_HOURS', 24);
  const intervalMin = numEnv('CLEANUP_INTERVAL_MIN', 30);
  const maxMb = numEnv('CLEANUP_MAX_MB', 0);
  const afterReleaseMin = numEnv('CLEANUP_AFTER_RELEASE_MIN', 10);
  return {
    ttlMs: ttlHours > 0 ? ttlHours * 60 * 60 * 1000 : 0,
    intervalMs: intervalMin > 0 ? intervalMin * 60 * 1000 : 0,
    maxBytes: maxMb > 0 ? maxMb * 1024 * 1024 : 0,
    afterReleaseMs: afterReleaseMin >= 0 ? afterReleaseMin * 60 * 1000 : 10 * 60 * 1000,
    ttlHours,
    intervalMin,
    maxMb,
    afterReleaseMin,
    enabled: true,
  };
}

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 标记任务为「已关闭 / 已换新任务」，到期后清理
 * @param {string} jobId
 * @param {{ reason?: string, delayMs?: number, jobs?: Map<string, object> }} [opts]
 */
export async function releaseJob(jobId, opts = {}) {
  if (!jobId || !/^[a-f0-9]{8,16}$/i.test(jobId)) {
    throw new Error('无效的 jobId');
  }

  const cfg = getCleanupConfig();
  const delayMs = opts.delayMs ?? cfg.afterReleaseMs;
  const dir = jobDir(jobId);
  const st = await safeStat(dir);
  if (!st) {
    opts.jobs?.delete(jobId);
    return { ok: true, missing: true, jobId };
  }

  const now = Date.now();
  const releaseAt = now + Math.max(0, delayMs);
  const payload = {
    jobId,
    reason: opts.reason || 'released',
    releasedAt: now,
    releaseAt,
  };
  await fsp.writeFile(path.join(dir, RELEASE_FILE), JSON.stringify(payload, null, 2), 'utf8');

  if (opts.jobs?.has(jobId)) {
    const prev = opts.jobs.get(jobId) || {};
    opts.jobs.set(jobId, {
      ...prev,
      released: true,
      releaseAt,
      releaseReason: payload.reason,
      updatedAt: now,
    });
  }

  // 延迟为 0：立刻删
  if (delayMs <= 0) {
    const size = await dirSize(dir);
    await fsp.rm(dir, { recursive: true, force: true });
    opts.jobs?.delete(jobId);
    return { ok: true, jobId, removed: true, releaseAt, freedBytes: size };
  }

  return {
    ok: true,
    jobId,
    releaseAt,
    delayMs,
    message: `${Math.round(delayMs / 60000)} 分钟后自动清理`,
  };
}

/**
 * 批量标记（开新任务时释放旧任务）
 */
export async function releaseJobs(jobIds, opts = {}) {
  const ids = [...new Set((jobIds || []).filter(Boolean))];
  const results = [];
  for (const id of ids) {
    try {
      results.push(await releaseJob(id, opts));
    } catch (err) {
      results.push({ ok: false, jobId: id, error: err.message || String(err) });
    }
  }
  return results;
}

/**
 * @param {object} [opts]
 * @param {Map<string, object>} [opts.jobs]
 * @param {(msg:string)=>void} [opts.onLog]
 */
export async function cleanupOutput(opts = {}) {
  const { jobs, onLog = console.log } = opts;
  const cfg = getCleanupConfig();
  await ensureDir(OUTPUT_ROOT);

  const entries = await fsp.readdir(OUTPUT_ROOT, { withFileTypes: true });
  const now = Date.now();
  /** @type {{ id:string, dir:string, mtimeMs:number, size:number, releaseAt?:number }[]} */
  const jobsOnDisk = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) {
      if (/^(_|\.)/.test(ent.name) || ent.name.startsWith('debug')) {
        const p = path.join(OUTPUT_ROOT, ent.name);
        try {
          await fsp.rm(p, { force: true, recursive: true });
        } catch {
          // ignore
        }
      }
      continue;
    }

    const dir = path.join(OUTPUT_ROOT, ent.name);
    const meta = await safeStat(dir);
    if (!meta) continue;

    const looksLikeJob =
      /^[a-f0-9]{8,16}$/i.test(ent.name) ||
      (await exists(path.join(dir, 'result.json'))) ||
      (await exists(path.join(dir, 'source.mp4')));

    if (!looksLikeJob) continue;

    const size = await dirSize(dir);
    const releaseMeta = await readRelease(dir);
    jobsOnDisk.push({
      id: ent.name,
      dir,
      mtimeMs: meta.mtimeMs,
      size,
      releaseAt: releaseMeta?.releaseAt,
    });
  }

  jobsOnDisk.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const removed = [];
  let freed = 0;

  // 1) 已标记释放且到期
  for (const job of jobsOnDisk) {
    if (!job.releaseAt || job.releaseAt > now) continue;
    await removeJob(job, jobs);
    removed.push({ id: job.id, reason: 'released', size: job.size });
    freed += job.size;
    job._gone = true;
  }

  // 2) TTL 兜底
  if (cfg.ttlMs > 0) {
    for (const job of jobsOnDisk) {
      if (job._gone) continue;
      if (now - job.mtimeMs <= cfg.ttlMs) continue;
      await removeJob(job, jobs);
      removed.push({ id: job.id, reason: 'ttl', size: job.size });
      freed += job.size;
      job._gone = true;
    }
  }

  // 3) 体积上限
  if (cfg.maxBytes > 0) {
    let total = jobsOnDisk.filter((j) => !j._gone).reduce((s, j) => s + j.size, 0);
    for (const job of jobsOnDisk) {
      if (job._gone) continue;
      if (total <= cfg.maxBytes) break;
      await removeJob(job, jobs);
      removed.push({ id: job.id, reason: 'quota', size: job.size });
      freed += job.size;
      total -= job.size;
      job._gone = true;
    }
  }

  // 4) 内存表同步
  if (jobs) {
    for (const [id, info] of jobs.entries()) {
      if (info.releaseAt && info.releaseAt <= now) {
        jobs.delete(id);
        continue;
      }
      const age = now - (info.updatedAt || 0);
      if (cfg.ttlMs > 0 && age > cfg.ttlMs) jobs.delete(id);
    }
  }

  if (removed.length) {
    onLog(`[cleanup] 已清理 ${removed.length} 个任务，释放约 ${formatBytes(freed)}`);
  }

  return {
    removed,
    freedBytes: freed,
    remaining: jobsOnDisk.filter((j) => !j._gone).length,
    pendingRelease: jobsOnDisk.filter((j) => !j._gone && j.releaseAt && j.releaseAt > now).length,
    config: cfg,
  };
}

export function startCleanupScheduler(opts = {}) {
  const cfg = getCleanupConfig();

  const run = () =>
    cleanupOutput(opts).catch((err) => {
      console.error('[cleanup] 失败:', err.message || err);
    });

  const bootTimer = setTimeout(run, 3_000);
  // 释放队列更频繁检查（每分钟）
  const releaseTimer = setInterval(run, 60_000);
  let intervalTimer = null;
  if (cfg.intervalMs > 0) {
    intervalTimer = setInterval(run, cfg.intervalMs);
    if (typeof intervalTimer.unref === 'function') intervalTimer.unref();
  }
  if (typeof bootTimer.unref === 'function') bootTimer.unref();
  if (typeof releaseTimer.unref === 'function') releaseTimer.unref();

  console.log(
    `[cleanup] 已启用：关闭/换任务后 ${cfg.afterReleaseMin} 分钟清理` +
      (cfg.ttlHours ? `；兜底保留 ${cfg.ttlHours}h` : '') +
      (cfg.maxMb ? `；上限 ${cfg.maxMb}MB` : ''),
  );

  return () => {
    clearTimeout(bootTimer);
    clearInterval(releaseTimer);
    if (intervalTimer) clearInterval(intervalTimer);
  };
}

async function readRelease(dir) {
  try {
    const raw = await fsp.readFile(path.join(dir, RELEASE_FILE), 'utf8');
    const data = JSON.parse(raw);
    if (!data?.releaseAt) return null;
    return data;
  } catch {
    return null;
  }
}

async function removeJob(job, jobs) {
  await fsp.rm(job.dir, { recursive: true, force: true });
  jobs?.delete(job.id);
}

async function safeStat(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += await dirSize(p);
    else {
      const st = await safeStat(p);
      if (st) total += st.size;
    }
  }
  return total;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
