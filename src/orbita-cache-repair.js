// macOS-only repair of cached Orbita executables that cannot be loaded.
// EBADARCH can mean a damaged download OR an incompatible architecture. Keep
// the original in quarantine so a failed re-download never destroys that copy.
import { lstatSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { dataPath } from './paths.js';

const REPAIR_TOKEN = 'orbita-exec-repair-2026-10-06-v2';

function isLoadError(error) {
  return error?.errno === -86 || ['EBADARCH', 'ENOEXEC'].includes(error?.code);
}

// A timeout, signal, permission/resource error or nonzero exit does not prove
// corruption. Preserve the cache and leave the sweep retryable in those cases.
async function probe(bin, spawnProcess, timeoutMs) {
  try {
    if (!lstatSync(bin).isFile()) return 'unknown';
  } catch (error) {
    return error.code === 'ENOENT' ? 'broken' : 'unknown';
  }
  return new Promise((resolve) => {
    let child;
    try { child = spawnProcess(bin, ['--version', '--no-sandbox'], { stdio: 'ignore' }); }
    catch (error) { resolve(isLoadError(error) ? 'broken' : 'unknown'); return; }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish('unknown');
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, timeoutMs);
    child.once('error', (error) => finish(isLoadError(error) ? 'broken' : 'unknown'));
    child.once('exit', (code) => finish(code === 0 ? 'healthy' : 'unknown'));
  });
}

export async function repairOrbitaCache({
  platform = process.platform,
  browserDir = join(homedir(), '.gologin', 'browser'),
  flagFile = dataPath('orbita-cache-repair.json'),
  spawnProcess = spawn,
  timeoutMs = 10000,
} = {}) {
  if (platform !== 'darwin') return;
  try {
    try { if (JSON.parse(readFileSync(flagFile, 'utf8')).token === REPAIR_TOKEN) return; }
    catch { /* no completed sweep */ }
    // Do not mark an absent cache done: it may be populated later.
    const dirs = readdirSync(browserDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^orbita-browser-\d[\d.]*$/.test(entry.name));
    const quarantined = [];
    let complete = true;
    for (const { name } of dirs) {
      const dir = join(browserDir, name);
      // Never traverse a symlink inside the bundle while probing an executable.
      let bin = dir;
      let safe = true;
      for (const part of ['Orbita-Browser.app', 'Contents', 'MacOS', 'Orbita']) {
        bin = join(bin, part);
        try { if (lstatSync(bin).isSymbolicLink()) { safe = false; break; } }
        catch (error) { if (error.code !== 'ENOENT') safe = false; }
      }
      if (!safe) { complete = false; continue; }
      const result = await probe(bin, spawnProcess, timeoutMs);
      if (result === 'unknown') { complete = false; continue; }
      if (result !== 'broken') continue;
      const target = `${dir}.quarantine-${Date.now()}`;
      renameSync(dir, target);
      quarantined.push(target);
      console.log(`[orbita-repair] quarantined ${name}; GoLogin can download a replacement`);
    }
    if (complete && dirs.length) {
      writeFileSync(flagFile, JSON.stringify({ token: REPAIR_TOKEN, at: new Date().toISOString(), quarantined }, null, 2) + '\n');
    }
  } catch (error) {
    console.warn(`[orbita-repair] skipped (${error.message})`);
  }
}
