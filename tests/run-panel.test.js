import { test } from 'node:test';
import assert from 'node:assert';
import { railIndex, batchPips, accountColumns } from '../public/js/runpanel.mjs';
import { sweepHealth, missReason, parkSentence } from '../src/campaign.js';

test('the live account is centred, so the previous sits left and the next right', () => {
  const cols = [{ live: false }, { live: false }, { live: true }, { live: false }];
  assert.equal(railIndex(cols), 2);
});

test('the first account is flush left, because there is no previous', () => {
  assert.equal(railIndex([{ live: true }, { live: false }, { live: false }]), 0);
});

test('nothing live falls back to the first column', () => {
  assert.equal(railIndex([{ live: false }, { live: false }]), 0);
  assert.equal(railIndex([]), 0);
});

test('pips mark done, current and remaining', () => {
  assert.deepEqual(batchPips(2, 4, true), ['on', 'on', 'now', '']);
});

test('a finished batch has no current pip', () => {
  assert.deepEqual(batchPips(4, 4, true), ['on', 'on', 'on', 'on']);
});

test('an idle account has no current pip even mid-batch', () => {
  // Nothing is happening, so nothing may look like it is happening.
  assert.deepEqual(batchPips(2, 4, false), ['on', 'on', '', '']);
});

test('steps are carried only by the account that is working', () => {
  const [live, idle] = accountColumns({ accountPanel: [
    { email: 'a@b.c', live: true, steps: [['done', 'Opened the browser', '00:04']] },
    { email: 'd@e.f', live: false, steps: [['done', 'Opened the browser', '00:04']] },
  ] });
  assert.equal(live.steps.length, 1);
  assert.deepEqual(idle.steps, [], 'a frozen checklist on an idle account reads as live');
});

test('both numbers survive: the batch and the day', () => {
  const [c] = accountColumns({ accountPanel: [
    { email: 'a@b.c', live: true, batchDone: 5, batchSize: 8, sentToday: 21, dailyLimit: 50 },
  ] });
  assert.equal(c.batchDone, 5);
  assert.equal(c.batchSize, 8);
  assert.equal(c.sentToday, 21);
  assert.equal(c.dailyLimit, 50);
});

test('a turn size that does not exist stays blank rather than borrowing the eight', () => {
  const [c] = accountColumns({ accountPanel: [{ email: 'a@b.c', batchSize: null }] });
  assert.equal(c.batchSize, null);
});

test('a missing panel yields no columns rather than throwing', () => {
  assert.deepEqual(accountColumns({}), []);
  assert.deepEqual(accountColumns(null), []);
});

test('identity restriction remains explicit in the shared account panel', () => {
  const [c] = accountColumns({ accountPanel: [{
    email: 'blocked@ortus.solutions',
    state: 'identity-restricted',
    sub: 'Identity Restricted in the SoO. Removed from rotation; queued leads are safe.',
  }] });
  assert.equal(c.state, 'identity-restricted');
  assert.match(c.sub, /queued leads are safe/i);
});

// ── The sweep's own health, in the operator's words ──────────────────────────
// A check that fails for one account used to leave one log line and nothing
// else, so the account read as healthy for the rest of the run.

test('a check that lands on the login page says the account must be logged in again', () => {
  const h = sweepHealth('session-expired (redirected to https://www.linkedin.com/uas/login)');
  assert.equal(h.state, 'needs-login');
  assert.match(h.note, /logged in again in GoLogin/);
  assert.ok(!/session|expired|redirect/i.test(h.note), 'no internal wording reaches the operator');
});

test('a browser that never opened is told apart from an account that is logged out', () => {
  assert.equal(sweepHealth('navigation-failed: Navigation timeout of 30000 ms exceeded').state, 'cannot-open');
  assert.equal(sweepHealth('Failed to launch profile 68a1').state, 'cannot-open');
});

test('LinkedIn asking the account to slow down reads as slowing down, not as an error code', () => {
  const h = sweepHealth('http-429');
  assert.equal(h.state, 'rate-limited');
  assert.ok(!/429/.test(h.note));
});

test('an unrecognised failure still leaves a state behind', () => {
  const h = sweepHealth('batch-update: something odd');
  assert.equal(h.state, 'trouble');
  assert.ok(h.note.length > 0);
});

test('a check that worked leaves no health state at all', () => {
  assert.equal(sweepHealth(''), null);
  assert.equal(sweepHealth(null), null);
});

test('every miss is explained as a sentence, never as a reason key', () => {
  assert.match(missReason('already_processed', ''), /^[A-Z].*\.$/);
  assert.match(missReason('other', 'Skipped: Weekly limit reached'), /invitations for the week/);
  assert.match(missReason('other', 'Skipped: Session expired'), /logged in again in GoLogin/);
  const rate = missReason('other', 'Skipped: Rate-limited (HTTP 429) — confirming…');
  assert.ok(!/429|HTTP/.test(rate));
  assert.ok(!/—/.test(rate), 'no em dashes reach the operator');
});

test('a park reason is rewritten, so no raw internal wording reaches the card', () => {
  const s = parkSentence('Weekly invitation limit reached (2× HTTP 429)');
  assert.ok(!/HTTP|429/.test(s));
  // Inferred from refused invites, so it says "suspected" — LinkedIn's own message stays certain.
  assert.match(s, /^Suspected weekly invitation limit/);
  assert.match(parkSentence('Weekly invitation limit hit (~100/week)'), /invitations for the week/);
  assert.match(parkSentence('Session expired — log in again'), /logged in again in GoLogin/);
  assert.equal(parkSentence(''), '');
  assert.match(parkSentence('unconfirmed_streak'), /Five leads in a row could not be confirmed/);
  assert.match(parkSentence('Parked after 5 consecutive unconfirmed sends'), /choose Try again/);
});
