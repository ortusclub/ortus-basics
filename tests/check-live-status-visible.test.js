import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = app.indexOf('let liveStatusForcedOpen = false;');
const end = app.indexOf("if (typeof window !== 'undefined') window.syncLiveStatusVisibility = syncLiveStatusVisibility;");
const source = app.slice(start, end) + '\nthis.sync = syncLiveStatusVisibility; this.setKey = (k) => { _checkWizardKey = k; };';

function harness({ typed, cockpit, editingDraft = true, viewingLocal = null }) {
  const sec = { style: {}, classList: { removed: [], remove(c) { this.removed.push(c); }, add() {} } };
  const els = { 'nav-status': sec, 'campaign-name-input': { value: typed }, 'campaign-mode': { value: 'connect_and_introduce' } };
  const ctx = vm.createContext({
    document: { getElementById: id => els[id] || null, querySelector: () => null },
    location: { hash: '#/new' }, window: {}, __cockpit: cockpit,
    isOnNewCampaignView: () => editingDraft, _viewingLocalCampaign: viewingLocal, _viewingCloudId: null, _whBusy: false,
    placeLiveCard() {},
  });
  vm.runInContext(source, ctx);
  return { ctx, sec };
}

const idleNameless = { running: false, state: 'idle', name: '', monitoringCheckInProgress: true, hasLogs: false };

test('a check started from the wizard being edited shows and expands its Live Status', () => {
  const h = harness({ typed: 'Barry', cockpit: idleNameless });
  h.ctx.setKey('barry');
  h.ctx.sync();
  assert.equal(h.sec.style.display, '');
  assert.ok(h.sec.classList.removed.includes('collapsed'));
});

test('after that check finishes, its log stays on the same wizard', () => {
  const h = harness({ typed: 'Barry', cockpit: { ...idleNameless, monitoringCheckInProgress: false, hasLogs: true } });
  h.ctx.setKey('barry');
  h.ctx.sync();
  assert.equal(h.sec.style.display, '');
});

test('a check started elsewhere does not surface on an unrelated draft', () => {
  const h = harness({ typed: 'Other draft', cockpit: idleNameless });
  h.ctx.setKey('barry');
  h.ctx.sync();
  assert.equal(h.sec.style.display, 'none');
});

test('with no check remembered, an idle nameless engine still hides the section on a draft', () => {
  const h = harness({ typed: 'Barry', cockpit: { ...idleNameless, monitoringCheckInProgress: false, hasLogs: true } });
  h.ctx.sync();
  assert.equal(h.sec.style.display, 'none');
});

test('launching a check remembers the wizard and reveals the section immediately', () => {
  const at = app.indexOf('async function _launchCheckRun(scope)');
  const fn = app.slice(at, app.indexOf("fetch('/api/bulk-check-now'", at));
  assert.match(fn, /_checkWizardKey = \(document\.getElementById\('campaign-name-input'\)\?\.value \|\| ''\)\.trim\(\)\.toLowerCase\(\);/);
  assert.match(fn, /__cockpit\.monitoringCheckInProgress = true;/);
  assert.match(fn, /syncLiveStatusVisibility\(\)/);
  assert.equal((app.match(/liveStatusForcedOpen = false;\n  _checkWizardKey = '';/g) || []).length, 6, 'every place that forgets the forced-open log also forgets the check wizard');
});

test('the engine still wearing yesterday\'s ended campaign does not hide a check started here', () => {
  // 2026-09-25: installed app, campaign ended the day before, engine keeps its
  // name/id until restart; Check pressed on a wizard → nothing showed.
  const stale = { running: false, state: 'done', name: 'Yesterday CC', campaignId: 'c-old', monitoringCheckInProgress: true, hasLogs: true };
  const h = harness({ typed: 'Barry', cockpit: stale });
  h.ctx.setKey('barry');
  h.ctx.sync();
  assert.equal(h.sec.style.display, '');
  assert.ok(h.sec.classList.removed.includes('collapsed'));
});

test('a genuinely running campaign still wins over a remembered check key', () => {
  const live = { running: true, state: 'running', name: 'Other live', campaignId: 'c-live', monitoringCheckInProgress: false, hasLogs: true };
  const h = harness({ typed: 'Barry', cockpit: live });
  h.ctx.setKey('barry');
  h.ctx.sync();
  assert.equal(h.sec.style.display, 'none');
});
