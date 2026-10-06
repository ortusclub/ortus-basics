// One-time repair for a corrupt GoLogin Orbita download.
//
// Symptom: a profile's browser fails to launch with
//   "failed to open — spawn Unknown system error -86"
// macOS errno 86 is EBADARCH ("Bad CPU type in executable"). In practice this is
// NOT an architecture mismatch (the team's Macs + Orbita builds are all arm64) —
// it's a *truncated / incomplete* Orbita download the kernel can't exec. `file`
// still reports the right arch because the Mach-O header is intact, so the only
// reliable test is to actually try to run it.
//
// On startup (once per REPAIR_TOKEN) we probe every cached Orbita with
// `--version`. A healthy binary prints its version and exits 0 (a few seconds); a
// corrupt one fails to exec *immediately*. We delete ONLY the ones that fail, so
// GoLogin re-downloads just those on the next launch — healthy versions are left
// untouched (no needless multi-hundred-MB re-downloads). Probes run in parallel,
// so the whole sweep costs about one healthy-probe's time regardless of how many
// versions are cached.
//
// Fully guarded + idempotent: any failure here is logged and swallowed so it can
// never block app startup, and the flag file means it runs at most once per token.

import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { dataPath } from './paths.js';

// Bump this string to deliberately trigger a fresh one-time sweep in a future
// release (e.g. if a new batch of corrupt downloads shows up).
const REPAIR_TOKEN = 'orbita-ebadarch-2026-10-06';
const FLAG_FILE = 'orbita-cache-repair.json';
const BROWSER_DIR = join(homedir(), '.gologin', 'browser');
// A healthy `--version` returns in ~3s; cap well above that so a slow machine is
// never mistaken for a broken binary. A broken binary fails long before this.
const PROBE_TIMEOUT_MS = 10000;

function alreadyDone() {
  try { return JSON.parse(readFileSync(dataPath(FLAG_FILE), 'utf8')).token === REPAIR_TOKEN; }
  catch { return false; }
}

function markDone(removed) {
  try {
    writeFileSync(dataPath(FLAG_FILE),
      JSON.stringify({ token: REPAIR_TOKEN, at: new Date().toISOString(), removed }, null, 2) + '\n');
  } catch (e) { console.warn(`[orbita-repair] could not record flag: ${e.message}`); }
}

// macOS layout: orbita-browser-<v>/Orbita-Browser.app/Contents/MacOS/Orbita
function orbitaBinary(dir) {
  return join(BROWSER_DIR, dir, 'Orbita-Browser.app', 'Contents', 'MacOS', 'Orbita');
}

// Resolves true ONLY when the binary cannot be executed (missing, or the -86 /
// EBADARCH exec failure). A binary that runs — even slowly — is never flagged.
function probeBroken(bin) {
  return new Promise((resolve) => {
    if (!existsSync(bin)) return resolve(true);
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(bin, ['--version', '--no-sandbox'], { stdio: 'ignore' });
    } catch {
      return finish(true); // spawn threw synchronously → cannot execute → broken
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } finish(false); }, PROBE_TIMEOUT_MS);
    // 'error' fires when exec itself fails (this is the EBADARCH -86 case).
    child.on('error', () => { clearTimeout(timer); finish(true); });
    // It ran: exit 0 is healthy; a non-zero exit means the binary is damaged.
    child.on('exit', (code) => { clearTimeout(timer); finish(code !== 0); });
  });
}

/**
 * One-time: delete any cached Orbita browser that can no longer be launched, so
 * GoLogin re-downloads a clean copy on the next campaign. Safe to call on every
 * startup — it no-ops once the flag for this token is written. Never throws.
 */
export async function repairOrbitaCache() {
  try {
    if (alreadyDone()) return;
    if (!existsSync(BROWSER_DIR)) { markDone([]); return; }

    const dirs = readdirSync(BROWSER_DIR)
      .filter((d) => d.startsWith('orbita-browser-') && !d.endsWith('.tar.gz'));

    const results = await Promise.all(
      dirs.map(async (d) => ({ dir: d, broken: await probeBroken(orbitaBinary(d)).catch(() => false) })),
    );

    const removed = [];
    for (const { dir, broken } of results) {
      if (!broken) continue;
      try {
        rmSync(join(BROWSER_DIR, dir), { recursive: true, force: true });
        removed.push(dir);
        console.log(`[orbita-repair] removed un-launchable browser: ${dir}`);
      } catch (e) {
        console.warn(`[orbita-repair] could not remove ${dir}: ${e.message}`);
      }
    }

    console.log(removed.length
      ? `[orbita-repair] cleared ${removed.length} corrupt Orbita version(s) — GoLogin re-downloads on next launch`
      : '[orbita-repair] all cached Orbita versions launch fine — nothing removed');
    markDone(removed);
  } catch (e) {
    console.warn(`[orbita-repair] skipped (${e.message})`); // never block startup
  }
}
