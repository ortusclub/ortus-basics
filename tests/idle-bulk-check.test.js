import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFireIdleBulkCheck, AUTOMATIC_CHECKS_ENABLED } from '../src/campaign.js';
import { readFileSync } from 'node:fs';

// The between-checks interval is now the operator cadence, passed in as
// intervalMs. The first-hour age gate (campaignStartTime) is unchanged.
const ONE_HOUR = 60 * 60 * 1000;
const baseInput = () => ({
  mode: 'connect_and_introduce',
  campaignStartTime: Date.now() - (75 * 60 * 1000), // 75 min ago — past 60-min age gate
  profileBrowserOpen: false,
  profileWeeklyLimited: false,
  semaphoreAvailable: 1,
  lastBulkCheckAt: Date.now() - (2 * ONE_HOUR), // 2h ago — past a 1h cadence
  intervalMs: ONE_HOUR,                          // operator picked "every hour"
  now: Date.now(),
});

test('never fires on its own, even when every gate passes — checks are manual only', () => {
  assert.equal(AUTOMATIC_CHECKS_ENABLED, false);
  assert.equal(shouldFireIdleBulkCheck(baseInput()), false);
});

test('skips when mode is not a connect-then-followup mode', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'connect_only' }), false);
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'message_only' }), false);
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'introduce_back' }), false);
});

test('never fires on its own for connect_and_message either', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'connect_and_message' }), false);
});

test('skips when campaign uptime < 60 min (first-hour blackout)', () => {
  const input = { ...baseInput(), campaignStartTime: Date.now() - (45 * 60 * 1000) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('skips when profile browser is open (in-batch trigger owns it)', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), profileBrowserOpen: true }), false);
});

test('skips when profile is parked permanently (weeklyLimited)', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), profileWeeklyLimited: true }), false);
});

test('skips when semaphore has no available slot', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), semaphoreAvailable: 0 }), false);
});

test('HONORS the operator cadence: skips when interval not yet elapsed', () => {
  // 30 min since last check, but operator picked every hour → not due yet.
  const input = { ...baseInput(), lastBulkCheckAt: Date.now() - (30 * 60 * 1000) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('HONORS the operator cadence: a 6h pick is NOT due at 2h', () => {
  const input = { ...baseInput(), intervalMs: 6 * ONE_HOUR, lastBulkCheckAt: Date.now() - (2 * ONE_HOUR) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('an elapsed operator interval does not start a check on its own', () => {
  const t = Date.now();
  const input = { ...baseInput(), now: t, intervalMs: ONE_HOUR, lastBulkCheckAt: t - ONE_HOUR };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('the in-batch sweep after a send is behind the same manual-only switch', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.match(src, /if \(AUTOMATIC_CHECKS_ENABLED && \(mode === 'connect_and_introduce' \|\| mode === 'connect_and_message'\) && result\.action === 'connection_sent'\)/);
});
