/**
 * Google Sheets writer.
 *
 * Writes tracking data back to ANY Google Sheet via the central Apps Script.
 * The Apps Script is deployed once from the Ortus master sheet but can
 * update any sheet the deploying Google account has edit access to.
 *
 * The sheetId is extracted from whatever Google Sheet URL the campaign uses.
 */

import { extractSheetId, extractSheetGid } from './utils.js';
import { SHEETS_WEBAPP_URL } from './sheets-webapp-url.js';
import { onWebappLane } from './webapp-lane.js';

// Shared default or independently owned bridge from sheets-webapp-url.js.
// Function form preserved so the existing call sites don't have to change.
const getWebAppUrl = () => SHEETS_WEBAPP_URL;

// v2.58.x: per-operator timezone. Set once at campaign start by campaign.js
// (reads the launcher's stored preference). Empty string means "no preference"
// and Apps Script falls back to Session.getScriptTimeZone() as before.
let _operatorTz = '';

export function setOperatorTz(tz) {
  _operatorTz = typeof tz === 'string' ? tz : '';
}

// A transient write error is a network/timeout/5xx-class failure that a retry
// can plausibly fix — as opposed to a permanent one (auth, row-not-found, bad
// request) where retrying just wastes time. The Apps Script write actions are
// idempotent (they set fixed cell values), so retrying a transient failure is
// safe — at worst it re-stamps the same value (and may add a duplicate Audit
// Log row, which is harmless).
//
// 2026-08-12: `simultane` was added after a run logged 270 permanent-classified
// failures reading "Troppe chiamate simultanee: Fogli di lavoro" ("Too many
// simultaneous invocations: Spreadsheets"). That is Google shedding load, i.e.
// the most retryable error there is — but it matched nothing here, so every one
// of those rows was dropped without a single retry. The stem covers both the
// English and Italian wording the bridge returns.
const _TRANSIENT_WRITE_RE =
  /timeout|abort|ECONN|EAI_AGAIN|socket|network|fetch failed|terminated|simultane|\b(429|500|502|503|504)\b/i;

export function isTransientWriteError(msg) {
  return _TRANSIENT_WRITE_RE.test(String(msg || ''));
}

/**
 * Retry an idempotent write attempt across transient failures.
 *
 * `attemptFn(attempt)` returns the bridge result object. A result with no
 * `.error` (including `null`, meaning no webapp configured) is success and is
 * returned immediately. A result whose `.error` is permanent (auth, not-found)
 * is also returned immediately — retrying won't help. Only transient errors
 * are retried, up to `maxAttempts`, with linear backoff (baseDelayMs × attempt).
 * `sleep` is injectable so tests don't actually wait.
 */
export async function withWriteRetry(attemptFn, {
  maxAttempts = 3,
  baseDelayMs = 1000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await attemptFn(attempt);
    if (!result || !result.error) return result;        // success (or no-op)
    if (!isTransientWriteError(result.error)) return result; // permanent — don't retry
    if (attempt < maxAttempts) {
      log(`transient write error (attempt ${attempt}/${maxAttempts}): ${result.error} — retrying`);
      await sleep(baseDelayMs * attempt);
    }
  }
  return result; // exhausted retries — return last (transient) error
}

// Per-leg timeout on the POST and its 302-redirect follow. Raised 15s → 60s.
// A client abort cancels nothing: the Apps Script execution keeps running
// server-side, so the old 15s cutoff didn't reduce load, it just guaranteed the
// caller never saw the result and retried — turning one logical write into two
// or three concurrent executions. 60s clears both measured ceilings: the web
// app cold-starts in 28–58s, and a warm 25-row bulk chunk lands in ~8s
// (measured 2026-08-12 against the live deployment).
const WEBAPP_TIMEOUT_MS = 60000;

// One POST attempt to the Apps Script web app. Returns the parsed result or
// an { error } object; never throws. Wrapped by postToWebApp's retry loop.
async function _postOnce(url, body) {
  try {
    // Apps Script returns 302 on POST. Node fetch converts POST→GET on
    // redirect, hitting doGet() instead of doPost(). Handle manually.
    // P-05 fix (2.8.18): 15s timeout on both legs of the redirect chain.
    // Without it, an Apps Script hang stalls the campaign loop indefinitely.
    const initial = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS),
    });

    let res;
    if (initial.status >= 300 && initial.status < 400) {
      const location = initial.headers.get('location');
      res = await fetch(location, { signal: AbortSignal.timeout(WEBAPP_TIMEOUT_MS) });
    } else {
      res = initial;
    }

    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { error: `Sheets service access denied (HTTP ${res.status}). Restore the deployment's access or configure your own Sheets bridge.` };
    }
    if (res.status >= 400) {
      return { error: `Sheets service returned HTTP ${res.status}` };
    }
    try {
      return JSON.parse(text);
    } catch {
      // Sometimes the response is HTML (Google login page) — means auth issue
      if (text.includes('accounts.google.com') || text.includes('Sign in')) {
        console.warn('[sheets-writer] Apps Script returned login page — redeployment may be needed');
        return { error: 'Authentication error — redeploy the Apps Script' };
      }
      return { error: `Sheets service returned a non-JSON response (HTTP ${res.status}); check the deployment and its access settings.` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * POST to the Apps Script web app, retrying transient (timeout/network)
 * failures so a one-off Google-side latency spike doesn't permanently drop a
 * row's write (the bug behind "Kyra's row never got written").
 */
async function postToWebApp(payload) {
  const url = getWebAppUrl();
  if (!url) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — skipping');
    return null;
  }

  // v2.58.x: attach tz so GAS can stamp dateLastAction in the launcher's
  // local time. GAS uses `data.tz || Session.getScriptTimeZone()` so older
  // GAS deployments (pre-paste) silently ignore this field.
  const enriched = _operatorTz ? { ...payload, tz: _operatorTz } : payload;
  const body = JSON.stringify(enriched);

  // 4 attempts / 1.5s base mirrors the cloud engine's pushRows. The first
  // attempt against a cold web app can burn its whole 30s and still warm the
  // instance, so the extra attempt is what turns a cold start into a success
  // instead of a dropped row.
  const result = await withWriteRetry(() => onWebappLane(() => _postOnce(url, body)), {
    maxAttempts: 4,
    baseDelayMs: 1500,
    log: (m) => console.warn(`[sheets-writer] ${m}`),
  });

  if (result && result.error) {
    console.warn(`[sheets-writer] POST failed: ${result.error}`);
  }
  return result;
}

/**
 * Ensures tracking columns exist in the target sheet.
 * Call once at campaign start.
 *
 * @param {string} sheetUrl - Any Google Sheet URL
 */
export async function ensureTrackingColumns(sheetUrl, mode) {
  if (!getWebAppUrl()) return false;

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  console.log(`[sheets-writer] Ensuring tracking columns on sheet ${sheetId}${mode ? ` (mode: ${mode})` : ''}…`);

  const result = await postToWebApp({
    action: 'ensureColumns',
    sheetId,
    gid: gid || '',
    mode: mode || '',
  });

  if (result?.success) {
    console.log(`[sheets-writer] ✓ Columns ready. ${result.added?.length ? 'Added: ' + result.added.join(', ') : 'All existed.'}`);
    return true;
  }

  if (result?.error) {
    console.warn(`[sheets-writer] ensureColumns failed: ${result.error}`);
  }
  return false;
}

/**
 * v2 schema: provision per-mode columns and hide non-relevant mode columns.
 * Called once at campaign start (replaces ensureTrackingColumns for v2 sheets).
 *
 * @param {string} sheetUrl - any Google Sheet URL
 * @param {string} mode - one of connect_only | check_status | message_only |
 *                        introduce_back | open_profile_only | inmail_only
 * @returns {Promise<{ ok: boolean, added: string[], hidden: string[], shown: string[] }>}
 *          ok=true when the bridge confirmed the prepareSheet call.
 *          Returns { ok: false } silently if SHEETS_WEBAPP_URL isn't set so
 *          local-dev runs without bridge config continue to work.
 */
export async function prepareSheet(sheetUrl, mode) {
  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — prepareSheet skipped');
    return { ok: false, added: [], hidden: [], shown: [] };
  }

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  console.log(`[sheets-writer] prepareSheet(${mode}) on sheet ${sheetId}…`);

  const result = await postToWebApp({
    action: 'prepareSheet',
    sheetId,
    gid: gid || '',
    mode: mode || ''
  });

  if (result?.success) {
    if (result.added?.length) {
      console.log(`[sheets-writer] ✓ prepareSheet added: ${result.added.join(', ')}`);
    }
    if (result.hidden?.length) {
      console.log(`[sheets-writer] ✓ prepareSheet hidden: ${result.hidden.join(', ')}`);
    }
    return { ok: true, added: result.added || [], hidden: result.hidden || [], shown: result.shown || [] };
  }

  // Say WHY it didn't confirm — a non-JSON reply (Google error page) used to be
  // dropped silently, leaving only "didn't confirm" in the campaign log.
  const reason = result?.error
    || (result?.raw !== undefined ? `non-JSON reply (HTTP ${result.status}): ${String(result.raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}` : '')
    || (result ? `unexpected reply: ${JSON.stringify(result).slice(0, 200)}` : 'no reply');
  console.warn(`[sheets-writer] prepareSheet failed: ${reason}`);
  return { ok: false, added: [], hidden: [], shown: [], reason };
}

/**
 * Updates a single row's tracking data in the target sheet.
 *
 * @param {string} sheetUrl - The Google Sheet URL (any sheet)
 * @param {string} linkedinUrl - LinkedIn profile URL (used to find the row)
 * @param {object} tracking - Fields to update
 */
export async function updateSheetRow(sheetUrl, linkedinUrl, tracking, linkedinColumn) {
  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — skipping');
    return false;
  }
  return enqueueRowUpdate(sheetUrl, linkedinUrl, tracking, linkedinColumn);
}

// ── Row-update coalescing ──────────────────────────────────────────────────
// Every caller in the app writes one row per Apps Script execution. One
// measured campaign run made 3,293 such calls from a single laptop; 1,772 of
// them were lost. The writes themselves are fine — the call rate is what kills
// them. So updateSheetRow no longer POSTs: it drops the row into a per-sheet
// buffer that flushes as a single `updateRows` execution carrying up to 100
// rows. Callers are unchanged and still get their own true/false back, because
// the Apps Script returns a per-row result index-aligned with what we sent.
//
// The buffer is keyed by (sheetId, gid, urlColumnName) — the three things that
// decide which cells a row resolves to. Rows destined for different tabs or
// matched on different URL columns can never share an execution.
// 100, same as the cloud engine's BULK_CHUNK — the two must not drift.
//
// Measured against the live deployment 2026-08-12, before and after the
// handleUpdateRows fix that hoists the URL-column read out of the per-lead
// loop:  100 rows  40.7s → 3.8s,  25 rows  8.4s → 4.2s. Per-row cost is now
// flat, so the chunk size is bounded by the execution's own ceiling rather
// than by a scan that grew with it. These timings are for rows that resolve
// to no sheet row, so they exclude the per-row write itself; the engine has
// run 100-row chunks of real writes against this same script under a 30s
// timeout, and this side allows 60s.
const BULK_CHUNK = 100;
const COALESCE_MS = 300;              // max added latency for a lone write

const _rowBuffers = new Map();        // key -> { sheetId, gid, col, items, timer }
const _pendingFlushes = new Set();    // in-flight flush promises, for flushSheetWrites()

// An Apps Script deployment older than the `updateRows` action routes it to the
// `default:` branch — handleUpdateRow — which rejects the bulk payload with
// "linkedinUrl is required". That exact string is the "this deployment is old"
// signal, and it makes the chunk fall back to per-row writes rather than lose
// the rows. (Verified 2026-08-12: the live deployment DOES support updateRows.)
function _isUnsupportedBulk(err) {
  return /linkedinUrl is required|Unknown action|updateRows/i.test(String(err || ''));
}

function enqueueRowUpdate(sheetUrl, linkedinUrl, tracking, linkedinColumn) {
  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl) || '';
  const col = linkedinColumn || '';
  const key = `${sheetId}|${gid}|${col}`;

  let buf = _rowBuffers.get(key);
  if (!buf) {
    buf = { sheetId, gid, col, items: [], timer: null };
    _rowBuffers.set(key, buf);
  }

  const settled = new Promise((resolve) => {
    buf.items.push({ row: { linkedinUrl, ...tracking }, resolve });
  });

  if (buf.items.length >= BULK_CHUNK) {
    _flushBuffer(key);
  } else if (!buf.timer) {
    // Armed once, on the first row of a buffer — never re-armed by later rows.
    // A steady stream therefore still flushes every COALESCE_MS instead of
    // being starved by its own arrivals.
    buf.timer = setTimeout(() => _flushBuffer(key), COALESCE_MS);
  }
  return settled;
}

function _flushBuffer(key) {
  const buf = _rowBuffers.get(key);
  if (!buf) return;
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  const items = buf.items;
  _rowBuffers.delete(key);
  if (!items.length) return;

  // ponytail: chunks within one flush are ordered, but two overlapping flushes
  // for the same key are not. Only matters if the same lead is written twice
  // inside COALESCE_MS, where the fields are additive anyway. Add a per-key
  // chain if that ever stops being true.
  const flush = (async () => {
    for (let i = 0; i < items.length; i += BULK_CHUNK) {
      await _writeChunk(buf, items.slice(i, i + BULK_CHUNK));
    }
  })();
  _pendingFlushes.add(flush);
  flush.finally(() => _pendingFlushes.delete(flush));
}

async function _writeChunk(buf, items) {
  const result = await postToWebApp({
    action: 'updateRows',
    sheetId: buf.sheetId,
    gid: buf.gid,
    urlColumnName: buf.col,
    rows: items.map((it) => it.row),
  });

  if (!result) {                                  // no webapp configured
    items.forEach((it) => it.resolve(false));
    return;
  }

  const err = result.error;
  if (err && _isUnsupportedBulk(err)) {
    console.warn('[sheets-writer] Apps Script has no bulk updateRows — falling back to per-row writes (redeploy for the 100× saving)');
    for (const it of items) it.resolve(await _writeOneRow(buf, it.row));
    return;
  }

  if (err || !result.success) {
    // The whole execution failed after its retries. Say so loudly and name the
    // count: 1,772 rows once vanished here with nothing but a per-row warning
    // scrolling past, which is how a >50% loss rate went unnoticed for months.
    console.warn(`[sheets-writer] ✗ LOST ${items.length} row write(s) for sheet ${buf.sheetId}: ${err || 'no success flag'}`);
    items.forEach((it) => it.resolve(false));
    return;
  }

  // results[i] mirrors rows[i]. A missing entry means the script didn't report
  // per-row detail, in which case the chunk is all-or-nothing — and it said
  // success. Same reading as the engine's pushRows.
  const results = Array.isArray(result.results) ? result.results : [];
  let failed = 0;
  items.forEach((it, i) => {
    const one = results[i];
    const ok = !one || !one.error;
    if (!ok) {
      failed++;
      console.warn(`[sheets-writer] row not written (${it.row.linkedinUrl}): ${one.error}`);
    }
    it.resolve(ok);
  });
  console.log(`[sheets-writer] ✓ ${items.length - failed}/${items.length} row(s) updated in sheet ${buf.sheetId}${failed ? ` — ${failed} not found` : ''}`);
}

// The pre-coalescing write path, kept only for old Apps Script deployments.
async function _writeOneRow(buf, row) {
  const { linkedinUrl, ...tracking } = row;
  const result = await postToWebApp({
    action: 'updateRow',
    sheetId: buf.sheetId,
    gid: buf.gid,
    linkedinUrl,
    urlColumnName: buf.col,
    ...tracking,
  });
  if (result?.success) return true;
  if (result?.error) console.warn(`[sheets-writer] Update failed for ${linkedinUrl}: ${result.error}`);
  return false;
}

// One updateRows POST carries at most this many rows. The POST aborts at 15s
// (_postOnce) and the Apps Script rescans the URL column per row, so a single
// 700-row request would time out and lose the whole batch.
// ponytail: fixed size, no adaptive tuning — raise it if real batches finish fast.
const UPDATE_ROWS_CHUNK = 100;

/**
 * Batched sibling of updateSheetRow: stamps many rows through ONE Apps Script
 * call per chunk (`action:'updateRows'` → handleUpdateRows), instead of one
 * lock-holding POST per row. handleUpdateRows replies
 * `{ success, results:[ {ok:true,row,…} | {error} ] }` index-aligned with the
 * rows sent, so one missing lead never fails the rest of the batch.
 *
 * @param {string} sheetUrl - The Google Sheet URL (any sheet)
 * @param {Array<{linkedinUrl:string}>} rows - one entry per row: the URL plus its tracking fields
 * @param {string} linkedinColumn - name of the URL column ('' → auto-detect)
 * @returns {Promise<{ok:number, total:number, failures:Array<{linkedinUrl:string,error:string}>}>}
 *          `failures` keeps per-row visibility: which rows did not stamp, and why.
 */
export async function updateSheetRows(sheetUrl, rows, linkedinColumn) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.linkedinUrl);
  const failures = [];
  if (!list.length) return { ok: 0, total: 0, failures };

  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL configured — skipping');
    return { ok: 0, total: list.length, failures: list.map((r) => ({ linkedinUrl: r.linkedinUrl, error: 'no SHEETS_WEBAPP_URL configured' })) };
  }

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  let ok = 0;

  for (let i = 0; i < list.length; i += UPDATE_ROWS_CHUNK) {
    const chunk = list.slice(i, i + UPDATE_ROWS_CHUNK);
    const result = await postToWebApp({
      action: 'updateRows',
      sheetId,
      gid: gid || '',
      urlColumnName: linkedinColumn || '',
      rows: chunk,
    });
    const results = (result && Array.isArray(result.results)) ? result.results : null;
    if (!results) {
      // Whole-chunk failure (network, auth, no URL column) — every row in it is unstamped.
      const error = (result && result.error) || 'no results returned by the sheets bridge';
      console.warn(`[sheets-writer] updateRows failed for ${chunk.length} row(s): ${error}`);
      for (const r of chunk) failures.push({ linkedinUrl: r.linkedinUrl, error });
      continue;
    }
    chunk.forEach((r, j) => {
      const res = results[j];
      if (res && res.ok) ok += 1;
      else failures.push({ linkedinUrl: r.linkedinUrl, error: (res && res.error) || 'no result returned for this row' });
    });
  }

  console.log(`[sheets-writer] updateRows stamped ${ok}/${list.length} row(s) in sheet ${sheetId}`);
  return { ok, total: list.length, failures };
}

/**
 * Write out every buffered row and wait for it to land. Call at the end of a
 * campaign, and before the process exits — otherwise the last partial buffer
 * dies with up to COALESCE_MS of writes still in it.
 */
export async function flushSheetWrites() {
  for (const key of [..._rowBuffers.keys()]) _flushBuffer(key);
  while (_pendingFlushes.size) {
    await Promise.allSettled([..._pendingFlushes]);
  }
}

/**
 * Phase 11.3 — reads the Reply tracking columns for a single row.
 * Used by check-dms.js's non-destructive writeback: if the row already has
 * Reply="yes" we skip re-writing (preserves manual operator edits).
 *
 * Returns { Reply, ReplyAt, ReplyPreview } on hit, null if row not found or
 * webapp not configured. The Apps Script's `getRowStatus` action must return
 * { success: true, row: { Reply, ReplyAt, ReplyPreview }, ... } for a match.
 *
 * @param {string} sheetUrl - The Google Sheet URL
 * @param {string} linkedinUrl - LinkedIn profile URL
 * @param {string} linkedinColumn - name of the URL column
 * @returns {Promise<{Reply?: string, ReplyAt?: string, ReplyPreview?: string} | null>}
 */
export async function getSheetRowStatus(sheetUrl, linkedinUrl, linkedinColumn) {
  if (!getWebAppUrl()) return null;

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);

  const result = await postToWebApp({
    action: 'getRowStatus',
    sheetId,
    gid: gid || '',
    linkedinUrl,
    urlColumnName: linkedinColumn || '',
  });

  if (result?.success && result?.row) {
    return {
      Reply: result.row.Reply || result.row.reply || '',
      ReplyAt: result.row['Reply At'] || result.row.replyAt || '',
      ReplyPreview: result.row['Reply Preview'] || result.row.replyPreview || '',
    };
  }

  // Row not found or error → treat as "no status" so caller can write freely.
  return null;
}

/**
 * 2.9.7: Append one inbound message to the Replies tab. Bridge dedupes on
 * (leadUrl, timestamp) so re-polls are idempotent. Schema columns are
 * First Name | Last Name | Body (Lead URL + Timestamp hidden for dedup).
 *
 * @param {string} sheetUrl
 * @param {object} reply { leadUrl, timestamp, firstName, lastName, body }
 * @returns {Promise<boolean>}
 */
export async function appendReplyRow(sheetUrl, reply) {
  if (!getWebAppUrl()) {
    console.log('[sheets-writer] No SHEETS_WEBAPP_URL — skipping Replies append');
    return false;
  }
  // 2.9.7: dedup is now (leadUrl, body), not (leadUrl, timestamp).
  // Timestamp can be empty when LinkedIn's DOM doesn't expose a <time>
  // element for that message — that's fine, body is the dedup key.
  if (!reply?.leadUrl || !reply?.body) {
    console.warn('[sheets-writer] appendReplyRow: leadUrl + body required');
    return false;
  }
  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  const result = await postToWebApp({
    action: 'appendReply',
    sheetId,
    gid: gid || '',
    leadUrl: reply.leadUrl,
    timestamp: reply.timestamp,
    firstName: reply.firstName || '',
    lastName: reply.lastName || '',
    body: reply.body || '',
  });
  if (result?.success) {
    if (result.deduped) {
      console.log(`[sheets-writer] Replies row already exists (deduped) for ${reply.leadUrl}`);
    } else {
      console.log(`[sheets-writer] ✓ Appended Replies row ${result.row} for ${reply.leadUrl}`);
    }
    return true;
  }
  if (result?.error) {
    console.warn(`[sheets-writer] appendReply failed: ${result.error}`);
  }
  return false;
}

/**
 * Batch update multiple rows at once (more efficient for large campaigns).
 *
 * @param {string} sheetUrl - The Google Sheet URL
 * @param {Array<{linkedinUrl: string, [key: string]: string}>} updates
 */
/**
 * Dump the bulk-check's fetched connections into a sidecar tab on the same
 * sheet for transparency / manual matching. One tab per sender so multi-
 * account sweeps don't overwrite each other.
 *
 * v2.62: `activeSenders` scopes the tab to just the senders of the current
 * campaign. The Apps Script filters out rows whose Account isn't in the
 * list, so the tab acts as a per-campaign Bible — only connections from
 * accounts assigned in the sheet's Sender column survive a refresh.
 * Omit (legacy callers) → no filtering, current behavior preserved.
 */
// Why the last Recent Connections write was not confirmed, for the sweep log.
// The operator only sees campaign.log, never this process's stdout.
export let lastRecentConnectionsError = '';

export async function writeRecentConnectionsTab(sheetUrl, sender, connections, activeSenders) {
  lastRecentConnectionsError = '';
  if (!getWebAppUrl()) { lastRecentConnectionsError = 'no Sheets service configured'; return null; }
  const sheetId = extractSheetId(sheetUrl);
  try {
    const result = await postToWebApp({
      action: 'writeRecentConnections',
      sheetId,
      sender: sender || '',
      connections: connections || [],
      activeSenders: Array.isArray(activeSenders) ? activeSenders : [],
    });
    if (result?.ok) {
      console.log(`[sheets-writer] ✓ Wrote ${result.rows} row(s) to "${result.tab}" (accumulated: ${Array.isArray(result.accumulated) ? result.accumulated.length : 0})`);
      if (!Array.isArray(result.accumulated)) lastRecentConnectionsError = 'the Sheets service did not return the accumulated rows';
      return Array.isArray(result.accumulated) ? result.accumulated : null;
    }
    lastRecentConnectionsError = (result && result.error) ? String(result.error) : 'no confirmation from the Sheets service';
    if (result?.error) console.warn(`[sheets-writer] writeRecentConnections failed: ${result.error}`);
    return null;
  } catch (err) {
    lastRecentConnectionsError = err.message;
    console.warn(`[sheets-writer] writeRecentConnections threw: ${err.message}`);
    return null;
  }
}

/**
 * Wipe the "Recent Connections" tab clean (keeps the header row). Called once
 * at campaign start so the tab is a fresh per-campaign record. Best-effort —
 * returns false on any failure; a stale tab is non-fatal (active-sender
 * scoping still prevents foreign-account false positives).
 */
export async function clearRecentConnectionsTab(sheetUrl, accounts = null) {
  if (!getWebAppUrl()) return false;
  const sheetId = extractSheetId(sheetUrl);
  try {
    // `accounts`: clear only these accounts' rows. The tab is shared by every
    // campaign tab in the workbook, so a campaign starting on one tab must not
    // wipe the record the others accumulated.
    const result = await postToWebApp({ action: 'clearRecentConnections', sheetId,
      ...(Array.isArray(accounts) && accounts.length ? { accounts } : {}) });
    if (result?.ok) {
      console.log('[sheets-writer] ✓ Cleared "Recent Connections" tab');
      return true;
    }
    if (result?.error) console.warn(`[sheets-writer] clearRecentConnections failed: ${result.error}`);
    return false;
  } catch (err) {
    console.warn(`[sheets-writer] clearRecentConnections threw: ${err.message}`);
    return false;
  }
}

/**
 * v2.72: Dump inbound replies (1:1 threads only, last message only) into a
 * shared "Recent Messages" sidecar tab — the reply-check counterpart of
 * writeRecentConnectionsTab. Each call refreshes only THIS account's rows so
 * the latest last-message wins. `messages` items: { account, name,
 * lastMessage, receivedAt, matched }. Requires the Apps Script's
 * `writeRecentMessages` handler (redeploy needed). Best-effort.
 */
export async function writeRecentMessagesTab(sheetUrl, sender, messages, activeSenders) {
  if (!getWebAppUrl()) return null;
  const sheetId = extractSheetId(sheetUrl);
  try {
    const result = await postToWebApp({
      action: 'writeRecentMessages',
      sheetId,
      sender: sender || '',
      messages: messages || [],
      activeSenders: Array.isArray(activeSenders) ? activeSenders : [],
    });
    if (result?.ok) {
      console.log(`[sheets-writer] ✓ Wrote ${result.rows} row(s) to "${result.tab}"`);
      return true;
    }
    if (result?.error) console.warn(`[sheets-writer] writeRecentMessages failed: ${result.error}`);
    return null;
  } catch (err) {
    console.warn(`[sheets-writer] writeRecentMessages threw: ${err.message}`);
    return null;
  }
}

export async function batchUpdateSheet(sheetUrl, updates, { requireConfirmation = false } = {}) {
  if (!getWebAppUrl() || !updates.length) return false;

  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);

  // Chunked at 100 like everything else. The one caller that matters here is
  // the Needs Login flag, which builds one update per row assigned to an
  // account — thousands on a big sheet, previously posted as a single payload
  // that had to finish inside one Apps Script execution or lose the lot.
  let processed = 0;
  let allOk = true;
  let failureReason = '';
  for (let i = 0; i < updates.length; i += BULK_CHUNK) {
    const chunk = updates.slice(i, i + BULK_CHUNK);
    const result = await postToWebApp({
      action: 'batchUpdate',
      sheetId,
      gid: gid || '',
      updates: chunk,
    });
    if (result?.success) {
      const failedRows = Array.isArray(result.results) ? result.results.filter((row) => row.error) : [];
      // A row the script matched but wrote nothing to means every requested
      // field lacked a column on this tab. The script still calls that a
      // success, so say it here or the loss is invisible.
      const silentRows = Array.isArray(result.results) ? result.results.filter((row) => !row.error && Array.isArray(row.updated) && row.updated.length === 0) : [];
      if (silentRows.length) console.warn(`[sheets-writer] ⚠ ${silentRows.length} matched row(s) had no column to receive the update on sheet ${sheetId} — are the tracking columns provisioned?`);
      if (requireConfirmation && failedRows.length) {
        allOk = false;
        failureReason = `${failedRows.length} row(s) failed: ${failedRows[0].error}`;
      }
      processed += typeof result.processed === 'number' ? result.processed : chunk.length;
      continue;
    }
    allOk = false;
    failureReason = result?.error || 'no success flag';
    console.warn(`[sheets-writer] ✗ LOST batch rows ${i + 1}–${i + chunk.length} for sheet ${sheetId}: ${result?.error || 'no success flag'}`);
  }

  if (processed) {
    console.log(`[sheets-writer] ✓ Batch updated ${processed} rows in sheet ${sheetId}`);
  }
  if (!allOk && requireConfirmation) {
    throw new Error(`Sheet updates were not all confirmed: ${failureReason}`);
  }
  return allOk;
}
