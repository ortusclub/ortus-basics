// SoO writes retry transient failures — but ONLY the idempotent ones.
//
// The Apps Script webapp this posts to cold-starts in 28-58s (measured in the
// engine repo, campaign-soo-writer.js), so a single short attempt aborts every
// write while the container warms. That is why setSoO retries.
//
// bumpSoOConnections must NOT. It posts a DELTA (+N) the script accumulates: a
// timeout raised after the script committed the write is indistinguishable from
// one raised before it, so a retry would inflate the weekly connection tally —
// numbers that feed real reporting. Its safety net is the cloud reconciler,
// which leaves failed leads UNcounted so a later poll retries exactly once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flipAccountInUse, bumpConnectionsThisWeek, markAccountNeedsLoginSoO, isTransientSoOError,
} from '../src/soo-writer.js';

const NO_SLEEP = { baseDelayMs: 0, sleep: async () => {} };

/** Swap global fetch for a counting stub, always failing with `err`. */
function stubFetch(err) {
  const calls = { n: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = async () => { calls.n++; throw err; };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

test('the In Use flip stays disabled', async () => {
  const f = stubFetch(timeoutErr());
  try {
    const res = await flipAccountInUse(
      { email: 'a@ortus.solutions', creditHeader: 'CC (Credits)', userHeader: 'CC App User', operatorEmail: 'me@ortus.solutions' },
      NO_SLEEP,
    );
    assert.equal(res.ok, false, 'still resolves to a result — never throws to the caller');
    assert.equal(f.calls.n, 0);
  } finally { f.restore(); }
});

test('Needs Login retries too — same idempotent setSoO payload', async () => {
  const f = stubFetch(timeoutErr());
  try {
    await markAccountNeedsLoginSoO({ email: 'a@ortus.solutions' }, NO_SLEEP);
    assert.equal(f.calls.n, 4);
  } finally { f.restore(); }
});

test('the weekly connection bump stays disabled', async () => {
  const f = stubFetch(timeoutErr());
  try {
    const res = await bumpConnectionsThisWeek({ email: 'a@ortus.solutions', delta: 3 }, NO_SLEEP);
    assert.equal(res.ok, false);
    assert.equal(f.calls.n, 0);
  } finally { f.restore(); }
});

test('a permanent login-flag failure is not retried', async () => {
  // Retrying an auth/bad-request rejection only multiplies the latency in front
  // of the send loop.
  const f = stubFetch(new Error('HTTP 401'));
  try {
    await markAccountNeedsLoginSoO(
      { email: 'a@ortus.solutions' },
      NO_SLEEP,
    );
    assert.equal(f.calls.n, 1);
  } finally { f.restore(); }
});

test('the transient classifier matches what the engine treats as retryable', () => {
  // Kept in sync with campaign-soo-writer.js / campaign-sheet-writer.js in the
  // engine repo — a divergence here means the two halves disagree about which
  // failures are worth retrying.
  for (const msg of ['timeout', 'The operation was aborted', 'ECONNRESET', 'EAI_AGAIN',
    'socket hang up', 'network error', 'fetch failed', 'terminated', 'HTTP 429',
    'HTTP 500', 'HTTP 502', 'HTTP 503', 'HTTP 504']) {
    assert.ok(isTransientSoOError(new Error(msg)), `${msg} must be transient`);
  }
  for (const msg of ['HTTP 401', 'HTTP 403', 'HTTP 400', 'no matching row']) {
    assert.ok(!isTransientSoOError(new Error(msg)), `${msg} must be permanent`);
  }
});
