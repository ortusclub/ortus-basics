// Basics retired cloud campaign transport. These calls must remain offline,
// including legacy saved configurations with schedules or remembered primaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCloudCampaign, restartCloudCampaign } from '../src/campaigns-client.js';

test('Basics rejects scheduled launch without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await startCloudCampaign({ mode: 'connect_and_introduce', profileIds: ['p1'], leads: [{ leadUrl: 'https://www.linkedin.com/in/test' }],  startAt: '2026-12-01T12:00:00Z' });
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('Basics rejects immediate launch without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await startCloudCampaign({ mode: 'connect_and_introduce', profileIds: ['p1'], leads: [{ leadUrl: 'https://www.linkedin.com/in/test' }], });
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('Basics rejects scheduled restart without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await restartCloudCampaign('legacy', { startAt: '2026-12-01T12:00:00Z' });
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('Basics rejects immediate restart without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await restartCloudCampaign('legacy');
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});
