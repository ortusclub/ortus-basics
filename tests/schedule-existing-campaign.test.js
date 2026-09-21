import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('an opened existing campaign can be scheduled locally — the old clone guard is gone from that path', () => {
  const fn = app.slice(app.indexOf('window.launchScheduleIt = async function'), app.indexOf('// Save as draft — autosave already persisted everything'));
  assert.ok(!/_existingCampaignBlocksNewDispatch\(\)\) return;/.test(fn));
  assert.match(fn, /startCampaign\(\{ queueOnly: true, scheduleCron: result\.cron, scheduleName: result\.name \}\)/);
});

test('a schedule carries the FULL launch and the campaign\'s permanent id', () => {
  const submit = app.slice(app.indexOf('async function submitStartCampaign('), app.indexOf("const url = opts.queueOnly ? '/api/campaign/queue-only'"));
  assert.match(submit, /if \(opts\.scheduleCron\)/);
  assert.match(submit, /campaignId: body\.campaignId/);
  assert.match(submit, /launchBody: body/);
  assert.match(server, /launchBody: \(req\.body\.launchBody && typeof req\.body\.launchBody === 'object'\)/);
});

test('when it fires, a schedule runs that full launch under the same campaign id', () => {
  assert.match(server, /if \(schedule\.launchBody\) \{\s+const fullConfig = buildCampaignConfig\(\{ \.\.\.schedule\.launchBody, campaignId: schedule\.campaignId, name: schedule\.name \}\);/);
});
