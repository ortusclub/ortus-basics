// Basics retired cloud campaign transport. These calls must remain offline,
// including legacy saved configurations with schedules or remembered primaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCloudCampaign } from '../src/campaigns-client.js';

test('Basics rejects launch with remembered connections without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await startCloudCampaign({ profileIds: ['p1'], leads: [{ leadUrl: 'https://www.linkedin.com/in/test' }],  mode: 'connect_and_introduce', primaryConn: { p1: 'connected' } });
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('Basics rejects launch without remembered connections without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await startCloudCampaign({ profileIds: ['p1'], leads: [{ leadUrl: 'https://www.linkedin.com/in/test' }],  mode: 'connect_and_introduce' });
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});
