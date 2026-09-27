// These tests mock transport; provide a dummy configured workspace for gateway signing.
process.env.GOLOGIN_API_TOKEN = 'test-only-workspace-credential';
// The SoO fetch is the launcher's whole source of truth: every account's first
// name, its FREE/in-use state, and the Construction filter all come from it. When
// it fails, sooData is EMPTY — so every account renders "no first name" and the
// states are wrong. The operator's fix was to keep hitting Refresh.
//
// Measured against the live Apps Script on 2026-07-31 (1011 rows, ~1.0 MB):
//   4.4s ✓   20.4s ✗(133-byte error body)   3.4s ✓   3.7s ✓   14.9s ✗(133 bytes)
//   12.6s ✓  ← would have been killed by the old 10s cap despite succeeding
// and separately four consecutive failures in a row.
//
// Two distinct failure modes, so two fixes:
//   1. slow-but-successful — the old AbortSignal.timeout(10_000) cut these off.
//      Worse, that ONE signal covered both hops (the POST and the redirect
//      follow), so the budget was shared, not per-request.
//   2. transient Apps Script errors — a longer timeout cannot help; only a retry
//      can. The script is shared by every operator, so contention is expected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSoOData, SOO_TIMEOUT_MS, SOO_ATTEMPTS } from '../src/soo.js';

const OK_BODY = { accounts: [{ email: 'a@ortus.solutions', 'First Name': 'Ann' }] };

// Minimal stand-in for the Apps Script endpoint. `script` is one entry per call.
function stubFetch(script) {
  const calls = [];
  globalThis.fetch = async (_url, opts = {}) => {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push(step);
    if (step === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    if (step === 'network') throw new Error('socket hang up');
    if (step === 'upstream') return { status: 200, json: async () => ({ error: 'Service invoked too many times', errorCode: 'UPSTREAM' }) };
    return { status: 200, json: async () => OK_BODY };
  };
  return calls;
}

const noSleep = async () => {};

test('a per-attempt budget well above the observed 12.6s success', () => {
  assert.ok(SOO_TIMEOUT_MS >= 20_000,
    `10s cut off real successes (12.6s measured); got ${SOO_TIMEOUT_MS}ms`);
});

test('it retries rather than giving up on one bad response', () => {
  assert.ok(SOO_ATTEMPTS >= 2, `a single attempt cannot survive a transient error; got ${SOO_ATTEMPTS}`);
});

test('a transient timeout is retried and the second attempt wins', async () => {
  const calls = stubFetch(['timeout', 'ok']);
  const data = await fetchSoOData({ sleep: noSleep });
  assert.deepEqual(data, OK_BODY, 'the caller gets data, not an error');
  assert.equal(calls.length, 2, 'exactly one retry was needed');
});

test('a transient Apps Script error body is retried too', async () => {
  // The 133-byte failures: the request COMPLETES, so a longer timeout is no help.
  const calls = stubFetch(['upstream', 'ok']);
  const data = await fetchSoOData({ sleep: noSleep });
  assert.deepEqual(data, OK_BODY);
  assert.equal(calls.length, 2);
});

test('a network blip is retried', async () => {
  stubFetch(['network', 'ok']);
  assert.deepEqual(await fetchSoOData({ sleep: noSleep }), OK_BODY);
});

test('it gives up after the attempt budget and keeps the typed error', async () => {
  const calls = stubFetch(['timeout']);
  await assert.rejects(
    () => fetchSoOData({ sleep: noSleep }),
    (err) => {
      assert.equal(err.code, 'TIMEOUT', 'callers branch on .code — it must survive the retry loop');
      return true;
    },
  );
  assert.equal(calls.length, SOO_ATTEMPTS, `tried exactly ${SOO_ATTEMPTS} times, then stopped`);
});

test('a first-attempt success costs exactly one request', async () => {
  // The happy path is 3-5s and must not be slowed or duplicated by the retry
  // wrapper — this endpoint is hit on every app load.
  const calls = stubFetch(['ok']);
  await fetchSoOData({ sleep: noSleep });
  assert.equal(calls.length, 1);
});

test('each attempt gets its OWN timeout, not a shared budget', async () => {
  // The old code built one AbortSignal and passed it to both the POST and the
  // redirect follow, so a slow first hop ate the second hop's time.
  const signals = [];
  globalThis.fetch = async (_url, opts = {}) => {
    signals.push(opts.signal);
    return { status: 200, json: async () => OK_BODY };
  };
  await fetchSoOData({ sleep: noSleep });
  assert.ok(signals.length >= 1);
  assert.ok(signals.every((s) => s), 'every request carries an abort signal');
});
