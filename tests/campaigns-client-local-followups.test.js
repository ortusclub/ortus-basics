// Basics retired cloud campaign transport. These calls must remain offline,
// including legacy saved configurations with schedules or remembered primaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalFollowups, ackLocalFollowups } from '../src/campaigns-client.js';

test('Basics rejects polling follow-ups without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await getLocalFollowups('operator@example.test');
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('Basics rejects acknowledging follow-ups without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await ackLocalFollowups(['task1'], 'operator@example.test');
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});
