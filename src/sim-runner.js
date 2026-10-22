// "Campaign test" runner for the dev app. Spawns tests/sim/run.mjs (the campaign simulator) as a child
// process and exposes start / status / stop / report to the UI. The packaged app ships tests/sim, and the
// button only shows for accounts allowed to use the development engine (see registerSimRoutes' `allowed`).
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIM = join(ROOT, 'tests', 'sim');
const RUN = join(SIM, 'run.mjs');
// Reports and the downloaded test browser go in the app's writable data folder (the installed app bundle is read-only);
// a plain repo checkout without ORTUS_DATA_DIR keeps them under tests/sim/reports.
const REPORTS = process.env.SIM_REPORT_DIR || (process.env.ORTUS_DATA_DIR ? join(process.env.ORTUS_DATA_DIR, 'sim-reports') : join(SIM, 'reports'));
const BROWSER_DIR = process.env.SIM_BROWSER_DIR || (process.env.ORTUS_DATA_DIR ? join(process.env.ORTUS_DATA_DIR, 'sim-browser') : undefined);
const PROGRESS = join(REPORTS, 'progress.json');
const SUMMARY = join(REPORTS, 'summary.json');

// Rough wall-clock for the first estimate, before any scenario has finished (estimate for a laptop running 2 scenarios at a time; the live estimate replaces it after the first scenario finishes).
export const DEFAULT_TOTAL_MS = { quick: 2 * 60 * 1000, full: 8 * 60 * 1000 };
export const MODES = {
  quick: { label: 'Quick test', only: '/(setup-screen|start-gates|happy|acceptance-followup)$' },
  full: { label: 'Full test', only: '' },
};

let child = null;
let current = null;      // { mode, startedAt, error }

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** Pure: null when the run really finished, otherwise the message to show. Exit 1 means "finished with
 *  NEW findings" only when this run produced a fresh summary — a crash also exits 1 and must never be swallowed. */
export function classifyExit({ code, progress, summary, startedAt, tail = '' }) {
  const fresh = !!summary && new Date(summary.finishedAt).getTime() >= startedAt - 1000;
  if (fresh && (code === 0 || code === 1)) return null;
  return (progress && progress.state === 'error' && progress.message)
    || `The test stopped before finishing (exit ${code}). ${String(tail).split('\n').slice(-4).join(' ').trim()}`;
}

export function simAvailable() { return existsSync(RUN); }

/** Pure: turn a progress file + clock into what the UI shows. Exported for tests. */
export function describeProgress(progress, { mode = 'quick', now = Date.now() } = {}) {
  if (!progress) return { total: 0, done: 0, pct: 0, etaMs: null, running: [] };
  const total = progress.total || 0;
  const done = Math.min(progress.done || 0, total);
  const elapsed = Math.max(0, now - (progress.startedAt || now));
  let etaMs;
  if (progress.state === 'done') etaMs = 0;
  else if (done === 0) etaMs = Math.max(0, (DEFAULT_TOTAL_MS[mode] || DEFAULT_TOTAL_MS.quick) - elapsed);
  else etaMs = Math.round((elapsed / done) * (total - done));
  return {
    total, done, pct: total ? Math.round((done / total) * 100) : 0, etaMs, elapsedMs: elapsed,
    preparing: progress.state === 'preparing', message: progress.message || '',
    running: (progress.scenarios || []).filter(s => s.status === 'running').map(s => s.id),
    scenarios: progress.scenarios || [],
  };
}

export function simStatus({ now = Date.now() } = {}) {
  if (!simAvailable()) return { available: false };
  const live = !!child;
  const progress = readJson(PROGRESS);
  const summary = readJson(SUMMARY);
  const state = live ? 'running' : (current?.error ? 'error' : 'idle');
  const fresh = live && progress && progress.startedAt >= (current?.startedAt || 0) - 2000 ? progress : null;
  return {
    available: true, state,
    mode: current?.mode || null,
    error: current?.error || null,
    progress: fresh ? describeProgress(fresh, { mode: current.mode, now }) : null,
    hasReport: !!summary,
    finishedAt: summary?.finishedAt || null,
    counts: summary?.counts || null,
  };
}

export function simReport() { return readJson(SUMMARY); }

export function startSim(mode, { campaignRunning = false } = {}) {
  if (!simAvailable()) return { ok: false, error: 'The campaign test is not part of this copy of the app.' };
  if (!MODES[mode]) return { ok: false, error: 'Unknown test type.' };
  if (child) return { ok: false, error: 'A test is already running.' };
  if (campaignRunning) return { ok: false, error: 'A campaign is running. Wait for it to finish — the test opens several browsers and would slow it down.' };
  current = { mode, startedAt: Date.now(), error: null };
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SIM_REPORT_DIR: REPORTS, ...(BROWSER_DIR ? { SIM_BROWSER_DIR: BROWSER_DIR } : {}), SIM_CONCURRENCY: process.env.SIM_CONCURRENCY || String(Math.max(1, Math.min(3, Math.floor(cpus().length / 4)))) };
  if (MODES[mode].only) env.SIM_ONLY = MODES[mode].only; else delete env.SIM_ONLY;
  let tail = '';
  child = spawn(process.execPath, ['--import', join(SIM, 'register.mjs'), RUN], { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (d) => { tail = (tail + d).slice(-1500); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  child.on('error', (e) => { current.error = `Could not start the test: ${e.message}`; child = null; });
  child.on('close', (code) => {
    const stopped = current?.stopped;
    child = null;
    // run.mjs exits 1 for NEW findings (a result, not a failure to run); 3 = no browser; anything else = it broke.
    if (!stopped) {
      const err = classifyExit({ code, progress: readJson(PROGRESS), summary: readJson(SUMMARY), startedAt: current.startedAt, tail });
      if (err) current.error = err;
    }
  });
  return { ok: true };
}

export function stopSim() {
  if (!child) return { ok: true };
  current.stopped = true;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* */ } }
  return { ok: true };
}

/** Wire the four routes. `campaignRunning` is injected so this module never imports the engine. */
export function registerSimRoutes(app, { campaignRunning, allowed = () => true }) {
  // Everyone else sees `available: false`, so the button never appears for them.
  const gate = (req, res, next) => (allowed(req) ? next() : res.status(403).json({ error: 'The campaign test is only for development-engine accounts.' }));
  app.get('/api/sim/status', (req, res) => res.json(allowed(req) ? simStatus() : { available: false }));
  app.get('/api/sim/report', gate, (_req, res) => { const r = simReport(); r ? res.json(r) : res.status(404).json({ error: 'No test has finished yet.' }); });
  app.post('/api/sim/start', gate, (req, res) => {
    const out = startSim(String(req.body?.mode || 'quick'), { campaignRunning: !!campaignRunning() });
    res.status(out.ok ? 200 : 409).json(out);
  });
  app.post('/api/sim/stop', gate, (_req, res) => res.json(stopSim()));
}
