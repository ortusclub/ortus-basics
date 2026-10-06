import { test } from 'node:test';
import assert from 'node:assert';
import { _setTestState, tickMonitoringNow, getCampaignState } from '../src/campaign.js';

test('tickMonitoringNow does nothing when state is not monitoring', async () => {
  _setTestState({ state: 'idle', nextCheckAt: new Date(Date.now() - 60_000).toISOString() });
  let fired = false;
  await tickMonitoringNow({ _testStub: () => { fired = true; } });
  assert.equal(fired, false);
});

test('tickMonitoringNow does nothing when nextCheckAt is in the future', async () => {
  _setTestState({
    state: 'monitoring',
    nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
  });
  let fired = false;
  await tickMonitoringNow({ _testStub: () => { fired = true; } });
  assert.equal(fired, false);
});

test('overdue legacy monitoring never starts an automatic browser check', async () => {
  const nextCheckAt = new Date(Date.now() - 1000).toISOString();
  _setTestState({ state: 'monitoring', autoChecksEnabled: true, nextCheckAt,
    monitoringUntil: new Date(Date.now() + 86400000).toISOString(), checkIntervalMinutes: 30, logs: [] });
  let fired = false;
  await tickMonitoringNow({ _testStub: () => { fired = true; } });
  assert.equal(fired, false);
  assert.equal(getCampaignState().nextCheckAt, nextCheckAt);
});

// Even a stale schedule with no accounts must remain inert in manual-only Basics.
test('manual-only monitoring does not enqueue retries or change cadence', async () => {
  const nextCheckAt = new Date(Date.now() - 1000).toISOString();
  _setTestState({ state: 'monitoring', nextCheckAt,
    monitoringUntil: new Date(Date.now() + 86400000).toISOString(),
    checkIntervalMinutes: 60, emptyCheckStreak: 6, participatingProfileIds: [], logs: [] });
  await tickMonitoringNow();
  const s = getCampaignState();
  assert.equal(s.nextCheckAt, nextCheckAt);
  assert.equal(s.checkIntervalMinutes, 60);
  assert.equal(s.emptyCheckStreak, 6);
  assert.deepEqual(s.logs, []);
});

test('tickMonitoringNow does not reschedule when state changes during fire', async () => {
  const past = new Date(Date.now() - 1000);
  _setTestState({
    state: 'monitoring',
    nextCheckAt: past.toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
    checkIntervalMinutes: 30,
    logs: [],
  });
  const originalNext = past.toISOString();
  await tickMonitoringNow({
    _testStub: async () => { _setTestState({ state: 'done' }); },
  });
  const s = getCampaignState();
  assert.equal(s.nextCheckAt, originalNext, 'nextCheckAt should NOT be advanced after state changed away from monitoring');
});
