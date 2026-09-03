/**
 * Writes account status back to the State of Operations (SoO) "LinkedIn
 * Accounts" board. Companion to src/soo.js (which only READS the SoO).
 *
 * Two one-way, best-effort writes (see the 2026-06-12 spec):
 *   - flipAccountInUse():        credit cell Available -> In Use + operator email
 *   - markAccountNeedsLoginSoO(): the account's "Needs Login" cell -> 'Y'
 *
 * Every export is best-effort and NEVER throws to the caller. A failure (kill
 * switch off, no email, network error, 503, no matching row) resolves to a
 * result object — outreach must never depend on it.
 */
import { SHEETS_WEBAPP_URL, SOO_SHEET_ID, SOO_SHEET_GID } from './sheets-webapp-url.js';
import { onWebappLane } from './webapp-lane.js';

// 30s PER HOP. It used to be 10s SHARED across both hops of the
// POST-then-follow-the-302 dance — less than a cold Apps Script container's
// warm-up, hence the intermittent "The operation was aborted due to timeout"
// on the In Use flip. 30s is the engine's number (campaign-soo-writer.js),
// measured against this same webapp: it cold-starts in 28-58s.
const SOO_WRITE_TIMEOUT_MS = 30_000;

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The connection-request modes. A 'connection_sent' in any of these consumes a
// CC (connection) credit. open_profile_only is intentionally not here (it never
// writes to the SoO). inmail_only is also not here — it has its own branch below.
const CONNECT_MODES = new Set([
  'connect_only',
  'connect_and_introduce',
  'connect_and_message',
]);

// SoO header for the per-account weekly connection tally (column AX on the
// board). Matched by header text in the Apps Script — must equal the sheet
// header EXACTLY. The count is accumulated + weekly-reset server-side.
export const SOO_CONN_WEEK_HEADER = 'Number of Connections (this week)';

/**
 * The send `action` a cloud campaign of this mode will produce — the cloud side
 * has no per-send hook, so it has to name the action up front to ask
 * resolveSoOTarget which column to flip. Returns '' for modes that write nothing.
 *
 * Shared by the dispatch-time flip (server.js) and the reconcile-time retry
 * (cloud-soo-reconcile.js) so the two can never disagree about which cloud modes
 * touch the SoO.
 */
export function cloudFlipAction(mode) {
  return ({
    connect_only: 'connection_sent',
    connect_and_introduce: 'connection_sent',
    connect_and_message: 'connection_sent',
    inmail_only: 'inmail_sent',
    open_profile_only: 'message_sent',
  })[mode] || '';
}

/**
 * True when this send is a connection request that should tick the weekly
 * connection tally — i.e. a 'connection_sent' in one of the connect modes
 * (CC / CC+IC / CC+DM). Mirrors the CONNECT_MODES gate used for credit flips.
 */
export function isConnectSend(mode, action) {
  return action === 'connection_sent' && CONNECT_MODES.has(mode);
}

/**
 * Pure mapping. Given the campaign mode and the send result's action, return
 * the SoO credit column to flip + its paired User column, or null for "no
 * write". Keyed on the action (what was actually sent) AND gated by mode so
 * open_profile_only writes nothing — even if it falls back to InMail (OP mode is excluded from this map entirely).
 * @returns {{creditHeader: string, userHeader: string}|null}
 */
export function resolveSoOTarget(mode, action) {
  if (action === 'connection_sent' && CONNECT_MODES.has(mode)) {
    // Stamp the reserver into the unprotected fallback column 'CC App User'
    // (column AJ on the SoO board), NOT the protected 'CC User' (writes to the
    // protected column throw inside the Apps Script setSoO handler). The Apps
    // Script matches the column by header name, so this MUST equal the sheet
    // header EXACTLY — verified 2026-06-16 via a dry-run that printed
    // `column AJ (#36) header = "CC App User"`. An earlier guess of
    // 'CC User App' silently matched no column, so nothing was ever stamped.
    return { creditHeader: 'CC (Credits)', userHeader: 'CC App User' };
  }
  if (action === 'inmail_sent' && mode === 'inmail_only') {
    return { creditHeader: 'Inmail Credits', userHeader: 'Inmail User' };
  }
  // Message Campaign (open_profile_only): a genuine Open-Profile message uses the
  // Linkedin OP channel, so flip Linkedin (OP Credits) [AD] + stamp Linkedin OP
  // User [AE]. Reverses the earlier "OP writes nothing" stance per the operator
  // (2026-06-19): the credit column MUST reflect that the account was used. The
  // InMail fallback path (action 'inmail_sent' in OP mode) is left untouched.
  if (mode === 'open_profile_only' && (action === 'op_message_sent' || action === 'message_sent')) {
    return { creditHeader: 'Linkedin (OP Credits)', userHeader: 'Linkedin OP User' };
  }
  return null;
}

// ── Fuzzy account → SoO row resolution ──────────────────────────────────────
// GoLogin profile labels and SoO Email cells drift apart in practice: a stray
// space, a trailing-dot typo, ".solution" vs ".solutions". An exact match drops
// those on the floor silently. We resolve the GoLogin label to the closest SoO
// Email BEFORE the write — but only when it is UNAMBIGUOUS. Identity is exactly
// where a wrong guess reserves the wrong person's account, so this is
// skip-on-doubt: a near-tie between two candidates resolves to null, never a coin
// flip. The caller then sends the raw label (clean no-match) rather than guessing.

/** lowercase, trim, drop ALL whitespace. Dots are kept — a.b@ ≠ ab@ as logins. */
function normAccount(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, '');
}

/** Levenshtein edit distance (iterative two-row, O(n·m) time, O(n) space). */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Similarity in [0,1]: 1 = identical, 0 = nothing in common. */
function similarity(a, b) {
  if (!a && !b) return 1;
  const max = Math.max(a.length, b.length) || 1;
  return 1 - levenshtein(a, b) / max;
}

/**
 * Resolve a GoLogin account label to a SoO Email, fuzzily but safely.
 *  - An exact (normalized) match always wins.
 *  - Otherwise the single best candidate at or above `threshold` wins ONLY if it
 *    is unambiguous: the runner-up must trail by at least `gap`. A near-tie
 *    returns { ambiguous: true } so the caller can refuse + log, never misfire.
 * @param {string}   accountName  the GoLogin profile label
 * @param {string[]} sooEmails    SoO Email-column values
 * @returns {{email:string, exact:boolean, score:number}|{ambiguous:true, score:number}|null}
 */
export function resolveSoOEmail(accountName, sooEmails, { threshold = 0.93, gap = 0.06 } = {}) {
  const want = normAccount(accountName);
  if (!want) return null;
  const cands = [];
  for (const raw of (sooEmails || [])) {
    const norm = normAccount(raw);
    if (norm) cands.push({ raw, norm });
  }
  for (const c of cands) {
    if (c.norm === want) return { email: c.raw, exact: true, score: 1 };
  }
  let best = null, second = null;
  for (const c of cands) {
    const score = similarity(want, c.norm);
    if (!best || score > best.score) { second = best; best = { raw: c.raw, score }; }
    else if (!second || score > second.score) { second = { raw: c.raw, score }; }
  }
  if (!best || best.score < threshold) return null;
  if (second && (best.score - second.score) < gap) {
    return { ambiguous: true, score: best.score };
  }
  return { email: best.raw, exact: false, score: best.score };
}

/**
 * Ortus Basics 1.0: the SoO is never written to. Campaign results go straight to
 * the campaign sheet (src/sheets-writer.js), which is untouched by this.
 *
 * Forced off rather than deleted because every writer below already returns
 * `{ ok:false, disabled:true }` through this one gate — flipping it here stops
 * the In Use flip, the weekly-connections bump and the needs-login stamp in a
 * single place, and the same gate covers src/cloud-soo-reconcile.js.
 * (was: enabled unless ORTUS_SOO_WRITEBACK is off/0/false)
 */
export function sooWritebackEnabled() {
  return false;
}

// Shared/admin logins that must NEVER be stamped as an individual reserver.
// The shared DASHBOARD_USERS credential (and the ADMIN_EMAILS notification
// addresses) collapse multiple operators onto one identity, so stamping it
// would label every reservation as Antonio — exactly what we must avoid.
const ALWAYS_BLOCKED_STAMP_EMAILS = ['ortus@ortusclub.com', 'antonio@ortusclub.com'];

/**
 * Build the lowercased set of emails that must not be stamped as a reserver:
 * the hardcoded admin/shared addresses + every login parsed out of the shared
 * DASHBOARD_USERS ("email:pass,email:pass") + the ADMIN_EMAILS list.
 */
export function blockedOperatorEmails(env = process.env) {
  const out = new Set(ALWAYS_BLOCKED_STAMP_EMAILS);
  String(env.DASHBOARD_USERS || '')
    .split(',')
    .map((pair) => pair.split(':')[0].trim().toLowerCase())
    .filter(Boolean)
    .forEach((e) => out.add(e));
  String(env.ADMIN_EMAILS || 'antonio@ortusclub.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .forEach((e) => out.add(e));
  return out;
}

/**
 * Normalize the operator email for stamping, dropping it (→ '') when blank or
 * when it's a shared/admin login. buildFlipPayload then omits the user cell, so
 * a shared login leaves the reserver blank rather than mislabelling it.
 * Preserves original case for the stamp; the block check is case-insensitive.
 */
export function resolveStampEmail(operatorEmail, blocked = blockedOperatorEmails()) {
  const trimmed = String(operatorEmail || '').trim();
  if (!trimmed) return '';
  if (blocked.has(trimmed.toLowerCase())) return '';
  return trimmed;
}

/**
 * Decide which email to stamp as the reserver. The per-machine operator email
 * (operator-identity.js) is AUTHORITATIVE and used verbatim — it's the explicit
 * "who is at this keyboard", so it's never blocked (an operator may legitimately
 * set antonio@ on Antonio's own machine). Only when it's unset do we fall back
 * to the login email, which still blank-stamps the shared/admin credential so a
 * shared login never mislabels every reservation as one person.
 */
export function resolveOperatorStamp({ perMachineEmail, loginEmail, blocked = blockedOperatorEmails() } = {}) {
  const pm = String(perMachineEmail || '').trim();
  if (pm) return pm;
  return resolveStampEmail(loginEmail, blocked);
}

/** Build the setSoO payload for an "In Use" flip (credit + paired user, guarded). */
export function buildFlipPayload({ email, creditHeader, userHeader, operatorEmail }) {
  const fields = { [creditHeader]: 'In Use' };
  if (operatorEmail) fields[userHeader] = operatorEmail;
  return {
    sheetId: SOO_SHEET_ID,   // satisfies the Apps Script router's required field
    gid: SOO_SHEET_GID,      // router resolves the LinkedIn Accounts tab by gid
    action: 'setSoO',
    email,
    fields,
    guardAvailableFor: [creditHeader],
    // Write-once: the operator stamp is sticky. Once a name is in "CC App User"
    // it is never overwritten by a later run — only a human clearing the cell
    // frees it to be re-stamped. Passover/reset does NOT clear it.
    guardWriteOnceFor: [userHeader],
  };
}

/**
 * Build the payload for a server-side weekly connection-count increment. The
 * Apps Script (action 'bumpSoOConnections') accumulates the delta into the
 * "Number of Connections (this week)" cell and resets it to `delta` on the
 * first write of a new ISO week — so the app only ever reports what THIS send
 * added and never has to remember a weekly total.
 */
export function buildBumpConnectionsPayload({ email, delta = 1 }) {
  return {
    sheetId: SOO_SHEET_ID,
    gid: SOO_SHEET_GID,
    action: 'bumpSoOConnections',
    email,
    delta,
    header: SOO_CONN_WEEK_HEADER,
  };
}

/** Build the setSoO payload for a Needs Login flag (no guard). */
export function buildNeedsLoginPayload({ email }) {
  return {
    sheetId: SOO_SHEET_ID,
    gid: SOO_SHEET_GID,
    action: 'setSoO',
    email,
    fields: { 'Needs Login': 'Y' },
    guardAvailableFor: [],
  };
}

// One attempt: POST, then follow the 302 by hand (node fetch would downgrade
// the redirected POST to a GET).
async function postOnce(payload) {
  // Queued behind every other Apps Script POST this process makes. setSoO and
  // bumpSoOConnections both take a GLOBAL LockService lock inside the script,
  // so two of these in flight at once don't just risk the simultaneous-
  // invocation limit — the second one sits burning its 10s waitLock.
  return onWebappLane(() => _postOnceOnLane(payload));
}

async function _postOnceOnLane(payload) {
  // A FRESH signal per hop — the redirect follow gets its own full budget, the
  // way every other webapp caller here does it (soo.js:93, sheets.js:288,
  // sheets-writer.js:88, log-writer.js:232). Sharing one signal meant the
  // second hop inherited whatever was left of the first, and since Apps Script
  // answers every POST with a 302 there is ALWAYS a second hop.
  const initial = await fetch(SHEETS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(SOO_WRITE_TIMEOUT_MS),
  });
  let response = initial;
  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get('location');
    if (!location) throw new Error('redirect with no Location header');
    response = await fetch(location, { signal: AbortSignal.timeout(SOO_WRITE_TIMEOUT_MS) });
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * A transient failure is one a retry can fix — timeout, socket/DNS, 5xx, 429.
 * A permanent one (auth, bad request, a script-level rejection) returns
 * immediately, because retrying it only multiplies the latency.
 *
 * Mirror of the engine's campaign-soo-writer.isTransientWriteError /
 * campaign-sheet-writer's copy. The engine deliberately keeps its own local
 * copy so its files apply in any order; keep this regex in sync with those.
 */
const TRANSIENT_RE = /timeout|abort|ECONN|EAI_AGAIN|socket|network|fetch failed|terminated|\b(429|500|502|503|504)\b/i;
export function isTransientSoOError(err) {
  const msg = err && (err.message || err);
  return TRANSIENT_RE.test(String(msg || ''));
}

// Actions whose payload is IDEMPOTENT — it sets fixed cells, server-side guarded,
// so re-sending it after an ambiguous failure is a no-op rather than a double
// write. Only these may be retried.
//
// 'bumpSoOConnections' is deliberately NOT here: it posts a DELTA (+N) that the
// Apps Script accumulates. A timeout raised AFTER the script committed the write
// is indistinguishable from one raised before it, so retrying would inflate the
// weekly connection tally — real reporting data. It gets one attempt, and the
// cloud reconciler's durable "leave it uncounted, a later poll retries" is what
// makes that safe (src/cloud-soo-reconcile.js).
const IDEMPOTENT_ACTIONS = new Set(['setSoO']);

// POST a payload to the central Apps Script, retrying transient failures.
//
// 4 attempts, linear backoff — matching the engine's campaign-soo-writer, which
// was tuned against the live webapp: it cold-starts in 28-58s, so a single short
// attempt aborts every write while the container is warming. That measurement is
// why SOO_WRITE_TIMEOUT_MS is 30s per hop rather than the 10s this used to use.
async function postSetSoO(payload, { maxAttempts = 4, baseDelayMs = 1500, sleep = _sleep } = {}) {
  const attempts = IDEMPOTENT_ACTIONS.has(payload && payload.action) ? maxAttempts : 1;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await postOnce(payload);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isTransientSoOError(err)) break;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr;
}

/**
 * Flip an account's credit cell to "In Use" (server-side guarded to Available)
 * and stamp the operator email into the paired User cell. Best-effort.
 * @returns {Promise<object>} { ok, matched, written, skipped } or { ok:false, ... }
 */
export async function flipAccountInUse({ email, creditHeader, userHeader, operatorEmail }, retryOpts) {
  if (!sooWritebackEnabled()) return { ok: false, disabled: true };
  if (!email) return { ok: false, error: 'no email' };
  if (!creditHeader || !userHeader) return { ok: false, error: 'no headers' };
  try {
    // operatorEmail is already resolved by the caller (resolveOperatorStamp):
    // the per-machine operator identity, or a blanked shared login. Stamp verbatim.
    const data = await postSetSoO(buildFlipPayload({ email, creditHeader, userHeader, operatorEmail }), retryOpts);
    if (data && data.error) return { ok: false, error: data.error };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Increment the account's weekly connection tally in the SoO by `delta` (the
 * Apps Script accumulates + weekly-resets server-side). Best-effort; never
 * throws. Fires once per successful connection send ("live" write-back).
 * @returns {Promise<object>} { ok, matched, value, week, reset } or { ok:false, ... }
 */
export async function bumpConnectionsThisWeek({ email, delta = 1 }, retryOpts) {
  if (!sooWritebackEnabled()) return { ok: false, disabled: true };
  if (!email) return { ok: false, error: 'no email' };
  try {
    const data = await postSetSoO(buildBumpConnectionsPayload({ email, delta }), retryOpts);
    if (data && data.error) return { ok: false, error: data.error };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Set the account's "Needs Login" SoO cell to 'Y'. Best-effort. Never cleared
 * by the app (manual clear by the LinkedIn team).
 * @returns {Promise<object>} { ok, matched, written } or { ok:false, ... }
 */
export async function markAccountNeedsLoginSoO({ email }, retryOpts) {
  if (!sooWritebackEnabled()) return { ok: false, disabled: true };
  if (!email) return { ok: false, error: 'no email' };
  try {
    const data = await postSetSoO(buildNeedsLoginPayload({ email }), retryOpts);
    if (data && data.error) return { ok: false, error: data.error };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
