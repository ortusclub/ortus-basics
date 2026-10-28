import { test } from 'node:test';
import assert from 'node:assert/strict';

test('runMonitoringCheck rejects when campaign not in monitoring state', async () => {
  // Reset campaign state to non-monitoring
  const mod = await import('../src/campaign.js');
  // We don't have direct access to mutate `campaign`, but a freshly imported
  // module has campaign.state === undefined or 'running' or whatever default
  // — verify the helper short-circuits
  const r = await mod.runMonitoringCheck('p1', 'test');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /not in monitoring/i);
});

test('runMonitoringCheckAll rejects when campaign not in monitoring state', async () => {
  const mod = await import('../src/campaign.js');
  const r = await mod.runMonitoringCheckAll();
  assert.equal(r.ok, false);
});

test('canRunAcceptanceCheck: monitoring, or finished with recorded accounts; never over a live run or without accounts', async () => {
  const { canRunAcceptanceCheck } = await import('../src/campaign.js');
  assert.equal(canRunAcceptanceCheck({ state: 'monitoring', running: false, participatingProfileIds: [] }), true);
  assert.equal(canRunAcceptanceCheck({ state: null, running: false, participatingProfileIds: ['p1'] }), true);
  assert.equal(canRunAcceptanceCheck({ state: 'done', running: false, participatingProfileIds: ['p1'] }), true);
  assert.equal(canRunAcceptanceCheck({ state: null, running: true, participatingProfileIds: ['p1'] }), false);
  assert.equal(canRunAcceptanceCheck({ state: null, running: false, participatingProfileIds: [] }), false);
  assert.equal(canRunAcceptanceCheck({ state: null, running: false }), false);
  assert.equal(canRunAcceptanceCheck(null), false);
});
