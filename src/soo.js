import { sheetsFetch } from './sheets-gateway-client.js';
/**
 * Shared helper for fetching State of Operations data from the Apps Script
 * web app. Used by both the /api/soo-status endpoint and the signup allowlist
 * path in auth.js so they share timeout, error-shape, and redirect handling.
 *
 * Throws errors with `.code` set to one of:
 *   NOT_CONFIGURED · TIMEOUT · NETWORK · UPSTREAM
 * so callers can branch on the kind of failure without parsing messages.
 */

import { SHEETS_WEBAPP_URL, SOO_SHEET_ID, SOO_SHEET_GID } from './sheets-webapp-url.js';
import { SCRAPER_ENGINE_TOKEN } from './scraper-engine-url.js';
import { onWebappLane } from './webapp-lane.js';

// Measured against the live sheet 2026-07-31 (1011 rows, ~1.0 MB): the happy
// path is 3-5s, but successful fetches were seen at 12.6s and slow failures at
// 15-20s. The old 10s budget therefore killed responses that were merely slow —
// and it was ONE signal shared across both hops (the POST and the redirect
// follow), so a slow first hop ate the second hop's time. Now per-attempt.
export const SOO_TIMEOUT_MS = 25_000;

// The Apps Script is shared by every operator (one central deployment), so
// contention is normal and some failures return an ERROR BODY rather than
// hanging — no timeout can help those, only trying again. Observed 2 failures
// in 5, and separately 4 in a row.
export const SOO_ATTEMPTS = 3;
const SOO_RETRY_BACKOFF_MS = [800, 2_000];
export const SOO_STATUS_CACHE_MS = 5 * 60 * 1000;

// All server consumers share one live request. Without this, opening the
// account picker while another SoO-backed panel was loading started another
// 1 MB Apps Script read. A rejected read is cleared in `finally`, so recovery
// is never wedged behind a failed promise.
let _inflight = null;
let _statusCache = null;

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch the SoO, retrying transient failures.
 *
 * When this throws, the launcher's sooData is EMPTY — every account renders
 * "no first name", the FREE/in-use states are wrong, and the Construction
 * filter can't run. That is why it retries rather than surfacing the first
 * failure: the operator's workaround was hammering Refresh until it worked.
 *
 * The typed `.code` survives the loop — callers branch on it.
 */
export async function fetchSoOData({ attempts = SOO_ATTEMPTS, sleep = _sleep, random = Math.random } = {}) {
  if (_inflight) return _inflight;
  _inflight = fetchSoODataWithRetry({ attempts, sleep, random })
    .finally(() => { _inflight = null; });
  return _inflight;
}

async function fetchSoODataWithRetry({ attempts, sleep, random }) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchSoOOnce();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      const base = SOO_RETRY_BACKOFF_MS[Math.min(attempt - 1, SOO_RETRY_BACKOFF_MS.length - 1)];
      // Operators tend to open/refresh together. Jitter prevents every app from
      // retrying the shared Google account at the same instant.
      await sleep(Math.round(base * (0.75 + (random() * 0.5))));
    }
  }
  throw lastErr;
}

/**
 * Cached status-reader used by /api/soo-status.
 *
 * A stale successful snapshot is more truthful and safer than replacing the
 * entire roster with "NOT IN SoO" during a Google outage. `force` skips only
 * the fresh-cache check; it still joins an already-running request.
 */
export async function fetchSoOStatusData({ force = false, now = Date.now, ...fetchOpts } = {}) {
  const at = Number(now());
  if (!force && _statusCache && at - _statusCache.fetchedAt < SOO_STATUS_CACHE_MS) {
    return { data: _statusCache.data, state: 'fresh', fetchedAt: _statusCache.fetchedAt };
  }
  try {
    const data = await fetchSoOData(fetchOpts);
    _statusCache = { data, fetchedAt: Number(now()) };
    return { data, state: 'fresh', fetchedAt: _statusCache.fetchedAt };
  } catch (error) {
    if (_statusCache) {
      return { data: _statusCache.data, state: 'stale', fetchedAt: _statusCache.fetchedAt, error };
    }
    throw error;
  }
}

// Test-only reset: exported rather than relying on module-cache tricks, which
// can hide a stuck in-flight promise or a stale snapshot between test cases.
export function resetSoOStatusCacheForTests() {
  _inflight = null;
  _statusCache = null;
}

async function fetchSoOOnce() {
  // v2.52.0: SOO_SHEET_ID, SOO_SHEET_GID, and the webapp URL are all hard-coded
  // in sheets-webapp-url.js. Any matching .env values are ignored. Previously
  // operators had to ask Antonio for the SoO values, paste them into a local
  // .env, and re-paste on every update — which is why the SoO panel silently
  // failed for any operator who skipped that setup step.
  const sooSheetId = SOO_SHEET_ID;
  const sooGid = SOO_SHEET_GID;
  const webappUrl = SHEETS_WEBAPP_URL;

  // Development engines expose the same roster through the Google Sheets API.
  // This avoids Apps Script's small simultaneous-execution pool. Only use an
  // explicitly configured engine here: released apps keep the existing Apps
  // Script fallback until the endpoint is promoted to the live engine.
  const engineBase = String(process.env.SCRAPER_ENGINE_URL || '').replace(/\/+$/, '');
  if (engineBase) {
    try {
      const token = process.env.SCRAPER_ENGINE_TOKEN || SCRAPER_ENGINE_TOKEN;
      const response = await fetch(`${engineBase}/api/soo-status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
      const engineData = await response.json();
      if (response.ok && Array.isArray(engineData && engineData.accounts)) return engineData;
      throw new Error((engineData && engineData.error) || `HTTP ${response.status}`);
    } catch (error) {
      console.warn(`[SoO] Direct engine read unavailable; using Apps Script fallback: ${error.message}`);
    }
  }

  const payload = JSON.stringify({
    sheetId: sooSheetId,
    action: 'getSoO',
    sooSheetId,
    sooGid: sooGid || '',
  });

  let data;
  try {
    // Apps Script returns 302 on POST; node fetch would downgrade the redirect
    // to GET (HTTP spec). Handle manually — stop on redirect, re-fetch Location.
    //
    // A FRESH signal per hop. Sharing one meant the redirect follow — the hop
    // that actually streams the ~1 MB body — inherited whatever was left after
    // the POST, so a slow handshake could leave it almost no time at all.
    //
    // On the shared webapp lane: this read pulls a ~1 MB body and holds an Apps
    // Script execution the whole time, so letting it run alongside a campaign's
    // row writes is exactly the contention that trips the per-spreadsheet
    // simultaneous-invocation limit.
    data = await onWebappLane(async () => {
      const initial = await sheetsFetch(webappUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(SOO_TIMEOUT_MS),
      });

      const response = (initial.status >= 300 && initial.status < 400)
        ? await fetch(initial.headers.get('location'), { signal: AbortSignal.timeout(SOO_TIMEOUT_MS) })
        : initial;

      return response.json();
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw makeError(`Apps Script timed out after ${SOO_TIMEOUT_MS / 1000}s`, 'TIMEOUT');
    }
    throw makeError(`Apps Script fetch failed: ${err.message}`, 'NETWORK');
  }

  if (data && data.error) {
    throw makeError(data.error, data.errorCode || 'UPSTREAM');
  }

  return data;
}
