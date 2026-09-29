import fsp from 'node:fs/promises';
import path from 'node:path';
import { OUTPUT_ROOT, UPLOADS_ROOT, jobDir, ensureDir } from './paths.js';

const RELEASE_FILE = '.release.json';

/**
 * 本机工具：默认不做定时/延迟自动清理，由用户点「清理缓存」触发。
 * 仍可用环境变量覆盖（一般不必）：
 * - CLEANUP_TTL_HOURS / CLEANUP_INTERVAL_MIN / CLEANUP_MAX_MB / CLEANUP_AFTER_RELEASE_MIN
 */
export function getCleanupConfig() {
  const ttlHours = numEnv('CLEANUP_TTL_HOURS', 0);
  const intervalMin = numEnv('CLEANUP_INTERVAL_MIN', 0);
  const maxMb = numEnv('CLEANUP_MAX_MB', 0);
  const afterReleaseMin = numEnv('CLEANUP_AFTER_RELEASE_MIN', -1);
  return {
    ttlMs: ttlHours > 0 ? ttlHours * 60 * 60 * 1000 : 0,
    intervalMs: intervalMin > 0 ? intervalMin * 60 * 1000 : 0,
    maxBytes: maxMb > 0 ? maxMb * 1024 * 1024 : 0,
    afterReleaseMs: afterReleaseMin >= 0 ? afterReleaseMin * 60 * 1000 : null,
    ttlHours,
    intervalMin,
    maxMb,
    afterReleaseMin,
    autoEnabled: ttlHours > 0 || intervalMin > 0 || maxMb > 0 || afterReleaseMin >= 0,
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
 * 标记任务为「已关闭 / 已换新任务」
 * 默认不自动删；仅当 CLEANUP_AFTER_RELEASE_MIN>=0 时按延迟清理。
 */
export async function releaseJob(jobId, opts = {}) {
  if (!jobId || !/^[a-f0-9]{8,16}$/i.test(jobId)) {
    throw new Error('无效的 jobId');
  }

  const cfg = getCleanupConfig();
  const delayMs =
    opts.delayMs != null
      ? opts.delayMs
      : cfg.afterReleaseMs != null
        ? cfg.afterReleaseMs
        : null;
  const dir = jobDir(jobId);
  const st = await safeStat(dir);
  if (!st) {
    opts.jobs?.delete(jobId);
    return { ok: true, missing: true, jobId };
  }

  const now = Date.now();

  // 本机默认：只从内存表拿掉，磁盘保留，等用户手动清理
  if (delayMs == null) {
    opts.jobs?.delete(jobId);
    return { ok: true, jobId, kept: true, message: '任务已关闭，缓存保留至手动清理' };
  }

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
 * @param {boolean} [opts.purgeAll] 立刻清空 output（及 uploads）
 * @param {(msg:string)=>void} [opts.onLog]
 */
export async function cleanupOutput(opts = {}) {
  const { jobs, onLog = console.log, purgeAll = false } = opts;
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

  if (purgeAll) {
    for (const job of jobsOnDisk) {
      await removeJob(job, jobs);
      removed.push({ id: job.id, reason: 'purge', size: job.size });
      freed += job.size;
      job._gone = true;
    }
    freed += await wipeDirContents(UPLOADS_ROOT);
    jobs?.clear();
  } else {
    // 1) 已标记释放且到期（仅当用户开了延迟清理时）
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

/** 手动清空缓存：删除全部抽帧输出与上传临时文件 */
export async function purgeCache(opts = {}) {
  return cleanupOutput({ ...opts, purgeAll: true });
}

export function startCleanupScheduler(opts = {}) {
  const cfg = getCleanupConfig();
  if (!cfg.autoEnabled) {
    console.log('[cleanup] 自动清理已关闭（本机工具默认保留缓存，可手动清理）');
    return () => {};
  }

  const run = () =>
    cleanupOutput(opts).catch((err) => {
      console.error('[cleanup] 失败:', err.message || err);
    });

  const bootTimer = setTimeout(run, 3_000);
  const releaseTimer = setInterval(run, 60_000);
  let intervalTimer = null;
  if (cfg.intervalMs > 0) {
    intervalTimer = setInterval(run, cfg.intervalMs);
    if (typeof intervalTimer.unref === 'function') intervalTimer.unref();
  }
  if (typeof bootTimer.unref === 'function') bootTimer.unref();
  if (typeof releaseTimer.unref === 'function') releaseTimer.unref();

  console.log(
    `[cleanup] 已启用自动清理` +
      (cfg.afterReleaseMin >= 0 ? `：关闭后 ${cfg.afterReleaseMin} 分钟` : '') +
      (cfg.ttlHours ? `；兜底保留 ${cfg.ttlHours}h` : '') +
      (cfg.maxMb ? `；上限 ${cfg.maxMb}MB` : ''),
  );

  return () => {
    clearTimeout(bootTimer);
    clearInterval(releaseTimer);
    if (intervalTimer) clearInterval(intervalTimer);
  };
}

async function wipeDirContents(root) {
  let freed = 0;
  try {
    await ensureDir(root);
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(root, ent.name);
      const size = ent.isDirectory() ? await dirSize(p) : (await safeStat(p))?.size || 0;
      await fsp.rm(p, { recursive: true, force: true });
      freed += size;
    }
  } catch {
    // ignore
  }
  return freed;
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

export { formatBytes };
