import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sameCampaign } from '../public/js/campaign-lifecycle.mjs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('a check run from the wizard shows its log on the selected campaign, started or not', () => {
  const start = app.indexOf('function localCampaignViewStatus(');
  const src = app.slice(start, app.indexOf('// v2.160.46: OPEN on an ACTIVE', start));
  const ctx = vm.createContext({ sameCampaign, location: { hash: '#/new' },
    _viewingLocalCampaign: { id: 'saved-x', name: 'Hello', campaignId: 'c1', status: { name: 'Hello', state: 'draft', running: false, logs: [] } } });
  vm.runInContext(src + '\nthis.view = localCampaignViewStatus;', ctx);
  // The engine is idle, nameless, but sweeping — its log must reach the card.
  const merged = ctx.view({ running: false, name: '', campaignId: null, monitoringCheckInProgress: true, logs: ['[t] 📡 Sweeping…'] });
  assert.equal(merged.name, 'Hello');
  assert.equal(merged.monitoringCheckInProgress, true);
  assert.deepEqual(merged.logs, ['[t] 📡 Sweeping…']);
  // A real running campaign that is NOT the selected one still does not leak in.
  const other = ctx.view({ running: true, name: 'Other', campaignId: 'c9', logs: ['x'] });
  assert.equal(other.name, 'Hello');
  assert.notDeepEqual(other.logs, ['x']);
});

test('the live card has a checking branch that renders the log and offers Stop', () => {
  assert.match(app, /const isChecking = !!\(status && status\.monitoringCheckInProgress && !status\.running && !isMonitoring\);/);
  const branch = app.slice(app.indexOf('if (isChecking) {'), app.indexOf('if (isDailyWait || isNeedsReview) {'));
  assert.match(branch, /v3SetText\('activeEyebrow', 'Checking connections…'\)/);
  assert.match(branch, /logEl\.innerHTML = lastN\.map\(line => v3RenderLogLine\(line\)\)\.join\(''\)/);
  assert.match(branch, /_renderVjCardControls\(card, status, \{ active: true \}\)/);
});

test('the launch-card check button becomes Stop check while a check runs, and restores its handler after', () => {
  const fn = app.slice(app.indexOf('function refreshLaunchCheckBtn()'), app.indexOf("if (typeof window !== 'undefined') window.stopLaunchCheck = stopLaunchCheck;"));
  assert.match(fn, /btn\.textContent = '■ Stop check'/);
  assert.match(fn, /fetch\('\/api\/bulk-check\/stop', \{ method: 'POST' \}\)/);
  assert.match(fn, /btn\.onclick = \(\) => window\.launchCheckNow\(\);/);
  assert.ok(!/btn\.onclick = null/.test(app.slice(app.indexOf('function refreshLaunchCheckBtn()'), app.indexOf('// Keep it in step with the mode picker'))));
});

test('a check started from this wizard carries its log even while the engine still names an ended campaign', () => {
  const start = app.indexOf('function localCampaignViewStatus(');
  const src = app.slice(start, app.indexOf('// v2.160.46: OPEN on an ACTIVE', start));
  const mk = (launchedHere) => {
    const ctx = vm.createContext({ sameCampaign, location: { hash: '#/new' }, _checkLaunchedHere: () => launchedHere,
      _viewingLocalCampaign: { id: 'saved-x', name: 'Barry', campaignId: 'c-barry', status: { name: 'Barry', state: 'draft', running: false, logs: [] } } });
    vm.runInContext(src + '\nthis.view = localCampaignViewStatus;', ctx);
    return ctx;
  };
  const stale = { running: false, state: 'done', name: 'Yesterday CC', campaignId: 'c-old', monitoringCheckInProgress: true, logs: ['[t] 📡 Sweeping…'] };
  const here = mk(true).view(stale);
  assert.equal(here.name, 'Barry');
  assert.equal(here.monitoringCheckInProgress, true);
  assert.deepEqual(here.logs, ['[t] 📡 Sweeping…']);
  // Not launched here → the ended campaign's log stays off this wizard.
  const elsewhere = mk(false).view(stale);
  assert.notDeepEqual(elsewhere.logs, ['[t] 📡 Sweeping…']);
});
