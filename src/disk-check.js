// Phase 2.8.20 (W3-C2) — disk-space pre-flight check.
// Uses Node's statfs (≥18.15). Project requires Node ≥22 per package.json,
// so statfs is always available in target runtimes.

import { statfs } from 'node:fs/promises';
import { dataPath } from './paths.js';

const DEFAULT_THRESHOLD_BYTES = Number(process.env.DISK_FREE_THRESHOLD_BYTES) || (1 * 1024 * 1024 * 1024); // 1 GB

export function isDiskSpaceError(error) {
  return error?.code === 'ENOSPC' || error?.code === 'LOW_DISK_SPACE'
    || /disk space too low|no space left on device|\bENOSPC\b/i.test(String(error?.message || error || ''));
}

export async function checkDiskFree(thresholdBytes = DEFAULT_THRESHOLD_BYTES) {
  try {
    const stats = await statfs(dataPath('.'));
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      freeBytes,
      thresholdBytes,
      ok: freeBytes >= thresholdBytes,
      error: null,
    };
  } catch (err) {
    // Treat probe failure as "ok" — a broken disk-check must not block
    // the operator. (We can't reliably distinguish "no disk pressure" from
    // "permission denied on statfs" without false positives.)
    return {
      freeBytes: null,
      thresholdBytes,
      ok: true,
      error: err && err.message ? err.message : String(err),
    };
  }
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}
