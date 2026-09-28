/**
 * sheet-write-tracker.js
 *
 * Second-level retry + failure ledger for Google Sheet writes.
 * By the time writeSheetWithRetry is called, the underlying write has ALREADY
 * been retried by sheets-writer's withWriteRetry (up to 3×). This is a
 * campaign-level retry that fires after sheets-writer has exhausted its retries.
 *
 * Non-blocking: the campaign loop must never be stopped by a write failure.
 * All errors are swallowed; failures are recorded to the in-memory ledger.
 */

// ─── Module-level state ───────────────────────────────────────────────────────

let _failures = [];
let _warningLogger = null;
let _defaultRetryDelayMs = 30_000;

// ─── configure() ─────────────────────────────────────────────────────────────

/**
 * Wire up optional integrations. Call once on startup from campaign.js.
 * @param {object} opts
 * @param {function} [opts.warningLogger] - called with (entry) on each failure
 * @param {number}   [opts.retryDelayMs]  - override module-level default delay
 */
export function configure({ warningLogger, retryDelayMs } = {}) {
  if (warningLogger !== undefined) _warningLogger = warningLogger;
  if (retryDelayMs !== undefined) _defaultRetryDelayMs = retryDelayMs;
}

// ─── Ledger helpers ───────────────────────────────────────────────────────────

/** Returns a shallow copy of the failure ledger. */
export function getFailures() {
  return [..._failures];
}

/** Empties the failure ledger. */
export function clearFailures() {
  _failures = [];
}

/**
 * Directly append an entry to the ledger (and invoke warningLogger if set).
 * @param {object} entry - { url, leadName, column, payload, errorMessage, timestamp, attempts }
 */
export function recordFailure(entry) {
  _failures.push(entry);
  if (_warningLogger) {
    try { _warningLogger(entry); } catch {}
  }
}

// ─── writeSheetWithRetry ─────────────────────────────────────────────────────

/**
 * Call fn() once. On failure (throws or returns {error}), wait retryDelayMs,
 * then call fn() again. On second failure, record to the ledger.
 * NEVER throws — non-blocking by design.
 *
 * @param {function} fn                      - async () => result
 * @param {object}   [meta]                  - { url, leadName, column, payload }
 * @param {object}   [opts]
 * @param {number}   [opts.retryDelayMs]     - ms to wait between attempts (default 30000)
 * @param {function} [opts.sleep]            - injectable sleep for tests
 * @returns {Promise<any>} result of fn, or undefined on double failure
 */
export async function writeSheetWithRetry(
  fn,
  meta = {},
  {
    retryDelayMs = _defaultRetryDelayMs,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}
) {
  let result;

  // ── Attempt 1 ──
  try {
    result = await fn();
    if (!result?.error) return result;
  } catch (err1) {
    // fall through to retry
    result = null;
    const _err1 = err1; // hold ref in case retry also fails — but we overwrite below
    void _err1;
  }

  // ── Wait ──
  await sleep(retryDelayMs);

  // ── Attempt 2 ──
  let errorMessage;
  try {
    result = await fn();
    if (!result?.error) return result;
    errorMessage = result.error;
  } catch (err2) {
    errorMessage = err2?.message ?? String(err2);
  }

  // ── Record failure ──
  // This is the replay payload, not a display preview. Truncating JSON makes
  // normal message results impossible to retry.
  const payload = meta.payload ?? '';

  recordFailure({
    url: meta.url ?? null,
    sheetUrl: meta.sheetUrl ?? null,
    leadName: meta.leadName ?? null,
    column: meta.column ?? null,
    payload,
    errorMessage: errorMessage ?? 'unknown error',
    timestamp: new Date().toISOString(),
    attempts: 2,
  });

  return result ?? { error: errorMessage || 'Unknown sheet write failure' };
}

// ─── retryFailures ────────────────────────────────────────────────────────────

/**
 * Attempt to retry every failure currently in the ledger.
 * @param {function} retryFn - async (failure) => { error? } | throws
 * @returns {Promise<{ retried: number, stillFailing: number }>}
 */
export async function retryFailures(retryFn) {
  const snapshot = [..._failures];
  let stillFailing = 0;

  for (const failure of snapshot) {
    try {
      const result = await retryFn(failure);
      if (result?.error) {
        // Still failing — update errorMessage in place
        failure.errorMessage = result.error;
        stillFailing++;
      } else {
        // Success — remove from ledger
        const idx = _failures.indexOf(failure);
        if (idx !== -1) _failures.splice(idx, 1);
      }
    } catch (err) {
      failure.errorMessage = err?.message ?? String(err);
      stillFailing++;
    }
  }

  return { retried: snapshot.length, stillFailing };
}
