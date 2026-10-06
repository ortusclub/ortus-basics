// Basics retired cloud campaign transport. These calls must remain offline,
// including legacy saved configurations with schedules or remembered primaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { signalPrimaryAcceptDone } from '../src/campaigns-client.js';

test('Basics rejects primary handshake without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await signalPrimaryAcceptDone('legacy', ['p1']);
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});

test('Basics rejects empty handshake without network access', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  const result = await signalPrimaryAcceptDone('legacy', null);
  assert.deepEqual(result, { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});
