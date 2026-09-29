#!/usr/bin/env node
import { purgeCache, getCleanupConfig } from './lib/cleanup.js';

const cfg = getCleanupConfig();
console.log('清理配置:', {
  autoEnabled: cfg.autoEnabled,
  ttlHours: cfg.ttlHours,
  intervalMin: cfg.intervalMin,
  maxMb: cfg.maxMb,
});

const result = await purgeCache();
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
