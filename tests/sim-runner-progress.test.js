import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProgress, MODES, DEFAULT_TOTAL_MS, classifyExit, registerSimRoutes } from '../src/sim-runner.js';

const mk = (o) => ({ state: 'running', startedAt: 1_000_000, total: 10, done: 0, scenarios: [], ...o });

test('no progress file yet → zeroes, no estimate', () => {
  assert.deepEqual(describeProgress(null), { total: 0, done: 0, pct: 0, etaMs: null, running: [] });
});

test('before any scenario finishes, the estimate is the typical duration minus elapsed', () => {
  const d = describeProgress(mk({}), { mode: 'quick', now: 1_000_000 + 60_000 });
  assert.equal(d.etaMs, DEFAULT_TOTAL_MS.quick - 60_000);
  assert.equal(d.pct, 0);
});

test('estimate extrapolates from the pace so far', () => {
  const d = describeProgress(mk({ done: 4 }), { now: 1_000_000 + 200_000 });
  assert.equal(d.etaMs, Math.round((200_000 / 4) * 6));     // 50s per scenario × 6 left
  assert.equal(d.pct, 40);
});

test('a finished run has nothing left', () => {
  assert.equal(describeProgress(mk({ state: 'done', done: 10 }), { now: 9_999_999 }).etaMs, 0);
});

test('lists only the scenarios currently running', () => {
  const d = describeProgress(mk({ scenarios: [{ id: 'a', status: 'running' }, { id: 'b', status: 'pass' }, { id: 'c', status: 'queued' }] }));
  assert.deepEqual(d.running, ['a']);
});

test('done never exceeds total (guards against a stale progress file)', () => {
  assert.equal(describeProgress(mk({ done: 99 })).done, 10);
});

test('quick test targets the happy-path and acceptance scenarios only; full test has no filter', () => {
  assert.match(MODES.quick.only, /happy/);
  assert.match(MODES.quick.only, /acceptance-followup/);
  assert.equal(MODES.full.only, '');
});

test('exit 0 or 1 with a fresh summary is a real result', () => {
  const summary = { finishedAt: new Date(2_000_000).toISOString() };
  assert.equal(classifyExit({ code: 0, summary, startedAt: 1_999_000 }), null);
  assert.equal(classifyExit({ code: 1, summary, startedAt: 1_999_000 }), null);   // 1 = new findings
});

test('exit 1 WITHOUT a fresh summary is a crash and must be reported (macOS pipe-truncation bug)', () => {
  const stale = { finishedAt: new Date(1_000_000).toISOString() };
  assert.match(classifyExit({ code: 1, summary: stale, startedAt: 2_000_000, tail: 'SyntaxError: Unexpected end of JSON' }), /stopped before finishing.*Unexpected end/);
  assert.match(classifyExit({ code: 1, summary: null, startedAt: 2_000_000 }), /stopped before finishing/);
});

test('an error recorded by the runner is shown verbatim', () => {
  assert.equal(classifyExit({ code: 3, progress: { state: 'error', message: 'No browser found' }, summary: null, startedAt: 1 }), 'No browser found');
});

test('while the test browser downloads, progress says so instead of looking stuck', () => {
  const d = describeProgress(mk({ state: 'preparing', message: 'Downloading a test browser — 40%' }));
  assert.equal(d.preparing, true);
  assert.match(d.message, /40%/);
  assert.equal(describeProgress(mk({})).preparing, false);
});

test('only allowed accounts can see or use the test; everyone else sees it as unavailable', () => {
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; }, post: (p, ...h) => { routes['POST ' + p] = h; } };
  registerSimRoutes(app, { campaignRunning: () => false, allowed: (req) => req.ok });
  const call = (key, req) => { let out; const res = { status(c) { out = { code: c }; return this; }, json(b) { out = { ...(out || { code: 200 }), body: b }; } };
    const [first, second] = routes[key]; if (second) first(req, res, () => second(req, res)); else first(req, res); return out; };
  assert.deepEqual(call('GET /api/sim/status', { ok: false }).body, { available: false });
  assert.equal(call('POST /api/sim/start', { ok: false, body: {} }).code, 403);
  assert.equal(call('POST /api/sim/stop', { ok: false }).code, 403);
  assert.equal(call('GET /api/sim/report', { ok: false }).code, 403);
});
