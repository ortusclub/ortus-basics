import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCampaignLoopGuard } from '../src/campaign-loop-guard.js';

test('repeated failed turns pause on the third attempt with a retry delay', () => {
  const guard = createCampaignLoopGuard();
  const stalled = { before: 'lead-0', after: 'lead-0' };
  assert.deepEqual(guard.record('a', stalled), { stalled: true, attempts: 1, pause: false, retryDelayMs: 15000 });
  assert.equal(guard.record('a', stalled).pause, false);
  assert.equal(guard.record('a', stalled).pause, true);
});

test('rotating across accounts does not hide a repeated failure', () => {
  const guard = createCampaignLoopGuard();
  for (let round = 1; round <= 3; round++) {
    const result = guard.record('broken', { before: '0', after: '0' });
    guard.record('healthy', { before: String(round), after: String(round + 1) });
    assert.equal(result.pause, round === 3);
  }
});

test('advancing past a skipped lead counts as progress and resets the streak', () => {
  const guard = createCampaignLoopGuard();
  guard.record('a', { before: '0', after: '0' });
  guard.record('a', { before: '0', after: '0' });
  assert.equal(guard.record('a', { before: '0', after: '1' }).stalled, false);
  assert.equal(guard.record('a', { before: '1', after: '1' }).attempts, 1);
});

test('intentional holds, exhausted accounts and manual pauses do not count', () => {
  const guard = createCampaignLoopGuard();
  for (let i = 0; i < 10; i++) {
    assert.equal(guard.record('a', { before: '0', after: '0', retryable: false }).pause, false);
  }
});

test('explicit resume starts a fresh retry allowance', () => {
  const guard = createCampaignLoopGuard();
  for (let i = 0; i < 3; i++) guard.record('a', { before: '0', after: '0' });
  guard.reset();
  assert.equal(guard.record('a', { before: '0', after: '0' }).attempts, 1);
});
