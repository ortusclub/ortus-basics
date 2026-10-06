import { appFunction } from './helpers/app-source.js';
// Pressing "Resume sending" must do three things AT THE CLICK, not after the
// VM round-trip: write a line in the log, turn the card green, and not be
// undone by the very next poll. Operator, 2026-09-01: "I need JUST THAT WHEN I
// PRESS RESUME SENDING IT STARTS TO SEND THE FUCKING THINGS BACK ... a line in
// the log says RESUME SENDING and the card turns green".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../public/css/dashboard-v0.3.css', import.meta.url), 'utf8');

test('the click marks the campaign as resuming before the fetch', () => {
  const i = APP.indexOf('async function restartCloudCampaignUI');
  assert.ok(i > 0, 'restartCloudCampaignUI missing');
  const body = APP.slice(i, i + 5000);
  const mark = body.indexOf('_markCloudResuming(id, true)');
  const fetchAt = body.indexOf('/restart');
  assert.ok(mark > 0, 'resume is never marked optimistically');
  assert.ok(mark < fetchAt, 'the flag must be set BEFORE the VM is asked');
});

test('the click also writes the log line before the fetch', () => {
  const i = APP.indexOf('async function restartCloudCampaignUI');
  const body = APP.slice(i, i + 5000);
  assert.ok(body.indexOf('_pushCloudEventNow(id, fromStart') < body.indexOf('/restart'),
    'the log line must be pushed on the click, not after the round-trip');
});

test('resuming beats monitoring, so the card leaves the blue tint', () => {
  const i = APP.indexOf('function applyVjCardAppearance');
  const body = APP.slice(i, i + 5000);
  assert.ok(/const monitoring = !_resumingNow/.test(body),
    'a resuming card must not still count as monitoring');
  assert.ok(/_isResumingId\(status && status\.id, state\)/.test(body),
    'the flag must be readable by BOTH card renderers, not only card #2');
});

test('green is the default tone, so no monitoring class means green', () => {
  assert.ok(/--vj-tone:\s*var\(--green\)/.test(CSS), 'default card tone is not green');
  assert.ok(/\.vj-card\.is-monitor,\s*\n?[^{]*\.vj-card\.is-monitoring \{ --vj-tone: var\(--blue\); \}/.test(CSS)
    || /is-monitoring \{ --vj-tone: var\(--blue\); \}/.test(CSS), 'monitoring tone is not blue');
});

test('is-resuming is cleared before it is re-applied, like every other state', () => {
  const i = APP.indexOf('function applyVjCardAppearance');
  const body = APP.slice(i, i + 5000);
  assert.ok(body.includes("'is-resuming'"), 'is-resuming is never removed');
  assert.ok(body.includes("root.classList.toggle('is-resuming'"), 'is-resuming is never applied');
});

test('a refused or unreachable resume clears the flag', () => {
  const i = APP.indexOf('async function restartCloudCampaignUI');
  const body = APP.slice(i, i + 4000);
  const offs = body.split('_markCloudResuming(id, false)').length - 1;
  assert.equal(offs, 2, 'both failure paths must put the card back');
});

test('polling another campaign preserves the selected local running status', () => {
  const selected = { id: 'a', status: { id: 'a', running: true, state: 'sending' } };
  const view = new Function('_viewingLocalCampaign', 'location', 'sameCampaign',
    appFunction('localCampaignViewStatus') + '; return localCampaignViewStatus;')(
      selected, { hash: '#/new' }, () => false);
  assert.deepEqual(view({ id: 'b', running: true, state: 'monitoring' }), selected.status);
});
