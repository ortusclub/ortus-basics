// campaign-monitor.js
//
// Phase C — the acceptance-MONITORING engine. Ties together:
//   • getRecentConnections (vendored browser primitive)  — fetch ~80 recent conns
//   • CampaignStore.upsert/getConnections (Phase B)       — accumulate, sender-scoped
//   • computeBulkCheckUpdates (Phase A, ported verbatim)  — match leads ↔ conns
//   • CampaignStore.updateLeadOutcome (Phase B)           — stamp the verdict
//
// runBulkCheck is the wrapper the scheduler's monitor task calls per
// (campaign, account); it returns the newly-accepted lead URLs so the follow-up
// modes (Phase D/E) can fire intros/DMs. Browser access is INJECTABLE
// (fetchRecent) so the whole flow is testable with canned connections — no
// real LinkedIn.

const MONITORING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (matches the app)

let _core = null;
async function getCore() { if (!_core) _core = await import("./campaign-bulkcheck-core.mjs"); return _core; }
let _helpers = null;
async function getHelpers() { if (!_helpers) _helpers = await import("./campaign-lib/linkedin/helpers.js"); return _helpers; }

const LINKEDIN_COLUMN = "LinkedIn URL";

// Source-sheet numeric Member-ID column names — mirrors _SOURCE_MEMBER_ID_KEYS
// in campaign-lib/profile-identity.js (readSourceMemberId reads these). Kept in
// sync by hand because profile-identity.js doesn't export the list.
const MEMBER_ID_KEYS = [
  "Linkedin Membership ID", "LinkedIn Membership ID", "linkedin membership id",
  "Linkedin Member ID", "LinkedIn Member ID", "linkedin member id",
  "Member ID", "member id", "memberId", "membershipId", "membership id",
];

// Engine lead row → the row shape computeBulkCheckUpdates expects (it tolerates
// many column-name variants; we supply the canonical ones).
//
// STATUS columns stay DB-authoritative: the engine's DB is the parity-equivalent
// of the app's LIVE sheet (which the app re-reads every sweep), and it is fresher
// than the FROZEN import snapshot in row_data. We deliberately do NOT spread all
// of row_data here — a stale import-time status could shadow our verdict (the
// matcher reads "Connection Accepted Status" at higher priority than the
// "Connected Status" key we write). We DO pass through the source-sheet numeric
// Member-ID columns so readSourceMemberId() can build the `num:` identity axis —
// the app's strongest cross-account acceptance/dedup key (was dead on the VM,
// audit #16). Custom template columns are NOT needed here (the matcher never
// reads them — they matter only for personalization, handled separately).
function leadToRow(l, linkedinColumn = LINKEDIN_COLUMN) {
  const rd = l && l.row_data && typeof l.row_data === "object" ? l.row_data : {};
  const idCols = {};
  for (const k of MEMBER_ID_KEYS) if (k in rd) idCols[k] = rd[k];
  return {
    ...idCols,
    [linkedinColumn]: l.lead_url,
    "First Name": l.first_name || "",
    "Last Name": l.last_name || "",
    "Connection Request Status": l.connection_request_status || "",
    "Connected Status": l.connection_accepted_status || "",
    "Introduction Status": l.introduction_status || "",
    "DM Status": l.dm_status || "",
    "LinkedIn URN": l.member_urn || l.member_number || "",
    "Sender": l.assigned_profile || "",
  };
}

// A matcher update → updateLeadOutcome fields.
function mapUpdate(u) {
  const f = {};
  const cc = u.cc ?? u.checkStatus;
  if (cc != null) f.connectionAcceptedStatus = cc;
  if (u.connectionStatus != null) f.connectionRequestStatus = u.connectionStatus;
  if (u.stage != null) f.stage = u.stage;
  if (u.connectedAlready != null) f.connectedAlready = /^yes$/i.test(String(u.connectedAlready));
  if (u.introductionStatus != null) f.introductionStatus = u.introductionStatus;
  if (u.dmStatus != null) f.dmStatus = u.dmStatus;
  // R3 (#11): the matcher's cross-sender / already-connected branches REASSIGN
  // the row's Sender to the account actually connected (the app writes this to
  // the Sender column). Mirror it by moving assigned_profile so the connected
  // account's own sweep fires the intro/DM from a genuine 1st-degree browser.
  // Only honor a non-empty reassignment — never blank out an assignment.
  if (u.sender != null && String(u.sender).trim()) f.assignedProfile = String(u.sender).trim();
  return f;
}

// A lead is worth checking once an invite has gone out (the matcher applies the
// terminal/dedup guards from there).
function isMonitorable(l) {
  return !!(l.connection_request_status && String(l.connection_request_status).trim());
}

function stillPendingLabel(now = new Date()) {
  return `Still Pending (${now.toISOString().slice(0, 16).replace("T", " ")})`;
}

// Run ONE acceptance check for (campaign, account): fetch recent connections,
// accumulate, match this account's monitorable leads, stamp verdicts. Returns
// { connectedUrls, applied, checked }. `page` is the live browser; `fetchRecent`
// is injectable for tests (default: the vendored getRecentConnections).
// A dead/expired LinkedIn session surfaces as specific browser/Voyager errors:
// the page's cookie store walled off (Access is denied), a redirect to the
// login/checkpoint/authwall, or a 401/403 from the API. Distinguish those from
// benign "no new connections" or a transient fetch hiccup, so the operator is
// only nagged to re-login when it's genuinely a stale session. Mirrors the
// send-path's session-death detection.
function isSessionInvalidError(msg) {
  if (!msg) return false;
  const m = String(msg).toLowerCase();
  return (
    (m.includes("cookie") && m.includes("access is denied")) ||
    m.includes("not logged in") ||
    m.includes("checkpoint") ||
    m.includes("authwall") ||
    m.includes("/login") ||
    m.includes("401") ||
    m.includes("403") ||
    m.includes("unauthorized")
  );
}

// Navigate to a stable LinkedIn URL, THEN pull recent connections — 1:1 with
// local's bulkCheckConnections (bulk-check-connections.js:625-648).
// getRecentConnections reads document.cookie for the JSESSIONID/CSRF token and
// intentionally does NOT navigate itself. A fresh monitor/check browser
// (launchProfile never navigates) sits on about:blank, where document.cookie is
// walled off → "Failed to read the 'cookie' property from 'Document': Access is
// denied" — the error operators saw on a manual check after "stop sending, keep
// monitoring". That string also (mis)matches isSessionInvalidError, falsely
// stamping a healthy account Needs-Login. Navigating first makes the cookie
// readable AND turns a genuinely dead session into a proper /login|/checkpoint
// redirect (the real Needs-Login signal). getRecent is injected so the Voyager
// call stays swappable. Returns getRecentConnections' contract: an array, with a
// `.error` sentinel on failure. Exported for unit tests.
async function navigateThenFetchRecent(page, getRecent) {
  let postNavUrl = "";
  try {
    await page.goto("https://www.linkedin.com/mynetwork/invite-connect/connections/", {
      waitUntil: "domcontentloaded", timeout: 30000,
    });
    postNavUrl = (typeof page.url === "function" ? page.url() : "") || "";
  } catch (e) {
    const empty = []; empty.error = `navigation-failed: ${e.message}`; return empty;
  }
  if (/\/login|\/uas\/|\/checkpoint/.test(postNavUrl)) {
    const empty = []; empty.error = `session-expired (redirected to ${postNavUrl})`; return empty;
  }
  return getRecent(page);
}

async function runBulkCheck({ store, campaign, account, page, fetchRecent }) {
  const { computeBulkCheckUpdates } = await getCore();
  // Tests inject fetchRecent (canned connections) and bypass the navigation. The
  // default first navigates to a stable LinkedIn URL (see navigateThenFetchRecent).
  const fetch = fetchRecent
    || ((pg) => navigateThenFetchRecent(pg, async (p) => (await getHelpers()).getRecentConnections(p, 0)));

  const fresh = (await fetch(page)) || [];
  // getRecentConnections returns the array with a `.error` sentinel on failure.
  // A session-invalid error must be SURFACED (typed throw) so the scheduler's
  // monitor handler stamps SoO Needs-Login for the operator — not swallowed as
  // "0 acceptances", which is how a stale login silently did nothing for days.
  if (fresh.error && isSessionInvalidError(fresh.error)) {
    throw Object.assign(new Error(fresh.error), { sessionInvalid: true });
  }
  await store.upsertConnections(campaign.id, account, fresh);
  // R3 (#11/#15): feed the matcher the WHOLE-campaign lead + connection set, not
  // just this account's. The app's bulk-check runs against the entire sheet and
  // the accumulated Recent-Connections tab (all senders), which is what makes
  // cross-account acceptance detection and cross-account dedup work. `account`
  // stays as `profileName` (the sweeping account) so the matcher's sender-scoping
  // and 1st-degree-intro gate (`sweepingConnected`) behave identically.
  const conns = await store.getAllConnections(campaign.id);

  const leads = (await store.getCampaignLeads(campaign.id)).filter(isMonitorable);
  if (!leads.length) return { connectedUrls: [], applied: 0, checked: 0 };

  const rows = leads.map((l) => leadToRow(l));
  const dmSentTerminal = campaign.mode === "connect_and_message";
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, conns, LINKEDIN_COLUMN, stillPendingLabel(), { dmSentTerminal, profileName: account }
  );

  // R3 (#15): the app stamps EVERY row copy of a matched URL (google-apps-script
  // handleUpdateRow v2.105 → findRowsByUrl writes all copies), so a person who
  // appears on more than one row — often under different senders — is resolved
  // consistently. Mirror that: apply each url-keyed update to ALL leads sharing
  // the URL, not just the first. Multiple updates for one URL apply in order
  // (last write wins), exactly as the sheet does.
  const byUrl = new Map();
  for (const l of leads) {
    let arr = byUrl.get(l.lead_url);
    if (!arr) { arr = []; byUrl.set(l.lead_url, arr); }
    arr.push(l);
  }
  let applied = 0;
  for (const u of updates) {
    const matched = byUrl.get(u.linkedinUrl);
    if (!matched) continue;
    const fields = mapUpdate(u);
    for (const lead of matched) {
      await store.updateLeadOutcome(lead.id, fields);
      applied++;
    }
  }
  return { connectedUrls, applied, checked: rows.length };
}

// Sweep all participating accounts for a campaign (acquiring the shared account
// lock so a scrape/another campaign never collides). openSession is injectable
// (real: GoLogin launch; test: a stub). Returns the union of newly-accepted URLs.
async function monitorSweep({ store, campaign, openSession, fetchRecent }) {
  const accounts = campaign.profile_ids || [];
  const accepted = [];
  for (const account of accounts) {
    if (!(await store.acquireAccount(account))) continue; // busy elsewhere — skip
    let session = null;
    try {
      session = openSession ? await openSession(account) : { page: null };
      const r = await runBulkCheck({ store, campaign, account, page: session.page, fetchRecent });
      accepted.push(...r.connectedUrls);
    } catch (_) { /* best-effort per account */ }
    finally {
      if (session && session.close) { try { await session.close(); } catch {} }
      await store.releaseAccount(account);
    }
  }
  return { accepted };
}

// Window/cadence decision for the recurring monitor task. Past monitoring_until
// → expired (stop). Else → reschedule next_check_at by the cadence.
function nextMonitorDecision(campaign, now = new Date()) {
  const until = campaign.monitoring_until ? new Date(campaign.monitoring_until) : null;
  if (until && now.getTime() >= until.getTime()) return { expired: true, nextCheckAt: null };
  const intervalMs = (campaign.check_interval_minutes || 60) * 60000;
  return { expired: false, nextCheckAt: new Date(now.getTime() + intervalMs) };
}

// Pure tail decision for handleMonitor after a sweep runs. Separated so the
// lifecycle semantics are unit-testable without a DB/session:
//   'expire'    → past monitoring_until: stop, mark the campaign done.
//   'park'      → auto-checks turned off: this sweep ran, but DON'T arm the next
//                 one. The campaign stays 'monitoring'; the recurring timer is
//                 paused. Check-now (or toggling auto back on) re-arms it. This
//                 mirrors the local app: auto-off stops the timer, manual checks
//                 still work.
//   'reschedule'→ normal: arm the next check by the cadence.
function monitorTailAction({ expired, autoChecksEnabled }) {
  if (expired) return "expire";
  if (autoChecksEnabled === false) return "park";
  return "reschedule";
}

module.exports = { runBulkCheck, monitorSweep, nextMonitorDecision, monitorTailAction, leadToRow, mapUpdate, isMonitorable, isSessionInvalidError, navigateThenFetchRecent, MONITORING_WINDOW_MS };
