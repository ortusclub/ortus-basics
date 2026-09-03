/**
 * Cloud campaign engine client.
 *
 * Sibling of scraper-client.js. Where scraper-client.js dispatches Sales Nav
 * SCRAPES to the GKE engine, this module dispatches CAMPAIGNS (connect / intro /
 * DM / follower-growth) to the SAME engine's campaign API — so a campaign can
 * run in the cloud (survives the laptop closing) instead of on the operator's
 * Mac. It launches NO browser locally and bypasses the local campaign/
 * performOutreach path entirely.
 *
 * Same host + bearer token as the scraper (the campaign API is mounted on the
 * engine's frontend behind the same auth), so it reuses scraper-engine-url.js —
 * no separate endpoint/token to configure.
 *
 * Engine campaign API (server-side campaign-api.js):
 *   POST /api/campaign/start        { mode, name, owner, profileIds[], sheetUrl,
 *                                     dailyLimit, config{}, leads[{leadUrl,
 *                                     memberUrn, fullName}] }
 *   GET  /api/campaign/list?owner=
 *   GET  /api/campaign/:id
 *   POST /api/campaign/:id/stop[?pause=1]
 *
 * Like scraper-client.js, calls NEVER throw — they resolve to parsed JSON or an
 * { error } object so the dashboard can surface "engine not wired up yet" or a
 * transient failure without crashing the campaign flow.
 */

import { withWriteRetry } from './sheets-writer.js';
import { SCRAPER_ENGINE_URL, SCRAPER_ENGINE_TOKEN } from './scraper-engine-url.js';

const engineUrl = () => (process.env.SCRAPER_ENGINE_URL || SCRAPER_ENGINE_URL).replace(/\/+$/, '');
const engineToken = () => process.env.SCRAPER_ENGINE_TOKEN || SCRAPER_ENGINE_TOKEN;

// Control round-trips are quick; the engine runs the campaign async and the UI
// polls /api/campaign/:id for progress. 20s is generous.
const REQUEST_TIMEOUT_MS = 20000;

// Modes the cloud engine supports (mirror of campaign-runtime MODE_PLAN). Used
// to gate the "Run in cloud" toggle so unsupported modes stay local-only.
// 'message_only', 'inmail_only' and 'check_status' were REMOVED on 2026-08-06
// (retired product-wide — see RETIRED_MODES in public/js/campaign-modes.mjs).
// check_status here means the standalone CAMPAIGN; the cloud monitor sweep that
// checks acceptances for CC+IC / CC+DM is a different path and is untouched.
// Dropping them here
// is what makes handleStartCloud 400 them, so the VM half of the retirement
// needs no engine deploy. The engine still implements both; it just never gets
// asked. `open_profile_only` (Message Campaign) stays — it is the one the engine
// PR #4 actually fixed.
export const CLOUD_MODES = new Set([
  'connect_only',
  'introduce_back',
  'connect_and_introduce',
  'connect_and_message',
  'follower_growth',
  'open_profile_only',
]);

/** True when the engine URL is configured, so the UI can gate the cloud toggle. */
export function isCampaignEngineConfigured() {
  return !!engineUrl();
}

/** True when a given mode can run in the cloud today. */
export function isCloudMode(mode) {
  return CLOUD_MODES.has(String(mode || ''));
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = engineToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// One attempt; returns parsed JSON or { error }, never throws. 5xx/429 embed the
// status so withWriteRetry's transient detection retries them; 4xx are returned
// as-is (retrying won't help — it's a bad request).
async function requestOnce(method, path, body) {
  // Ortus Basics 1.0: cloud campaigns are discontinued, so nothing in this
  // module should touch the network. Short-circuiting here (rather than at each
  // caller) stops the followup poller, the board refresh and every control
  // round-trip from retrying an engine this build never uses — the source of
  // the "engine did not answer" spam and the "Can't reach the cloud engine"
  // banner. Sales Nav scrapes are unaffected: they go through
  // src/scraper-client.js, a different module against the same engine.
  return { error: 'Cloud campaigns are discontinued in this version' };
  /* eslint-disable no-unreachable */
  const base = engineUrl();
  if (!base) return { error: 'Campaign engine not configured (set SCRAPER_ENGINE_URL)' };
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (!res.ok) {
      const detail = parsed && parsed.error ? `: ${parsed.error}` : '';
      // Carry `reason` through. The handover routes refuse with a reason and no
      // `error` field ({ ok:false, reason:'sweep_in_flight' | 'not_local' |
      // 'not_resumable' }), and the caller has to tell those apart to say
      // anything honest to the operator.
      const reason = parsed && parsed.reason ? { reason: parsed.reason } : {};
      return { error: `HTTP ${res.status}${detail}`, status: res.status, ...reason };
    }
    return parsed;
  } catch (err) {
    return { error: err.message };
  }
}

// withWriteRetry's own wording says "transient write error", borrowed from the
// sheet writer and wrong here: these calls only read (list / status / stop).
// An operator reading "write error" in the log goes looking for data that was
// never being written (Sam, 1 Sep). Say what actually happened instead — the
// engine did not answer, and we are asking again — while keeping the attempt
// count and the real reason the helper already put in the message.
export function engineRetryLine(message) {
  return `[cloud] the engine did not answer ${String(message).replace(/^transient write error /, '')}`;
}

// Retry wrapper for IDEMPOTENT calls (list / status / stop).
function requestWithRetry(method, path, body) {
  return withWriteRetry(() => requestOnce(method, path, body), {
    maxAttempts: 3,
    baseDelayMs: 1000,
    log: (m) => console.warn(engineRetryLine(m)),
  });
}

/**
 * Start a campaign on the cloud engine.
 *
 * Single attempt (NO retry): starting a campaign is not idempotent — a retried
 * POST after a transient blip could create a duplicate. Pass a stable `id` to
 * make it idempotent if you need retries. The operator can re-click if it fails.
 *
 * @param {object}   c
 * @param {string}   c.mode         one of CLOUD_MODES
 * @param {string[]} c.profileIds   GoLogin accounts the campaign may drive
 * @param {Array}    c.leads        [{ leadUrl, memberUrn?, fullName? }]
 * @param {object}   [c.config]     mode templates/settings (connectionNote,
 *                                  ccDmBody, primaryName, primaryIntroBody,
 *                                  primaryUrl, introTitle, monthlyBudget, …)
 * @param {string}   [c.name]       display name
 * @param {string}   [c.owner]      operator id/email (walls off per-user views)
 * @param {string}   [c.sheetUrl]   source sheet (for reference/write-back)
 * @param {number}   [c.dailyLimit] per-account daily cap
 * @param {string}   [c.id]         optional stable id (idempotency)
 * @param {string}   [c.startAt]    ISO instant — engine holds it until then
 */
export function startCloudCampaign(c = {}) {
  const mode = String(c.mode || '');
  if (!isCloudMode(mode)) {
    return Promise.resolve({ error: `Mode "${mode}" can't run in the cloud yet.` });
  }
  const profileIds = (Array.isArray(c.profileIds) ? c.profileIds : []).filter(Boolean);
  if (!profileIds.length) return Promise.resolve({ error: 'No GoLogin accounts selected.' });
  const leads = (Array.isArray(c.leads) ? c.leads : [])
    .map((l) => ({
      leadUrl: (l.leadUrl || l.url || l.lead_url || '').trim(),
      memberUrn: l.memberUrn || l.member_urn || null,
      fullName: l.fullName || l.full_name || l.name || '',
      // Auto-routed modes pin each lead to its sender account.
      routeAccount: l.routeAccount || l.route_account || '',
      // The full source-sheet row → engine row_data, so intro templates can fill
      // {company}/{title}/etc. Without this, those variables render blank in the
      // 3-way intro (the engine's lead columns are never populated).
      row: l.row || l.row_data || {},
    }))
    .filter((l) => l.leadUrl);
  if (!leads.length) return Promise.resolve({ error: 'No leads to send (source sheet empty or unreadable).' });

  return requestOnce('POST', '/api/campaign/start', {
    id: c.id,
    mode,
    name: c.name || '',
    owner: c.owner || '',
    profileIds,
    sheetUrl: c.sheetUrl || '',
    dailyLimit: c.dailyLimit ?? 50,
    config: c.config || {},
    leads,
    // CC+IC: accounts this machine already knows are connected to the primary,
    // so the engine's per-campaign table starts with the truth instead of blank.
    ...(c.primaryConn && Object.keys(c.primaryConn).length ? { primaryConn: c.primaryConn } : {}),
    // Scheduled start (ISO). The engine parks the campaign in 'scheduled' and
    // fires it itself at that instant — this machine can be off. Omitted (or in
    // the past) → starts immediately, the pre-existing behaviour.
    ...(c.startAt ? { startAt: c.startAt } : {}),
  });
}

/** List cloud campaigns (optionally scoped to one operator). */
export function listCloudCampaigns(owner) {
  const q = owner ? `?owner=${encodeURIComponent(owner)}` : '';
  return requestWithRetry('GET', `/api/campaign/list${q}`);
}

/**
 * Cloud load: how many campaigns are drawing a runtime against the ceiling, and
 * the ordered ids of everything waiting for a slot.
 *
 * The queue is global — the board is filtered per operator, the cloud is not —
 * so a campaign's position comes from here and never from the board's own rows.
 */
export function getCloudCapacity() {
  return requestWithRetry('GET', '/api/campaign/capacity');
}

/**
 * Per-account block truth for a set of GoLogin profile ids: why each cannot
 * send, and when it could again. Feeds both the Waiting card and the Start
 * prompt, so the two can never disagree. Idempotent GET, so it retries
 * transient failures.
 */
export function getCloudPreflight(profileIds, dailyLimit) {
  const q = encodeURIComponent((profileIds || []).join(','));
  // dailyLimit is optional and the engine skips the daily-cap check without it.
  // Pass it whenever the caller knows it: the daily cap is the most common block
  // in prod, and an account that has spent it reads as "usable" otherwise.
  const dl = Number(dailyLimit) > 0 ? `&dailyLimit=${Math.floor(Number(dailyLimit))}` : '';
  return requestWithRetry('GET', `/api/campaign/preflight?profiles=${q}${dl}`);
}

/** One campaign + its live lead-status counts. */
export function getCloudCampaign(id) {
  return requestWithRetry('GET', `/api/campaign/${encodeURIComponent(id)}`);
}

/**
 * Per-lead status rows for one cloud campaign — the engine's per-lead endpoint
 * (deployed as of 2026-07). Each row: { id, leadUrl, fullName, account, status
 * ('pending'|'sent'|'error'|...), stage, error, sentAt, connectionStatus,
 * connectionAcceptedStatus, introductionStatus, dmStatus }. Idempotent GET, so
 * it retries transient failures. Returns { leads:[…], total } or { error }.
 */
export function getCloudCampaignLeads(id) {
  return requestWithRetry('GET', `/api/campaign/${encodeURIComponent(id)}/leads`);
}

/** Per-account status for the campaign's accounts (daily used vs limit, parked/
 *  throttled/weekly-cap, needs-login). Feeds the Live Status "Accounts" panel. */
export function getCloudCampaignAccounts(id) {
  return requestWithRetry('GET', `/api/campaign/${encodeURIComponent(id)}/accounts`);
}

/**
 * Signal the engine that the local primary browser has accepted the campaign's
 * pending sender invitations (cloud primary-handshake, local-only primary).
 * Single attempt (mirrors startCloudCampaign) — a duplicate returns a terminal
 * 409 that requestOnce encodes as { error, status:409 }. See
 * docs/cloud-engine-primary-handshake-spec.md.
 * @param {string}   id           cloud campaign id
 * @param {string[]} acceptedIds  sender profileIds accepted
 */
export function signalPrimaryAcceptDone(id, acceptedIds) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/primary-accept-done`, {
    accepted: Array.isArray(acceptedIds) ? acceptedIds : [],
  });
}

/**
 * Ship the primary's captured LinkedIn session to the engine so a follow-up can
 * later run AS the primary on the VM. Single attempt (mirrors
 * signalPrimaryAcceptDone) — best-effort, called from a try/catch that must
 * never fail the handshake either way.
 * @param {{memberId:string, publicIdentifier:string, displayName:string, cookies:Array}} cap
 */
export function postPrimarySession(cap) {
  return requestOnce('POST', `/api/primaries/${encodeURIComponent(cap.memberId)}/session`, {
    publicIdentifier: cap.publicIdentifier,
    displayName: cap.displayName,
    cookies: cap.cookies,
  });
}

// Bare vanity slug (e.g. "jane-doe") from a /in/ profile URL, lowercased —
// what the engine's GET /api/primaries/by-slug/:slug expects (it does
// `WHERE lower(public_identifier)=lower($1)`). Do NOT reuse
// primaryKeyFromUrl (primary-status-store.js) here — it returns a PREFIXED
// key ('s:'+slug or 'm:'+token) for a different store. Encoded member tokens
// (/in/ACwAA…, /in/ACoAA…) have no vanity slug, so — same detection as
// primaryKeyFromUrl — they resolve to '' (no by-slug lookup possible; the
// wizard just shows no hint for those primaries).
export function extractPrimarySlug(primaryUrl) {
  const m = String(primaryUrl || '').match(/\/in\/([^/?#]+)/i);
  if (!m) return '';
  const raw = m[1];
  if (/^AC[ow]AA/i.test(raw)) return '';
  return raw.toLowerCase();
}

/**
 * The primary's captured-session state on the cloud engine, keyed by bare
 * vanity slug — backs the wizard's "session live / needs login" hint next to
 * the Primary Person URL field. Single attempt (mirrors getCloudCampaign's
 * sibling calls that must never throw): returns the engine's
 * { state, name, capturedAt } or { error }; the server route (server.js
 * /api/primary-session) is the one that folds any error into { state:'none' }
 * so a flaky engine never breaks the wizard.
 * @param {string} slug bare lowercased vanity slug (see extractPrimarySlug)
 */
export function getPrimarySession(slug) {
  return requestOnce('GET', '/api/primaries/by-slug/' + encodeURIComponent(slug));
}

/**
 * Personal-primary follow-ups the owner's app must drain locally (the VM never
 * sends a personal follow-up). Returns the engine's { followups:[...] } (due
 * ones for this owner's campaigns) or { error }.
 * @param {string} owner operator email
 */
export function getLocalFollowups(owner) {
  return requestWithRetry('GET', '/api/local-followups?owner=' + encodeURIComponent(owner || ''));
}

/**
 * Ack drained follow-ups so the engine marks them 'delegated' (never re-offers).
 * Single attempt: called only AFTER the local enqueue succeeded, so a lost ack
 * just re-offers next poll (local dedupe makes the re-enqueue a no-op).
 * @param {string[]} taskIds
 */
export function ackLocalFollowups(taskIds, owner) {
  return requestOnce('POST', '/api/local-followups/ack', { taskIds: taskIds || [], owner: owner || '' });
}

/**
 * Stop a cloud campaign.
 * - default: cancel (leads not yet actioned are abandoned).
 * - { pause: true }: pause (resumable) instead of cancel.
 * - { keepMonitoring: true }: the "Stop sending, keep monitoring" choice —
 *   stop claiming new leads but transition into the monitoring window so
 *   already-sent connects keep being swept for acceptance + auto-intro/DM
 *   (connect_and_* only; other modes land on 'done'). Mirrors the local
 *   stopAndKeepMonitoring path. pause + keepMonitoring are mutually exclusive;
 *   keepMonitoring wins.
 */
export function stopCloudCampaign(id, { pause = false, keepMonitoring = false, immediate = false } = {}) {
  // Every operator Stop is immediate. keepMonitoring only decides what remains
  // after sending is cut; it never changes how quickly sending stops.
  immediate = true;
  const qs = keepMonitoring
    ? '?keepMonitoring=1&immediate=1'
    : (pause ? '?pause=1&immediate=1' : '?immediate=1');
  return requestWithRetry('POST', `/api/campaign/${encodeURIComponent(id)}/stop${qs}`);
}

/**
 * Resume a paused cloud campaign (mirror of the local Resume). Flips the engine
 * status 'paused' → 'running' so the scheduler continues from where it left off.
 * Idempotent (a non-paused campaign returns its current status). Retries like the
 * other control calls.
 */
export function resumeCloudCampaign(id) {
  return requestWithRetry('POST', `/api/campaign/${encodeURIComponent(id)}/resume`);
}

/**
 * Restart a cancelled/stopped/errored cloud campaign — re-activates the SAME
 * campaign record (engine flips its terminal status back to 'running'; leads
 * already sent carry sentAt and are skipped, so it continues where it left off).
 * `fromStart` is passed for parity with the app's two buttons but does not clear
 * lead state (operator chose "still skip done rows"). Retries like the other
 * control calls; returns { error, status } until the engine ships the route so
 * the UI can degrade gracefully.
 */
export function restartCloudCampaign(id, { fromStart = false, dailyLimit, startAt, resumeSending = false } = {}) {
  const body = { fromStart: !!fromStart, resumeSending: !!resumeSending };
  if (dailyLimit != null && Number(dailyLimit) > 0) body.dailyLimit = Math.floor(Number(dailyLimit));
  // Scheduled restart: the engine parks the campaign in 'scheduled' and restarts
  // it itself at this instant instead of going straight back to running.
  if (startAt) body.startAt = startAt;
  return requestWithRetry('POST', `/api/campaign/${encodeURIComponent(id)}/restart`, body);
}

// Monitoring controls (Task 3 Part B) — mirror the local ⚡ Check now / Automatic
// checks toggle. Single-shot (requestOnce): user-initiated, fine to fail loudly.
// Return { error, status } until the engine ships these routes, so the UI can
// degrade gracefully ("engine update pending") instead of throwing.
// scope: 'campaign' (default) sweeps just this campaign's accounts; 'all' sweeps
// every unique account in the sheet's "Account Used" column (engine derives it).
export function cloudCheckNow(id, scope = 'campaign') {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/check-now`, { scope: scope === 'all' ? 'all' : 'campaign' });
}
// Stop the sweep the VM is running right now. The engine raises a flag its
// sweep consumes at the next account boundary; the campaign itself is untouched.
export function cloudCheckStop(id) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/check/stop`, {});
}
export function setCloudAutoChecks(id, enabled) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/auto-checks`, { enabled: !!enabled });
}
// Edit a cloud campaign's account set while it is paused/stopped — the cloud
// twin of the local pause-edit panel (toggle an account off, add another
// GoLogin profile). add: [{ profileId, email }], remove: [profileId]. The engine
// refuses this while the campaign is running/queued (a worker is mid-batch).
export function setCloudCampaignAccounts(id, { add = [], remove = [] } = {}) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/accounts`, { add, remove });
}
// Handover, VM → this Mac: ask the engine to give up ownership of a campaign.
// The engine flips runs_on to 'local', stops claiming work and resets its
// empty-check streak — but ONLY if it can prove nothing is mid-sweep. It fails
// CLOSED: a live sweep, a lost race, or an engine too old to know the route all
// answer HTTP 409, which the caller must treat as ABORT, never as retry-anyway.
// Single attempt on purpose: withWriteRetry would re-POST a refusal.
export function releaseCloudCampaign(id) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/handover-release`, {});
}
// Handover, this Mac → VM, for a campaign the VM never destroyed: a MONITORING
// campaign kept status='monitoring' through handover-release (only a running or
// paused one was cancelled), so its engine row is still intact and can simply be
// taken back rather than re-dispatched as a new campaign with a new id. The
// engine sets runs_on='vm', resets empty_check_streak and re-arms the monitor
// task one base interval out.
// Two refusals, both HTTP 409: `not_local` (the VM already owns it) and
// `not_resumable` (its status is not 'monitoring', so a done or cancelled
// campaign is never quietly revived by a handover). Single attempt for the same
// reason as releaseCloudCampaign: a retry would re-POST a refusal.
export function reclaimCloudCampaign(id) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/handover-reclaim`, {});
}
// Un-bench a weekly-capped account (operator Retry in the Accounts panel).
export function unbenchCloudAccount(id, profileId) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/accounts/${encodeURIComponent(profileId)}/unbench`, {});
}
// Record what THIS MACHINE found about one account's connection to the primary.
// Every connect and every acceptance happens here, on the operator's Mac; the VM
// only reads. Without this the engine would keep showing whatever it last
// managed to read for itself, and the panel would contradict the handshake that
// had just run. state: connected | pending | not_connected | unverified.
export function recordCloudPrimaryConn(id, profileId, { state, primaryUrl = '', line = '' } = {}) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/accounts/${encodeURIComponent(profileId)}/primary-conn`, { state, primaryUrl, line });
}
// Local-check write-back: mirror the sheet's per-lead statuses into the engine
// after the operator runs this cloud campaign's acceptance check on their OWN
// machine (local GoLogin sweep). Engine applies fill-only — safe to re-post.
export function syncCloudLeadStatuses(id, leads) {
  return requestOnce('POST', `/api/campaign/${encodeURIComponent(id)}/lead-status-sync`, { leads: Array.isArray(leads) ? leads : [] });
}

/**
 * Open the live MJPEG screencast for a running cloud campaign's active browser
 * session — the campaign analogue of openJobViewStream (scraper-client.js). The
 * engine must expose `GET /api/campaign/:id/view` streaming
 * multipart/x-mixed-replace (see docs/cloud-engine-campaign-view-spec.md).
 *
 * Resolves to { ok:true, contentType, body, abort } to pipe straight to the
 * dashboard <img>, or { ok:false, status, error } — never throws. No timeout
 * (long-lived stream); the caller aborts when the viewer closes.
 *
 * Until the engine ships that endpoint, the `/view` path falls through to the
 * engine's SPA (text/html); we detect that and report a clean "not available
 * yet" (501) instead of piping HTML into an <img>.
 */
export async function openCampaignViewStream(id) {
  const base = engineUrl();
  if (!base) return { ok: false, status: 503, error: 'Campaign engine not configured' };
  const controller = new AbortController();
  try {
    const headers = {};
    const token = engineToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${base}/api/campaign/${encodeURIComponent(id)}/view`, {
      method: 'GET', headers, signal: controller.signal,
    });
    if (!res.ok) {
      // Read the body BEFORE aborting — aborting the controller tears down the
      // response stream, so a read-after-abort loses the engine's JSON reason
      // (e.g. {error:"no active session"}) and falls back to a bare "HTTP 404".
      // The viewer's calm idle state keys on that "no active session" string.
      let body = null; try { body = await res.json(); } catch { /* not json */ }
      controller.abort();
      return { ok: false, status: res.status, error: (body && body.error) || `HTTP ${res.status}` };
    }
    const ct = res.headers.get('content-type') || '';
    if (/text\/html/i.test(ct)) {
      controller.abort();
      return { ok: false, status: 501, error: "Live browser view isn't available yet — the cloud engine doesn't stream campaign browsers. (The per-lead log shows live activity.)" };
    }
    return {
      ok: true,
      contentType: ct || 'multipart/x-mixed-replace',
      body: res.body,
      abort: () => { try { controller.abort(); } catch { /* */ } },
    };
  } catch (err) {
    controller.abort();
    return { ok: false, status: 502, error: err.message };
  }
}
