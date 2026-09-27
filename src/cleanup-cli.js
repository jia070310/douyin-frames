#!/usr/bin/env node
import { cleanupOutput, getCleanupConfig } from './lib/cleanup.js';

const cfg = getCleanupConfig();
console.log('清理配置:', {
  ttlHours: cfg.ttlHours,
  intervalMin: cfg.intervalMin,
  maxMb: cfg.maxMb,
  enabled: cfg.enabled,
});

const result = await cleanupOutput();
console.log(
  JSON.stringify(
    {
      removed: result.removed.length,
      freedBytes: result.freedBytes,
      remaining: result.remaining,
      items: result.removed,
    },
    null,
    2,
  ),
);
