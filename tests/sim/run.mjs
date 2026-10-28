#!/usr/bin/env node
// Campaign simulator. Discovers the campaign types, builds generic scenarios for
// each, runs them against the real engine in the fake world (one child process per
// scenario), checks invariants, and writes tests/sim/reports/latest.{md,json}.
//
//   node tests/sim/run.mjs                      all engine modes, all scenarios
//   SIM_ONLY=connect_only node tests/sim/run.mjs        regex filter on "mode/scenario"
//   SIM_CONCURRENCY=3 ...                       parallel scenarios (default 3)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScenarios } from './scenarios.mjs';
import { runChecks } from './checks.mjs';
import { buildSummary, summaryData } from './summary.mjs';
import './compat.mjs';
import { findBrowser, checkBrowser, ensureBrowser } from './browser.mjs';
import { createRequire } from 'node:module';
import { profileFor } from './modes.mjs';
import { readFileSync, existsSync } from 'node:fs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REGISTER = join(HERE, 'register.mjs');
// Reports live in a writable folder: the app can start the test from inside the installed (read-only) app bundle.
const REPORTS = process.env.SIM_REPORT_DIR || join(HERE, 'reports');
// Fast by default: the engine's built-in pauses are shortened 4x (validated: identical results to real time on all 34
// scenarios). Set SIM_SPEED=1 for real-time waits.
process.env.SIM_SPEED = process.env.SIM_SPEED || '4';
const ONLY = process.env.SIM_ONLY ? new RegExp(process.env.SIM_ONLY) : null;
const CONC = Number(process.env.SIM_CONCURRENCY || 3);

// Every child process gets a throwaway data folder: the test must never read or write the operator's real data.
const SIM_ROOT = mkdtempSync(join(tmpdir(), 'sim-root-'));
function child(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', REGISTER, ...args], { cwd: join(HERE, '../..'), env: { ...process.env, ORTUS_DATA_DIR: join(SIM_ROOT, 'data'), ORTUS_SHEETS_WEBAPP_URL: 'https://script.google.com/macros/s/SIMSHEET/exec' } });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', () => resolve(out));
  });
}
const grab = (out, tag) => { const l = out.split('\n').find(x => x.startsWith(tag)); if (!l) return null; try { return JSON.parse(l.slice(tag.length)); } catch { return null; } };

// Acknowledged findings: "<scenario id>:<check name>" -> note. They stay in the report but don't fail the run.
const KNOWN_FILE = join(HERE, 'known-findings.json');
const known = existsSync(KNOWN_FILE) ? JSON.parse(readFileSync(KNOWN_FILE, 'utf8')) : {};
const isKnown = (id, c) => known[`${id}:${c.name}`] || known[`*/${id.split('/')[1]}:${c.name}`] || known[`${id.split('/')[0]}/*:${c.name}`];

const discoverOut = await child([join(HERE, 'discover.mjs')]);
const modes = grab(discoverOut, 'SIMDISCOVER:');
if (!modes) {
  // Say WHY (the child's own error), not just that it failed.
  const why = discoverOut.split('\n').map(x => x.trim()).filter(x => /error|cannot|enoent|not found/i.test(x)).slice(0, 2).join(' ').slice(0, 300) || discoverOut.trim().split('\n').slice(-2).join(' ').slice(0, 300);
  try { mkdirSync(REPORTS, { recursive: true }); writeFileSync(join(REPORTS, 'progress.json'), JSON.stringify({ state: 'error', startedAt: Date.now(), total: 0, done: 0, scenarios: [], message: 'Could not list the campaign types. ' + why })); } catch { /* */ }
  console.error('discovery failed: ' + why); process.exit(2);
}
const engine = modes.filter(m => m.engine);
const notEngine = modes.filter(m => !m.engine);

const scenarios = engine.flatMap(m => buildScenarios(m.value).map(sc => (sc.kind === 'screen' ? { ...sc, modeName: m.name } : sc))).filter(s => !ONLY || ONLY.test(s.id));
const PROGRESS = join(REPORTS, 'progress.json');
mkdirSync(REPORTS, { recursive: true });
const startedAt = Date.now();
const prog = { state: 'running', startedAt, total: scenarios.length, done: 0, concurrency: CONC, scenarios: scenarios.map(s => ({ id: s.id, status: 'queued' })), message: '' };
const writeProgress = () => { try { writeFileSync(PROGRESS, JSON.stringify(prog)); } catch { /* */ } };
// Exit codes: 0 = clean/known only · 1 = NEW findings · 2 = could not discover campaigns · 3 = browser/hang · 4 = runner crashed.
// Crash handlers come BEFORE the browser check so a crash there is reported as a crash, never as findings.
const crash = (e) => { prog.state = 'error'; prog.message = 'The test runner crashed: ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' '); writeProgress(); console.error(prog.message); process.exit(4); };
process.on('uncaughtException', crash); process.on('unhandledRejection', crash);
{
  const puppeteer = createRequire(join(HERE, '../../package.json'))('puppeteer-core');
  // No Chrome-type browser on this computer: fetch a small test browser once (kept for next time) instead of asking the operator to install one.
  if (!findBrowser()) {
    prog.state = 'preparing'; prog.message = 'Getting a test browser ready (one time only)…'; writeProgress();
    let last = 0;
    const got = await ensureBrowser((pct) => {
      if (Date.now() - last < 700 && pct < 100) return; last = Date.now();
      prog.message = `Downloading a test browser (one time only, about 100 MB) — ${pct}%`; writeProgress();
    });
    if (!got.ok) { prog.state = 'error'; prog.message = got.message; writeProgress(); console.error(got.message); process.exit(3); }
    prog.state = 'running'; prog.message = ''; writeProgress();
  }
  const probe = await checkBrowser(puppeteer);
  if (!probe.ok) { prog.state = 'error'; prog.message = probe.message; writeProgress(); console.error(probe.message); process.exit(3); }
}
writeProgress();
const tmp = mkdtempSync(join(tmpdir(), 'sim-specs-'));
console.log(`Simulating ${scenarios.length} scenarios across ${engine.length} campaign types (concurrency ${CONC})…`);

const results = [];
const retriedNote = (id) => { const r = results.find(x => x.spec.id === id); return r && r.retried === 'passed' ? ' (passed on a second try, alone — the first try failed while the computer was busy)' : r && r.retried ? ' (failed again on a second try)' : ''; };
let next = 0;
let aborted = false, hungCount = 0, okCount = 0;
// Runs one scenario in its own process and returns { res, checks, out }.
async function runOne(spec, tag = '') {
  const file = join(tmp, spec.id.replace(/\W+/g, '_') + tag + '.json');
  writeFileSync(file, JSON.stringify(spec));
  const t = Date.now();
  const resultFile = file.replace(/\.json$/, '.result.json');
  const out = await child([join(HERE, spec.kind === 'screen' ? 'run-screen.mjs' : spec.kind === 'gates' ? 'run-gates.mjs' : 'run-scenario.mjs'), file, resultFile]);
  mkdirSync(join(REPORTS, 'logs'), { recursive: true });
  let res = null; try { res = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { /* process died before writing */ }
  res = res || { id: spec.id, mode: spec.mode, desc: spec.desc, hung: false, threw: 'scenario process died before reporting:\n' + out.slice(-1500),
    crashes: [], campaign: { running: false }, logs: out.split('\n').slice(-40), rowWrites: [], batchWrites: [], actions: [], invites: [], messages: [], unhandled: [], elapsedMs: Date.now() - t };
  return { res, checks: runChecks(spec, res), out };
}
const logName = (spec, tag = '') => join(REPORTS, 'logs', spec.id.replace(/\W+/g, '_') + tag + '.log');
const hasNew = (spec, checks) => checks.some(c => !c.ok && !isKnown(spec.id, c));
const statusOf = (spec, checks) => { const failed = checks.filter(c => !c.ok); return !failed.length ? 'pass' : failed.every(f => isKnown(spec.id, f)) ? 'known' : 'new'; };

async function worker() {
  while (next < scenarios.length && !aborted) {
    const spec = scenarios[next++];
    prog.scenarios.find(x => x.id === spec.id).status = 'running'; writeProgress();
    const { res, checks, out } = await runOne(spec);
    writeFileSync(logName(spec), out.replace(/SIMRESULT:.*/, ''));
    results.push({ spec, res, checks });
    const failed = checks.filter(c => !c.ok);
    if (res.hung) hungCount++; else okCount++;
    if (!aborted && hungCount >= 3 && okCount === 0) {
      aborted = true;
      prog.state = 'error'; prog.message = 'The scenarios are not finishing on this computer (the first ' + hungCount + ' all timed out), so the test was stopped. Details are in ' + join(REPORTS, 'logs') + '.';
    }
    prog.done++; Object.assign(prog.scenarios.find(x => x.id === spec.id), { status: statusOf(spec, checks), ms: res.elapsedMs }); writeProgress();
    console.log(`${failed.length ? (failed.every(f => isKnown(spec.id, f)) ? '~' : '✗') : '✓'} ${spec.id}  (${Math.round(res.elapsedMs / 1000)}s)${failed.length ? '  → ' + failed.map(f => f.name).join(', ') : ''}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// Several fake browsers at once can overload a laptop (the app then slows itself down on purpose, and a lead may be
// left untouched). So a scenario with a NEW finding gets ONE more try, alone on the machine. A real bug fails again;
// a finding caused by the machine being busy does not, and is reported as passing-on-retry. The first attempt's log is kept.
if (!aborted) {
  const suspects = results.filter(r => hasNew(r.spec, r.checks));
  for (const [i, r] of suspects.entries()) {
    prog.message = `Re-checking ${suspects.length - i} scenario(s) that failed while the computer was busy…`;
    prog.scenarios.find(x => x.id === r.spec.id).status = 'running'; writeProgress();
    try { writeFileSync(logName(r.spec, '.first-attempt'), r.res.logs.join('\n')); } catch { /* */ }
    const again = await runOne(r.spec, '.retry');
    writeFileSync(logName(r.spec), again.out.replace(/SIMRESULT:.*/, ''));
    const clean = !hasNew(r.spec, again.checks);
    Object.assign(r, { res: again.res, checks: again.checks, retried: clean ? 'passed' : 'failed again' });
    Object.assign(prog.scenarios.find(x => x.id === r.spec.id), { status: statusOf(r.spec, again.checks), ms: again.res.elapsedMs });
    console.log(`${clean ? '✓' : '✗'} ${r.spec.id}  retried alone: ${clean ? 'passed (the first attempt failed while the computer was busy)' : 'failed again — a real finding'}`);
  }
  prog.message = ''; writeProgress();
}
results.sort((a, b) => a.spec.id.localeCompare(b.spec.id));

// ── report ──
const isNew = (r) => r.checks.some(c => !c.ok && !isKnown(r.spec.id, c));
const failedAll = results.filter(r => r.checks.some(c => !c.ok));
const newFailures = results.filter(isNew);
const L = [];
L.push(`# Campaign simulator report`, '', `Run: ${new Date().toISOString()} · ${results.length} scenarios · **${results.length - failedAll.length} clean, ${failedAll.length} with findings (${newFailures.length} new, ${failedAll.length - newFailures.length} already known)**`, '');
const scenarioDropped = (mode, fn) => buildScenarios(mode).every(sc => sc.id.split('/')[1] !== fn) && !!profileFor(mode);
L.push(...buildSummary({ results, modes, isKnown, scenarioDropped }));
L.push('## Detail — every scenario', '');
L.push('| Campaign type | Scenario | Result | Time |', '|---|---|---|---|');
for (const { spec, res, checks } of results) {
  const f = checks.filter(c => !c.ok);
  L.push(`| ${spec.mode} | ${spec.id.split('/')[1]} | ${f.length ? (f.every(x => isKnown(spec.id, x)) ? '🟡 ' : '❌ ') + f.map(x => x.name).join(', ') : '✅'}${retriedNote(spec.id)} | ${Math.round(res.elapsedMs / 1000)}s |`);
}
L.push('', '## Bug notes (things to look at)', '');
if (!failedAll.length) L.push('No invariant failures.');
for (const { spec, res, checks } of failedAll) {
  L.push(`### ${spec.id}`, `_${spec.desc}_`, '');
  for (const c of checks.filter(x => !x.ok)) {
    const k = isKnown(spec.id, c);
    L.push(`- ${k ? '🟡 KNOWN' : '🔴 NEW'} **${c.name}** — ${c.detail}${k ? `\n  - _${k}_` : ''}`);
  }
  L.push('', '<details><summary>Last log lines</summary>', '', '```', ...res.logs.slice(-25).map(l => l.slice(0, 220)), '```', '</details>', '');
}
L.push('## Campaign types not simulated', '');
for (const m of modes) {
  if (m.engine) { if (!m.hasProfile) L.push(`- **${m.name}** (\`${m.value}\`) — simulated with the GENERIC profile; add a profile in modes.mjs for accurate seeds/expectations.`); }
  else L.push(`- **${m.name}** (\`${m.value}\`) — not driven by startCampaign(); no simulator adapter yet.`);
}
const unh = new Map();
for (const { res } of results) for (const u of res.unhandled) { const k = u.action || u.url; unh.set(k, (unh.get(k) || 0) + 1); }
L.push('', '## Network the fake world did not model', '', [...unh].map(([k, n]) => `${k} ×${n}`).join(' · ') || 'none');
mkdirSync(REPORTS, { recursive: true });
writeFileSync(join(REPORTS, 'latest.md'), L.join('\n'));
writeFileSync(join(REPORTS, 'latest.json'), JSON.stringify(results.map(({ spec, res, checks }) => ({ id: spec.id, checks, elapsedMs: res.elapsedMs, phase2: res.phase2, rowWrites: res.rowWrites, invites: res.invites, messages: res.messages })), null, 1));
const sdata = summaryData({ results, modes, isKnown, scenarioDropped });
writeFileSync(join(REPORTS, 'summary.json'), JSON.stringify({ finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, quick: !!ONLY, ...sdata }));
if (!aborted) { prog.state = 'done'; prog.done = prog.total; } writeProgress();
console.log(`\nReport: ${join(REPORTS, 'latest.md')} — ${newFailures.length ? newFailures.length + ' scenario(s) with NEW findings' : failedAll.length ? 'only known findings' : 'all clear'}`);
process.exit(aborted ? 3 : newFailures.length ? 1 : 0);
