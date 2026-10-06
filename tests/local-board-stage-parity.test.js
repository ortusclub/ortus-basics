import { appFunction } from './helpers/app-source.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('dashboard normalizes its local snapshot before constructing card #2', () => {
  assert.match(source, /const s = _decorateLocalLiveStatus\(_cachedLocal \|\| await/);
  assert.match(source, /_localLive = s;/,
    'the normalized result must become the shared snapshot for all dashboard consumers');
});

test('native local board row carries the complete shared stage contract', () => {
  const start = source.indexOf("where: 'local', id: 'local-active'");
  const end = source.indexOf('});', start);
  assert.ok(start > 0 && end > start);
  const row = source.slice(start, end);
  for (const field of [
    'profileIds', 'participatingProfileIds', 'monitoringCheckInProgress',
    'liveAccount', 'currentAction', 'batchDone', 'batchSize', 'nextCheckAt',
  ]) assert.match(row, new RegExp(`\\b${field}\\b`), `${field} must reach the shared card`);
});

test('selected local campaign carries its full live snapshot', () => {
  const selected = { id: 'a', status: {} };
  const incoming = { id: 'a', liveAccount: 'p1', currentAction: 'sending', batchDone: 2,
    batchSize: 5, participatingProfileIds: ['p1'], running: true };
  const view = new Function('_viewingLocalCampaign', 'location', 'sameCampaign',
    appFunction('localCampaignViewStatus') + '; return localCampaignViewStatus;')(
      selected, { hash: '#/new' }, () => true);
  const status = view(incoming);
  for (const key of ['liveAccount', 'currentAction', 'batchDone', 'batchSize', 'participatingProfileIds']) {
    assert.deepEqual(status[key], incoming[key]);
  }
});

test('dashboard clone clears inherited stage render caches before filling', () => {
  const start = source.indexOf('function vjCardSkeleton(cid)');
  const end = source.indexOf('function _setDupeChip', start);
  assert.ok(start > 0 && end > start);
  const skeleton = source.slice(start, end);
  assert.match(skeleton, /delete el\.dataset\.html/,
    'facts and milestones must redraw after their cloned DOM is emptied');
  assert.match(skeleton, /_cstage\.dataset\.glyphphase = ''/,
    'the phase glyph must redraw for the dashboard campaign');
  assert.match(skeleton, /_cstage\.dataset\.acctkey = ''/,
    'account pills must redraw for the dashboard campaign');
});

test('runtime interruption stays inside the unified stage instead of restoring legacy layout', () => {
  const start = source.indexOf('function renderLiveStage(root, status)');
  const end = source.indexOf('window.stageAcctPick', start);
  assert.ok(start > 0 && end > start);
  const renderer = source.slice(start, end);
  assert.match(renderer, /const interrupted = !canonicalOwned && !!/);
  assert.match(renderer, /let phase = canonicalOwned\s*\? String\(\(ca && ca\.phase\) \|\| 'starting'\)/);
  assert.match(renderer, /interrupted \? 'paused'/);
  assert.doesNotMatch(renderer,
    /if \(status && \(status\.state === 'interrupted'[\s\S]{0,220}_hideStage\(root\)/,
    'lid-close recovery must never revive the old card');
});

test('local preflight renders through the same stage contract', () => {
  const start = source.indexOf('// Pre-flight owns the live line outright');
  const end = source.indexOf('// Bug 14:', start);
  assert.ok(start > 0 && end > start);
  const branch = source.slice(start, end);
  assert.match(branch, /renderLiveStage\(card, status\)/);
  assert.doesNotMatch(branch, /_hideStage\(card\)/);
});

test('the unified monitoring stage counts from nextCheckAt on every surface', () => {
  const start = source.indexOf('function _tickLiveStages()');
  const end = source.indexOf('setInterval(_tickLiveStages, 1000)', start);
  assert.ok(start > 0 && end > start);
  const ticker = source.slice(start, end);
  assert.match(source, /stage\.dataset\.nextCheckAt = phase === 'monitoring'/,
    'each dashboard or builder clone must retain the absolute due time');
  assert.match(ticker, /Date\.parse\(stage\.dataset\.nextCheckAt/);
  assert.match(ticker, /v3FmtCountdown\(nextCheckAt - Date\.now\(\)\)/,
    'the visible timer must tick from the schedule, not from poll/render age');
  assert.match(ticker, /stageSideValue/,
    'the large right-hand value must update every second too');
});
