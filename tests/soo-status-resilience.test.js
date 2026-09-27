// These tests mock transport; provide a dummy configured workspace for gateway signing.
process.env.GOLOGIN_API_TOKEN = 'test-only-workspace-credential';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchSoOData,
  fetchSoOStatusData,
  resetSoOStatusCacheForTests,
} from '../src/soo.js';

const OK = { accounts: [{ email: 'safe@ortus.solutions', Status: 'Active' }] };

test('concurrent SoO consumers share one upstream read', async () => {
  resetSoOStatusCacheForTests();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: 200, json: async () => OK };
  };

  const results = await Promise.all([
    fetchSoOData(), fetchSoOData(), fetchSoOData(), fetchSoOData(), fetchSoOData(),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results, [OK, OK, OK, OK, OK]);
});

test('status endpoint cache serves fresh data without another Google execution', async () => {
  resetSoOStatusCacheForTests();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { status: 200, json: async () => OK };
  };

  const first = await fetchSoOStatusData({ now: () => 1_000 });
  const second = await fetchSoOStatusData({ now: () => 2_000 });
  assert.equal(calls, 1);
  assert.equal(first.state, 'fresh');
  assert.equal(second.state, 'fresh');
  assert.deepEqual(second.data, OK);
});

test('a failed refresh preserves the last successful snapshot', async () => {
  resetSoOStatusCacheForTests();
  globalThis.fetch = async () => ({ status: 200, json: async () => OK });
  await fetchSoOStatusData({ now: () => 1_000 });

  globalThis.fetch = async () => { throw new Error('Google overloaded'); };
  const stale = await fetchSoOStatusData({ force: true, attempts: 1, now: () => 9_000 });
  assert.equal(stale.state, 'stale');
  assert.deepEqual(stale.data, OK);
  assert.match(stale.error.message, /Google overloaded/);
});

test('the picker distinguishes an outage from an account absent from SoO', () => {
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /sooLoadState === 'error'/);
  assert.match(app, /word: _sooUnavailable \? 'SoO UNAVAILABLE'/);
  assert.match(app, /Could not check the SoO — status unknown and selection disabled/);
  assert.match(app, /const _sooUnknown = !_soo/);
  assert.match(app, /_sooUnknown \|\| \(_showBreakdown/,
    'unknown SoO status must lock the account rather than merely changing its label');
  assert.match(app, /else if \(_noSoo\) _sub = 'Not in the SoO/,
    'NOT IN SoO remains reserved for a successful lookup with no matching row');
});
