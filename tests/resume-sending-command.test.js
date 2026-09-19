import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../src/campaigns-client.js', import.meta.url), 'utf8');

test('Ortus Basics resume always targets this Mac', () => {
  const decision = APP.slice(APP.indexOf('window.openCampaignResumeDecision ='), APP.indexOf('function _activeCardCloudId'));
  assert.match(decision, /current = 'local'/);
  assert.match(decision, /okLabel: 'Continue on this Mac', cancelLabel: 'Cancel'/);
  assert.doesNotMatch(decision, /restartCloudCampaignUI|pauseCloudCampaignUI|Continue on Cloud|otherLabel/);
});

test('monitoring Resume asks whether to start sending or acceptance checking', () => {
  const decision = APP.slice(APP.indexOf('window.openCampaignResumeDecision ='), APP.indexOf('function _activeCardCloudId'));
  assert.match(decision, /What should resume now\?/);
  assert.match(decision, /okLabel: 'Resume sending now'/);
  assert.match(decision, /cancelLabel: 'Resume acceptance checking now'/);
  assert.match(decision, /_resumeAcceptanceCheckNow\(id, current, btn\)/);
});

test('the large campaign card uses the same monitoring choice as the dashboard', () => {
  const start = APP.indexOf('function _adaptActiveCardControls');
  const controls = APP.slice(start, APP.indexOf('// Cloud "Open"', start));
  assert.match(controls, /_renderVjCardControls\(card, status, \{ active: true \}\)/);
  assert.doesNotMatch(controls, /_viewingCloudId/);
});

test('the UI sends resumeSending=true to the local API', () => {
  const restart = APP.slice(APP.indexOf('async function restartCloudCampaignUI'), APP.indexOf('// Task 3 Part B'));
  assert.match(restart, /resumeSending: !!resumeSending/);
});

test('the desktop server and cloud client preserve the Resume Sending flag', () => {
  const route = SERVER.slice(SERVER.indexOf("app.post('/api/campaign/cloud/:id/restart'"), SERVER.indexOf('// Edit a dispatched cloud campaign'));
  assert.match(route, /resumeSending: !!\(req\.body && req\.body\.resumeSending\)/);
  assert.match(CLIENT, /resumeSending: !!resumeSending/);
});
