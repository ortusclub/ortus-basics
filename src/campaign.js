import { ensureCampaignIdentity, getConfigById, saveConfig } from './campaign-configs.js';
import { campaignLifecycle } from '../public/js/campaign-lifecycle.mjs';
import { weeklyCutoffMs, nextWeeklyResetMs, monthlyCutoffMs, nextMonthlyResetMs } from './weekly-reset-cutoff.js';
/**
 * Campaign orchestrator — v17.
 *
 * EXACT WORKFLOW:
 * 1. User selects 2-5 GoLogin accounts + lead list
 * 2. For each GoLogin profile:
 *    a. Open GoLogin profile
 *    b. Load LinkedIn home page
 *    c. Wait 20 seconds on home page
 *    d. Set zoom to 67%
 *    e. For each lead:
 *       - Open lead's LinkedIn profile
 *       - Wait 30 seconds for page to load
 *       - Ensure zoom is 67%
 *       - Execute Connect action
 *       - Wait 10 seconds after connection sent
 *       - Next lead
 *    f. Close all tabs + close GoLogin browser
 *    g. Open next GoLogin profile, repeat
 */

import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'fs';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import { launchProfile, closeProfile, closeAllProfiles, getProfiles, getProfilePid, applyFocusEmulation } from './gologin-launcher.js';
import { launchLocalBrowser, closeLocalBrowser } from './local-launcher.js';
import { fetchSheet as fetchSheetRows, isSystemTabName, looksLikeLeadRows, listSheetTabs } from './sheets.js';
import { withGid, extractSheetGid } from './utils.js';
import { updateSheetRow, batchUpdateSheet, ensureTrackingColumns, prepareSheet, setOperatorTz, clearRecentConnectionsTab, flushSheetWrites } from './sheets-writer.js';
import { SHEETS_WEBAPP_URL } from './sheets-webapp-url.js';
import { writeSheetWithRetry, getFailures, clearFailures, configure as configureSheetWriteTracker } from './sheet-write-tracker.js';
import { getPrefs as getOperatorPrefs, identityGateEnabled } from './operator-prefs.js';
import { opsLogEvent, flushOpsLog, campaignLogAppendRun, dashboardUpsert } from './log-writer.js';
import { classifyOutcome } from './linkedin/outcome-classify.js';
import { emptyTally, applyOutcome } from './campaign-tally.js';
import { summariseCampaign } from './campaign-summary.js';
import { performOutreach } from './linkedin/outreach.js';
import { getProfileUrn, captureProfileMeta, waitForProfileRender } from './linkedin/helpers.js';
// Note-credit state for the sending session — see the WeakMap in actions.js.
import { getNoteState } from './linkedin/actions.js';
import { verifyConnectIdentity, readSourceMemberId, is404Url } from './profile-identity.js';
import { bulkCheckConnections } from './linkedin/bulk-check-connections.js';
import { runAutoIntros, _shouldQueueAutoAccept } from './linkedin/auto-intro.js';
import { checkAndConnectPrimary, primaryConnState } from './linkedin/primary-connection.js';
import { readSelfIdentity, acceptInvitationFrom, acceptAllPendingInvitations } from './linkedin/accept-invitation.js';
import { buildAcceptTask, enqueuePrimaryTask } from './primary-tasks.js';
import { planAccountsNeedingConnect, handshakeProgress, shouldProceed } from './preflight-handshake.js';
import { clampCadenceMinutes } from '../public/js/campaign-modes.mjs';
import { runAutoDms } from './linkedin/auto-dm.js';
import { registerSchedule as registerPostCampaignSweep, removeSchedulesForSheet as removeBulkSchedules } from './post-campaign-bulk-check.js';
import { registerReplySchedule as registerReplyTracking, removeSchedulesForSheet as removeReplySchedules } from './post-campaign-reply-check.js';
import { transitionToMonitoring } from './campaign-state-transitions.js';
import { registerAppender, buildAppendLogger, unregisterAppender } from './campaign-log-bus.js';
import { writeMonitoringState, readMonitoringState, clearMonitoringState, extractMonitoringSlice } from './monitoring-persistence.js';
import { computeMonitoringUntil } from './monitoring-time.js';
import { checkCadenceMin, nextEmptyStreak, summarizeMonitoringSweep } from './monitoring-cadence.js';
import { shouldAutoFireCheck } from './monitoring-auto-checks.js';
import { shouldContinueTurn, shouldRequeue, canAddProfile } from './bench-gate.js';
import { decideResumeAction } from './monitoring-resume.js';
import { enqueueDesktopNotification } from './notifier.js';
import { decide429 } from './throttle-policy.js';
import { resolveSoOTarget, resolveSoOEmail, flipAccountInUse, markAccountNeedsLoginSoO, resolveOperatorStamp, isConnectSend, bumpConnectionsThisWeek } from './soo-writer.js';
import { fetchSoOData } from './soo.js';
import { identityRestrictionLabel } from './soo-restrictions.js';
import { getOperatorEmail } from './operator-identity.js';
import { dataPath } from './paths.js';
import { readLastRun, writeLastRun } from './last-run-store.js';
import { readBlocklist } from './blocklist.js';
import { blocklistExcludedUrls } from './preflight-lint.js';
import { CampaignRegistry } from './campaign-registry.js';
import { checkDiskFree } from './disk-check.js';
import { plainLine } from './log-voice.js';
import { readRuntimeInterruption, writeRuntimeInterruption, clearRuntimeInterruption, interruptionCopy, isInterruption, interruptionMatches } from './runtime-interruption.js';
import { readJson, writeJsonAtomic, updateJsonAtomic } from './atomic-json-store.js';
import {
  sample as rmSample,
  decideThrottle,
  cfg as rmCfg,
  computeDelayMultiplier,
  _resetSampleCache,
  getAmbient,
  readAvailableMemory,
} from './resource-monitor.js';
import * as browserSemaphore from './browser-semaphore.js';
import {
  primaryKeyFromUrl, storeKey, getEntry,
  mergeLiveRead, resolveDisplayState, seedConnectedIds,
  loadPrimaryStatus, savePrimaryStatus,
} from './primary-status-store.js';
import { buildDebrief } from './debrief.js';
import {
  recordSkip, clearSkips, getSkips, summarizeSkips,
  ALREADY_PROCESSED, IDENTITY_UNCONFIRMED, WATCHDOG_TIMEOUT,
  MALFORMED_URL, FAILED_REPEATEDLY, OTHER, TERMINAL_STAGE,
} from './skip-ledger.js';

const STATE_FILE = dataPath('state.json');
const HISTORY_PATH = dataPath('history.json');
const LAST_RUN_FILE = dataPath('last-run-settings.json');
// Acceptance-check timing:
//   • First check is gated by FIRST_HOUR_BLACKOUT_MS (in-batch) and
//     IDLE_CAMPAIGN_MIN_DURATION_MS (idle) — always ~1h after campaign start,
//     regardless of cadence. (Gives LinkedIn time to start accepting.)
//   • After that, the gap between checks is the operator's cadence
//     (checkIntervalMinutes), honored identically during sending and
//     monitoring. Manual /api/bulk-check-now bypasses both rules.
const FIRST_HOUR_BLACKOUT_MS = 60 * 60 * 1000;
// Same 60-min floor as the cooldown — the idle trigger already double-
// counted as the first-hour gate, this keeps them in sync.
const IDLE_CAMPAIGN_MIN_DURATION_MS = 60 * 60 * 1000;
// Per-(profileId, sheetId) timestamp of the last bulk Connection Status
// check. Used to gate the bulk-check per profile per sheet, avoiding
// redundant Voyager hits. In-campaign gates use the operator cadence
// (campaign.checkIntervalMinutes) directly; BULK_CHECK_INTERVAL_MS is the
// FALLBACK sweep interval when no cadence is configured (see
// resolveBulkCheckIntervalMs, used by the post-campaign sweep scheduler).
const BULK_CHECK_FILE = dataPath('bulk-check-cooldown.json');
const PRIMARY_STATUS_FILE = dataPath('primary-status.json');
const BULK_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Derive the bulk acceptance-check sweep interval from the operator's
 * per-campaign cadence. Pure — unit-tested in tests/bulk-check-interval.test.js.
 *
 * @param {number|string|null|undefined} checkIntervalMinutes - operator cadence
 *   in minutes (campaign.checkIntervalMinutes). Non-finite / <= 0 → unset.
 * @param {number} [fallbackMs] - interval when the cadence is unset
 *   (defaults to the historical 6h BULK_CHECK_INTERVAL_MS).
 * @returns {number} interval in ms.
 */
export function resolveBulkCheckIntervalMs(checkIntervalMinutes, fallbackMs = BULK_CHECK_INTERVAL_MS) {
  const min = Number(checkIntervalMinutes);
  return Number.isFinite(min) && min > 0 ? min * 60_000 : fallbackMs;
}
const SUCCESS_ACTIONS = new Set(['connection_sent', 'message_sent', 'inmail_sent', 'op_message_sent', 'already_processed', 'status_accepted', 'status_pending', 'status_declined', 'already_connected']);

// The subset of SUCCESS_ACTIONS where somebody was genuinely written to. The
// per-account panel lists these people by name; a status check that merely
// confirmed a connection reached nobody and must not appear there.
const SENT_ACTIONS = new Set(['connection_sent', 'message_sent', 'inmail_sent', 'op_message_sent']);

/** What each send reads as in the operator's log. Never the action name. */
const SENT_WORDS = {
  connection_sent: 'a connection request',
  message_sent: 'a message',
  inmail_sent: 'an InMail',
  op_message_sent: 'a message',
};

// ═══════════════════════════════════════════════════════════════════════════
// Phase 11.2: batch-loop constants + pure helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Hard cap — 5 leads per batch per profile, for ALL modes (D-01). Not configurable. */
export const BATCH_SIZE = 8; // v2.79: 5→8 — fewer browser re-opens/health-checks per turn

/** Pure helper — human-readable label for a parked-profile reason code.
 *  Used by the end-of-run "why did it stop" notice (v2.72). */
export function prettyParkReason(reason) {
  switch (reason) {
    case 'session_expired':   return 'logged out / session expired';
    case 'weekly_limit_429':  return 'weekly invite limit reached';
    case 'consecutive_skips': return 'too many consecutive skips / failures';
    case 'op_credit_limit':   return 'suspected OP credits limit reached';
    case 'suspected_weekly_limit': return 'suspected weekly invitation limit (HTTP 429)';
    default:                  return reason || 'parked';
  }
}

/** Phase 2.8.20 (W2-A1) — per-lead watchdog timeout. Catches Puppeteer hangs
 *  that the protocol-level 120s timeout would otherwise paper over. Default
 *  180s; env-overridable for stress-testing (LEAD_TIMEOUT_MS=2000 will time
 *  out almost every lead, useful for proving the path).
 */
export const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 180000;

// Hard cap on simultaneously-open browsers (Orbita + local Chromium combined).
// 2.9.9: dropped from 3 → 2 per Q-protocol decision. Type-agnostic — every
// launch (GoLogin or local) acquires a slot via browser-semaphore.js.
// Override via .env only if you have ≥16GB RAM and know what you're doing.
const MAX_CONCURRENT_PROFILES = Number(process.env.MAX_CONCURRENT_PROFILES) || 2;

/** Phase 2.8.20 (W3-D1) — state.json `processed` retention window in days.
 *  Default 60. Entries older than this are dropped on next loadState; the
 *  pruned state persists on the next saveState call. Configurable via env.
 *  Semantics: a lead untouched for N days is "forgotten" — fair game to retry.
 */
const STATE_RETENTION_DAYS = Number(process.env.STATE_RETENTION_DAYS) || 60;

export function withWatchdog(promise, timeoutMs, profileId) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(
      new Error('lead_timeout_watchdog'),
      { kind: 'watchdog', profileId, timeoutMs }
    )), timeoutMs);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

// v2.97 — solo-check lead preempt. A manual bulk check ("Run a solo check")
// takes precedence over the running campaign: instead of waiting up to the 180s
// lead watchdog for a cooperative pause boundary, preemptCurrentLead() abandons
// the in-flight lead immediately so the loop reaches its pause boundary within
// ~1s. The abandoned lead is left UNSTAMPED → re-attempted on resume (the only
// risk is a single in-flight action finishing in the background, which the
// operator opted into). Armed per-lead at the watchdog race; null between leads,
// in which case preempt is a no-op and the pause still lands at the next
// boundary.
let _leadPreemptReject = null;
export function preemptCurrentLead() {
  if (_leadPreemptReject) {
    _leadPreemptReject(Object.assign(new Error('lead_preempted'), { kind: 'preempt' }));
    return true;
  }
  return false;
}

/** Minimum between-batch wait — floor for the derived-from-bph math (D-03). */
const MIN_BETWEEN_BATCHES_MS = 60 * 1000;

/** Gap threshold past which we close the browser instead of parking (D-13). */
const PROFILE_CLOSE_GAP_MIN_DEFAULT = 15;
function getCloseGapMin() {
  const v = Number(process.env.PROFILE_CLOSE_GAP_MIN);
  return Number.isFinite(v) && v > 0 ? v : PROFILE_CLOSE_GAP_MIN_DEFAULT;
}

/**
 * Pure helper — close the profile between batches when the gap is long enough
 * that keeping Chromium warm costs more than the re-launch S3 round-trip.
 * Exported for tests/batch-loop.test.js.
 */
export function shouldCloseBetweenBatches({ waitMs, closeGapMin }) {
  const threshold = Number.isFinite(closeGapMin) && closeGapMin > 0
    ? closeGapMin
    : getCloseGapMin();
  return Number(waitMs) > threshold * 60 * 1000;
}

/**
 * Pure predicate — should the idle bulk-check fire for this profile right now?
 * All seven gates must pass. Exported for tests/idle-bulk-check.test.js.
 *
 * @param {object} ctx
 * @param {string}  ctx.mode                  - campaign mode (only the connect-then-followup modes connect_and_introduce / connect_and_message trigger idle checks)
 * @param {number}  ctx.campaignStartTime     - epoch ms when campaign began
 * @param {boolean} ctx.profileBrowserOpen    - is this profile's browser currently open? (in-batch trigger handles those)
 * @param {boolean} ctx.profileWeeklyLimited  - is this profile parked permanently?
 * @param {number}  ctx.semaphoreAvailable    - remaining browserSemaphore slots (0 = full)
 * @param {number}  ctx.lastBulkCheckAt       - epoch ms of last bulk-check for this (sheet, profile); 0 if never
 * @param {number}  ctx.intervalMs            - operator cadence between checks, in ms (defaults to 1h if absent)
 * @param {number}  ctx.now                   - epoch ms (current time — injected for testability)
 * @returns {boolean}
 */
/** Ortus Basics: a connection check NEVER starts on its own. It runs only when
 *  the operator asks for one (Check connections / Check now, or choosing the
 *  Check Status campaign type). This switches off the two checks that used to
 *  piggy-back on a running campaign: the idle bulk-check between turns and the
 *  in-batch sweep after a send. */
export const AUTOMATIC_CHECKS_ENABLED = false;

export function shouldFireIdleBulkCheck(ctx) {
  if (!AUTOMATIC_CHECKS_ENABLED) return false;
  // v2.62: connect_and_message (CC+DM) shares the same connect-then-
  // followup loop shape as CC+IC, so idle bulk-checks apply equally.
  if (ctx.mode !== 'connect_and_introduce' && ctx.mode !== 'connect_and_message') return false;
  if (ctx.now - ctx.campaignStartTime < IDLE_CAMPAIGN_MIN_DURATION_MS) return false;
  if (ctx.profileBrowserOpen) return false;
  if (ctx.profileWeeklyLimited) return false;
  if (ctx.semaphoreAvailable <= 0) return false;
  // Between-checks interval is the operator cadence (ms), passed in by the
  // caller. Defaults to 1h if a caller forgets it (matches the picker minimum).
  const intervalMs = Number.isFinite(ctx.intervalMs) ? ctx.intervalMs : 60 * 60 * 1000;
  if (ctx.now - ctx.lastBulkCheckAt < intervalMs) return false;
  return true;
}

async function appendHistory(entry) {
  await updateJsonAtomic(HISTORY_PATH, [], (value) => {
    const history = Array.isArray(value) ? value : [];
    history.push({ ...entry, runId: entry.runId || `${entry.startedAt || entry.date || Date.now()}-${Math.random().toString(36).slice(2, 9)}` });
    return history;
  });
}

// Data directory creation is handled centrally in src/paths.js.

async function loadState() {
  const s = await readJson(STATE_FILE, { processed: {}, dailyCounts: {} });
  // Phase 2.8.20 (W3-D1): prune entries older than retention window.
  // Done at load (not save) so the trim happens once per process startup
  // rather than on every campaign-step persistence.
  const cutoff = Date.now() - STATE_RETENTION_DAYS * 86400000;
  let pruned = 0;
  for (const [url, entry] of Object.entries(s.processed || {})) {
    const ts = entry?.date ? Date.parse(entry.date) : NaN;
    if (Number.isFinite(ts) && ts < cutoff) {
      delete s.processed[url];
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[state] pruned ${pruned} entries older than ${STATE_RETENTION_DAYS}d`);
  }
  return s;
}
async function saveState(s) { await writeJsonAtomic(STATE_FILE, s); }

// Bulk-check cooldown helpers. Stored as { "<sheetId>|<profileId>": timestamp }
// so different sheets don't share a single profile's cooldown.
async function readBulkCheckCooldown() {
  try { return JSON.parse(await readFile(BULK_CHECK_FILE, 'utf8')); }
  catch { return {}; }
}
async function writeBulkCheckCooldown(map) {
  try { await writeFile(BULK_CHECK_FILE, JSON.stringify(map, null, 2)); }
  catch (err) { console.warn(`[bulk-check] cooldown write failed: ${err.message}`); }
}
function bulkCheckKey(sheetId, profileId) { return `${sheetId}|${profileId}`; }
// Extract spreadsheet ID from a Google Sheet URL.
function _extractSheetIdFromUrl(url) {
  const m = (url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * Pure run-guard decision: is the source we're about to send from actually a
 * lead tab? Safety backstop in front of every send. No I/O — the caller
 * gathers the inputs (just-fetched rows, the chosen gid, tab metadata).
 *
 * @param {object} args
 * @param {number} args.tabCount - number of tabs in the workbook (unknown → 1).
 * @param {string} args.gid - the operator-chosen tab gid ('' when none chosen).
 * @param {string} args.tabName - name of the resolved tab ('' when unknown).
 * @param {Record<string,string>[]} args.rows - the rows just fetched.
 * @returns {{ ok: boolean, reason: string }}
 */
export function decideLeadSource({ tabCount, gid, tabName, rows }) {
  if (Number(tabCount) > 1 && !gid) {
    return { ok: false, reason: 'multiple tabs, no tab chosen' };
  }
  if (tabName && isSystemTabName(tabName)) {
    return { ok: false, reason: 'system tab, not leads: ' + tabName };
  }
  if (!looksLikeLeadRows(rows)) {
    return { ok: false, reason: 'tab does not look like a lead list' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * Host-resource preflight — non-blocking. Returns warnings if the host
 * is already under heavy load so the caller can surface them to the
 * operator before opening any browsers.
 */
async function checkHostHealth() {
  const warnings = [];
  const GB = 1024 * 1024 * 1024;
  // 2.9.8: use vm_stat-based "available" RAM on macOS instead of os.freemem(),
  // which only counts strictly-free pages and ignores reclaimable inactive +
  // file-cached pages. The strict-free metric is always tiny on a healthy
  // Mac, which used to falsely warn "0.1GB free" on machines with 2-3 GB of
  // actually-available RAM.
  const mem = await readAvailableMemory();
  const availableGB = mem.availableBytes / GB;
  const totalGB = mem.totalBytes / GB;
  const load1 = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const loadThreshold = cpuCount * 0.8;

  if (availableGB < 2) {
    warnings.push(`Available RAM is ${availableGB.toFixed(1)}GB / ${totalGB.toFixed(1)}GB total — low.`);
  }
  if (load1 > loadThreshold) {
    warnings.push(`1-min load average ${load1.toFixed(2)} exceeds ${loadThreshold.toFixed(2)} (${cpuCount} CPUs × 0.8).`);
  }
  return { ok: warnings.length === 0, warnings };
}

// v2.11.11: "Sender" is the canonical sheet column for sender attribution.
// Earlier versions of the bot wrote to both "Account Used" and "Sender";
// the Apps Script bridge schema dropped "Account Used" and the bot's
// writeback no longer fills it. This helper centralises the read so the
// next column-name change is a one-line edit instead of a grep + 3 sites.
//
// v2.58.x: The Introduction Campaign mode (introduce_back) lets operators
// point the bot at a non-canonical sender column — e.g. a sheet whose
// header is "LinkedIn 1st Connections" instead of "Sender". When a
// senderColumn is provided, read from it first; fall back to the canonical
// Sender/sender keys so existing campaigns keep working unchanged.
function getSenderName(row, senderColumn) {
  if (senderColumn && row && row[senderColumn] != null) {
    const v = row[senderColumn].toString().trim();
    if (v) return v;
  }
  return (row?.Sender || row?.sender || '').toString().trim();
}

// v2.84: pure helper — build the batch-update payload that flags ('Y') or
// clears ('') the "Needs Login" SoO column for every row assigned to one
// account. An account that needs re-login can't touch any of its leads, so we
// flag them all; cleared on the account's next success. The Apps Script routes
// `needsLogin` to the column by HEADER NAME (writeFields), so it survives the
// column moving position. Exported for unit testing; the campaign loop wraps
// this with the network write + per-run dedup.
export function buildNeedsLoginUpdates(rows, accountName, senderColumn, linkedinColumn, value) {
  const acctNorm = (accountName == null ? '' : accountName.toString().toLowerCase().trim());
  if (!acctNorm) return [];
  const updates = [];
  for (const r of (rows || [])) {
    const rowAcct = (getSenderName(r, senderColumn) || '').toString().toLowerCase().trim();
    if (rowAcct !== acctNorm) continue;
    const url = extractLinkedInUrl(r, linkedinColumn);
    if (!url) continue;
    updates.push({ linkedinUrl: url, needsLogin: value });
  }
  return updates;
}

// Campaign-scoped counters — reset every time a campaign starts
const campaignCounts = {};
const campaignSendCounts = {};
const campaignMessageCounts = {};

// v2.14.x: Snapshot of the most recent startCampaign() options, captured
// at run-start. Used by restoreCampaign() to re-launch with the exact same
// settings after a force-reset. Survives until the next startCampaign;
// cleared explicitly is never necessary (next start overwrites). Lost on
// app restart — Restore-after-crash falls back to history.json's last
// entry, which carries the same shape via its settings snapshot.
let _lastRunSettings = null;

function getCampaignCount(profileId) {
  return campaignCounts[profileId] || 0;
}
function bumpCampaignCount(profileId) {
  campaignCounts[profileId] = (campaignCounts[profileId] || 0) + 1;
}
function getCampaignSendCount(profileId) { return campaignSendCounts[profileId] || 0; }
function bumpCampaignSendCount(profileId) {
  campaignSendCounts[profileId] = (campaignSendCounts[profileId] || 0) + 1;
}
function getCampaignMessageCount(profileId) { return campaignMessageCounts[profileId] || 0; }
function bumpCampaignMessageCount(profileId) {
  campaignMessageCounts[profileId] = (campaignMessageCounts[profileId] || 0) + 1;
}

// 2.9.8: normalize any skip/failure reason to a "Skipped: <reason>" form
// for consistent display in the dashboard log and the Audit-Log "Action"
// column. Success messages pass through untouched.
export function normalizeSkipReason(msg) {
  if (!msg) return msg;
  const s = String(msg);
  if (s.startsWith('Skipped:')) return s;
  // Success / non-skip cases — pass through untouched
  if (/^(Connection sent|Message sent|InMail sent|Open Profile message sent|Acceptance confirmed|sent IC|Already in target state|Already connected|Still pending)/i.test(s)) {
    return s;
  }
  const lower = s.toLowerCase();
  if (lower.includes('legacy sales nav')) return 'Skipped: Legacy Sales Nav URL';
  // v2.112.26 (#4): dead profile — must win over the generic "profile not found"
  // rule below so the operator sees the precise 404 wording they chose.
  if (lower.includes('profile_not_found_404')) return 'Skipped: Profile not found (404)';
  if (lower.includes('profile not found') || lower.includes('url not found')) return 'Skipped: URL not found';
  if (lower.includes('login page detected') || lower.includes('session expired')) return 'Skipped: Session expired';
  if (lower.includes('email required')) return 'Skipped: Email required';
  if (lower.includes('connect button not found')) return 'Skipped: Connect button not found';
  // v2.14.x: modal cross-check detected we clicked Connect for someone
  // other than the profile owner (e.g. a sidebar firstName collision).
  if (lower.includes('connect_modal_wrong_person')) return 'Skipped: Connect modal opened for wrong person';
  if (lower.includes('send not confirmed') || lower.includes('send_not_confirmed')) return 'Skipped: Send not confirmed';
  // v2.10.0 — VOYAGER_REJECTED carries the HTTP status + LinkedIn's own error reason.
  // v2.78 — a bare 429 is ambiguous: it's USUALLY the weekly invitation cap, but
  // can also be a transient throttle. We don't claim the weekly cap until it's
  // confirmed (HTTP_429_PARK_THRESHOLD consecutive 429s → park). So the per-
  // attempt line reads "rate-limited, confirming"; the park line states the cap.
  // Other statuses (400/403/etc.) are rare — keep the code visible for diagnostics.
  if (lower.includes('voyager_rejected')) {
    const statusMatch = s.match(/HTTP\s+(\d+)/i);
    if (statusMatch && statusMatch[1] === '429') return 'Skipped: Likely weekly invitation limit reached (HTTP 429) — confirming…';
    return statusMatch ? `Skipped: LinkedIn rejected (HTTP ${statusMatch[1]})` : 'Skipped: LinkedIn rejected';
  }
  // v2.112.x — note longer than LinkedIn's free 200-char custom-invite cap: the
  // sending account isn't Premium, so Send stayed disabled. Operator wording.
  if (lower.includes('note_too_long')) return 'Skipped: Profile not premium, custom notes limit';
  if (lower.includes('weekly invitation limit') || lower.includes('weekly_limit')) return 'Skipped: Weekly limit reached';
  if (lower.includes('inmail credits') || lower.includes('inmail_no_credits')) return 'Skipped: InMail credits exhausted';
  if (lower.includes('not yet connected')) return 'Skipped: Not yet connected';
  if (lower.includes('not confirmed connected')) return 'Skipped: Not confirmed connected';
  if (lower.includes('linkedin error toast') || lower.includes('linkedin_error_toast')) return 'Skipped: LinkedIn error toast';
  if (lower.includes('not open profile') || lower.includes('not_open_profile')) return 'Skipped: contact is either not Open Profile or the sending account has reached its monthly OP credit limit';
  if (lower.includes('rate_limited') || lower.includes('rate-limit')) return 'Skipped: Rate limited';
  if (lower.includes('lead_timeout_watchdog') || lower.includes('lead timeout')) return 'Skipped: Lead timed out';
  if (lower.includes('no modal appeared')) return 'Skipped: Connect modal did not appear';
  if (lower.includes('connect failed')) return 'Skipped: Connect failed';
  // Fallback for unknown errors — still prefix
  return `Skipped: ${s}`;
}

// ── The per-account panel's words ────────────────────────────────────────────
// Everything below turns an internal reason into one sentence an operator can
// read out loud. The vocabulary is the one that already exists: the reasons
// normalizeSkipReason() produces, the reasons recordProfileEnd() records, and
// the errors a monitoring sweep returns. Nothing here invents a new reason.

const NEEDS_LOGIN_LINE = 'This account needs to be logged in again in GoLogin.';
const SLOW_DOWN_LINE = 'LinkedIn asked this account to slow down.';
const WEEKLY_LINE = 'This account has used up its invitations for the week.';

/**
 * What a monitoring sweep just learned about one account, or null when the
 * sweep worked.
 *
 * A sweep that failed for one account used to push a single line into a log
 * that scrolls away, after which the account looked healthy for the rest of
 * the run. The card needs a state that stays put until that account's next
 * check succeeds.
 */
export function sweepHealth(error) {
  if (!error) return null;
  const s = String(error).toLowerCase();
  if (/session-expired|session expired|\/login|\/uas\/|checkpoint|no-csrf/.test(s)) {
    return { state: 'needs-login', note: NEEDS_LOGIN_LINE };
  }
  if (/navigation-failed|launch|browser|timeout|closed|crash/.test(s)) {
    return { state: 'cannot-open', note: 'The browser for this account would not open, so it was not checked.' };
  }
  if (/429|999|rate.?limit|throttl/.test(s)) {
    return { state: 'rate-limited', note: SLOW_DOWN_LINE };
  }
  if (/stopped by you/.test(s)) {
    return { state: 'trouble', note: 'You stopped the check before this account finished.' };
  }
  return { state: 'trouble', note: 'The last check did not finish for this account.' };
}

// Skip-ledger reason slugs (src/skip-ledger.js) as sentences.
const MISS_BY_SLUG = {
  already_processed: 'Already contacted from this app before.',
  identity_unconfirmed: 'The profile that opened was not this person, so nothing was sent.',
  watchdog_timeout: 'Their page took too long to load, so this account moved on.',
  malformed_url: 'That row has no usable LinkedIn address.',
  duplicate_row: 'The same person appears more than once in the sheet.',
  failed_repeatedly: 'Tried more than once and it kept failing.',
  terminal_stage: 'The sheet already says this one is done.',
};

// The wording normalizeSkipReason() produces, matched loosely, as sentences.
// Order matters: the first match wins, so the specific cases come first.
const MISS_BY_DETAIL = [
  [/session expired|login page/, NEEDS_LOGIN_LINE],
  [/likely weekly/, 'LinkedIn refused this invitation (HTTP 429). Most likely this account has reached its weekly invitation limit.'],
  [/weekly/, WEEKLY_LINE],
  [/429|rate.?limit/, SLOW_DOWN_LINE],
  [/inmail credits/, 'This account has no InMail credits left.'],
  [/not premium|notes limit|note_too_long/, 'The note was longer than a non-Premium account is allowed to send.'],
  [/not found|404/, 'That LinkedIn profile no longer exists.'],
  [/legacy sales nav/, 'The sheet has an old Sales Navigator address for them, which cannot be opened.'],
  [/email required/, 'LinkedIn wanted their email address before it would connect.'],
  [/not open profile/, 'Either they are not an Open Profile, or this account has used up its monthly Open Profile credits.'],
  [/not yet connected|not confirmed connected/, 'They have not accepted the invitation yet.'],
  [/wrong person/, 'The connect window opened on somebody else, so nothing was sent.'],
  [/connect button|modal/, 'LinkedIn did not offer a connect button on their profile.'],
  [/send not confirmed/, 'LinkedIn never confirmed the send, so it was not counted.'],
  [/timed out|timeout/, 'Their page took too long to load, so this account moved on.'],
  [/error toast/, 'LinkedIn showed an error on their profile.'],
];

/** Why one person was not reached, as a sentence. Never a reason key. */
export function missReason(slug, detail) {
  const known = MISS_BY_SLUG[slug];
  if (known) return known;
  const d = String(detail || '').toLowerCase();
  for (const [re, line] of MISS_BY_DETAIL) if (re.test(d)) return line;
  return 'Something went wrong on their profile, so nothing was sent.';
}

// The reasons recordProfileEnd() stores carry version notes, counters and code
// words. Rewritten here so the card never prints them raw.
const PARK_LINES = [
  [/session expired/, NEEDS_LOGIN_LINE],
  [/suspected weekly|weekly.*429/, 'Suspected weekly invitation limit — LinkedIn refused its invite, which is nearly always the weekly limit. Try again on the next round to test it.'],
  [/weekly/, WEEKLY_LINE],
  [/op credit/, 'Suspected OP credits limit reached — five contacts in a row were not Open Profile. Choose Try again to unbench it.'],
  [/note credits/, 'This account has run out of invitations that carry a note.'],
  [/not premium/, 'The note was longer than a non-Premium account is allowed to send.'],
  [/inmail/, 'This account has no InMail credits left.'],
  [/campaign limit/, 'This account reached the limit you set for the day.'],
  [/checkpoint|challenge/, 'LinkedIn wants a person to confirm this account before it can carry on.'],
  [/throttl/, 'Paused while this Mac was under strain. It picks up again on the next run.'],
  [/unconfirmed streak|consecutive unconfirmed/, 'Five leads in a row could not be confirmed. Open this account, then choose Try again.'],
  [/identity/, 'Stopped early because the profiles opening were not the people in the sheet.'],
  [/consecutive skips/, 'Stopped early after several people in a row could not be reached.'],
  [/complete/, 'Finished every row it was given.'],
];

/** A park reason as a sentence. '' when there is no reason to explain. */
export function parkSentence(reason) {
  if (!reason) return '';
  // Park reasons arrive both as prose ('Session expired — log in again') and as
  // code words ('session_expired'), so flatten the underscores before matching.
  const r = String(reason).toLowerCase().replace(/_/g, ' ');
  for (const [re, line] of PARK_LINES) if (re.test(r)) return line;
  return 'This account stopped early.';
}

export function extractLinkedInUrl(row, linkedinColumn) {
  // 1. User-specified column takes priority
  if (linkedinColumn && row[linkedinColumn]) {
    let v = row[linkedinColumn].trim();
    // Already a full URL (http://linkedin.com, https://linkedin.com, linkedin.com/...)
    if (v.includes('linkedin.com')) {
      if (!v.startsWith('http')) v = 'https://' + v;
      return v;
    }
    // Slug or ID without domain — convert to URL
    if (v && !v.includes(' ') && !v.includes('@')) {
      return `https://www.linkedin.com/in/${v}`;
    }
  }

  // 2. Fallback: scan all columns for any value containing linkedin.com
  for (const key of Object.keys(row)) {
    const v = (row[key] || '').trim();
    if (v.includes('linkedin.com')) {
      return v.startsWith('http') ? v : 'https://' + v;
    }
  }
  return null;
}

export function getModeHint(mode, prevAction) {
  if (mode === 'connect_only') return 'force_connect';
  // Phase 1 of connect_and_introduce + connect_and_message is identical to
  // connect_only — send the connection request. Phase 2 (the post-acceptance
  // message — intro 3-way DM for CC+IC, plain 1:1 DM for CC+DM) is handled
  // by the bulk-check sweep + runAutoIntros/runAutoDms; this mode hint just
  // covers the per-lead connect step.
  if (mode === 'connect_and_introduce' || mode === 'connect_and_message') return 'force_connect';
  if (mode === 'message_only' || mode === 'introduce_back') return 'force_message';
  if (mode === 'check_status') return 'check_only';
  if (mode === 'inmail_only') return 'force_inmail';
  if (mode === 'open_profile_only') return 'force_open_profile';
  return null;
}

// v2.14.x — Pure predicate: is this v2-schema row eligible for a standalone
// DM (message_only) or IB (introduce_back) send?
//
// History: the original filter only matched Stage === 'Connected · DM Now',
// which is written by ONE code path — the per-lead Voyager check in
// outreach.js (status_accepted action → buildSheetDataForAction at line 908).
// The bulk-check (bulk-check-connections.js:164-188) writes
// `cc: 'Connected'` to the 'Connection Accepted Status' column but does NOT
// touch Stage, so after a real CC → bulk-check flow every accepted row
// still has Stage = 'Connect Pending'. Standalone DM/IB campaigns silently
// found zero targets on those sheets.
//
// This predicate accepts three Stage states that all mean "row is connected,
// safe to DM":
//   - 'Connected · DM Now'  — per-lead Voyager check confirmed (status_accepted)
//   - 'Already connected'   — bulk-check Path B, pre-existing 1st-degree
//   - 'Connect Pending'     iff Connection Accepted Status says Connected
//                             (bulk-check Path A leaves Stage unchanged but
//                             writes cc)
//
// Terminal stages (DM Sent / IC Sent / OP Sent / InM Sent / Replied / Done)
// and any Skipped-* stage are rejected so reruns can't re-send. CC+IC's
// monitoring path is intentionally NOT touched — it bypasses this filter
// entirely (runAutoIntros reads connectedUrls directly from bulk-check).
export function isDmIbEligible(row) {
  const stage = (row['Stage'] || row['stage'] || '').toString().trim();
  if (!stage || stage.startsWith('Skipped')) return false;
  const TERMINAL = new Set(['DM Sent', 'IC Sent', 'InM Sent', 'OP Sent', 'Replied', 'Done']);
  if (TERMINAL.has(stage)) return false;
  if (stage === 'Connected · DM Now' || stage === 'Already connected') return true;
  if (stage === 'Connect Pending') {
    const cc = (
      row['Connection Accepted Status'] || row['connection accepted status'] ||
      row['Connected Status']            || row['connected status'] || ''
    ).toString().trim();
    return cc === 'Connected' || cc === 'Already connected';
  }
  return false;
}

// v2.96.0 — PRE-SEND identity gate. The connect flow (outreach.js → actions.js)
// navigates to the lead URL and clicks Connect with NO check that the loaded
// profile is the intended lead. Encoded /in/ACwAA… URLs that mis-load under
// LinkedIn rate-limiting therefore sent the (correctly-named) connection note
// to the WRONG person — including strangers and an internal colleague
// (2026-06-11 incident). This gate runs BEFORE the send: it navigates, captures
// the loaded profile, and verifies its identity against the sheet row. It
// re-navigates up to MAX_IDENTITY_ATTEMPTS; if it can never POSITIVELY confirm,
// the caller skips the lead (skip-on-doubt) rather than risk a wrong send.
export const MAX_IDENTITY_ATTEMPTS = 5;
// v2.105.2: pause between identity retries. "no-member-number-captured (profile
// did not load)" is a rate-limited/slow session — retrying instantly just hits
// the same cold state. Give the session 20s to breathe before re-navigating.
export const IDENTITY_RETRY_DELAY_MS = 20_000;

// v2.96.0 (Phase 2) — outcomes that mean "the session/page is degrading" (a
// navigation race, timeout, profile-not-found, rate-limit, or an
// identity-unverified skip) as opposed to a benign skip like already-connected.
// A cluster of these escalates the inter-lead backoff and, if it never clears,
// parks the account. Pure + tested.
export function isDegradationSignal(errorMsg) {
  return /Execution context was destroyed|lead_timeout_watchdog|Navigation timeout|net::ERR_|Profile not found|page_not_found|rate_limited|too many requests|HTTP 429|\b429\b|linkedin_error|something went wrong|LINKEDIN_ERROR_TOAST|SEND_NOT_CONFIRMED|identity[-_ ]unverified|identity unverified/i
    .test(String(errorMsg || ''));
}

// v2.96.0 (Phase 2) — exponential backoff for a degradation streak. Pure +
// tested. streak 0 ⇒ baseMs unchanged; each consecutive degraded lead doubles
// the wait, capped by maxMult and an absolute maxMs ceiling, so a degrading
// LinkedIn session gets time to recover instead of being hammered.
export function degradationBackoffMs(baseMs, streak, { maxMult = 32, maxMs = 20 * 60 * 1000, jitter = false, rng = Math.random, retryAfterMs = 0 } = {}) {
  const s = Math.max(0, Math.floor(streak || 0));
  const mult = Math.min(maxMult, 2 ** s);
  const capped = Math.min(maxMs, baseMs * mult);
  const val = jitter ? Math.floor(rng() * capped) : capped;
  return Math.max(val, retryAfterMs);
}

// v2.112.7 — classify a connect-failure message into one of five buckets so the
// campaign loop can route throttling, invite caps, checkpoints, transient glitches,
// and benign outcomes to the right recovery paths. Pure + exported. Test in
// PRIORITY order (invite_cap before throttle so "weekly invitation limit" is never
// caught by the generic 429/rate-limited rule).
export function classifyConnectFailure(msg) {
  const m = String(msg || '').toLowerCase();
  if (/weekly invitation|invitation limit|weekly_limit/.test(m)) return 'invite_cap';
  if (/checkpoint|captcha|unusual activity|verify (you|your)|challenge/.test(m)) return 'challenge';
  if (/429|rate[_ ]limited|too many requests|resource level throttle|voyager_rejected/.test(m)) return 'throttle';
  if (/execution context was destroyed|navigation|timeout|net::err_|no modal appeared|context was destroyed/.test(m)) return 'transient';
  return 'benign';
}

// v2.96.2 — normalize a Sales-Navigator lead URL to its /in/<urn> form so the
// identity gate can verify it the same way performOutreach connects (which does
// the same reverse transform, outreach.js). Legacy /sales/profile/<numeric>,…,
// NAME_SEARCH has no extractable AC-URN → returned unchanged → the gate fails to
// load a profile and skips (safe). Pure + tested.
export function salesNavToInUrl(url) {
  const m = String(url || '').match(/\/sales\/(?:lead|people)\/(AC[ow]AA[A-Za-z0-9_-]+)/i);
  return m ? `https://www.linkedin.com/in/${m[1]}` : (url || '');
}

// LinkedIn's encoded /in/ACwAA… and /in/ACoAA… identifiers carry the numeric
// member id in their base64url payload. The browser APIs occasionally omit the
// same values on a late-rendering profile (the sender-specific blank-column
// bug), but the URL is already verified by the identity gate and is therefore a
// safe fallback. Keep this local and deterministic: no extra LinkedIn request.
export function recoverProfileIdentityFromUrl(url) {
  const token = (String(url || '').match(/(AC[ow]AA[A-Za-z0-9_-]+)/i) || [])[1] || '';
  let memberNumber = '';
  if (token) {
    try {
      const buf = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (buf.length >= 8) {
        const n = buf.readUInt32BE(4);
        if (n > 0 && n < 4294967295) memberNumber = String(n);
      }
      if (!memberNumber && buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n > 0 && n < 4294967295) memberNumber = String(n);
      }
    } catch { /* malformed token → leave unknown */ }
  }
  return { memberId: token, memberNumber };
}

function mergeProfileMeta(...parts) {
  const out = { memberId: '', memberNumber: '', name: '', isOpenProfile: null, connectionDegree: null };
  for (const p of parts) {
    if (!p) continue;
    if (!out.memberId && p.memberId) out.memberId = p.memberId;
    if (!out.memberNumber && p.memberNumber) out.memberNumber = String(p.memberNumber);
    if (!out.name && p.name) out.name = p.name;
    if (out.isOpenProfile == null && p.isOpenProfile != null) out.isOpenProfile = !!p.isOpenProfile;
    if (out.connectionDegree == null && p.connectionDegree != null) out.connectionDegree = p.connectionDegree;
  }
  return out;
}

// v2.112.26 (#4): true when the loaded page is LinkedIn's "this page doesn't
// exist" interstitial — the dead-profile case the identity gate must skip
// terminally rather than retry. Mirrors the proven text probe in outreach.js
// (matches "this page doesn" so it's robust to straight vs curly apostrophes).
// Best-effort: any eval failure (context destroyed mid-nav) → false.
async function pageShowsProfileNotFound(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body?.innerText || '').toLowerCase().slice(0, 3000);
      return t.includes('this page doesn') && t.includes('exist');
    });
  } catch { return false; }
}

export async function gateConnectIdentity(page, { url, row, sourceName = '', log = () => {}, verifyIdentity = true }) {
  const sourceMemberId = readSourceMemberId(row);
  // Verify the same profile performOutreach will connect on: a /sales/ lead URL
  // is rewritten to /in/<urn> before the connect, so gate the /in/ form.
  const navUrl = salesNavToInUrl(url);
  // v2.113: operator disabled the identity safeguard (sidebar toggle, sticky
  // per-operator pref, default ON). Behave like pre-gate v2.97 — navigate to the
  // sheet URL and let the connect fire on whatever loads — BUT keep the 404
  // dead-profile short-circuit so a bad URL is still stamped "Profile not found"
  // instead of burning a connect attempt (operator-confirmed: 404 stays on).
  // No name/member matching, no 5× retry loop, no skip-on-doubt.
  if (!verifyIdentity) {
    try {
      await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const _landed = page.url();
      if (is404Url(_landed) || await pageShowsProfileNotFound(page)) {
        return { ok: false, reason: 'profile_not_found_404', notFound: true, loaded: { name: '', memberNumber: '' } };
      }
    } catch (e) {
      // Navigation glitched (context destroyed mid-nav, timeout). Don't skip the
      // lead — just don't claim the page is on the profile. The caller treats
      // navigated:false as "performOutreach must navigate itself" (skipNavigation
      // off), exactly the v2.97 send path.
      return { ok: true, reason: `identity-gate-disabled (nav failed: ${e.message})`, loaded: { name: '', memberNumber: '' }, navigated: false };
    }
    // Page is on the lead's profile already → let the send reuse this navigation.
    return { ok: true, reason: 'identity-gate-disabled', loaded: { name: '', memberNumber: '' }, navigated: true };
  }
  let last = { ok: false, reason: 'not-attempted', loaded: { name: '', memberNumber: '' } };
  // v2.112.26 (#5): Stop must interrupt this loop immediately. The 20s
  // inter-attempt wait polls campaign._abort so a mid-wait Stop breaks out fast
  // instead of grinding through all MAX_IDENTITY_ATTEMPTS.
  const abortableSleep = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !campaign._abort) {
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  for (let attempt = 1; attempt <= MAX_IDENTITY_ATTEMPTS; attempt++) {
    // v2.112.26 (#5): operator pressed Stop → bail now rather than running the
    // remaining attempts. Skip-on-doubt: the caller treats !ok as a skip.
    if (campaign._abort) { last.reason = `aborted-by-stop (${last.reason})`; return last; }
    let meta = {};
    let landedUrl = '';
    try {
      // v2.112.7 (Fix B): on a re-navigation (attempt > 1), force a real page
      // teardown first — an SPA same-URL goto can be a no-op, so a wedged page
      // never actually reloads. about:blank guarantees a fresh load below.
      if (attempt > 1) await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
      await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // v2.112.26 (#4): dead-profile short-circuit BEFORE the 12s render wait.
      // A 404 / "this page doesn't exist" can never resolve to the intended
      // member, so retrying 5× at 20s each is pure waste. Bail immediately and
      // let the caller stamp the row "Skipped: Profile not found (404)". The URL
      // check catches the /404 + /in/unavailable redirects; the text probe
      // catches the interstitial that keeps the original /in/ URL.
      {
        const _landed = page.url();
        if (is404Url(_landed) || await pageShowsProfileNotFound(page)) {
          return { ok: false, reason: 'profile_not_found_404', notFound: true, loaded: { name: '', memberNumber: '' } };
        }
      }
      // v2.103: wait for the profile top-card to actually PAINT before reading,
      // instead of a blind 2.5s. LinkedIn renders the <h1> name client-side
      // after domcontentloaded, so the old fixed wait read an empty name every
      // time → name-match never fired → the gate leaned entirely on the
      // rate-limited Voyager member-number API and mass-skipped healthy leads
      // ("no-member-number-captured"). Polling for the <h1> also lets the
      // encoded /in/ACwAA… → vanity redirect settle, avoiding the
      // "Execution context was destroyed" mid-navigation race.
      await waitForProfileRender(page, { timeoutMs: 12000 });
      landedUrl = page.url();
      meta = await captureProfileMeta(page);
    } catch (e) {
      // A throw here ("Execution context was destroyed, …navigation") IS the
      // degradation signal — treat as unconfirmed and retry on a fresh load.
      last = { ok: false, reason: `capture-threw: ${e.message}`, loaded: { name: '', memberNumber: '' } };
      log(`  ⟳ ${attempt}/${MAX_IDENTITY_ATTEMPTS} identity unconfirmed — ${last.reason}`);
      if (attempt < MAX_IDENTITY_ATTEMPTS) {
        log(`  ⏳ waiting ${IDENTITY_RETRY_DELAY_MS / 1000}s before retry…`);
        await abortableSleep(IDENTITY_RETRY_DELAY_MS);
      }
      continue;
    }
    const v = verifyConnectIdentity({
      capturedMemberNumber: meta.memberNumber,
      capturedUrn: meta.memberId,
      capturedName: meta.name,
      leadUrl: navUrl,
      landedUrl,
      sourceMemberId,
      sourceName,
      strict: true,
    });
    last = { ok: v.ok, reason: v.reason, loaded: { name: meta.name || '', memberNumber: meta.memberNumber || '' } };
    if (v.ok) {
      if (attempt > 1) log(`  ✓ identity confirmed on attempt ${attempt} (${v.reason})`);
      // Do not throw away the profile data that was read on the VERIFIED page.
      // The old flow scraped a second time after Connect and used only that
      // result; a late/empty second response is why one sender populated the
      // four metadata columns while another sender left them blank.
      const recovered = recoverProfileIdentityFromUrl(navUrl);
      last.identity = mergeProfileMeta(meta, recovered, {
        memberNumber: sourceMemberId,
      });
      return last;
    }
    log(`  ⟳ ${attempt}/${MAX_IDENTITY_ATTEMPTS} identity unconfirmed — ${v.reason}`);
    if (attempt < MAX_IDENTITY_ATTEMPTS) {
      log(`  ⏳ waiting ${IDENTITY_RETRY_DELAY_MS / 1000}s before retry…`);
      await abortableSleep(IDENTITY_RETRY_DELAY_MS);
    }
  }
  return last;
}

// v2.59.x: Does this (action, mode) represent a pending invite worth
// monitoring for acceptance? A NEW invite (connection_sent) always does. A
// lead ALREADY invited in a prior campaign returns already_processed
// (stamped "Connect Pending") in the connect-then-followup modes — that is
// still an outstanding invite the monitoring phase must watch (catch the
// acceptance → fire auto-DM / auto-intro). Counting only connection_sent
// meant a re-run on already-pending leads ended "0 sent → no monitoring", so
// "Stop sending, keep monitoring" had nothing to start even with real pending
// invites out there. Used to populate profilesThatSentAtLeastOne, which gates
// the running→monitoring transition.
export function countsAsMonitorableInvite(action, mode) {
  if (action === 'connection_sent') return true;
  if (action === 'already_processed' &&
      (mode === 'connect_and_introduce' || mode === 'connect_and_message')) {
    return true;
  }
  return false;
}

// Phase 2.8.20 (W3-C2): cached disk status, refreshed on a 30s interval.
// Kept module-local so getCampaignStatus() can stay synchronous (it's called
// from /api/campaign/status hot path).
let _diskStatusCache = { freeBytes: null, thresholdBytes: 0, ok: true, error: null };
async function _refreshDiskStatus() {
  try { _diskStatusCache = await checkDiskFree(); } catch (_) {}
}
_refreshDiskStatus();
setInterval(_refreshDiskStatus, 30000).unref?.();

// ── Campaign state (exposed to dashboard) ──
// Phase 1.2 of the parallel-campaigns refactor: the singleton `campaign`
// object is now registered as a single entry in a CampaignRegistry. The
// object itself is unchanged — all existing reads/writes (campaign.running,
// campaign.processedToday++, etc.) work exactly as before. Two derived
// getters (status, participatingProfileIds) project onto the shape the
// registry indexes on. Phase 1.3 onwards starts threading id through
// callers; for now there is always exactly one entry with this id.
export const SINGLETON_CAMPAIGN_ID = 'legacy-singleton';
export const registry = new CampaignRegistry();

// v2.74 — profileIds with a bulk/idle connection-check browser open RIGHT NOW.
// Populated by runIdleBulkCheck / runMonitoringCheck while their browser is
// live, cleared in their finally. stopCampaign() / stopMonitoring() force-close
// these so "Stop everything" halts checking within a second or two instead of
// grinding through every remaining account. Module-level (not on `campaign`) so
// it never gets serialized into persisted monitoring state.
const activeBulkChecks = new Set();
function _forceCloseActiveBulkChecks() {
  for (const pid of activeBulkChecks) {
    (pid === 'local-browser' ? closeLocalBrowser() : closeProfile(pid)).catch(() => {});
  }
}
// v2.78: let other modules (server.js's manual /api/bulk-check-now sweep)
// register their in-flight check browser so stopCampaign() force-closes it too.
export function addActiveBulkCheck(pid) { if (pid) activeBulkChecks.add(pid); }
export function removeActiveBulkCheck(pid) { if (pid) activeBulkChecks.delete(pid); }
// v2.78: force-close in-flight check browsers on demand (manual "Stop solo
// check" when no campaign is running, so stopCampaign isn't the right hook).
export function forceCloseActiveBulkChecks() { _forceCloseActiveBulkChecks(); }

// v2.78: may this account's CC+IC intros fire? Held while the account is known
// to be NOT connected to the primary ('pending'). Unknown (no entry — e.g. a
// monitoring sweep after restart) fails open so intros aren't blocked forever.
function _primaryIntroAllowed(profileId) {
  return (campaign._primaryConn && campaign._primaryConn.get(profileId)) !== 'pending';
}

export const campaign = {
  id: SINGLETON_CAMPAIGN_ID,
  // A stable registry slot is retained for compatibility; every actual run
  // receives its own identity so history, logs and recovery never infer runs
  // from a mutable campaign name.
  executionId: null,
  running: false,
  _abort: false,
  // Stop THIS acceptance check, not the campaign. _abort tears the whole run
  // down (stopCampaign sets it with _stoppedManually), so a check that reused
  // it would end monitoring too. Cleared when the sweep unwinds; state,
  // nextCheckAt and the monitoring window are never touched by it.
  _abortCheck: false,
  // The person the sweep is reading right now, so a stop can name them.
  _checkingLead: null,
  // v2.78: profileIds the operator has benched from the sending rotation for
  // the rest of THIS run. pickNextProfile skips them; reset each startCampaign
  // so a new campaign starts with every account active. (A Set — never
  // persisted; JSON.stringify drops it, which is fine since it's per-run.)
  _skippedProfiles: new Set(),
  _restrictedProfiles: new Map(),
  // v2.78: CC+IC per-account connection-to-primary status. profileId →
  // 'connected' | 'pending' (connect request sent, not yet accepted). Drives the
  // Live Status label and gates that account's intros. Reset each run.
  _primaryConn: new Map(),
  _primaryConnSource: new Map(), // profileId -> 'remembered' | 'live'
  _primaryStore: null,           // loaded data/primary-status.json (object) for this run
  _primaryKey: '',               // primaryKeyFromUrl(primaryUrl) for this run
  // v2.52.0: monotonic generation counter for orphan-loop detection.
  // startCampaign increments this and each loop captures its own myGen
  // closure. If restoreCampaign re-launches before the prior loop has
  // finished unwinding, the prior loop sees campaign._generation !== myGen
  // and exits immediately — regardless of whether _abort has been reset.
  // Without this, restoreCampaign creates orphan loops that keep sending
  // connections + transition to monitoring even after the operator's Stop.
  _generation: 0,
  // Phase 2.8.9: pause/resume. _pauseRequested flips immediately on user click;
  // _paused flips once the loop boundary acknowledges (i.e. current lead done).
  // The two-state separation lets the UI show "Pausing…" vs "Paused".
  _paused: false,
  _pauseRequested: false,
  currentProfile: null,
  processedToday: 0,
  totalProcessed: 0,
  // Phase 2.8.12: live cockpit action surface for the dashboard. Frontend
  // computes countdown remaining = max(0, endsAt - Date.now()). When endsAt
  // is null, the action is indeterminate (rotating arc).
  currentAction: null,
  logs: [],
  errors: [],
  parkedProfiles: [],
  // Local-browser re-login recovery (2026-06-15). _loginDone flips when the
  // operator clicks "Done" in the popup; awaitLocalLogin reads + resets it.
  _loginDone: false,
  // When set, the UI shows the "log into LinkedIn" popup. Shape:
  // { profileId, pName, since }. Cleared the moment the wait ends.
  awaitingLogin: null,
  softWarnings: [],
  // Plan B: per-profile end reasons — populated when an account is removed
  // from the rotation (weekly cap, parked, ejected, completed quota, etc.).
  // Read by the dashboard's account-queue table to explain why a row reads
  // "Done". Reset at startCampaign so each run starts clean.
  profileEndReasons: [],
  // v2.14.x: in-memory blacklist of leads already intro'd in this process.
  // Primary defense against re-firing the same IC DM when the sheet write
  // is delayed/dropped or when Google Sheets' CSV export cache lags behind
  // the most recent write. Bulk-check filters this set BEFORE pushing URLs
  // to connectedUrls; auto-intro .add()s URLs after successful (or already-
  // exists) intros. Reset on each new campaign start.
  introducedInRun: new Set(),
  // v2.62: same defense for the connect_and_message (CC+DM) mode — auto-dm
  // .add()s URLs after a successful DM so the next bulk-check sweep doesn't
  // re-fire the same message. Sheet stamp is `DM Status = "DM Sent"`.
  dmSentInRun: new Set(),
  // v2.61.0: count of MESSAGE_SEND_FAILED: compose-textbox failures per URL
  // within this process. Bulk-check uses it to stop re-queueing leads that
  // fail repeatedly even when reverify-and-downgrade (auto-intro.js) was
  // inconclusive (e.g. getConnectionStatus returned 'unknown'). Resets on
  // each new campaign run.
  composeAttempts: new Map(),
  name: '',
};

// Derived `status` getter for registry indexing — maps existing flags
// onto the four-state vocabulary the registry uses. participatingProfileIds
// is NOT defined here because the campaign loop already maintains it as a
// real writable field (campaign.js:1183, 2952): the subset of profiles that
// actually contributed in this run, not the same as the selected
// profileIds. Registry.activeProfileIds() reads it directly.
Object.defineProperty(campaign, 'status', {
  enumerable: false,
  configurable: true,
  get() {
    if (this._paused || this._pauseRequested) return 'paused';
    if (this.running) return 'running';
    if (this.state === 'monitoring') return 'monitoring';
    return 'idle';
  },
});

registry.register(campaign);

// Record why a profile finished its turn in this run. Idempotent: if the
// profile already has an entry, the first reason wins (so "weekly limit hit"
// isn't overwritten by a downstream "consecutive skips" trip-wire firing on
// the same loop iteration). Called everywhere weeklyLimited.add(profileId)
// fires.
function recordProfileEnd(profileId, profileName, reason) {
  if (!profileId || !reason) return;
  const existing = campaign.profileEndReasons.find((e) => e.profileId === profileId);
  if (existing) return;
  campaign.profileEndReasons.push({
    profileId,
    profileName: profileName || '',
    reason,
    at: Date.now(),
  });
}

/**
 * Record what a monitoring sweep just learned about ONE account, or clear it
 * when that account's check succeeded.
 *
 * During sending, an account that is logged out gets parked and the card shows
 * it. During monitoring, the same account only produced a log line that
 * scrolled out of view, after which it looked healthy forever. This is the
 * durable half of that: it survives until the account's next successful check.
 *
 * A sweep can cover accounts that are NOT in this campaign (the "all senders"
 * scope resolves them from the sheet's Sender column), so the name is stored
 * alongside the state rather than looked up from the campaign's own lists.
 */
function noteAccountHealth(profileId, profileName, error) {
  if (!profileId) return;
  campaign.accountHealth = campaign.accountHealth || {};
  const h = sweepHealth(error);
  if (!h) { delete campaign.accountHealth[profileId]; return; }
  campaign.accountHealth[profileId] = {
    profileName: profileName || '',
    state: h.state,
    note: h.note,
    at: Date.now(),
  };
}

// Phase 2.8.12: tiny helper — sets the action shown in the dashboard cockpit.
// durationMs > 0 = timed wait (countdown); durationMs null = indeterminate.
function setAction(label, opts = {}) {
  const { lead = null, account = null, mode = null, durationMs = null,
    phase = null, step = null, stepLabel = null, stepDetail = null } = opts;
  campaign.currentAction = {
    label,
    lead: lead || null,
    account: account || campaign.currentProfile || null,
    mode: mode || campaign.mode || null,
    endsAt: typeof durationMs === 'number' && durationMs > 0 ? Date.now() + durationMs : null,
    startedAt: Date.now(),
    phase: phase || null,
    step: step || null,
    stepLabel: stepLabel || label || null,
    stepDetail: stepDetail || null,
  };
  recordRuntimeInterruption('active-run');
}

// Helper for the central Operations Log (Ortus Operations Log sheet via
// log-writer.js). Fire-and-forget — never throws, never blocks. Reads
// campaign context from the global. Silent no-op when OPS_LOG_WEBAPP_URL
// is unset.
// Exported v2.57.x so auto-intro.js can surface intro failures with the
// same campaign key and severity classification, instead of those failures
// being trapped inside auto-intro's catch and never reaching the Ops Log.
export function _ops(severity, eventName, extra) {
  try {
    const e = extra || {};
    opsLogEvent(
      {
        name: campaign.name || '',
        startedAt: campaign.startedAt || '',
        operator: campaign.createdBy || '',
      },
      {
        severity,
        event: eventName,
        account: e.account || campaign.currentProfile || '',
        leadUrl: e.leadUrl || '',
        details: e.details || '',
        // v2.93 — structured fields for the single-Events-tab Ops Log v2.
        phase: e.phase || '',
        outcome: e.outcome || '',
        reason: e.reason || '',
      },
    );
  } catch (_) { /* fire-and-forget */ }
}

// v2.93 — push this campaign's at-a-glance Dashboard row to the Ops Log
// "Dashboard" tab. Fire-and-forget; the caller throttles the cadence.
function _pushDashboard(ended, endReason) {
  try {
    dashboardUpsert([summariseCampaign({
      name: campaign.name || '',
      operator: campaign.createdBy || '',
      mode: campaign.mode || '',
      ended: !!ended,
      endReason: endReason || '',
      totalTargets: campaign.totalTargets || 0,
      processed: campaign.totalProcessed || 0,
      tally: campaign.tally || emptyTally(),
    })]).catch(() => {});
  } catch (_) { /* never block the loop */ }
}

// 2.9.2: format a Date in the operator's local timezone (the Electron app
// runs on their machine, so new Date() already reflects their TZ — Philippines,
// Europe, US, wherever). Output: "May 4th, 13:43" — month abbreviation, day
// with ordinal suffix, 24h time, no seconds, no year.
const _MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatLocalDate(d) {
  const day = d.getDate();
  const ord = (day % 100 >= 11 && day % 100 <= 13) ? 'th'
            : (day % 10 === 1) ? 'st'
            : (day % 10 === 2) ? 'nd'
            : (day % 10 === 3) ? 'rd' : 'th';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${_MONTHS_SHORT[d.getMonth()]} ${day}${ord}, ${hh}:${mm}`;
}

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  campaign.logs.push(line);
  if (campaign.logs.length > 500) campaign.logs.shift();
  // 2.8.27: persist every line to data/campaign.log so post-run debugging
  // doesn't require dev-mode stdout. The in-memory campaign.logs is capped
  // at 500 lines; this file accumulates the full history. Rotation is
  // size-based at campaign start (rotateCampaignLogIfBig), so this hot-path
  // append stays cheap (no statSync per line).
  try {
    appendFileSync(CAMPAIGN_LOG_FILE, line + ` [campaignId=${campaign.campaignId || ''}] [runId=${campaign.executionId || ''}]` + '\n');
  } catch { /* never let logging take down the campaign */ }
}

/** 2.8.27: size-based rotation. Called once at campaign start. If campaign.log
 *  exceeds MAX bytes, rename to campaign.log.1 (overwriting any previous .1)
 *  and start fresh. Bounds disk usage at ~2x MAX without per-line overhead. */
const CAMPAIGN_LOG_FILE = dataPath('campaign.log');
const CAMPAIGN_LOG_ROTATED = dataPath('campaign.log.1');
const MAX_CAMPAIGN_LOG_BYTES = Number(process.env.MAX_CAMPAIGN_LOG_BYTES) || 50 * 1024 * 1024;
function rotateCampaignLogIfBig() {
  try {
    const sz = statSync(CAMPAIGN_LOG_FILE).size;
    if (sz >= MAX_CAMPAIGN_LOG_BYTES) renameSync(CAMPAIGN_LOG_FILE, CAMPAIGN_LOG_ROTATED);
  } catch { /* file doesn't exist yet — first run, fine */ }
}

const ERROR_LOG_FILE = dataPath('errors.log.json');
const WARNINGS_LOG_FILE = dataPath('warnings-log.ndjson');
const MAX_ERROR_LOG_ENTRIES = Number(process.env.MAX_ERROR_LOG_ENTRIES) || 500;

// Soft-warning dedupe window — same (profileId, kind) within this many ms is suppressed.
const SOFT_WARNING_DEDUPE_MS = 10 * 60 * 1000;
const SOFT_WARNING_CAP = 200;

/**
 * Append a soft warning to in-memory state with dedupe + cap.
 * Pure logic — does not write to disk (W3 adds that side-effect via appendWarningLog).
 *
 * @param {Object} state - The campaign state object (mutated)
 * @param {Object} entry - { profileId, pName, kind, message }
 * @returns {Object|null} - The pushed entry, or null if deduped
 */
function pushSoftWarning(state, { profileId, pName, kind, message }) {
  const now = Date.now();
  const cutoff = now - SOFT_WARNING_DEDUPE_MS;

  // Dedupe: skip if same (profileId, kind) was added within window
  for (let i = state.softWarnings.length - 1; i >= 0; i--) {
    const e = state.softWarnings[i];
    if (e.detectedAt < cutoff) break; // entries are time-ordered; stop walking
    if (e.profileId === profileId && e.kind === kind) {
      return null;
    }
  }

  const entry = { profileId, pName, kind, message, detectedAt: now };
  state.softWarnings.push(entry);

  // Cap: FIFO trim from front when exceeded
  while (state.softWarnings.length > SOFT_WARNING_CAP) {
    state.softWarnings.shift();
  }

  appendWarningLog(entry).catch(() => {}); // fire-and-forget, errors logged in helper
  // Mirror to the central Operations Log.
  _ops('WARN', `Soft warning: ${kind}`, { account: pName, details: message });
  return entry;
}

async function appendErrorLog(entry) {
  // Best-effort persistence — never block or break the campaign loop.
  try {
    let arr = [];
    try {
      const raw = await readFile(ERROR_LOG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch { /* file missing or unreadable — start fresh */ }
    arr.push(entry);
    if (arr.length > MAX_ERROR_LOG_ENTRIES) {
      arr.splice(0, arr.length - MAX_ERROR_LOG_ENTRIES);
    }
    // Atomic write: tmp file + rename, so a crash mid-write doesn't corrupt
    const tmp = ERROR_LOG_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(arr, null, 2));
    const { rename } = await import('node:fs/promises');
    await rename(tmp, ERROR_LOG_FILE);
  } catch (_) { /* swallow — disk-log failure must not break campaigns */ }
}

/**
 * Append a soft-warning entry to the NDJSON log, fire-and-forget.
 * Async (not sync — soft warnings are advisory, no need for crash-safe
 * sync write like server.js's appendFatalErrorSync).
 *
 * @param {Object} entry - { profileId, pName, kind, message, detectedAt }
 */
async function appendWarningLog(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    await appendFile(WARNINGS_LOG_FILE, line);
  } catch (err) {
    console.warn('[appendWarningLog]', err.message);
  }
}

// Wire sheet-write-tracker's warning logger so persistent write failures are
// surfaced in the operator warning log as well as the in-memory ledger.
configureSheetWriteTracker({
  warningLogger: (entry) => appendWarningLog({ ts: new Date().toISOString(), kind: 'sheet_write_failed', ...entry }).catch(() => {}),
});

/**
 * Second-level safety net for sheet write-backs. updateSheetRow already
 * retries transient errors internally (sheets-writer withWriteRetry, 3×/1s);
 * this wrapper retries ONCE more after 30s and, if still failing, records
 * the failure to the sheet-write-tracker ledger so the operator can see and
 * manually retry it (dashboard warning + /api/campaign/sheet-write-failures).
 * Never throws — a failed write must not stop the campaign loop.
 */
// Writes still in flight. The campaign no longer waits for a sheet write before
// moving to the next lead — see trackedSheetWrite — so something has to hold the
// promises until the end of the run.
const _pendingSheetWrites = new Set();

// Ortus Basics 1.0: the campaign used to AWAIT every sheet write inline. With
// Apps Script slow or failing, that cost minutes per lead: WEBAPP_TIMEOUT_MS is
// 60s and applies to both legs of the redirect, and writeSheetWithRetry does
// attempt → 30s sleep → attempt. A single failing row could stall the loop for
// ~4.5 minutes while the browser sat idle.
//
// The write is now fired and left to run. The result still lands in the sheet
// and a failure still reaches the ledger; the loop simply stops waiting on it.
// Ordering is safe: sheets-writer coalesces by sheet+column and merges rows
// written inside the same window, so concurrent writes for different leads
// batch rather than race.
async function trackedSheetWrite(sheetUrl, url, leadName, sheetData, linkedinColumn) {
  // updateSheetRow returns a boolean (true=ok, false=failed) — never throws.
  // When no webapp is configured, false is a no-op (nothing to track or retry).
  if (!SHEETS_WEBAPP_URL) return;

  const p = writeSheetWithRetry(
    () => updateSheetRow(sheetUrl, url, sheetData, linkedinColumn)
        .then((ok) => (ok ? {} : { error: 'sheet write failed (updateSheetRow returned false)' })),
    {
      url,
      leadName,
      column: linkedinColumn || '',
      payload: JSON.stringify(sheetData),
    },
  ).catch((err) => {
    // writeSheetWithRetry records its own failures; this only stops an unhandled
    // rejection now that nobody is awaiting the promise.
    console.warn(`[sheets-writer] write for ${leadName || url} threw: ${err?.message || err}`);
  }).finally(() => {
    _pendingSheetWrites.delete(p);
    campaign.sheetWriteFailures = getFailures().length;
  });

  _pendingSheetWrites.add(p);

  // A hard ceiling so a stalled Apps Script cannot accumulate hundreds of
  // in-flight writes. Well above a turn's BATCH_SIZE, so it never bites during
  // normal running.
  if (_pendingSheetWrites.size >= 40) {
    await Promise.race([..._pendingSheetWrites]).catch(() => {});
  }
}

/** Let every outstanding write finish. Called before a run reports itself done. */
async function drainSheetWrites() {
  while (_pendingSheetWrites.size) {
    await Promise.allSettled([..._pendingSheetWrites]);
  }
}

function pushError(err) {
  const entry = { at: new Date().toISOString(), message: err.message, profileName: campaign.currentProfile };
  campaign.errors.push({ time: entry.at, message: entry.message });
  if (campaign.errors.length > 100) campaign.errors.shift();
  // Phase 2.8.20 (W1-B2): also persist to disk (fire-and-forget).
  appendErrorLog(entry).catch(() => {});
  // Mirror to the central Operations Log so colleagues can self-diagnose.
  _ops('ERROR', err.message || 'Error', {
    details: err.stack ? (err.stack.split('\n')[1] || '').trim() : '',
  });
}

// ── Profile name cache ──
let profileNameCache = {};
let profileCacheTime = 0;

async function getProfileName(profileId, token) {
  if (Date.now() - profileCacheTime > 5 * 60 * 1000) {
    const all = await getProfiles(token);
    profileNameCache = {};
    for (const p of all) profileNameCache[p.id] = p.name;
    profileCacheTime = Date.now();
  }
  return profileNameCache[profileId] || profileId;
}

function getToken() {
  return process.env.GOLOGIN_API_TOKEN;
}

// ═══════════════════════════════════════════════════════════════════════════
// Organic feed browsing — mimics natural LinkedIn usage between connections
// ═══════════════════════════════════════════════════════════════════════════

async function browseFeedOrganically(page, pName) {
  try {
    log(`  🔄 [${pName}] Organic browsing — visiting feed…`);
    try {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch { /* timeout OK */ }
    await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));

    // Scroll the feed a bit
    const scrollCount = 2 + Math.floor(Math.random() * 3); // 2-4 scrolls
    for (let i = 0; i < scrollCount; i++) {
      await page.keyboard.press('PageDown');
      await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 3000)));
    }

    // ~30% chance: click a "Like" on a visible post (very natural action)
    if (Math.random() < 0.3) {
      const liked = await page.evaluate(() => {
        const likeButtons = Array.from(document.querySelectorAll('button'));
        const likeable = likeButtons.filter(b => {
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          // Only click "Like" (not already liked, not "Love", "Celebrate", etc.)
          return aria.startsWith('like ') && !aria.includes('liked') && b.offsetWidth > 0;
        });
        if (likeable.length > 0) {
          // Pick one of the first 3 visible posts
          const pick = likeable[Math.floor(Math.random() * Math.min(3, likeable.length))];
          pick.click();
          return true;
        }
        return false;
      });
      if (liked) log(`  👍 [${pName}] Liked a feed post (organic activity)`);
    }

    // Scroll back to top before leaving
    await page.keyboard.press('Home');
    await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
    log(`  🔄 [${pName}] Organic browsing done.`);
  } catch (err) {
    // Non-critical — don't let feed browsing errors break the campaign
    log(`  ⚠ [${pName}] Feed browse skipped: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Local-browser re-login recovery (2026-06-15)
// ═══════════════════════════════════════════════════════════════════════════

/** 5-min "operator walked away" ceiling for the local-browser login wait. */
export const LOCAL_LOGIN_MAX_WAIT_MS = 5 * 60 * 1000;

/**
 * Pure decision helper for awaitLocalLogin's poll loop. Resume the instant the
 * operator is logged in (Done click or auto-detect), keep waiting until then,
 * and give up only once the walked-away ceiling is hit.
 * @returns {'resume'|'wait'|'timeout'}
 */
export function decideLoginWaitAction({ elapsedMs, loggedIn, maxMs = LOCAL_LOGIN_MAX_WAIT_MS }) {
  if (loggedIn) return 'resume';
  if (elapsedMs >= maxMs) return 'timeout';
  return 'wait';
}

/** Operator clicked "Done" in the re-login popup (POST /api/campaign/login-done). */
export function confirmLogin() { campaign._loginDone = true; return { ok: true }; }

// ═══════════════════════════════════════════════════════════════════════════
// Profile health check (REL-04) — verifies LinkedIn session before leads
// ═══════════════════════════════════════════════════════════════════════════

async function checkProfileHealth(page, profileName) {
  const issues = [];

  // Phase 2.8.20 (W2-A2) — session-expired detection. If the page URL is on
  // a LinkedIn auth/checkpoint page, the cookies are dead. Surface this as a
  // distinct sessionExpired flag so the caller can park the profile for the
  // rest of the run instead of burning 5 retries on a dead session.
  try {
    const cur = page.url();
    if (cur && (cur.includes('/login') || cur.includes('/uas/login') || cur.includes('/checkpoint'))) {
      issues.push('session expired (auth page detected)');
      return { healthy: false, issues, sessionExpired: true };
    }
  } catch (_) { /* fall through to the existing Check 1 below */ }

  // Check 1: URL-based login detection
  try {
    const url = page.url();
    if (url.includes('/login') || url.includes('/authwall')) {
      issues.push('not logged in (redirected to login/authwall)');
      return { healthy: false, issues };
    }
  } catch (e) {
    issues.push(`URL check failed: ${e.message}`);
    return { healthy: false, issues };
  }

  // Check 2: Scroll the feed briefly to verify interactivity
  try {
    await page.evaluate(() => {
      window.scrollTo(0, 300);
      return new Promise(r => setTimeout(r, 1000));
    });
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch (e) {
    issues.push(`feed scroll failed: ${e.message}`);
  }

  // Check 3: Check for rate-limit banners
  try {
    const rateLimited = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('too many requests') ||
             text.includes('please try again later') ||
             text.includes('you\'ve reached the limit');
    });
    if (rateLimited) {
      issues.push('rate-limit banner detected');
      return { healthy: false, issues };
    }
  } catch (e) {
    issues.push(`rate-limit check failed: ${e.message}`);
  }

  return { healthy: issues.length === 0, issues };
}

/**
 * Park an idle profile on a low-RAM page during the per-lead delay window.
 * Swallows errors — parking failure must never break a campaign (D-10, D-11).
 * Called between performOutreach and the delay sleep in the round-robin loop.
 * Phase 11.1. Exported for tests/park-profile.test.js.
 */
export async function parkProfile(page, parkUrl = 'about:blank') {
  if (!page || page.isClosed?.()) return;
  try {
    await page.goto(parkUrl, { waitUntil: 'domcontentloaded', timeout: 5000 });
  } catch (err) {
    log(`  ⚠ Park failed: ${err.message}`);
  }
}

/**
 * Local-browser re-login recovery loop (2026-06-15). Brings the Chromium window
 * on-screen, raises the in-app "log into LinkedIn" popup (via campaign.awaitingLogin),
 * and resumes the moment the operator is logged in — either because they clicked
 * "Done" (campaign._loginDone) or because we auto-detect a logged-in URL/health.
 * Gives up after LOCAL_LOGIN_MAX_WAIT_MS (operator walked away) so the caller can
 * park the account exactly as before. Local-browser ONLY — GoLogin never calls this.
 * @returns {Promise<{ ok: boolean, page: object }>}
 */
async function awaitLocalLogin(page, profileId, pName) {
  // Bring the window forward so the operator can see + use it. Best-effort.
  try {
    const client = await page.target().createCDPSession();
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', { windowId, bounds: { left: 100, top: 100, width: 1366, height: 900, windowState: 'normal' } });
  } catch { /* */ }

  campaign.awaitingLogin = { profileId, pName, since: Date.now() };
  campaign._loginDone = false;
  log(`⏳ ${pName}: waiting up to 5 min for you to log into LinkedIn (or click Done)...`);

  const start = Date.now();
  let action = 'wait';
  let ticks = 0;
  while (action === 'wait') {
    await new Promise(r => setTimeout(r, 3000));
    if (campaign._abort) { action = 'timeout'; break; }

    // Re-acquire the active page (login can swap the tab/process).
    try {
      const pages = await page.browser().pages();
      if (pages.length > 0) page = pages[pages.length - 1];
    } catch { /* keep current */ }

    let loggedIn = false;
    try {
      const u = page.url();
      if (u.includes('linkedin.com') && !u.includes('/login') && !u.includes('/authwall') && !u.includes('/checkpoint')) {
        loggedIn = true;
      }
    } catch { /* */ }

    // If they clicked Done but the URL still looks logged-out, re-verify health
    // before trusting it — guards against a premature click.
    if (!loggedIn && campaign._loginDone) {
      try {
        const h = await checkProfileHealth(page, pName);
        loggedIn = !!h.healthy;
      } catch { /* */ }
      if (!loggedIn) {
        log(`  ⏳ ${pName}: not logged in yet — finish login in the browser, then click Done.`);
        campaign._loginDone = false;
      }
    }

    action = decideLoginWaitAction({ elapsedMs: Date.now() - start, loggedIn });
    if (action === 'wait' && (++ticks % 10 === 0)) {
      log(`  Still waiting for ${pName} login... (${Math.round((Date.now() - start) / 1000)}s)`);
    }
  }

  campaign.awaitingLogin = null;
  campaign._loginDone = false;

  if (action === 'resume') {
    // Tuck the window back off-screen and carry on.
    try {
      const client = await page.target().createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400 } });
    } catch { /* */ }
    log(`✓ ${pName}: re-logged in — resuming.`);
    return { ok: true, page };
  }

  log(`✗ ${pName}: login not completed within 5 min — parking account.`);
  return { ok: false, page };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 11.2: ensureProfileLoggedIn — cache clear + home nav + health check
// + interactive login wait. Extracted from the old STEP 1 warmup block so
// ensureOpen() can call it lazily on first batch (D-10).
// ═══════════════════════════════════════════════════════════════════════════

async function ensureProfileLoggedIn(launched, profileId, pName) {
  let page = launched.page;

  // Clear cache + service workers (keep cookies so login persists)
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCache');
    await client.send('ServiceWorker.unregister', { scopeURL: 'https://www.linkedin.com/' }).catch(() => {});
    log(`✓ ${pName}: cache cleared.`);
  } catch (e) {
    log(`⚠ ${pName}: cache clear skipped: ${e.message}`);
  }

  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log(`⚠ Home nav: ${e.message}`);
  }

  // Re-acquire page (prevents detached frame)
  try {
    const pages = await launched.browser.pages();
    if (pages.length > 0) {
      page = pages[pages.length - 1];
      await page.setViewport({ width: 1366, height: 900 });
      // v2.14.x: re-apply CDP focus emulation on the re-acquired page.
      // The launcher set it on the ORIGINAL page object only — this is a
      // different page reference whose CDP session has never been
      // configured. Without this call, the background-tab IC DM fix is
      // silently nullified anytime ensureProfileLoggedIn lands on a
      // non-original page (most common: post-login process-swap).
      await applyFocusEmulation(page, profileId);
    }
  } catch { /* keep current */ }

  // Health check
  log(`Checking ${pName} health...`);
  const health = await checkProfileHealth(page, pName);
  // Phase 2.8.20 (W2-A2): bubble up sessionExpired so the caller can park
  // the profile cleanly. Skip the recovery-prompt UX (which is for when the
  // user just needs to log in once more — sessionExpired means cookies are
  // dead and we should drop this profile from rotation entirely).
  if (health.sessionExpired && profileId !== 'local-browser') {
    // GoLogin cloud profiles can't be logged into interactively mid-run — drop.
    log(`✗ ${pName}: session expired — parking profile for rest of run.`);
    return { page: null, ok: false, sessionExpired: true };
  }
  if (!health.healthy) {
    if (profileId === 'local-browser') {
      // Local-browser session expiry (2026-06-15): the operator is at the
      // machine, so recover in place instead of parking. awaitLocalLogin pops
      // the window + the in-app "Done" popup and resumes on login; a 5-min
      // ceiling falls back to the same park-and-flag the caller does.
      if (health.sessionExpired) {
        log(`⚠ ${pName}: session expired — opening browser for you to log in.`);
        const r = await awaitLocalLogin(page, profileId, pName);
        if (!r.ok) return { page: null, ok: false, sessionExpired: true };
        page = r.page || page;
        log(`${pName} health check passed.`);
        return { page, ok: true };
      }
      log(`⚠ Local Browser not logged in. Bringing browser on-screen — please log into LinkedIn.`);
      log(`⏳ Waiting up to 120s for you to log in...`);
      await page.evaluate(() => { document.body.style.zoom = '90%'; }).catch(() => {});
      await page.evaluate(() => { if (window.moveTo) window.moveTo(100, 100); }).catch(() => {});
      try {
        const client = await page.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { left: 100, top: 100, width: 1366, height: 900, windowState: 'normal' } });
      } catch { /* */ }

      let loggedIn = false;
      for (let wait = 0; wait < 24; wait++) {
        if (campaign._abort) break;
        await new Promise(r => setTimeout(r, 5000));
        try {
          const currentUrl = page.url();
          if (!currentUrl.includes('/login') && !currentUrl.includes('/authwall') && currentUrl.includes('linkedin.com')) { loggedIn = true; break; }
          const recheck = await checkProfileHealth(page, pName);
          if (recheck.healthy) { loggedIn = true; break; }
        } catch { /* */ }
        if ((wait + 1) % 6 === 0) log(`  Still waiting for login... (${(wait + 1) * 5}s)`);
      }
      if (!loggedIn) {
        log(`✗ Local Browser: login timed out after 120s. Skipping.`);
        await closeLocalBrowser();
        return { page: null, ok: false };
      }
      log(`✓ Local Browser: logged in! Moving window off-screen.`);
      try {
        const client = await page.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400 } });
      } catch { /* */ }
    } else {
      log(`⚠ ${pName} not logged in: ${health.issues.join(', ')}. Bringing browser on-screen — please log in.`);
      log(`⏳ Waiting up to 120s for you to log into ${pName}...`);
      try {
        const client = await page.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { left: 100, top: 100, width: 1366, height: 900, windowState: 'normal' } });
      } catch { /* */ }

      let loggedIn = false;
      for (let wait = 0; wait < 24; wait++) {
        if (campaign._abort) break;
        await new Promise(r => setTimeout(r, 5000));
        try {
          const currentUrl = page.url();
          if (!currentUrl.includes('/login') && !currentUrl.includes('/authwall') && currentUrl.includes('linkedin.com')) { loggedIn = true; break; }
          const recheck = await checkProfileHealth(page, pName);
          if (recheck.healthy) { loggedIn = true; break; }
        } catch { /* */ }
        if ((wait + 1) % 6 === 0) log(`  Still waiting for ${pName} login... (${(wait + 1) * 5}s)`);
      }
      if (!loggedIn) {
        log(`✗ ${pName}: login timed out after 120s. Skipping.`);
        try { await launched.browser.close().catch(() => {}); await closeProfile(profileId); } catch { /* */ }
        return { page: null, ok: false };
      }
      log(`✓ ${pName}: logged in! Moving window off-screen.`);
      try {
        const client = await page.target().createCDPSession();
        const { windowId } = await client.send('Browser.getWindowForTarget');
        await client.send('Browser.setWindowBounds', { windowId, bounds: { left: -2400, top: -2400 } });
      } catch { /* */ }
    }
  }
  log(`${pName} health check passed.`);
  return { page, ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main campaign runner
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure helper: builds the sheetData payload for a given outreach action result.
 * Routes the action to the right v2 mode-specific status column, mirrors the
 * latest action into `Status`, and writes Stage when applicable.
 *
 * @param {object} args
 * @param {string} args.action         - result.action ('connection_sent' | 'message_sent' | ...)
 * @param {string} args.mode           - active campaign mode
 * @param {string} args.profileName    - GoLogin profile display name (becomes Sender)
 * @param {string} args.hyperSent      - HYPERLINK formula for "Sent" label (or '')
 * @param {boolean} args.introMode     - tpl.introMode flag (relevant for message_sent)
 * @param {boolean} args.messageOpenProfiles - tpl flag (relevant for op_message_sent audit)
 * @param {number} [args.creditsLeft]  - inmail credits remaining (inmail_sent only)
 * @returns {object} sheetData         - keys consumed by Apps Script FIELD_MAP
 */
export function buildSheetDataForAction({
  action,
  mode,
  profileName = '',
  hyperSent = '',
  introMode = false,
  messageOpenProfiles = false,
  creditsLeft
}) {
  // Write to BOTH 'Sender' (v2 schema) and 'Account Used' (legacy column).
  // Sheets that have only one of the two will silently ignore the missing
  // field; sheets that have both stay in sync. This is what makes the
  // "Account Used" column populate on legacy/migrated sheets.
  const out = { sender: profileName, accountUsed: profileName };

  switch (action) {
    case 'connection_sent':
      out.status            = 'Connection Request Sent';
      out.connectionStatus  = 'Connection Request Sent';
      out.stage             = 'Connect Pending';
      out.auditAction       = 'Connection sent';
      return out;

    case 'already_connected':
      out.status            = 'Already Connected';
      out.connectionStatus  = 'Already Connected';
      out.cc                = 'Connected';
      out.connectedAlready  = 'Yes';
      out.stage             = 'Connected';
      out.auditAction       = 'Already 1st-degree connection';
      return out;

    case 'message_sent':
      if (mode === 'introduce_back') {
        // Introduction Status is the per-mode source of truth — IC dedup reads
        // it (candidate filter L1475-1482), NOT Stage. v2.13.x: also mirror to
        // Status + Stage for visual consistency with every other mode. IC tabs
        // are separate and may lack Stage/Status columns; the Apps Script
        // FIELD_MAP silently ignores writes to absent columns, so this is safe.
        out.introStatus = 'IC Sent';
        out.status      = 'IC Sent';
        out.stage       = 'IC Sent';
      } else if (mode === 'message_only') {
        // DM Status is the per-mode source of truth (the "all connected"
        // dedup path reads it — candidate filter L1486-1495). But Direct
        // Messages run on the MAIN connection tabs, which have a Stage
        // column, and the Stage-schema dedup path (candidate filter L1499
        // + isDmIbEligible) treats Stage='DM Sent' as terminal. So Stage is
        // the re-send guard on that path, not just a summary — write all
        // three. (IC differs: separate tabs, dedup reads Introduction
        // Status, so the introduce_back branch above stays column-only.)
        out.dmStatus = 'DM Sent';
        out.status   = 'DM Sent';
        out.stage    = 'DM Sent';
      } else {
        out.status   = 'DM Sent';
        out.dmStatus = 'DM Sent';
        out.stage    = 'DM Sent';
      }
      out.message     = hyperSent;
      out.auditAction = 'Message sent';
      return out;

    case 'op_message_sent':
      // Legacy: Status mirrors 'DM Sent' for op_message_sent (preserved
      // from src/campaign.js:1841 for back-compat with sheet conditional
      // formatting rules that key on 'DM Sent').
      out.status     = 'DM Sent';
      out.opStatus   = 'OP Sent';
      out.op         = hyperSent;
      out.stage      = 'OP Sent';
      out.auditAction = (mode === 'connect_only' && messageOpenProfiles)
        ? 'Open Profile message sent (via connect mode)'
        : 'Open Profile message sent';
      return out;

    case 'inmail_sent':
      out.status     = 'Done';
      out.inmStatus  = 'InM Sent';
      out.inmail     = hyperSent;
      out.stage      = 'InM Sent';
      out.auditAction = 'InMail sent';
      if (typeof creditsLeft === 'number') {
        out.auditNotes = `InMail credits left: ${creditsLeft}`;
      }
      return out;

    case 'status_accepted':
      out.status           = 'Check Done.';
      out.checkStatus      = 'Connected';
      out.cc               = 'Connected';
      out.connectedAlready = 'Yes';
      out.stage            = 'Connected · DM Now';
      out.auditAction      = 'Acceptance confirmed';
      return out;

    case 'status_pending':
      // Stage left unchanged on pending (prior code: no stage write).
      out.checkStatus = 'Still Pending';
      out.auditAction = 'Check Status: still pending';
      return out;

    case 'already_processed': {
      // Stamp Stage per mode so empty-Stage rows don't stay empty after
      // a re-run. Also re-stamps the relevant status column — when the
      // operator clears the sheet between runs, the prior status data is
      // gone, so stamping here repopulates it (the LinkedIn-side state is
      // the real source of truth: outreach.js returned already_processed
      // because the connect/DM/InMail is actually in flight).
      out.auditAction = 'Already in target state';
      if (mode === 'connect_only' || mode === 'connect_and_introduce' || mode === 'connect_and_message') {
        out.stage            = 'Connect Pending';
        out.status           = 'Connection Request Sent';
        out.connectionStatus = 'Connection Request Sent';
      }
      else if (mode === 'message_only')     {
        // Mirror the message_sent branch: DM Status (per-mode) + Status +
        // Stage. DM runs on connection tabs whose Stage-schema dedup reads
        // Stage='DM Sent' as terminal, so an empty-Stage row must not stay
        // empty after a re-run.
        out.dmStatus = 'DM Sent';
        out.status   = 'DM Sent';
        out.stage    = 'DM Sent';
      }
      else if (mode === 'introduce_back')   {
        // Mirror the message_sent branch: Introduction Status (per-mode) +
        // Status + Stage. See message_sent above for the FIELD_MAP safety note.
        out.introStatus = 'IC Sent';
        out.status      = 'IC Sent';
        out.stage       = 'IC Sent';
      }
      else if (mode === 'inmail_only')      { out.stage = 'InM Sent'; out.status = 'InM Sent'; out.inmStatus = 'InM Sent'; }
      else if (mode === 'open_profile_only') { out.stage = 'OP Sent'; out.status = 'OP Sent'; out.opStatus = 'OP Sent'; }
      return out;
    }

    default:
      // Unknown action — return minimal payload so the caller can still
      // log audit info, no column writes.
      return out;
  }
}

/**
 * Pure helper: routes a normalized skip reason to the mode-specific column
 * + mirrors into Status + Stage. Used by every skip branch in the per-lead
 * loop so skip reasons land in the right place under the v2 schema.
 *
 * @param {string} mode             - active campaign mode
 * @param {string} normalizedReason - already passed through normalizeSkipReason()
 * @param {string} profileName      - sender label
 * @returns {object} sheetData
 */
export function buildSkipSheetData(mode, normalizedReason, profileName = '') {
  // normalizeSkipReason already produces "Skipped: <reason>" — Stage + Status
  // mirror that verbatim. The mode-specific column also receives the prefix
  // so the operator sees the skip reason in the column matching the campaign
  // they ran.
  const out = {
    sender: profileName,
    stage:  normalizedReason,
    status: normalizedReason
  };
  switch (mode) {
    case 'connect_only':       out.connectionStatus = normalizedReason; break;
    case 'check_status':       out.checkStatus      = normalizedReason; break;
    case 'message_only':       out.dmStatus         = normalizedReason; break;
    case 'introduce_back':     out.introStatus      = normalizedReason; break;
    case 'open_profile_only':  out.opStatus         = normalizedReason; break;
    case 'inmail_only':        out.inmStatus        = normalizedReason; break;
  }
  return out;
}

// v2.86.15: extracted from startCampaign so the live template-edit setter can
// rebuild the same normalized shape. Returns the canonical `tpl` object the send
// loop reads. Body is identical to the literal previously inlined at startup.
export function normalizeTemplates(templates = {}, mode = '') {
  return {
    connectionNote: templates.connectionNote || templates.note || '',
    followUpMessage: templates.followUpMessage || templates.followUp1 || '',
    inmail: {
      subject: templates.inmail?.subject || templates.inmailSubject || '',
      message: templates.inmail?.message || templates.inmailBody || '',
    },
    openProfileSubject: templates.openProfileSubject || templates.opSubject || '',
    openProfileBody: templates.openProfileBody || templates.opBody || '',
    // v2.72: Open Profile send channel + InMail fallback. opChannel is one of
    // sn_first (default) | sn_only | ln_first | ln_only; opSpendInMail gates
    // whether non-Open-Profile leads cost an InMail credit. Read in
    // outreach.js force_open_profile branch.
    opChannel: templates.opChannel || 'sn_first',
    opSpendInMail: !!templates.opSpendInMail,
    // 2.8.50: Introduction Messages — when introMode is true, sendMessage
    // routes to sendIntroMessage which adds introName as a second recipient
    // and sets a group title. Sheet stamp becomes "sent IC".
    // v2.11.17: introMode is now implied by mode === 'introduce_back'
    // (separate first-class mode); legacy presets that set introMode on
    // message_only still work because the client auto-migrates them, but
    // we OR the flag here as a final safety net.
    introMode: !!templates.introMode || mode === 'introduce_back',
    introName: (templates.introName || '').trim(),
    introTitle: templates.introTitle || 'Introduction: {firstName} <> {primaryFirstName}',
    // v2.62: CC+DM (connect_and_message) phase-2 body. Plain 1:1 DM sent
    // after acceptance, no primary person involved. runAutoDms reads
    // tpl.ccDmBody when mode === 'connect_and_message'.
    ccDmBody: (templates.ccDmBody || '').trim(),
    // primaryName / primaryUrl / primaryIntroBody passed through unchanged
    // for CC+IC's runAutoIntros — auto-dm.js ignores these fields.
    primaryName: templates.primaryName,
    primaryUrl: templates.primaryUrl,
    primaryIntroBody: templates.primaryIntroBody,
    // v2.91: primary-side automation config (see primary-side-automation spec).
    // autoAcceptPrimary — local browser auto-accepts the primary's incoming
    // invite from a campaign account. followUp* — automated first follow-up in
    // the intro's group thread. Posting identity is tpl.primarySource.
    autoAcceptPrimary: !!templates.autoAcceptPrimary,
    // autoAcceptAllPending — opt-in (default OFF). When on, the primary's
    // pre-flight session ALSO accepts every other pending invite in its inbox,
    // not just this campaign's matched senders (strangers included). Safe-by-
    // default per the "auto-send defaults OFF" operator rule.
    autoAcceptAllPending: !!templates.autoAcceptAllPending,
    followUpEnabled: !!templates.followUpEnabled,
    followUpBody: (templates.followUpBody || '').trim(),
    followUpDelayMinutes: Number(templates.followUpDelayMinutes) > 0 ? Number(templates.followUpDelayMinutes) : 10,
    // primarySource — the primary's ONE identity, used by BOTH auto-accept and
    // the automated follow-up: 'local-browser' (you) or a GoLogin profileId.
    // Concrete id, not an enum, so pass it through; empty/falsey → local-browser.
    primarySource: (() => {
      const v = (templates.primarySource || '').toString().trim();
      return v && v !== 'local-browser' ? v : 'local-browser';
    })(),
  };
}

// v2.86.15: live template edit while paused. Mutates the SAME tpl object the
// send loop already holds by reference, so no read-site changes are needed.
export function setLiveTemplates(newTemplates = {}) {
  if (!campaign.running) return { ok: false, reason: 'not-running' };
  if (!campaign._paused) return { ok: false, reason: 'not-paused' };
  if (!campaign._liveTpl) return { ok: false, reason: 'no-templates' };
  Object.assign(campaign._liveTpl, normalizeTemplates(newTemplates, campaign._liveMode));
  // Mutate the raw templates object IN PLACE (don't reassign). The send loop's
  // auto-intro / auto-DM call sites pass the closure `templates` object (=== the
  // same reference as campaign.templates, set at startup), and the monitoring
  // path reads campaign.templates. Mutating in place makes the actual message
  // BODY (primaryIntroBody / ccDmBody) go live too — not just the gating.
  if (campaign.templates && typeof campaign.templates === 'object') {
    Object.assign(campaign.templates, newTemplates);
  } else {
    campaign.templates = { ...newTemplates };
  }
  log('✎ Templates updated (live) while paused.');
  return { ok: true };
}

// v2.86.15: live daily-limit edit while paused. The send loop's per-lead gates
// read campaign.dailyLimit, so the new value takes effect on Resume.
export function setLiveDailyLimit(n) {
  if (!campaign.running) return { ok: false, reason: 'not-running' };
  if (!campaign._paused) return { ok: false, reason: 'not-paused' };
  const v = Math.max(1, Math.min(1000, Math.floor(Number(n) || 0)));
  if (!v) return { ok: false, reason: 'invalid' };
  campaign.dailyLimit = v;
  log(`✎ Daily limit updated (live) → ${v}.`);
  return { ok: true, dailyLimit: v };
}

// v2.86.15: live cadence edit while paused. The in-batch + idle bulk-check
// gates read campaign.checkIntervalMinutes, so the new value takes effect on
// Resume. clampCadenceMinutes is already imported at the top of this module.
export function setLiveCadence(min) {
  if (!campaign.running) return { ok: false, reason: 'not-running' };
  if (!campaign._paused) return { ok: false, reason: 'not-paused' };
  const v = clampCadenceMinutes(min);
  campaign.checkIntervalMinutes = v;
  log(`✎ Check cadence updated (live) → ${v} min.`);
  return { ok: true, checkIntervalMinutes: v };
}

export async function startCampaign({ campaignId = null, profileIds, benchedProfileIds = [], sheetUrl, sheetGid = '', templates, dailyLimit = 50, mode = 'connect_only', messageOpenProfiles = false, delayMin = 10, delayMax = 20, linkedinColumn = '', senderFirstNames = {}, concurrency = 1, name = '', acceptanceTrackingDays = 0, preflightCheckStatus = false, checkIntervalMinutes = 60, autoChecksEnabled = true, createdBy = null, senderColumn = '', allLeadsConnected = false, resumeContext = null, primaryCheckTiming = 'immediately', pauseOnThrottle = true, stopBeforeWeeklyReset = false, stopBeforeMonthlyReset = false, excludedUrls = [] }) {
  if (campaign.running) throw new Error('Campaign already running');
  const identity = ensureCampaignIdentity({ campaignId, name, config: { profileIds, sheetUrl, templates, mode } });
  campaignId = identity.campaignId;
  name = identity.name;
  clearRuntimeInterruption();
  campaign.executionId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  campaign._abortController = new AbortController();
  campaign.dailyResetNeeded = false;
  campaign.resumeAt = null;

  // #7: when 'after_connections', the primary connect/check is deferred until
  // all accounts finish sending connections — the pre-loop handshake and the
  // per-turn primary connect are skipped, and the same handshake runs post-loop.
  const _deferPrimary = primaryCheckTiming === 'after_connections';
  campaign.primaryCheckTiming = primaryCheckTiming;

  // v2.58.x — IC-only options. Coerced to defaults outside introduce_back
  // mode so accidental flagging from other code paths cannot change
  // unrelated campaign behavior.
  if (mode !== 'introduce_back') {
    senderColumn = '';
    allLeadsConnected = false;
  }

  // Lead-source guard: the operator-chosen tab (gid). Normalize to digits;
  // backfill from any gid already carried in the sheet URL when not supplied.
  // Persisted alongside sheetUrl everywhere so reruns/restores read the SAME tab.
  sheetGid = String(sheetGid || '').replace(/\D/g, '') || extractSheetGid(sheetUrl);

  // v2.14.x: snapshot for restoreCampaign(). Captured BEFORE anything can
  // throw, so even a campaign that fails preflight is recoverable.
  campaign.campaignId = campaignId;
  _lastRunSettings = {
    campaignId, profileIds, sheetUrl, sheetGid, templates, dailyLimit, mode, messageOpenProfiles,
    delayMin, delayMax, linkedinColumn, senderFirstNames, concurrency,
    name, acceptanceTrackingDays, preflightCheckStatus, createdBy,
    senderColumn, allLeadsConnected, checkIntervalMinutes, autoChecksEnabled, stopBeforeWeeklyReset, stopBeforeMonthlyReset,
    // Persist excludedUrls so restoreCampaign re-applies the same hard exclusions.
    excludedUrls: Array.isArray(excludedUrls) ? excludedUrls.slice() : [],
    benchedProfileIds: Array.isArray(benchedProfileIds) ? benchedProfileIds.slice() : [],
  };

  // Persist the snapshot so "Open" can rehydrate the wizard after the starting
  // process is gone (server restart / monitoring resume re-loads from disk but
  // never re-runs startCampaign, so the in-memory copy is the only one). Best-
  // effort, synchronous atomic write — a disk failure must not block the run.
  try { writeLastRun(LAST_RUN_FILE, _lastRunSettings); } catch { /* non-fatal */ }

  campaign.running = true;
  campaign.createdBy = createdBy || null;
  // v2.58.x — pick up the launcher's stored timezone so sheet timestamps
  // land in their local clock. Empty string resets any prior campaign's
  // value (one-campaign-at-a-time invariant means no race). Best-effort:
  // any read failure falls back to no tz, which preserves pre-feature
  // behavior (GAS uses Session.getScriptTimeZone()).
  try {
    const prefs = createdBy ? await getOperatorPrefs(createdBy) : null;
    setOperatorTz(prefs?.tz || '');
    // v2.113.x: cache the operator's identity-safeguard choice for this run so
    // the per-lead gate doesn't hit the prefs file on every lead. Default OFF
    // (2026-06-22) — the gate only runs when an operator explicitly turns it ON
    // (identityGate === true). No operator / missing pref / read failure all
    // resolve to OFF, matching the v2.97 connect-straight-to-URL path (404 skip
    // is preserved inside gateConnectIdentity's blind branch regardless).
    campaign.identityGateEnabled = identityGateEnabled(prefs);
  } catch { setOperatorTz(''); campaign.identityGateEnabled = identityGateEnabled(null); }
  campaign._abort = false;
  campaign._stoppedManually = false;
  campaign.stopReason = null;
  campaign._skipCleanup = false;
  clearSkips(); // reset skip ledger for this run
  // v2.78: seed the rotation benches from any accounts pre-benched in the wizard.
  campaign._skippedProfiles = new Set(Array.isArray(benchedProfileIds) ? benchedProfileIds : []);
  campaign._removedProfiles = new Set();
  campaign._restrictedProfiles = new Map();
  campaign._primaryConn = new Map();      // v2.78: fresh per-run primary-connection status
  // v2.52.0: capture this loop's generation. Any prior loop still in flight
  // (e.g. after restoreCampaign re-launched without waiting for the old loop
  // to fully unwind) will see campaign._generation !== myGen on its next
  // iteration check and exit — even though we just reset _abort to false.
  // See _generation comment on the campaign object for full context.
  const myGen = ++campaign._generation;
  const isOrphan = () => campaign._generation !== myGen;
  // v2.14.x: reset monitoring state machine fields on every new run.
  // Without this, a prior run that reached "Monitoring ended" sets
  // campaign.state = 'done' (campaign.js:3072), which then carries over
  // to the next CC+IC run and causes transitionToMonitoring to early-
  // return silently (campaign-state-transitions.js:12). Symptom in the
  // field: fresh CC+IC campaign reaches 3/3, logs "Campaign ended", but
  // the cockpit stays IDLE instead of flipping to Monitoring.
  campaign.state = null;
  campaign.phase = null;
  campaign.sendingEndedAt = null;
  // v2.72: one-shot "no more rows to process" notice for the dashboard popup.
  // Cleared on each new run; set in the finally block when a campaign ends
  // naturally (ran out of rows) rather than via operator-Stop or an error.
  campaign._endNotice = null;
  campaign.monitoringUntil = null;
  campaign.nextCheckAt = null;
  // A fresh local run is NOT the campaign a handover adopted, so it must not
  // keep that campaign's cloud id: server.js reads campaign.id to decide whether
  // there is an engine row to hand back, and a stale one would hand back the
  // wrong campaign. Only adoptMonitoring ever sets a non-singleton id.
  campaign.id = SINGLETON_CAMPAIGN_ID;
  campaign.participatingProfileIds = [];
  campaign.introducedInRun = new Set();
  campaign.dmSentInRun = new Set();
  campaign.composeAttempts = new Map();
  campaign._paused = false;
  // v2.112: resume staging — paused edits accumulate here, applied at the pause boundary.
  campaign._pendingResume = { reloadSheet: false, newRows: null, addProfiles: [], benchToggles: {} };
  campaign._pauseRequested = false;
  campaign.currentProfile = null;
  // v2.59 (resume support): when resumeContext is supplied (client clicked
  // Resume on a stopped campaign), seed the run-level counters from the
  // previous run's totals so the cockpit + history continue from where
  // they left off instead of resetting to 0. processedToday stays 0 — it's
  // a today-only counter, and resuming on a NEW day shouldn't pretend the
  // pre-resume day's sends happened today. The per-account dailyCounts
  // and per-URL `processed` map in state.json already preserve the
  // 'don't re-send' guarantee independently of these counters.
  const _resumeTotal = resumeContext && Number.isFinite(Number(resumeContext.totalProcessed)) ? Number(resumeContext.totalProcessed) : 0;
  campaign.processedToday = 0;
  campaign.totalProcessed = _resumeTotal;
  // Tab-as-Bible: the "Recent Connections" tab is a per-campaign record. Wipe
  // it clean at the start of a NEW campaign so stale rows from a prior run on
  // the same sheet can't produce false matches. On resume, keep the tab — the
  // accumulated record belongs to the campaign we're continuing.
  if (!resumeContext) {
    try {
      await clearRecentConnectionsTab(sheetUrl);
    } catch (err) {
      console.warn(`[campaign] Recent Connections wipe failed (non-fatal): ${err.message}`);
    }
  }
  campaign.totalTargets = 0;
  campaign.mode = mode;
  // ISO timestamp marking when this campaign run began. Used by the
  // central Operations Log to route events to the correct per-campaign
  // tab (campaign name + startedAt is the tab key, so resumes append
  // to the same tab).
  campaign.startedAt = new Date().toISOString();
  campaign.profileNames = [];
  campaign.errors = [];
  // v2.112.26 (#3): a fresh launch must start with a clean live log. campaign.logs
  // is an append-only buffer the cockpit polls every 2s; without this reset the
  // PREVIOUS campaign's lines linger and the new run looks like it's replaying old
  // activity. On resume, keep the buffer — we're continuing the same campaign, so
  // its log history is still ours (mirrors the Recent-Connections-tab rule above).
  // Placed before any of this run's log() calls, so no new lines are lost.
  if (!resumeContext) campaign.logs = [];
  campaign.tally = emptyTally(); // v2.93 — per-run funnel + leak counters
  campaign.parkedProfiles = [];
  campaign._cooldown429 = new Map(); // profileId -> { until, pName, reason }
  campaign.softWarnings = [];
  campaign.profileEndReasons = [];
  campaign.sheetWriteFailures = 0;
  clearFailures();
  campaign.name = (typeof name === 'string' ? name : '').trim();
  // v2.13.14: stash the wizard inputs on the campaign object so the
  // monitoring path (runMonitoringCheck → runAutoIntros) can read them
  // without being passed every arg explicitly. Without this, the post-
  // campaign auto-intro silently no-ops because `templates.primaryName`
  // is undefined inside runMonitoringCheck.
  campaign.templates = templates || {};
  campaign.senderFirstNames = senderFirstNames || {};
  campaign.sheetUrl = sheetUrl || '';
  recordRuntimeInterruption('active-run');
  // Lead-source guard: the resolved tab. Read back by the run-guard, the
  // monitoring slice, and re-fetches so every read targets the chosen tab.
  campaign.sheetGid = sheetGid || '';
  campaign.linkedinColumn = linkedinColumn || '';
  // v2.58.x — IC-only sheet-mapping options exposed on campaign state so
  // restore/monitoring paths can read them back from a running campaign.
  campaign.senderColumn = senderColumn || '';
  campaign.allLeadsConnected = !!allLeadsConnected;
  // v2.14.x: operator-chosen cadence for the monitoring auto-trigger.
  // Read by transitionToMonitoring (initial nextCheckAt) and by
  // tickMonitoringNow (reschedule after each fire). Persisted via
  // monitoring-persistence so post-restart rehydration honors it.
  // Backstop clamp (defense in depth — the server already clamps, but other
  // callers like restore/resume must not slip an out-of-range value through).
  checkIntervalMinutes = clampCadenceMinutes(checkIntervalMinutes);
  campaign.checkIntervalMinutes = checkIntervalMinutes;
  // v2.112: operator's launch-time choice for the after-sending auto-checks.
  // shouldAutoFireCheck() in tickMonitoringNow honors this; persisted via the
  // monitoring slice so it survives restart, and adjustable live on the card.
  // Ortus Basics 1.0: every acceptance check is manual. The periodic watcher
  // never auto-fires — "⚡ Check now" is the only way a check runs — so the
  // launch payload's autoChecksEnabled is ignored here.
  campaign.autoChecksEnabled = false;
  // v2.112.7 (Fix B): operator's pause-on-throttle choice. ON ⇒ a
  // `throttle`-classified connect failure parks that account (jittered backoff)
  // so other accounts keep running; OFF ⇒ the account keeps sending through
  // throttling after only the backoff sleep. Older saved campaigns without the
  // field default ON (back-compat). Challenges always halt regardless.
  campaign.pauseOnThrottle = pauseOnThrottle !== false;
  // "Free for all Friday": stop sending just before LinkedIn's weekly invitation
  // allowance resets, so this run never spends next week's invites.
  campaign.weeklyCutoffAt = stopBeforeWeeklyReset ? new Date(weeklyCutoffMs(Date.now())).toISOString() : null;
  // "Free for all 25th": the same idea for the MONTHLY message allowances (1st of the month, UTC).
  campaign.monthlyCutoffAt = stopBeforeMonthlyReset ? new Date(monthlyCutoffMs(Date.now())).toISOString() : null;
  campaign.dailyLimit = dailyLimit;
  // The per-account panel's own state, keyed by profile id. Reset per run:
  //   accountHealth  — what the last monitoring sweep learned about an account
  //                    (cleared for that account the moment its next check
  //                    succeeds). Kept in memory only, like campaignCounts.
  //   _turnByProfile — where an account is in its CURRENT turn (leads per turn),
  //                    which is not its daily cap.
  //   _reachedByProfile — the people each account actually sent to this run.
  campaign.accountHealth = {};
  campaign._turnByProfile = {};
  campaign._reachedByProfile = {};
  campaign._lastSample = null;   // phase 11.1: reset resource snapshot
  campaign._throttle   = null;   // phase 11.1: reset throttle state
  _resetSampleCache();           // clear module-level cache so first sample() is fresh
  browserSemaphore._reset();     // 2.9.9: reset hard browser cap to default
  browserSemaphore.setMax(MAX_CONCURRENT_PROFILES);

  // Reset campaign counts — allows reusing same accounts immediately
  for (const key of Object.keys(campaignCounts)) delete campaignCounts[key];
  for (const key of Object.keys(campaignSendCounts)) delete campaignSendCounts[key];
  for (const key of Object.keys(campaignMessageCounts)) delete campaignMessageCounts[key];

  // v2.14.x: defensive guard — if the campaign launches as connect_and_introduce
  // without the primary person fields, every accepted invite would silently
  // skip the auto-intro (runAutoIntros' internal early-return). The wizard's
  // Start handler now hard-blocks this case at click-time, but a queued or
  // restored campaign could still slip through if its persisted payload was
  // built before that guard existed. Surface a loud warning so the audit log
  // shows what happened.
  if (mode === 'connect_and_introduce') {
    const _pName = (templates && templates.primaryName || '').trim();
    const _pBody = (templates && templates.primaryIntroBody || '').trim();
    if (!_pName || !_pBody) {
      log('⚠ Connect+IntroBack started WITHOUT primary person fields — auto-intros will be skipped on every acceptance. Stop and reconfigure to enable intros.');
    }
  }
  // v2.62: same defensive guard for connect_and_message (CC+DM). If the
  // wizard's Start handler missed enforcing the body field — or if a
  // queued/restored payload was built before the guard — log loudly so
  // the audit trail shows why auto-DMs never fired on acceptances.
  if (mode === 'connect_and_message') {
    const _ccDmBody = (templates && templates.ccDmBody || '').trim();
    if (!_ccDmBody) {
      log('⚠ Connect+DM started WITHOUT ccDmBody template — auto-DMs will be skipped on every acceptance. Stop and reconfigure to enable DMs.');
    }
  }

  // Normalize templates
  const tpl = normalizeTemplates(templates, mode);
  // v2.86.15: expose the live tpl object + mode so setLiveTemplates can mutate
  // this exact reference (the send loop reads tpl.*) while paused.
  campaign._liveTpl = tpl;
  campaign._liveMode = mode;

  const campaignStartTime = Date.now();

  // Central Operations Log: mark the start of this campaign run.
  _ops('INFO', 'Campaign started', {
    details: `mode: ${mode} · ${Array.isArray(profileIds) ? profileIds.length : 0} account(s) · daily limit: ${dailyLimit}`,
  });

  // v2.11.7: track how the run ended so the dashboard badge can say
  // "completed" / "stopped" / "errored" instead of always "completed".
  // Resolved once in finally — catch sets 'errored', operator-stop sets
  // 'stopped' from campaign._abort, otherwise stays 'completed'.
  let endReason = 'completed';

  // Referenced by the finally block (end-of-list bulk-check + monitoring
  // handoff), so it must live outside the try below.
  const profilesThatSentAtLeastOne = new Set();

  try {
    rotateCampaignLogIfBig();
    log('=== Campaign starting ===');
    log(`Mode: ${mode}`);
    log(`Profiles: ${profileIds.length} selected`);
    const _NO_LIMIT_MODES = new Set(['check_status', 'message_only', 'introduce_back', 'inmail_only']);
    log(`Campaign limit per account: ${_NO_LIMIT_MODES.has(mode) ? 'unlimited (fast-mode)' : dailyLimit}`);
    if (campaign.monthlyCutoffAt) log(`Free for all 25th: ON — this campaign stops itself at ${new Date(campaign.monthlyCutoffAt).toLocaleString()} (15 min before LinkedIn's monthly message allowance renews, the 1st at 00:00 UTC).`);
    if (campaign.weeklyCutoffAt) log(`Free for all Friday: ON — this campaign stops itself at ${new Date(campaign.weeklyCutoffAt).toLocaleString()} (Sunday 12:00 California time — ahead of LinkedIn's weekly invitation limit resetting).`);
    if (!_NO_LIMIT_MODES.has(mode)) {
      log(`  (set in launch wizard — adjust under "Campaign limit per account" before next run if this isn't what you expected)`);
    }
    if (concurrency > 1) {
      log(`▶ Concurrency=${concurrency} workers (browser cap=${MAX_CONCURRENT_PROFILES}).`);
    }
    log(`Templates: note=${tpl.connectionNote ? '✓' : '—'} followUp=${tpl.followUpMessage ? '✓' : '—'} inmail=${tpl.inmail.subject ? '✓' : '—'}`);
    if (linkedinColumn) log(`LinkedIn column: "${linkedinColumn}"`);
    if (messageOpenProfiles) log('Open Profile messaging: ON');

    // Preflight: warn if the host is already under heavy load.
    // Non-blocking — operator decides whether to continue.
    const health = await checkHostHealth();
    if (!health.ok) {
      log('⚠ Your machine is under heavy load — close some apps or the campaign may fail.');
      for (const w of health.warnings) log(`   • ${w}`);
    }

    // ── Fetch leads from Google Sheet ──
    log('Fetching sheet…');
    setAction('Reading the campaign sheet', {
      phase: 'starting', step: 'fetching_sheet',
      stepDetail: 'Loading leads and checking the selected sheet tab',
    });
    // Lead-source guard: always read the operator-chosen tab. withGid is a
    // no-op when sheetGid is empty (legacy single-tab links keep working).
    const _src = withGid(sheetUrl, campaign.sheetGid);
    const rows = await fetchSheetRows(_src);
    log(`${rows.length} row(s). Columns: ${Object.keys(rows[0] || {}).join(', ')}`);

    // ── Lead-source run-guard (safety backstop) ──
    // Before any sends, prove this is a lead tab. Aborts the launch on a
    // multi-tab workbook with no tab chosen, a known system tab, or rows that
    // don't look like a lead list. listSheetTabs is best-effort: if it throws
    // (Apps Script not redeployed / offline), treat tabCount as unknown=1 and
    // fall back to the rows check.
    let _tabCount = 1;
    let _tabName = '';
    if (!campaign.sheetGid) {
      try {
        const _tabs = await listSheetTabs(sheetUrl);
        _tabCount = Array.isArray(_tabs) ? _tabs.length : 1;
      } catch (tabErr) {
        log(`  ⚠ Could not enumerate sheet tabs (${tabErr.message}) — relying on the lead-row check.`);
        _tabCount = 1;
      }
    }
    const _guard = decideLeadSource({
      tabCount: _tabCount,
      gid: campaign.sheetGid,
      tabName: _tabName,
      rows,
    });
    if (!_guard.ok) {
      const _msg = `Refusing to launch — bad lead source (${_guard.reason}). Pick the correct lead tab and try again.`;
      log(`✖ ${_msg}`);
      _ops('ERROR', 'Lead-source guard blocked launch', { details: _guard.reason });
      throw new Error(_msg);
    }

    // v2.84: "Needs Login" SoO flag. When an account's session expires it can't
    // act on any of its leads, so flag every row assigned to that account
    // (Sender column) with 'Y' so the operator can filter the sheet to all
    // stalled leads. Cleared on the account's next successful action. Per-run
    // dedup so we don't re-write on every repeated park. Best-effort — failures
    // are logged, never thrown into the campaign loop.
    const _needsLoginAccounts = new Set();  // accountNorm currently flagged this run
    async function setAccountNeedsLogin(accountName, flagged) {
      try {
        const acctNorm = (accountName == null ? '' : accountName.toString().toLowerCase().trim());
        if (!acctNorm) return;
        if (flagged) {
          if (_needsLoginAccounts.has(acctNorm)) return;   // already flagged this run
          _needsLoginAccounts.add(acctNorm);
        } else {
          if (!_needsLoginAccounts.has(acctNorm)) return;  // nothing to clear
          _needsLoginAccounts.delete(acctNorm);
        }
        const updates = buildNeedsLoginUpdates(rows, accountName, senderColumn, linkedinColumn, flagged ? 'Y' : '');
        if (updates.length) {
          await batchUpdateSheet(sheetUrl, updates);
          log(`  ${flagged ? '⚑' : '✓'} Needs Login ${flagged ? 'flagged' : 'cleared'} — ${accountName} (${updates.length} row(s)).`);
        }
      } catch (err) {
        log(`  ⚠ Needs Login ${flagged ? 'flag' : 'clear'} failed for ${accountName}: ${err.message}`);
      }
    }

    // v2.95: SoO board write-back (companion to the lead-sheet Needs Login
    // above). Both wrappers are best-effort, one-way, per-run de-duped, and
    // never throw into the loop. They write to the team SoO "LinkedIn Accounts"
    // board, matched by Email == the account's GoLogin profile name.
    const _sooFlipped = new Set();      // accountNorm already flipped to In Use this run
    const _sooNeedsLogin = new Set();   // accountNorm already flagged Needs Login this run
    let _sooAccountsCache = null;
    let _sooFetchedAt = 0;
    const SOO_RESTRICTION_REFRESH_MS = 5 * 60 * 1000;

    // The SoO's Email-column values, fetched once per run for fuzzy resolution.
    // A failed fetch caches [] so we don't retry every account — the flip then
    // falls back to the raw GoLogin label (exact match only, as before).
    async function sooAccounts({ force = false } = {}) {
      if (!force && _sooAccountsCache && Date.now() - _sooFetchedAt < SOO_RESTRICTION_REFRESH_MS) return _sooAccountsCache;
      try {
        const soo = await fetchSoOData();
        _sooAccountsCache = ((soo && soo.accounts) || []).filter((a) => a && a.email);
        _sooFetchedAt = Date.now();
      } catch (_) {
        if (!_sooAccountsCache) _sooAccountsCache = [];
      }
      return _sooAccountsCache;
    }

    async function sooEmailList() {
      return (await sooAccounts()).map((a) => a.email).filter(Boolean);
    }

    async function restrictionForProfile(profileId) {
      const accountName = profileNameCache[profileId] || profileId;
      const accounts = await sooAccounts();
      const emails = accounts.map((a) => a.email).filter(Boolean);
      const resolved = resolveSoOEmail(accountName, emails);
      if (!resolved || !resolved.email || resolved.ambiguous) return '';
      const row = accounts.find((a) => String(a.email).toLowerCase().trim() === String(resolved.email).toLowerCase().trim());
      return identityRestrictionLabel(row);
    }

    // Resolve a GoLogin account label to its best SoO Email, fuzzily but safely
    // (shared by the In-Use flip and the weekly connection-count bump so both
    // key the same row). Returns { email, note } on success — email may be the
    // raw label when the SoO list is unavailable or no fuzzy match applies — or
    // { ambiguous:true, score } when two accounts tie and we must refuse to guess.
    async function resolveAccountSoOEmail(accountName) {
      let email = accountName;
      let note = '';
      const emails = await sooEmailList();
      if (emails.length) {
        const r = resolveSoOEmail(accountName, emails);
        if (r && r.ambiguous) return { ambiguous: true, score: r.score };
        if (r && r.email && !r.exact) {
          email = r.email;
          note = ` (≈ "${accountName}" → "${r.email}", ${Math.round(r.score * 100)}%)`;
        } else if (r && r.email) {
          email = r.email; // exact (normalized) — use the sheet's spelling
        }
      }
      return { email, note };
    }

    async function flipSoOInUse(accountName, action) {
      // Ortus Basics 1.0: the SoO is never written to, and resolving which row an
      // account maps to costs a full SoO fetch — through the Apps Script that is
      // timing out. That cost was being paid on every single lead before the
      // disabled check was ever reached (measured: 53s per send). Nothing about
      // the SoO should happen at all, so leave immediately.
      return;
      /* eslint-disable no-unreachable */
      try {
        const target = resolveSoOTarget(mode, action);
        if (!target) return;
        const acctNorm = (accountName || '').toString().toLowerCase().trim();
        if (!acctNorm || _sooFlipped.has(acctNorm)) return;
        // Claim the account NOW so two sends can't post the same flip
        // concurrently — but the claim is released again on a transport
        // failure (see the `catch`/`!res.ok` branches below), so the next lead
        // for this account retries instead of the flip being lost for the run.
        // It used to be a permanent mark taken BEFORE the attempt: one timeout
        // and the account sat on "Available" in the SoO for the whole campaign
        // while it was actually in use, free for someone else to grab.
        _sooFlipped.add(acctNorm);
        // Authoritative reserver = the per-machine operator email (set in the
        // app), since every operator logs in with the SAME shared credential.
        // Falls back to the login (blanked if it's the shared/admin account).
        const stampEmail = resolveOperatorStamp({
          perMachineEmail: getOperatorEmail(),
          loginEmail: campaign.createdBy || '',
        });
        // Resolve the GoLogin label to the closest SoO Email (handles typos /
        // ".solution" vs ".solutions" / stray spaces). Skip-on-doubt: a near-tie
        // between two accounts falls back to the raw label rather than risk
        // reserving the wrong person's account.
        const resolved = await resolveAccountSoOEmail(accountName);
        if (resolved.ambiguous) {
          log(`  ⚠ SoO: "${accountName}" is too close to 2+ accounts (best ${Math.round(resolved.score * 100)}%) — refusing to guess, left as-is.`);
          return;
        }
        const matchEmail = resolved.email;
        const fuzzyNote = resolved.note;
        const res = await flipAccountInUse({
          email: matchEmail,
          creditHeader: target.creditHeader,
          userHeader: target.userHeader,
          operatorEmail: stampEmail,
        });
        // Every outcome logs — a SoO write must never fail silently again.
        // (These three branches used to be the only one that spoke; matched:false,
        // write-back-off, and transport errors were all swallowed, which is how
        // an account could sit on "Available" forever with no trace.)
        if (res && res.ok && res.matched && res.written && res.written.length) {
          log(`  ⚑ SoO: ${accountName} → ${target.creditHeader} = In Use (${stampEmail || '—'})${fuzzyNote}.`);
        } else if (res && res.ok && res.matched) {
          // Row found, but the guard left the credit cell alone. `skipped` carries
          // the real current value, e.g. 'CC (Credits) (not Available: "in use")'
          // — surface it verbatim so a stuck "Available" is self-explaining.
          const why = (Array.isArray(res.skipped) && res.skipped.length)
            ? res.skipped.join('; ')
            : `${target.creditHeader} not Available`;
          log(`  · SoO: ${accountName} not flipped — ${why}.`);
        } else if (res && res.ok && res.matched === false) {
          // No SoO row whose Email equals this account. Almost always a GoLogin
          // profile NOT named with the account's email (e.g. "test3").
          log(`  ⚠ SoO: no row matched "${accountName}" — nothing flipped. Is the GoLogin profile named with the account's email?`);
        } else if (res && res.disabled) {
          log(`  ⚠ SoO: write-back is OFF on this machine (ORTUS_SOO_WRITEBACK) — ${accountName} left as-is.`);
        } else if (!res || !res.ok) {
          // Transport-level failure (timeout, HTTP error, script error). Unlike
          // "no row matched" or a guard skip, this says nothing about the sheet
          // — release the claim so the next lead for this account tries again.
          _sooFlipped.delete(acctNorm);
          log(`  ⚠ SoO: flip failed for ${accountName} — ${(res && res.error) || 'unknown error'}. Will retry on the next lead.`);
        }
      } catch (err) {
        const acctNorm = (accountName || '').toString().toLowerCase().trim();
        if (acctNorm) _sooFlipped.delete(acctNorm);
        log(`  ⚠ SoO flip failed for ${accountName}: ${err.message}. Will retry on the next lead.`);
      }
    }

    // v2.124: weekly connection-count write-back. Fires on EVERY successful
    // connection send in a connect mode (CC / CC+IC / CC+DM) — unlike the
    // once-per-run In-Use flip — POSTing a +1 delta the Apps Script accumulates
    // into the SoO "Number of Connections (this week)" cell (col AX), resetting
    // it on a new ISO week. Best-effort: never throws into the send loop. The
    // per-account naming/ambiguity warnings are left to flipSoOInUse (which runs
    // first) so this doesn't double-log them.
    async function bumpSoOConnCount(accountName, action) {
      // Ortus Basics 1.0: the SoO is never written to, and resolving which row an
      // account maps to costs a full SoO fetch — through the Apps Script that is
      // timing out. That cost was being paid on every single lead before the
      // disabled check was ever reached (measured: 53s per send). Nothing about
      // the SoO should happen at all, so leave immediately.
      return;
      /* eslint-disable no-unreachable */

      try {
        if (!isConnectSend(mode, action)) return;
        const acctNorm = (accountName || '').toString().toLowerCase().trim();
        if (!acctNorm) return;
        const resolved = await resolveAccountSoOEmail(accountName);
        if (resolved.ambiguous) return; // flipSoOInUse already logged the tie
        const res = await bumpConnectionsThisWeek({ email: resolved.email, delta: 1 });
        if (res && res.ok && res.matched) {
          log(`  # SoO: ${accountName} → connections this week = ${res.value}${res.reset ? ' (new week — reset)' : ''}.`);
        } else if (res && res.ok && res.matched === false) {
          log(`  · SoO: no row matched "${accountName}" for connection count — check the SoO Email spelling.`);
        } else if (res && res.disabled) {
          // write-back OFF on this machine — flipSoOInUse already said so.
        } else if (!res || !res.ok) {
          log(`  ⚠ SoO: connection-count bump failed for ${accountName} — ${(res && res.error) || 'unknown error'}.`);
        }
      } catch (err) {
        log(`  ⚠ SoO connection-count failed for ${accountName}: ${err.message}`);
      }
    }

    async function markSoONeedsLogin(accountName) {
      try {
        const acctNorm = (accountName || '').toString().toLowerCase().trim();
        if (!acctNorm || _sooNeedsLogin.has(acctNorm)) return;
        _sooNeedsLogin.add(acctNorm);
        const res = await markAccountNeedsLoginSoO({ email: accountName });
        if (res && res.ok && res.matched) {
          log(`  ⚑ SoO: ${accountName} → Needs Login = Y.`);
        }
      } catch (err) {
        log(`  ⚠ SoO Needs Login failed for ${accountName}: ${err.message}`);
      }
    }

    // v2 schema: prepareSheet provisions only this mode's columns and hides
    // every other mode's columns. Apps Script returns BAD_MODE only on
    // unknown modes — known modes always provision/hide. Fall back to the
    // legacy ensureTrackingColumns path when prepareSheet doesn't confirm
    // (e.g. SHEETS_WEBAPP_URL not set, or bridge not redeployed yet).
    const prep = await prepareSheet(sheetUrl, mode).catch(err => {
      log(`⚠ prepareSheet failed: ${err.message}`);
      return { ok: false };
    });
    if (!prep.ok) {
      log(`  ⚠ prepareSheet didn't confirm${prep.reason ? ` (${prep.reason})` : ''} — falling back to legacy ensureTrackingColumns`);
      await ensureTrackingColumns(sheetUrl, mode).catch(err => {
        log(`⚠ Could not ensure tracking columns: ${err.message}`);
      });
    } else if (prep.hidden?.length) {
      log(`  ℹ Hidden columns from prior modes: ${prep.hidden.join(', ')}`);
    }

    const state = await loadState();

    // Hotfix 2.8.24-P1: clear stale _in_progress markers from previous runs.
    // These accumulate from (a) exceptions in the per-lead catch at the bottom
    // of the inner loop, (b) WEEKLY_LIMIT / INMAIL_NO_CREDITS branches that
    // don't clean up, and (c) hard crashes mid-lead. Without this, leads stuck
    // _in_progress are invisible to the pre-filter for STATE_RETENTION_DAYS.
    const stalePending = Object.entries(state.processed).filter(
      ([, v]) => v?.action === '_in_progress'
    );
    if (stalePending.length > 0) {
      log(`Clearing ${stalePending.length} stale _in_progress marker(s) from previous run`);
      for (const [url] of stalePending) delete state.processed[url];
      await saveState(state);
    }

    // v2.14.x: Resume support — seed campaignCounts from today's entries in
    // state.processed so an account that already sent N leads today (whether
    // on this campaign or one stopped earlier today) keeps that count instead
    // of resetting to 0/dailyLimit. This is what makes "Resume same settings"
    // pick up where the prior run left off, AND it cumulatively caps daily
    // activity so LinkedIn's per-day quotas can't be blown by stop-and-restart.
    // Skip-only actions don't count toward the daily send total.
    const _todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const _skipActions = new Set(['_in_progress', 'email_required', 'not_open_profile']);
    let _seedTotal = 0;
    for (const entry of Object.values(state.processed)) {
      if (!entry || !entry.profileId || !entry.date) continue;
      if (!entry.date.startsWith(_todayPrefix)) continue;
      if (_skipActions.has(entry.action)) continue;
      if (!profileIds.includes(entry.profileId)) continue;
      campaignCounts[entry.profileId] = (campaignCounts[entry.profileId] || 0) + 1;
      if (entry.action === 'connection_sent') {
        campaignSendCounts[entry.profileId] = (campaignSendCounts[entry.profileId] || 0) + 1;
      }
      if (SENT_ACTIONS.has(entry.action) && entry.action !== 'connection_sent') {
        campaignMessageCounts[entry.profileId] = (campaignMessageCounts[entry.profileId] || 0) + 1;
      }
      _seedTotal++;
    }
    if (_seedTotal > 0) {
      const summary = Object.entries(campaignSendCounts)
        .filter(([, n]) => n > 0)
        .map(([pid, n]) => {
          const pName = profileNameCache[pid] || (pid === 'local-browser' ? 'You' : pid);
          return `${pName} ${n}/${dailyLimit}`;
        }).join(' · ');
      log(`▶ Resuming today's counts: ${summary}`);
    }

    // Pre-filter targets. Filter rules (new schema):
    //   - check_status: only process rows with CC="Sent" (pending invites).
    //   - all other modes: skip rows where Status="Done".
    //   - connect_only: additionally require no prior CC history.
    //   - messaging modes (OP/DM/InMail): additionally skip rows where
    //     the campaign-specific column is already filled.
    // 2.9.0: detect new schema. If the sheet has a Stage column, Stage is
    // the single source of truth for filtering. Old sheets fall through to
    // the legacy CC/OP/Message/InMail logic below — unchanged.
    const hasStageSchema = rows.length > 0 && ('Stage' in rows[0] || 'stage' in rows[0]);

    // v2.58.x — Introduction Campaign + "all leads already connected"
    // bypass. When the operator has confirmed the sheet contains only
    // 1st-degree connections, skip the Stage gate entirely so a plain
    // sheet (no Stage column) works. Re-runs are still blocked because
    // a successful send stamps 'Introduction Status = IC Sent' which we
    // honor as the terminal-marker here. Failed rows (Introduction
    // Status starts with "Failed —") remain retryable.
    const icAllConnectedBypass = (mode === 'introduce_back' && allLeadsConnected);
    const dmAllConnectedBypass = (mode === 'message_only' && allLeadsConnected);
    if (icAllConnectedBypass) {
      log(`Introduction Campaign · "all leads already connected" — Stage filter bypassed.`);
    }
    if (dmAllConnectedBypass) {
      log(`Direct Messages · "all leads already connected" — Stage filter bypassed.`);
    }

    const _isTarget = (row) => {
      const url = extractLinkedInUrl(row, linkedinColumn);
      if (!url) return false;

      if (icAllConnectedBypass) {
        // v2.71: Intro Status is a one-shot column. ANY non-empty value
        // is terminal — 'IC Sent', 'Introduction Made', 'Failed — …',
        // 'Skipped — …', operator notes, anything. Operator must clear
        // the cell manually to re-enable a retry. Both header aliases
        // checked because CC+IC writes long-form 'Introduction Status'
        // and pure IC writes short-form 'Intro Status'.
        const introStatus = (
          row['Intro Status'] || row['intro status'] || row['Intro status'] ||
          row['Introduction Status'] || row['introduction status'] ||
          row['Introduction status'] || row['introStatus'] || ''
        ).toString().trim();
        return introStatus === '';
      }

      if (dmAllConnectedBypass) {
        // v2.61: DM mirrors IC. Single-column terminal check on DM Status.
        // Header per google-apps-script.js is 'DM Status'; aliases for
        // back-compat sheets and JSON-cased lookups.
        const dmStatus = (
          row['DM Status'] || row['dm status'] || row['DM status'] ||
          row['Direct Message Status'] || row['dmStatus'] || ''
        ).toString().trim();
        if (dmStatus === 'DM Sent') return false;
        return true;
      }

      // ── 2.9.0 Stage-based filtering ─────────────────────────────
      if (hasStageSchema) {
        const stage = (row['Stage'] || row['stage'] || '').toString().trim();
        const TERMINAL = new Set(['DM Sent', 'IC Sent', 'InM Sent', 'OP Sent', 'Replied', 'Done']);
        // 2.9.10: Stage may now carry the full skip reason
        // (e.g., "Skipped: URL not found"), not just bare "Skipped". Any value
        // starting with "Skipped" is terminal.
        const isSkipped = stage.startsWith('Skipped');

        // v2.11.15: with the Stage schema, the Stage cell is the single
        // source of truth for "is this row processable". The local
        // state.processed file used to layer an extra block, but that
        // meant a manual sheet edit (e.g. operator resets Stage to
        // 'Connected · DM Now' to re-test) was silently overruled by a
        // stale local marker. Drop the state.processed[url] checks here;
        // Stage carries the same information from the bridge writeback,
        // and the in-loop _in_progress marker (line ~1431) still
        // prevents two workers from racing on the same lead within one
        // run. Trade-off: if the sheet write fails after a successful
        // send, the next run could re-send. Acceptable given the
        // ergonomic win — and Stage writebacks have been reliable.
        if (mode === 'check_status') {
          return stage === 'Connect Pending';
        }
        if (mode === 'introduce_back') {
          // v2.59: IC tabs are separate from connection tabs and don't
          // necessarily have a Stage column. Filter reads only from the
          // Intro Status column — blank = process, anything else (IC Sent,
          // Failed — …, operator note, anything) = skip.
          // Header name per google-apps-script.js:319 is 'Intro Status';
          // long-form aliases kept for back-compat. Mirrored in the
          // in-loop re-validation below (~line 2188).
          const introStatus = (
            row['Intro Status'] || row['intro status'] || row['Intro status'] ||
            row['Introduction Status'] || row['introduction status'] ||
            row['Introduction status'] || row['introStatus'] || ''
          ).toString().trim();
          return introStatus === '';
        }
        if (mode === 'message_only') {
          // v2.61: Workflow A — full IC symmetry. Renamed display
          // "Message Only" → "Direct Messages". Single-column predicate
          // mirroring introduce_back: blank DM Status → process, anything
          // else (DM Sent, Failed — …, operator note) → skip. No Stage /
          // Connection Accepted Status read here; the operator vouches
          // for connection status by curating the sheet (or running
          // check_status first and pruning manually). Mirrored in the
          // in-loop re-validation further down this file.
          const dmStatus = (
            row['DM Status'] || row['dm status'] || row['DM status'] ||
            row['Direct Message Status'] || row['dmStatus'] || ''
          ).toString().trim();
          return dmStatus === '';
        }
        // Cold-lead modes — operator-confirmed: process only blank-Stage
        // rows. Any non-blank value means 'leave alone' (either a prior
        // run touched it, it's terminal, or it's a manual note).
        if (mode === 'connect_only' || mode === 'connect_and_introduce' || mode === 'connect_and_message') {
          return stage === '';
        }
        if (mode === 'inmail_only' || mode === 'open_profile_only') {
          // InMail and OP are 'coming soon' in v2.59 but kept aligned with
          // the cold-lead rule above for consistency if re-enabled.
          return stage === '';
        }
        // Other modes: terminal stages skip, everything else passes through.
        if (TERMINAL.has(stage) || isSkipped) return false;
        return true;
      }

      // ── Legacy schema filtering (sheets without a Stage column) ──
      const status    = (row['Connection Status'] || row['connection status'] || row['Status']  || row['status']  || '').toString().toLowerCase().trim();
      const cc        = (row['CC']      || row['cc']      || '').toString().toLowerCase().trim();
      const opCell    = (row['OP']      || row['op']      || '').toString().toLowerCase().trim();
      const msgCell   = (row['Message'] || row['message'] || '').toString().toLowerCase().trim();
      const inmailCell= (row['InMail']  || row['inmail']  || '').toString().toLowerCase().trim();
      const msgSent   = msgCell === 'sent' || opCell === 'sent';

      if (mode === 'check_status') {
        // 2.8.29: Account Used (column D) being filled = an invite was sent.
        // CC text is no longer the source of truth.
        const acct = getSenderName(row, senderColumn);
        return acct.length > 0;
      }

      if (mode === 'message_only') {
        // 2.8.31: messageable = Voyager-confirmed connection (CC ends with " Y")
        // AND no message/OP sent yet.
        // Status="Check Done." rows are EXPLICITLY allowed — they're the only
        // rows that have ever been verified. The status==='done' filter below
        // would otherwise reject every accepted invite.
        if (msgSent) return false;
        // 2.8.33: only block on state.processed when action proves a DM was
        // actually sent in a prior run (P-04 safety net for the case where the
        // LinkedIn send succeeded but the Sheets write failed). status_accepted
        // / connection_sent etc. are NOT blockers — they're exactly the rows we
        // want to message. The inner-loop lead picker (line ~1154) already
        // exempts message_only from the blanket state.processed skip; the
        // pre-filter must match.
        const prev = state.processed[url];
        if (prev && (prev.action === 'message_sent' || prev.action === 'op_message_sent')) return false;
        // Connected Status (was CC) = 'Connected' is the new
        // verified-acceptance signal, replacing the legacy " Y" suffix.
        // Tolerate both for sheets mid-migration.
        const ccRaw = (row['Connected Status'] || row['connected status'] || row['CC'] || row['cc'] || '').toString().trim();
        const isConnected = ccRaw === 'Connected' || /\sY\s*$/.test(ccRaw);
        if (!isConnected) return false;
        return true;
      }

      if (status === 'done') return false;

      if (mode === 'connect_only' || mode === 'connect_and_introduce' || mode === 'connect_and_message') {
        // Per-tab source of truth: only the Status column gates re-processing.
        // CC may carry residual data from past attempts (sender name, status
        // colours, "—" placeholder) and is no longer a blocker on its own.
        // Status is checked at line 908 above (== 'done') and broadened here
        // to catch the new 'Connection Request Sent' value plus any other
        // non-blank value the operator may have filled in.
        if (status) return false;
        if (messageOpenProfiles && opCell === 'sent') return false;
        return true;
      }

      if (mode === 'open_profile_only') {
        if (msgSent) return false;
        return true;
      }

      if (mode === 'inmail_only') {
        if (inmailCell === 'sent') return false;
        return true;
      }

      return true;
    }; // end _isTarget

    // Pre-flight hard exclusions (blocklist) — normalized-URL match.
    // Central guard: unconditionally apply blocklist to ALL launch paths
    // (start, queue-only, relaunch, scheduler, restore). Runs independently of
    // any ack token so blocklisted rows can never reach the campaign.
    let _centralBlocklistUrls = [];
    try {
      _centralBlocklistUrls = blocklistExcludedUrls(rows, { linkedinColumn, mode, blocklist: readBlocklist() });
      if (_centralBlocklistUrls.length) {
        log(`Pre-flight: ${_centralBlocklistUrls.length} blocklisted row(s) excluded (central guard)`);
      }
    } catch (guardErr) {
      log(`[warn] Pre-flight central guard failed (non-blocking): ${guardErr.message}`);
      pushSoftWarning(campaign, { profileId: '', pName: '', kind: 'preflight_guard_error', message: `Central blocklist guard error: ${guardErr.message}` });
    }
    const _allExcludedUrls = [...new Set([...(excludedUrls || []), ..._centralBlocklistUrls])];
    const _pfExcluded = new Set(_allExcludedUrls.map((u) =>
      String(u).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').split('?')[0]));
    const _pfRows = _pfExcluded.size
      ? (() => {
          const before = rows.length;
          const filtered = rows.filter((r) => {
            const u = extractLinkedInUrl(r, linkedinColumn) || '';
            const nu = u.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').split('?')[0];
            return !_pfExcluded.has(nu);
          });
          if (filtered.length !== before) log(`Pre-flight: ${before - filtered.length} row(s) excluded total`);
          return filtered;
        })()
      : rows;

    const targets = _pfRows.filter(_isTarget);
    log(`Pre-filter → ${targets.length} to process, ${_pfRows.length - targets.length} skipped (mode: ${mode})`);
    campaign.totalTargets = _resumeTotal + targets.length;

    // Load profile names
    log('Loading profile names…');
    setAction('Preparing the selected accounts', {
      phase: 'starting', step: 'loading_accounts',
      stepDetail: `${profileIds.length} account${profileIds.length === 1 ? '' : 's'} selected · resolving GoLogin profiles`,
    });
    // 2.8.29: in check_status mode profileIds starts empty (auto-derived from
    // sheet below) — but we still need the GoLogin token to fetch the profile
    // list and resolve Account Used → profile id. Always grab the token here.
    const hasGoLoginProfiles = profileIds.some(id => id !== 'local-browser');
    // 2.8.31: message_only also auto-derives profileIds from sheet (only the
    // sender that connected the lead can DM it), so we need the GoLogin token
    // even when the UI didn't pre-select profiles.
    const tokenNeeded = hasGoLoginProfiles || mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back';
    const token = tokenNeeded ? getToken() : null;
    for (const pid of profileIds) {
      if (pid === 'local-browser') {
        // 2.9.1: display name is "You" (was "Local Browser"). Sheet writeback
        // and dashboard pick this up via profileNameCache.
        profileNameCache[pid] = 'You';
      } else {
        await getProfileName(pid, token);
      }
    }

    // 2.8.28-P2: per-profile target slices (named for legacy reasons; used by
    // BOTH check_status and message_only since 2.8.31). Consumed by the inner
    // loop's per-profile cursor logic.
    let _checkStatusTargetsByProfile = null;

    // 2.8.28 (Check Status routing) / 2.8.31 (extended to message_only):
    // For modes where each row can only be processed by its original sender
    // (check_status — only the sender knows; message_only — only the sender
    // is connected), ignore UI-selected profileIds and auto-derive from
    // Account Used. Using any other account silently fails Voyager checks.
    if (mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back') {
      // Refresh the cache to ensure newly-added profiles are visible.
      if (token) {
        try {
          const all = await getProfiles(token);
          profileNameCache = {};
          for (const p of all) profileNameCache[p.id] = p.name;
        } catch (err) {
          log(`⚠ Could not refresh GoLogin profile list: ${err.message}`);
        }
      }
      const nameToId = {};
      Object.keys(profileNameCache).forEach(id => { nameToId[profileNameCache[id]] = id; });
      // 2.8.29: Local browser is a valid pseudo-profile. Sheets store its
      // Account Used as variants like "local-browser", "local-browser - manual",
      // or "Local Browser" — all map to the single 'local-browser' pseudo-id.
      // 2.9.1: keep all historical display names mapped back to the canonical
      // 'local-browser' id so existing sheet rows still auto-route correctly.
      nameToId['You']                    = 'local-browser';
      nameToId['Local Browser']          = 'local-browser';
      nameToId['local-browser']          = 'local-browser';
      nameToId['local-browser - manual'] = 'local-browser';

      const sendersInSheet = new Map(); // name -> count (uses display name)
      const unmatchedSenders = new Map(); // name -> count
      for (const row of targets) {
        const acct = getSenderName(row, senderColumn);
        if (!acct) {
          unmatchedSenders.set('(blank)', (unmatchedSenders.get('(blank)') || 0) + 1);
          continue;
        }
        if (nameToId[acct]) {
          // For local-browser variants, bucket under the canonical "You" label. (2.9.1)
          const displayName = (nameToId[acct] === 'local-browser') ? 'You' : acct;
          sendersInSheet.set(displayName, (sendersInSheet.get(displayName) || 0) + 1);
        } else {
          unmatchedSenders.set(acct, (unmatchedSenders.get(acct) || 0) + 1);
        }
      }

      const derivedProfileIds = [];
      for (const name of sendersInSheet.keys()) {
        derivedProfileIds.push(nameToId[name]);
      }

      const modeLabel = (mode === 'check_status') ? 'Check Status'
                      : (mode === 'introduce_back') ? 'Introduce Back'
                      : 'Message Only';
      const rowLabel = (mode === 'check_status') ? 'pending' : 'connected (Y)';
      log(`${modeLabel} auto-routing → ${derivedProfileIds.length} sender(s) found in sheet`);
      sendersInSheet.forEach((count, name) => log(`  • ${name}: ${count} ${rowLabel}`));
      if (unmatchedSenders.size > 0) {
        log(`⚠ Skipping ${[...unmatchedSenders.values()].reduce((a,b)=>a+b,0)} row(s) whose Sender is unknown:`);
        unmatchedSenders.forEach((count, name) => log(`  • ${name}: ${count} row(s) — no GoLogin profile matches`));
      }

      if (derivedProfileIds.length === 0) {
        log(`✗ ${modeLabel}: no sender accounts in the sheet match any GoLogin profile in this workspace.`);
        log('=== Campaign ended ===');
        campaign.running = false;
        campaign.endedAt = Date.now();
        return;
      }

      // Replace the UI-selected list with the derived list.
      profileIds = derivedProfileIds;
      // 2.8.29: ensure local-browser has a display name in the cache even when
      // it came from auto-derivation rather than UI selection.
      if (derivedProfileIds.includes('local-browser') && !profileNameCache['local-browser']) {
        profileNameCache['local-browser'] = 'You'; // 2.9.1: was 'Local Browser'
      }

      // 2.8.28-P2: Build per-profile target lists. Without this, the shared
      // round-robin leadIndex would burn BATCH_SIZE slots per profile on
      // skipped non-matching rows — every profile would close with 0
      // processed. Each profile gets its own slice and its own cursor below.
      _checkStatusTargetsByProfile = {};
      for (const pid of derivedProfileIds) _checkStatusTargetsByProfile[pid] = [];
      for (const row of targets) {
        const acct = getSenderName(row, senderColumn);
        const pid = nameToId[acct];
        if (pid && _checkStatusTargetsByProfile[pid]) {
          _checkStatusTargetsByProfile[pid].push(row);
        }
      }
    }

    campaign.profileNames = profileIds.map(id =>
      profileNameCache[id] || (id === 'local-browser' ? 'You' : id)
    );
    // Mirror the IDs alongside the names so the dashboard's per-row Open
    // Browser / Try Again buttons can call profile-specific endpoints.
    campaign.profileIds = profileIds.slice();
    log(`${Object.keys(profileNameCache).length} profiles in cache.`);

    // ── Phase 11.2: LAZY-LAUNCH BATCH LOOP ──
    // Profiles open on first batch (D-10). Each profile processes BATCH_SIZE leads
    // back-to-back, then either parks on about:blank (short gap) or closes + re-opens
    // next batch (long gap, D-13). Session break is gone (D-04). batchesPerHour sets
    // the target between-batch spacing (D-03).

    // Campaign-scoped session cache, replaces activeSessions array.
    const sessions = new Map(); // profileId → { profileId, pName, browser, page, warmedUp }

    /**
     * Lazy launch + warmup + health check. Called on first batch per profile;
     * subsequent batches short-circuit to the cached session (D-11 — 20s warmup
     * only on first open). Returns null if the profile cannot be made healthy.
     */
    async function ensureOpen(profileId) {
      // Phase 2.8.10: refuse to launch new browsers after stop has been
      // requested. Closes the launch-race that was leaving orphan windows
      // requiring a second Stop click to clean up.
      if (campaign._abort) return null;

      const cached = sessions.get(profileId);
      if (cached) return cached;

      // 2.9.2: never let the raw profileId 'local-browser' leak to the sheet
      // (it bypasses profileNameCache when that's stale). Force 'You'.
      const pName = profileNameCache[profileId] || (profileId === 'local-browser' ? 'You' : profileId);
      campaign.currentProfile = pName;

      // 2.9.9: hard browser cap is now enforced by the global semaphore in
      // browser-semaphore.js (replaces the old sessions.size >= cap check).
      // acquire() blocks until a slot is free — workers naturally serialize
      // when more want to launch than the cap allows.
      const semStatusBefore = browserSemaphore.getStatus();
      if (semStatusBefore.count >= semStatusBefore.max) {
        log(`  ⏸ ${pName}: waiting for browser slot (${semStatusBefore.count}/${semStatusBefore.max} in use)`);
      }
      try {
        await browserSemaphore.acquire({ signal: campaign._abortController?.signal });
      } catch (err) {
        if (campaign._abort || err?.name === 'AbortError') return null;
        throw err;
      }

      let success = false;
      try {
        if (campaign._abort) return null;
        log(`▶ Opening ${pName}…`);
        setAction('Opening browser', {
          account: pName, phase: campaign.phase === 'preflight' ? 'starting' : 'sending',
          step: 'opening_browser', stepDetail: 'Starting the GoLogin browser and restoring its LinkedIn session',
        });
        let launched;
        if (profileId === 'local-browser') {
          launched = await launchLocalBrowser();
        } else {
          launched = await launchProfile(profileId, token);
        }

        // Phase 2.8.10: abort may have fired DURING the launch above. Close
        // the just-launched browser immediately rather than letting it become
        // an orphan that survives /api/campaign/stop.
        if (campaign._abort) {
          log(`■ ${pName}: stop requested mid-launch — closing immediately.`);
          try {
            if (profileId === 'local-browser') await closeLocalBrowser();
            else await closeProfile(profileId);
          } catch { /* */ }
          return null;
        }

        const { page, ok, sessionExpired } = await ensureProfileLoggedIn(launched, profileId, pName);
        if (sessionExpired) {
          // Phase 2.8.20 (W2-A2): drop this profile from the round-robin and
          // surface in the right pane via parkedProfiles (W1-B1's mechanism).
          weeklyLimited.add(profileId);
          recordProfileEnd(profileId, pName, 'Session expired — log in again');
          campaign.parkedProfiles.push({
            profileId,
            pName,
            parkedAt: Date.now(),
            reason: 'session_expired',
          });
          // v2.84: flag every LEAD row handled by this account (Sender column)
          // as Needs Login = Y in the campaign sheet, so the operator can filter
          // to the stalled leads.
          await setAccountNeedsLogin(pName, true);
          // v2.95: ALSO flag this account on the SoO "LinkedIn Accounts" board
          // (matched by Email == profile name) so the LinkedIn team re-logs it.
          // Never auto-cleared. Best-effort — cannot affect the loop.
          await markSoONeedsLogin(pName);
          // Close the now-unusable session immediately to free RAM
          try {
            if (profileId === 'local-browser') await closeLocalBrowser();
            else await closeProfile(profileId);
          } catch { /* */ }
          return null;
        }
        if (!ok) return null;
        if (campaign._abort) {
          try {
            if (profileId === 'local-browser') await closeLocalBrowser();
            else await closeProfile(profileId);
          } catch { /* */ }
          return null;
        }

        // 2.8.27: home-page warmup removed per operator request — saved ~20s
        // per profile launch. The cache-clear nav already loads LinkedIn home,
        // and the per-lead navigation has its own networkidle0 + DOM-settle
        // waits, so the additional dwell here was redundant.

        const session = { profileId, pName, browser: launched.browser, page, warmedUp: true };
        sessions.set(profileId, session);
        success = true;

        // Pre-flight / standalone Check Status. Three trigger paths:
        //   1. preflightCheckStatus toggle on message_only / introduce_back
        //   2. mode === 'check_status' — bulk-first, per-lead fallback on
        //      failure (Sam's bulk approach; falls back to existing per-lead
        //      navigation if Voyager fetch errors out).
        // Errors are non-fatal — campaign proceeds either way. Bypasses the
        // 6h cooldown (explicit operator action for this run), then refreshes
        // the cooldown timestamp so back-to-back sweeps don't pile up.
        const isCheckStatusMode = mode === 'check_status';
        const isPreflightMode = preflightCheckStatus
          && (mode === 'message_only' || mode === 'introduce_back');
        if (isCheckStatusMode || isPreflightMode) {
          let bulkSucceeded = false;
          try {
            const label = isCheckStatusMode ? 'Check Status (bulk)' : 'Pre-flight Check Status';
            log(`  📡 [${pName}] ${label} sweep…`);
            const r = await bulkCheckConnections(page, sheetUrl, linkedinColumn, pName);
            if (r.error) {
              log(`  ⚠ [${pName}] Bulk check: ${r.error}`);
            } else {
              log(r.plain || `  ✓ [${pName}] Bulk: ${r.matched} Connected, ${r.stamped || 0} Still Pending (of ${r.fetched} fetched)`);
              bulkSucceeded = true;
            }
            try {
              const _sheetId = _extractSheetIdFromUrl(sheetUrl);
              const cooldown = await readBulkCheckCooldown();
              cooldown[bulkCheckKey(_sheetId, profileId)] = Date.now();
              await writeBulkCheckCooldown(cooldown);
            } catch { /* cooldown bookkeeping is best-effort */ }
          } catch (err) {
            log(`  ⚠ [${pName}] Bulk check threw: ${err.message}`);
          }

          // check_status: bulk handles ALL of this account's pending leads in
          // one Voyager call (marks Connected for matches, Still Pending for
          // unmatched-but-invited). When bulk succeeds, the per-lead loop
          // would just re-do work the bulk already did — close the profile so
          // the account rotation moves on. When bulk FAILS, fall through to
          // the existing per-lead navigation (Sam's approach failed → ours).
          if (isCheckStatusMode && bulkSucceeded) {
            log(`  ✓ [${pName}] check_status complete via bulk — closing profile`);
            recordProfileEnd(profileId, pName, 'Check Status complete (bulk)');
            weeklyLimited.add(profileId);
          }
        }

        return session;
      } catch (err) {
        log(`✗ ${pName}: failed to open — ${err.message}`);
        pushError(err);
        return null;
      } finally {
        // Release the slot if we didn't return a live session — closeSession()
        // is responsible for releasing in the success path.
        if (!success) browserSemaphore.release();
      }
    }

    /**
     * Close a single profile's browser, timing the operation (Q5 observability).
     * Serialized by the caller — only one close at a time (Pitfall 5 resolution).
     * Guards against double-close via sessions.get() guard.
     */
    async function closeSession(profileId) {
      const s = sessions.get(profileId);
      if (!s) return { durationMs: 0 };
      const t0 = Date.now();
      const withinCloseDeadline = async (work, label) => {
        let timer;
        try {
          return await Promise.race([
            Promise.resolve().then(work),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} exceeded 15 second close deadline`)), 15_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      try {
        if (profileId === 'local-browser') {
          await withinCloseDeadline(() => closeLocalBrowser(), 'Local browser');
        } else {
          await withinCloseDeadline(async () => {
            const pages = await s.browser.pages().catch(() => []);
            for (const p of pages) {
              try { await p.close(); } catch { /* */ }
            }
            await s.browser.close().catch(() => {});
            await closeProfile(profileId);
          }, `${s.pName} browser`);
        }
        const durationMs = Date.now() - t0;
        log(`✓ ${s.pName} browser closed. ⏱ close duration ${durationMs}ms`);
        sessions.delete(profileId);
        browserSemaphore.release();
        return { durationMs };
      } catch (e) {
        const durationMs = Date.now() - t0;
        log(`Close ${s.pName}: ${e.message} (⏱ ${durationMs}ms)`);
        sessions.delete(profileId);
        browserSemaphore.release();
        return { durationMs };
      }
    }

    /**
     * v2.14 — idle bulk-check. Briefly reopens a parked profile, fires
     * bulkCheck + runAutoIntros, closes. Respects browserSemaphore. Failures
     * non-fatal. Called from the worker-pool loop when shouldFireIdleBulkCheck
     * returns true for a profile.
     */
    async function runIdleBulkCheck(profileId, pName) {
      try {
        await browserSemaphore.acquire({ signal: campaign._abortController?.signal });
      } catch (err) {
        if (campaign._abort || err?.name === 'AbortError') return;
        throw err;
      }
      // v2.74: if Stop landed while we waited for a semaphore slot, don't even
      // open the browser.
      if (campaign._abort) { browserSemaphore.release(); return; }
      let launched;
      // v2.74: register the in-flight check so stopCampaign() can force-close
      // this browser and interrupt a check already mid-flight.
      activeBulkChecks.add(profileId);
      try {
        log(`  📡 [${pName}] Idle bulk-check — briefly reopening profile…`);
        launched = await launchProfile(profileId, token);

        const willAutoIntro = mode === 'connect_and_introduce' && _primaryIntroAllowed(profileId) && !!(
          tpl && tpl.primaryName && tpl.primaryName.trim() &&
          tpl.primaryIntroBody && tpl.primaryIntroBody.trim()
        );
        // v2.62: CC+DM equivalent gate. Same shape — only fires when the
        // body template is non-empty (otherwise runAutoDms internal early-
        // return would skip every lead anyway).
        const willAutoDm = mode === 'connect_and_message' && !!(
          tpl && tpl.ccDmBody && tpl.ccDmBody.trim()
        );
        const r = await bulkCheckConnections(launched.page, sheetUrl, linkedinColumn, pName, {
          // v2.14.x: stamp Connection Accepted immediately at bulk-check detection
          // so the operator sees acceptance in the sheet BEFORE the intro DM fires.
          // The auto-intro pass then only stamps Introduction Status (no longer
          // batched into a single Apps Script write).
          suppressAcceptedStamp: false,
        });
        if (r.error) {
          log(`  ⚠ [${pName}] Idle bulk-check: ${r.error}`);
        } else {
          log(r.plain || `  📡 [${pName}] Idle bulk-check: ${r.matched} Connected, ${r.stamped || 0} Still Pending (of ${r.fetched})`);
        }

        if (willAutoIntro && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
          await runAutoIntros({
            page: launched.page,
            profileId,
            profileName: pName,
            sheetUrl,
            linkedinColumn,
            connectedUrls: r.connectedUrls,
            templates,
            senderFirstNames,
            log,
          });
        } else if (willAutoDm && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
          await runAutoDms({
            page: launched.page,
            profileId,
            profileName: pName,
            sheetUrl,
            linkedinColumn,
            connectedUrls: r.connectedUrls,
            templates,
            senderFirstNames,
            log,
          });
        }

        // Update cooldown
        const _sheetId = _extractSheetIdFromUrl(sheetUrl);
        const cooldown = await readBulkCheckCooldown();
        cooldown[bulkCheckKey(_sheetId, profileId)] = Date.now();
        await writeBulkCheckCooldown(cooldown);
      } catch (err) {
        log(`  ⚠ [${pName}] Idle bulk-check failed: ${err.message}`);
      } finally {
        activeBulkChecks.delete(profileId);
        try {
          if (profileId === 'local-browser') await closeLocalBrowser();
          else await closeProfile(profileId);
        } catch { /* */ }
        browserSemaphore.release();
      }
    }

    let leadIndex = 0;
    let totalDone = 0;
    let totalVisited = 0;
    let leadsExhausted = false;
    // 2.8.28-P2: per-profile cursors for check_status mode (each profile has
    // its own targets slice in _checkStatusTargetsByProfile from the auto-
    // derivation block above). Exhaustion is tracked per-profile too — the
    // campaign ends when every derived profile has run out of its own rows.
    const _checkStatusCursorByProfile = {};
    const _checkStatusExhausted = new Set();
    const weeklyLimited = new Set(); // Profiles that hit weekly/credit limit
    // Phase 2.8.8: silent-failure guard — if a profile produces N
    // consecutive non-success outcomes, park it for the rest of the run.
    // Catches silent weekly-limit exhaustion and any other systemic per-account
    // failure pattern that our explicit detectors miss.
    // v2.11.2: OP/InM use 15 instead of BATCH_SIZE. The lead-quality signal in
    // these modes is unreliable (we only see Premium badge, not OP-eligibility;
    // InMail credits running out makes the compose box silently fail to mount)
    // so 5-in-a-row was triggering false parks on healthy accounts. 15 still
    // catches genuinely-broken accounts (logged out, banned mid-run).
    const SKIP_PARK_THRESHOLD =
      (mode === 'open_profile_only' || mode === 'inmail_only') ? 15 : BATCH_SIZE;
    const consecutiveSkips = new Map();
    // A single uncertain LinkedIn result is a lead-level miss, never a campaign
    // blocker. Only five consecutive misses of the SAME uncertainty kind on the
    // SAME sender indicate an unhealthy account and park that sender.
    const consecutiveUnconfirmed = new Map();
    const UNCONFIRMED_PARK_THRESHOLD = 5;
    // Open Profile sends: a run of "not Open Profile" skips on one account is more
    // likely its monthly OP credits running out than five non-OP leads in a row.
    // Bench it (Retry un-benches) instead of burning the rest of the sheet.
    const consecutiveNotOp = new Map();
    const NOT_OP_BENCH_THRESHOLD = 5;
    const bumpUnconfirmed = (profileId, kind) => {
      const previous = consecutiveUnconfirmed.get(profileId);
      const next = { kind, count: previous && previous.kind === kind ? previous.count + 1 : 1 };
      consecutiveUnconfirmed.set(profileId, next);
      return next.count;
    };
    // 429-specific consecutive counter. LinkedIn's Voyager API returns HTTP
    // 429 overwhelmingly for the weekly invitation cap (rather than transient
    // throttle, which the 6-min per-profile turn floor already prevents).
    // v2.78: two strikes is treated as weekly-limit-reached — park the profile
    // and rotate to the next. (One 429 can be a fluke throttle; two consecutive
    // is the cap. A wrong park is one click to undo via the re-enable toggle.)
    const consecutive429s = new Map();
    const cooldowns429 = new Map(); // profileId -> cooldown episodes served this run
    const HTTP_429_PARK_THRESHOLD = 2;
    // v2.96.0 (Phase 2) — degradation backoff. Connect campaigns ran at a FIXED
    // 15-45s pace regardless of how many leads mis-loaded; under LinkedIn
    // rate-limiting that just hammered a degrading session (and produced the
    // 2026-06-11 wrong-person sends). We now track a per-account "degradation
    // streak" of navigation races / timeouts / not-found / rate-limit /
    // identity-unverified outcomes and EXPONENTIALLY back off the inter-lead
    // delay (capped at DEGRADE_MAX_WAIT_MS) until a clean success resets it.
    // The existing SKIP_PARK_THRESHOLD still parks the account if it never recovers.
    const degradationStreak = new Map();
    const DEGRADE_MAX_MULT = 32;                // streak 5 ⇒ 32× before the cap bites
    const DEGRADE_MAX_WAIT_MS = 20 * 60 * 1000; // never wait longer than 20 min between leads
    // v2.112 (#2b): accounts added to the rotation mid-run + which have launched ≥once + a
    // per-account launch-failure count. A freshly-added account that can't even launch is
    // auto-benched after 2 failures so it doesn't churn. START accounts are NOT tracked here,
    // so their existing behavior is unchanged.
    const addedMidRun = new Set();
    const launchedOk = new Set();
    const launchFailures = new Map();
    // Expose a closure that retryParkedProfile() can call to clear all the
    // local skip counters + drop the profile from weeklyLimited so the next
    // rotation considers it again. Cleared in the finally block at end-of-run.
    campaign._unparkProfile = (profileId) => {
      weeklyLimited.delete(profileId);
      consecutiveSkips.set(profileId, 0);
      consecutiveUnconfirmed.delete(profileId);
      consecutiveNotOp.delete(profileId);
      consecutive429s.set(profileId, 0);
      cooldowns429.set(profileId, 0);
      campaign._cooldown429.delete(profileId);
      degradationStreak.set(profileId, 0);
    };

    // v2.112: resume-reload side-channel. Re-applies the SAME _isTarget filter to freshly
    // fetched rows and appends still-pending rows not already queued; updates in place the
    // row object for still-pending URLs already present (so edited variables go live).
    // Mutates `targets` in place — the loop reads it by reference. Must only be called at the
    // pause boundary (campaign._paused === true), so the loop isn't mid-iteration.
    // norm() mirrors normUrl() in src/resume-diff.js — kept local to avoid coupling campaign.js
    // to that frontend-agnostic module. Returns {added, updated, skippedNew}.
    campaign._reloadTargets = (newRows) => {
      const norm = (u) => String(u || '').trim().toLowerCase().split('?')[0].replace(/\/+$/, '');
      // Per-profile-slice modes (check_status/message_only/introduce_back) drain pre-built
      // slices in _checkStatusTargetsByProfile, NOT `targets` directly — so appended new
      // leads would never be seen. Pick up in-place edits to existing rows (shared object
      // refs, so they reach both arrays), but don't pretend to add brand-new leads.
      const sliceMode = !!_checkStatusTargetsByProfile;
      const byUrl = new Map();
      for (const r of targets) {
        const u = norm(extractLinkedInUrl(r, linkedinColumn));
        if (u) byUrl.set(u, r);
      }
      let added = 0, updated = 0, skippedNew = 0;
      for (const r of (newRows || []).filter(_isTarget)) {
        const u = norm(extractLinkedInUrl(r, linkedinColumn));
        if (!u) continue;
        if (!byUrl.has(u)) {
          if (sliceMode) { skippedNew++; continue; }
          targets.push(r); byUrl.set(u, r); added++;
        } else { Object.assign(byUrl.get(u), r); updated++; }
      }
      // `targets` only contains the work still owned by this local process.
      // Preserve the already-completed baseline imported during a VM → Mac
      // handover, otherwise Reload sheet makes the denominator jump backwards.
      campaign.totalTargets = _resumeTotal + targets.length;
      if (skippedNew) {
        log(`⟳ Reload: ${skippedNew} new lead(s) found, but new-lead pickup needs a restart in ${mode} mode. ${updated} existing lead(s) updated.`);
      }
      return { added, updated, skippedNew };
    };
    // Expose the row→url + filter so the server can compute a dry-run diff without applying.
    campaign._urlOf = (row) => extractLinkedInUrl(row, linkedinColumn);
    campaign._isTarget = _isTarget;
    campaign._currentTargets = () => targets;
    // Re-fetch the SAME sheet. campaign.js already imports fetchSheetRows and owns sheetUrl,
    // so the server stays out of the sheets layer — it just calls this. withGid pins the
    // operator-chosen tab (no-op when sheetGid is empty / legacy single-tab links).
    campaign._refetchRows = async () => fetchSheetRows(withGid(campaign.sheetUrl, campaign.sheetGid));

    // v2.96.0 (Phase 2) — reckless-settings guard. LinkedIn rate-limits
    // connection invites hard (~100/week is the practical ceiling); a high daily
    // limit on a single account is what degraded the session in the 2026-06-11
    // incident. Warn loudly so the operator can dial it back.
    const _CONNECT_MODES_WARN = new Set(['connect_only', 'connect_and_introduce', 'connect_and_message']);
    if (_CONNECT_MODES_WARN.has(mode) && dailyLimit > 80) {
      const _warn = `Daily limit ${dailyLimit}/account on ${profileIds.length} account(s) is high for connect mode — LinkedIn typically caps ~100 invites/week, and high volume on few accounts triggers the rate-limiting behind the 2026-06-11 wrong-person incident. Consider ≤50/account.`;
      log(`\n⚠⚠ ${_warn}\n`);
      _ops('WARN', 'reckless_daily_limit', { details: _warn });
    }

    log(`\n✓ Starting batch loop (BATCH_SIZE=${BATCH_SIZE})…\n`);
    setAction('Starting account rotation', {
      phase: 'starting', step: 'starting_rotation',
      stepDetail: `${targets.length} lead${targets.length === 1 ? '' : 's'} ready · choosing the first available account`,
    });

    // 2.9.8: modes that bypass the daily limit entirely.
    //   - check_status: read-only Voyager fetch, zero LinkedIn-visible action
    //   - message_only: DMs to 1st-degree connections, low risk
    //   - inmail_only: paid InMail credits already gate volume
    //   - open_profile_only: free Open-Profile messages, no connection req
    // Connect campaigns (connect_only) STILL respect the dailyLimit —
    // LinkedIn rate-limits connection requests aggressively.
    // Ortus Basics 1.0: the daily cap and the 6-min per-account turn floor used
    // to be one flag. Message Campaign (open_profile_only) now takes a real
    // daily message limit, but must NOT inherit the connect-mode turn floor —
    // messaging existing connections does not carry invite risk. So the two
    // concerns are separate sets from here on.
    const NO_DAILY_LIMIT = new Set(['check_status', 'message_only', 'introduce_back', 'inmail_only']);
    const NO_TURN_FLOOR  = new Set(['check_status', 'message_only', 'introduce_back', 'inmail_only', 'open_profile_only']);
    const skipsDailyLimit = NO_DAILY_LIMIT.has(mode);
    const skipsTurnFloor  = NO_TURN_FLOOR.has(mode);

    // ═════════════════════════════════════════════════════════════════════
    // 2.9.9 — Rotating-batch worker pool (replaces strict round-robin).
    //
    // Each worker pulls the next eligible profile from profileQueue, runs a
    // turn (up to BATCH_SIZE attempts), then yields its slot. When the turn
    // ends, the profile re-enqueues at the back and a per-profile cooldown
    // is set. Browser semaphore caps total open browsers regardless of how
    // many workers are spinning.
    //
    // pickNextProfile() filters out:
    //   - profiles already mid-turn (no double-run)
    //   - weeklyLimited / ejected profiles
    //   - profiles at daily cap (Q9-a "skip and advance")
    //   - profiles whose cooldown hasn't expired
    // If nothing's available, the worker idles 5s and rechecks (Q9-b fallback).
    // ═════════════════════════════════════════════════════════════════════
    const profileQueue = [...profileIds];
    const profilesBeingRun = new Set();
    const profileCooldownUntil = new Map();
    // v2.112 (#2a/H2): re-add a profile to the rotation queue if it drained out (a parked /
    // weekly-limited profile is NOT re-pushed at turn-end, so retry/un-bench must re-queue it
    // or it can never be picked again). shouldRequeue guards against double-enqueue.
    campaign._requeueProfile = (id) => {
      if (!id) return;
      if (shouldRequeue({ inQueue: profileQueue.includes(id), beingRun: profilesBeingRun.has(id) })) {
        profileQueue.push(id);
        log(`↻ ${profileNameCache[id] || id} re-queued for rotation (queue=${profileQueue.length}).`);
      }
    };
    // v2.112 (#2b): add a fresh account to the live rotation mid-run. Pushes to the run's
    // id/name arrays + the worker queue; the worker opens its browser on its next turn.
    campaign._addProfile = (id, name) => {
      if (!canAddProfile(campaign.profileIds, id)) return false;
      campaign.profileIds.push(id);
      campaign.profileNames.push(name || id);
      profileNameCache[id] = name || id;
      addedMidRun.add(id);
      profileQueue.push(id);
      log(`＋ ${name || id} added to the live rotation.`);
      return true;
    };
    // v2.11.0: dropped batchesPerHour. Per-profile cooldown is now a fixed 6-min
    // floor — protects the eject-cascade scenario (when most profiles drop out
    // mid-run, the survivors would otherwise hammer LinkedIn at unsafe rates).
    // For multi-profile pools the queue rotation is the natural pacer; this
    // floor only kicks in when the pool shrinks.
    const TURN_COOLDOWN_FLOOR_MS = 6 * 60 * 1000;
    const cooldownMs = skipsTurnFloor ? 0 : TURN_COOLDOWN_FLOOR_MS;
    if (concurrency > 1) {
      log(`Concurrency: ${concurrency} workers, browser cap: ${MAX_CONCURRENT_PROFILES}`);
    }
    if (cooldownMs > 0) {
      log(`Per-profile turn floor: ${(cooldownMs / 60000).toFixed(0)}min (queue rotation is the primary pacer).`);
    }


    function pickNextProfile() {
      const now = Date.now();
      for (let i = 0; i < profileQueue.length; i++) {
        const candidate = profileQueue[i];
        if (profilesBeingRun.has(candidate)) continue;
        // v2.78: operator benched this account for the rest of the run.
        if (campaign._skippedProfiles && campaign._skippedProfiles.has(candidate)) continue;
        if (weeklyLimited.has(candidate)) continue;
        if (!skipsDailyLimit && getCampaignSendCount(candidate) >= campaign.dailyLimit) continue;
        if (now < (profileCooldownUntil.get(candidate) || 0)) continue;
        // Clear stale _cooldown429 entry once the cooldown window has passed
        if (campaign._cooldown429.has(candidate) && now >= (campaign._cooldown429.get(candidate).until || 0)) {
          campaign._cooldown429.delete(candidate);
        }
        profileQueue.splice(i, 1);
        profilesBeingRun.add(candidate);
        return candidate;
      }
      return null;
    }

    function noProfilesLeftEver() {
      // True only when nobody can ever run again: nobody mid-turn AND every
      // queued profile is permanently out (weekly-limited or daily-capped).
      // Cooldown alone doesn't count as "out" — that's a wait, not exhaustion.
      if (profilesBeingRun.size > 0) return false;
      if (profileQueue.length === 0) return true;
      return profileQueue.every(id =>
        weeklyLimited.has(id) ||
        (!skipsDailyLimit && getCampaignSendCount(id) >= campaign.dailyLimit)
      );
    }

    /**
     * Run one turn for a single profile: open → up to BATCH_SIZE attempts → close/park.
     * Returns nothing — side-effects via shared closures (state, sessions,
     * weeklyLimited, consecutiveSkips, leadsExhausted).
     */
    async function runProfileTurn(profileId) {
        if (campaign._abort || isOrphan()) return;
        if (leadsExhausted) return;

        const restriction = await restrictionForProfile(profileId);
        if (restriction) {
          const name = profileNameCache[profileId] || profileId;
          const wasKnown = campaign._restrictedProfiles?.has(profileId);
          if (!campaign._restrictedProfiles) campaign._restrictedProfiles = new Map();
          campaign._restrictedProfiles.set(profileId, restriction);
          campaign._skippedProfiles.add(profileId);
          if (!wasKnown) log(`Account removed from rotation — ${name} is ${restriction} in the SoO. No lead was consumed; queued leads will use another available account.`);
          _persistRunSettings();
          return;
        }
        if (campaign._restrictedProfiles?.has(profileId)) {
          campaign._restrictedProfiles.delete(profileId);
          campaign._skippedProfiles.delete(profileId);
          log(`Account restored to rotation — ${profileNameCache[profileId] || profileId} is no longer Identity Restricted in the SoO.`);
        }

        const session = await ensureOpen(profileId);
        if (!session) {
          // v2.112 (#2b): a mid-run-added account that can't even launch would churn (re-
          // enqueued every rotation). After 2 failed launches before it ever opened, auto-
          // bench it so the campaign continues without it. START accounts are unaffected.
          if (addedMidRun.has(profileId) && !launchedOk.has(profileId)) {
            const fails = (launchFailures.get(profileId) || 0) + 1;
            launchFailures.set(profileId, fails);
            if (fails >= 2) {
              if (!campaign._skippedProfiles) campaign._skippedProfiles = new Set();
              campaign._skippedProfiles.add(profileId);
              log(`⚠ ${profileNameCache[profileId] || profileId} failed to launch ${fails}× — benched; campaign continues.`);
              _persistRunSettings();
            }
          }
          return; // opened-but-unhealthy OR launch failed
        }
        launchedOk.add(profileId);

        const { pName, browser } = session;
        let { page } = session;
        campaign.currentProfile = pName;

        if (!_deferPrimary) {
        // v2.78: CC+IC primary-connection gate. Verify this account is a
        // 1st-degree connection of the primary before its intros can fire.
        // First turn: read degree + (if not connected) send ONE connect request
        // to the primary. Later turns while 'pending': re-read degree only (no
        // re-send) and flip to 'connected' once accepted. Held intros release
        // automatically (willAutoIntro gate below reads campaign._primaryConn).
        if (mode === 'connect_and_introduce' && profileId !== 'local-browser') {
          const _primaryUrl = (tpl && tpl.primaryUrl || '').trim();
          if (!_primaryUrl) {
            // Diagnostic: no primary URL saved → the connection-to-primary check
            // can't run, so no Primary label appears. Logged once per account.
            if (!campaign._primaryConn.has(profileId)) {
              campaign._primaryConn.set(profileId, 'no_url');
              log(`  ⚠ [${pName}] No primary LinkedIn URL set — skipping the connected-to-primary check. Add the URL in the wizard and relaunch to enable it.`);
            }
          } else {
            const _prev = campaign._primaryConn.get(profileId);
            if (_prev !== 'connected') {
              try {
                // Ortus Basics 1.0: the automatic sender→primary handshake is
                // gone. Read the degree only — never send a connect to the
                // primary. A sender that is not 1st-degree with the primary
                // lands on 'pending', which _primaryIntroAllowed() reads to hold
                // the INTRO while the lead's own connection request still goes
                // out. (was: attemptConnect on the first turn)
                const _res = await checkAndConnectPrimary(page, _primaryUrl, {
                  log, pName, attemptConnect: false,
                });
                // v2.102: tri-state. connected → 'connected'; CONFIRMED
                // not-connected → 'pending' (connect sent, intros held); degree
                // unreadable → 'unverified' (no connect, neutral badge, intros
                // still proceed). A read failure must not coerce to 'pending'.
                {
                  const _live = primaryConnState(_res.connected); // 'connected'|'pending'|'unverified'
                  const _entry = campaign._primaryKey
                    ? getEntry(campaign._primaryStore, profileId, campaign._primaryKey) : null;
                  const _disp = resolveDisplayState(_entry, _live);
                  campaign._primaryConn.set(profileId, _disp.state);
                  campaign._primaryConnSource.set(profileId, _disp.source);
                  if (campaign._primaryKey && _live !== 'unverified') {
                    const _now = new Date().toISOString();
                    campaign._primaryStore = campaign._primaryStore || {};
                    campaign._primaryStore[storeKey(profileId, campaign._primaryKey)] =
                      mergeLiveRead(_entry, _live, _now, (tpl && tpl.primaryUrl) || '');
                    await savePrimaryStatus(PRIMARY_STATUS_FILE, campaign._primaryStore);
                  }
                }
                // v2.91: if we just sent a connect to the primary AND auto-accept
                // is enabled, capture this account's own identity and queue the
                // local browser to accept its invitation in the next idle gap.
                // Ortus Basics 1.0: never queue an accept task — nothing connects
                // to the primary any more, so there is no invitation to accept.
                if (false) {
                  try {
                    const _self = await readSelfIdentity(page);
                    // Don't enqueue a dead task: an empty identity (slow/cold
                    // nav) would never match an invitation. Surface a warning
                    // and skip — the connect was sent, so it can be accepted
                    // manually, and the next run can re-capture.
                    if (!_self.name && !_self.profileUrl) {
                      throw new Error('could not read this account\'s identity (nav not ready) — skipping auto-accept queue');
                    }
                    const _task = buildAcceptTask({
                      campaignProfileId: profileId,
                      campaignProfileName: pName,
                      sheetId: _extractSheetIdFromUrl(sheetUrl) || '',
                      sheetUrl,
                      account: _self,
                      primaryUrl: _primaryUrl,
                      sender: tpl.primarySource,
                    });
                    const _stored = await enqueuePrimaryTask(_task);
                    if (_stored) {
                      const _where = (tpl.primarySource && tpl.primarySource !== 'local-browser')
                        ? 'the primary\'s GoLogin profile'
                        : 'your local browser';
                      log(`  ⏳ [${pName}] Auto-accept queued — ${_where} will accept this account's invite at the next idle moment.`);
                    }
                  } catch (e) {
                    log(`  ⚠ [${pName}] Auto-accept queue warning: ${e.message}`);
                  }
                }
              } catch (e) {
                log(`  ⚠ [${pName}] Primary check error: ${e.message}`);
              }
            }
          }
        }
        }

        const batchStart = Date.now();

        // ── Inner: up to BATCH_SIZE leads for this profile ──
        // 2.8.29: check_status drains every row for this profile in one go.
        // 2.8.34: message_only does the same — open the browser, send to all
        // accepted connections back-to-back, close. No batching, no rotation.
        const innerLimit = (mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back') ? Infinity : BATCH_SIZE;
        // v2.81: stop the batch the instant the account is parked mid-turn
        // (e.g. the 2nd consecutive HTTP 429 → weekly-limit park). Without this
        // guard the loop kept firing all BATCH_SIZE leads at an account that had
        // already hit its cap, so "confirming…" repeated 8× before rotating.
        // v2.137 (final-review): cooling429 flag — set when a 429 cooldown fires
        // mid-turn; breaks the inner loop after that lead's error handling completes
        // so the queue rotates immediately (cooldown ≠ weeklyLimited: profile is
        // still re-enqueued at ~4671 and re-picked after the cooldown window).
        let cooling429 = false;
        // The operator's two turn markers. Everything between them belongs to
        // this account, which is otherwise only inferable from the [name] tags.
        const _turnSentAtStart = getCampaignSendCount(profileId);
        log(plainLine('turn-start', {
          account: pName,
          size: Number.isFinite(innerLimit) ? innerLimit : null,
        }));
        for (let leadInBatch = 0; leadInBatch < innerLimit && shouldContinueTurn({ abort: campaign._abort, orphan: isOrphan(), weeklyLimited: weeklyLimited.has(profileId), benched: campaign._skippedProfiles?.has(profileId) }); leadInBatch++) {
        // Where this account is in its TURN, for the per-account panel. `done`
        // is how many leads of this turn are behind it; `size` is how many the
        // turn holds, and is null for the modes that drain every remaining row
        // in one go (they have no turn size to show).
        campaign._turnByProfile = campaign._turnByProfile || {};
        campaign._turnByProfile[profileId] = {
          done: leadInBatch,
          size: Number.isFinite(innerLimit) ? innerLimit : null,
        };
        // Phase 2.8.9: pause check at the lead boundary — never mid-lead.
        await awaitUnpause(myGen);
        if (weeklyCutoffReached()) break;
        // v2.112 (#2a): also bail if the operator benched this account while paused — without
        // this, the post-pause path would send one more lead before the for-condition re-checks.
        if (campaign._abort || isOrphan() || campaign._skippedProfiles?.has(profileId)) break;
        // ── Phase 11.1: per-iteration resource sample + throttle decision ──
        // Pattern: RESEARCH.md §Pattern 2 (cached sample) + §Pattern 3 (multiplicative composition).
        // Writes campaign._lastSample and campaign._throttle for the status endpoint to read.
        try {
          const activePids = [...sessions.values()]
            .filter(s => s.profileId !== 'local-browser')
            .map(s => getProfilePid(s.profileId))
            .filter(Boolean);
          campaign._lastSample = await rmSample(activePids);
          const prevThrottle = campaign._throttle || { active: false, reason: '', multiplier: 1 };
          const nextThrottle = decideThrottle(prevThrottle, campaign._lastSample, rmCfg);
          if (!prevThrottle.active && nextThrottle.active) {
            log(`⚠ Throttle ENGAGED: ${nextThrottle.reason} — delays now ${nextThrottle.multiplier}x`);
          } else if (prevThrottle.active && !nextThrottle.active) {
            log(`✓ Throttle RELEASED — delays back to 1x`);
          }
          campaign._throttle = nextThrottle;
        } catch (err) {
          // Sampling failure must never break a campaign.
          log(`[resource-monitor] sample failed: ${err.message}`);
        }

        // Find the next unprocessed lead.
        // 2.8.28-P2 / 2.8.31: For modes that auto-route by sender (check_status,
        // message_only), use the per-profile target slice built at auto-
        // derivation time. Each profile only sees rows it originally sent.
        let row = null;
        if ((mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back') && _checkStatusTargetsByProfile) {
          const slice = _checkStatusTargetsByProfile[profileId] || [];
          let cursor = _checkStatusCursorByProfile[profileId] || 0;
          while (cursor < slice.length) {
            const candidate = slice[cursor];
            const candidateUrl = extractLinkedInUrl(candidate, linkedinColumn);
            cursor++;
            if (!candidateUrl) {
              const _cName = `${candidate['First Name'] || candidate['firstName'] || ''} ${candidate['Last Name'] || candidate['lastName'] || ''}`.trim() || '(no name)';
              recordSkip({ url: '', leadName: _cName, reason: MALFORMED_URL, profileId, profileName: pName, detail: 'No LinkedIn URL found in row — skipping lead' });
              continue;
            }
            row = candidate;
            break;
          }
          _checkStatusCursorByProfile[profileId] = cursor;
        } else {
          while (leadIndex < targets.length) {
            const candidate = targets[leadIndex];
            const candidateUrl = extractLinkedInUrl(candidate, linkedinColumn);
            leadIndex++;
            if (!candidateUrl) {
              const _cName = `${candidate['First Name'] || candidate['firstName'] || ''} ${candidate['Last Name'] || candidate['lastName'] || ''}`.trim() || '(no name)';
              recordSkip({ url: '', leadName: _cName, reason: MALFORMED_URL, profileId, profileName: pName, detail: 'No LinkedIn URL found in row — skipping lead' });
              continue;
            }
            // Skip URLs already touched by THIS installation's local state,
            // EXCEPT for modes where re-touching is intentional (message_only
            // sends DMs after acceptance; open_profile_only is fire-and-forget;
            // introduce_back fires from already-connected rows; the cold-lead
            // connect modes trust the sheet as source of truth so a cleared row
            // gets re-processed even if the local state remembers it).
            //
            // v2.160.122: connect_only joined that exemption. Its PRE-FILTER
            // already reads Stage and nothing else (~line 2471), so pre-flight
            // counted rows this picker then dropped — silently, since recordSkip
            // doesn't log. Field report 2026-08-03: "Pre-filter → 431 to process,
            // 0 skipped", one lead sent, then "All leads processed or filtered
            // out". 430 rows were blocked by a state.json the operator can't see,
            // and moving the leads to a fresh sheet never helped because the
            // memory is keyed by URL, not by sheet. The sheet is the source of
            // truth for these modes on both sides of the run now.
            if (mode !== 'message_only' && mode !== 'introduce_back' && mode !== 'open_profile_only' && mode !== 'connect_only' && mode !== 'connect_and_introduce' && mode !== 'connect_and_message' && state.processed[candidateUrl]) {
              // ALREADY_PROCESSED skip — record with original action+date from the state entry
              const _prev = state.processed[candidateUrl];
              const _prevAction = _prev?.action || 'unknown';
              // state.processed dates are human strings ("Jul 7th, 15:27"), which
              // new Date() can't parse — it stringifies to "Invalid Date" without
              // throwing. Only reformat when the date actually parses; otherwise
              // show the stored string as-is (it's already human-readable).
              const _prevD = new Date(_prev?.date);
              const _prevDate = !isNaN(_prevD.getTime())
                ? _prevD.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                : (_prev?.date || 'an earlier run');
              const _cName = `${candidate['First Name'] || candidate['firstName'] || ''} ${candidate['Last Name'] || candidate['lastName'] || ''}`.trim() || '(no name)';
              recordSkip({ url: candidateUrl, leadName: _cName, reason: ALREADY_PROCESSED, profileId, profileName: pName, detail: `${_prevAction} on ${_prevDate}` });
              continue;
            }
            const sheetStatus = (candidate['Connection Status'] || candidate['connection status'] || candidate['Status'] || candidate['status'] || '').toLowerCase();
            if (mode === 'connect_only' || mode === 'connect_and_introduce' || mode === 'connect_and_message') {
              if (sheetStatus) continue;
            }
            row = candidate;
            break;
          }
        }

        if (!row) {
          // 2.8.28-P2 / 2.8.31: per-profile exhaustion is normal in auto-routed
          // modes — skip this profile, end only when ALL profiles have drained.
          if ((mode === 'check_status' || mode === 'message_only' || mode === 'introduce_back') && _checkStatusTargetsByProfile) {
            _checkStatusExhausted.add(profileId);
            if (_checkStatusExhausted.size >= profileIds.length) {
              const label = (mode === 'check_status') ? 'Check Status'
                          : (mode === 'introduce_back') ? 'Introduce Back'
                          : 'Message Only';
              log(`All ${label} profiles have completed.`);
              leadsExhausted = true;
            }
            break;
          }
          // v2.160.122: say WHY. Every in-loop drop calls recordSkip, but that
          // only appends to an in-memory ledger — nothing reaches the live log,
          // so exhaustion read as "no more rows" with no trace of the hundreds
          // of rows that were dropped a millisecond earlier.
          log(`All leads processed or filtered out.${summarizeSkips(getSkips())}`);
          leadsExhausted = true;
          break;
        }

        campaign.currentProfile = pName;

        const url = extractLinkedInUrl(row, linkedinColumn);

        // Mark as in-progress
        state.processed[url] = { profileId, profileName: pName, action: '_in_progress', date: new Date().toISOString() };
        await saveState(state);

        // In-loop skip check. Mirrors the pre-filter rules; catches rows
        // that were updated between pre-filter and now (e.g. by a concurrent
        // campaign or a mid-run re-fetch).
        const status    = (row['Connection Status'] || row['connection status'] || row['Status']  || row['status']  || '').toString().toLowerCase().trim();
        const cc        = (row['CC']      || row['cc']      || '').toString().toLowerCase().trim();
        const msgCell   = (row['Message'] || row['message'] || '').toString().toLowerCase().trim();
        const opCell    = (row['OP']      || row['op']      || '').toString().toLowerCase().trim();
        const inmailCell= (row['InMail']  || row['inmail']  || '').toString().toLowerCase().trim();
        const msgSent   = msgCell === 'sent' || opCell === 'sent';

        // v2.11.12: in-loop re-validation must mirror the pre-filter (line ~803)
        // for both schemas. Pre-filter migrated to Stage in 2.9.x, but the
        // in-loop checks here were left on the legacy CC " Y" / msgSent /
        // inmailCell fields — fine on legacy sheets, but new-schema sheets
        // don't populate those columns so every messageable row was silently
        // skipped via `delete + continue` (no log). Detect new schema
        // (Stage column present) and gate on Stage; old schema falls through
        // to the legacy logic, unchanged.
        const _stage = (row['Stage'] || row['stage'] || '').toString().trim();
        const _hasStageHere = _stage.length > 0 || ('Stage' in row) || ('stage' in row);
        // Helper for in-loop re-validation skips (concurrent-stamp or terminal state).
        const _leadNameForSkip = `${row['First Name'] || row['firstName'] || ''} ${row['Last Name'] || row['lastName'] || ''}`.trim() || '(no name)';

        if (mode === 'check_status') {
          // 2.8.29: criterion is Sender filled, not CC=Sent.
          const acct = getSenderName(row, senderColumn);
          if (!acct) { delete state.processed[url]; continue; }
          // 2.8.28-P2: routing guard removed. The per-profile target slices
          // built at auto-derivation time already guarantee each profile sees
          // only rows it originally sent. The defense-in-depth name-equality
          // check tripped on local-browser variants (e.g., row says
          // "local-browser", pName is "Local Browser") and broke an entire
          // legitimate code path. Slice-based filtering is sufficient.
        } else if (mode === 'introduce_back') {
          // v2.59: IC re-validation mirrors the pre-filter (~line 1442).
          // Read only from Intro Status — IC tabs may not have a Stage
          // column at all. If anything is now in Intro Status (e.g. a
          // concurrent operator marked the row done, or a sibling worker
          // in the same run just stamped it), skip.
          const _introStatusNow = (
            row['Intro Status'] || row['intro status'] || row['Intro status'] ||
            row['Introduction Status'] || row['introduction status'] ||
            row['Introduction status'] || row['introStatus'] || ''
          ).toString().trim();
          if (_introStatusNow !== '') {
            recordSkip({ url, leadName: _leadNameForSkip, reason: TERMINAL_STAGE, profileId, profileName: pName, detail: `In-loop re-validation: Intro Status already set to "${_introStatusNow}" — skipping` });
            delete state.processed[url]; continue;
          }
        } else if (mode === 'message_only') {
          // v2.61: DM mirrors IC — read only from DM Status. Pre-filter
          // passed blank dmStatus; if a concurrent operator or worker
          // stamped it (DM Sent / Failed — … / operator note), skip.
          const _dmStatusNow = (
            row['DM Status'] || row['dm status'] || row['DM status'] ||
            row['Direct Message Status'] || row['dmStatus'] || ''
          ).toString().trim();
          if (_dmStatusNow !== '') {
            recordSkip({ url, leadName: _leadNameForSkip, reason: TERMINAL_STAGE, profileId, profileName: pName, detail: `In-loop re-validation: DM Status already set to "${_dmStatusNow}" — skipping` });
            delete state.processed[url]; continue;
          }
        } else if (mode === 'open_profile_only' || mode === 'inmail_only') {
          if (_hasStageHere) {
            // New schema: pre-filter required Stage in {'', 'Send Connect'}.
            // If a concurrent run flipped it to anything else, skip.
            if (_stage !== '' && _stage !== 'Send Connect') {
              recordSkip({ url, leadName: _leadNameForSkip, reason: TERMINAL_STAGE, profileId, profileName: pName, detail: `In-loop re-validation: Stage is "${_stage}" (not eligible for ${mode}) — skipping` });
              delete state.processed[url]; continue;
            }
          } else {
            if (status === 'done') {
              recordSkip({ url, leadName: _leadNameForSkip, reason: TERMINAL_STAGE, profileId, profileName: pName, detail: `In-loop re-validation: Connection Status is "done" — skipping` });
              delete state.processed[url]; continue;
            }
            if (mode === 'open_profile_only' && msgSent) {
              recordSkip({ url, leadName: _leadNameForSkip, reason: TERMINAL_STAGE, profileId, profileName: pName, detail: `In-loop re-validation: Message already sent — skipping` });
              delete state.processed[url]; continue;
            }
            if (mode === 'inmail_only' && inmailCell === 'sent') {
              recordSkip({ url, leadName: _leadNameForSkip, reason: TERMINAL_STAGE, profileId, profileName: pName, detail: `In-loop re-validation: InMail already sent — skipping` });
              delete state.processed[url]; continue;
            }
          }
        } else {
          if (status === 'done') {
            recordSkip({ url, leadName: _leadNameForSkip, reason: TERMINAL_STAGE, profileId, profileName: pName, detail: `In-loop re-validation: Connection Status is "done" — skipping` });
            delete state.processed[url]; continue;
          }
        }

        // Build template data
        const data = { ...row };
        data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
        data.lastName = row['Last Name'] || row['lastName'] || row['last_name'] || '';
        data.company = row['Company'] || row['company'] || '';
        data.title = row['Title'] || row['title'] || row['Job Title'] || '';
        data.senderName = pName || '';
        const resolvedFirst = senderFirstNames[profileId];
        data.senderFirstName = (resolvedFirst && resolvedFirst.trim())
          || (pName || '').split(/\s+/)[0]
          || '';

        let hint = getModeHint(mode, state.processed[url]?.action);

        const isOpenProfile = (row['Open Profile'] || row['openProfile'] || row['open_profile'] || '').toLowerCase().trim();
        if (messageOpenProfiles && hint === 'force_connect') {
          // "Message Open Profiles Directly" — try OP first (free message),
          // fall back to sending a connection request if not an Open Profile.
          // Runtime detection via the Message panel, not a sheet column.
          hint = 'force_connect_op_fallback';
          log(`  ↳ OP-first + Connect-fallback flow`);
        }

        try {
          // Re-acquire page and close stale tabs to prevent RAM buildup
          try {
            const pages = await browser.pages();
            if (pages.length > 1) {
              page = pages[pages.length - 1];
              for (let i = 0; i < pages.length - 1; i++) {
                try { await pages[i].close(); } catch { /* */ }
              }
            } else if (pages.length === 1) {
              page = pages[0];
            }
            session.page = page;
            // v2.14.x: re-apply CDP focus emulation. Same reason as
            // ensureProfileLoggedIn — see comment there. Idempotent, so
            // safe even if pages[N-1] is the same page object as before.
            await applyFocusEmulation(page, profileId);
          } catch { /* keep current */ }

          // v2.52.0 (Layer B) — page health probe before processing each lead.
          // Symptom this addresses: Input.dispatchKeyEvent timed out during
          // organic browsing leaves the renderer's main thread wedged.
          // browseFeedOrganically swallows that error and the loop continues,
          // but the page is now CDP-unresponsive. The existing retry path
          // re-acquires the same dead page reference, burning 3 × 180s per
          // lead before giving up — 9 minutes of wasted retries per stuck
          // lead, with no recovery. A 3-second evaluate() probe catches the
          // wedge cheaply: live pages return in <50ms; wedged pages hit the
          // probe timeout and we close the session so the profile rotation
          // re-opens a fresh browser on its next turn.
          let _pageHealthy = true;
          try {
            await Promise.race([
              page.evaluate(() => 1),
              new Promise((_, reject) => setTimeout(
                () => reject(new Error('page_health_probe_timeout')), 3000
              )),
            ]);
          } catch (probeErr) {
            _pageHealthy = false;
            log(`  ⚠ ${pName}: page unresponsive (${probeErr.message}) — closing session, profile re-rotates with fresh browser next turn`);
            try { await closeSession(profileId); } catch { /* best-effort */ }
          }
          if (!_pageHealthy) break;

          log(`→ [${pName}] ${url} (${data.firstName || '?'}) [${hint || 'auto'}]`);
          const _liveLeadName = `${data.firstName || ''} ${data.lastName || ''}`.trim() || data.firstName || '?';
          setAction('Opening the LinkedIn profile', {
            lead: _liveLeadName, account: pName, phase: 'sending',
            step: 'opening_profile', stepDetail: 'Waiting for the local browser event',
          });

          // ── v2.96.0: PRE-SEND identity gate (connect modes only) ──
          // Confirm the loaded profile IS the intended lead BEFORE any Connect
          // click. Without this, an encoded /in/ACwAA… URL that mis-loads under
          // rate-limiting sent the correctly-named note to the wrong person.
          // Skip-on-doubt: 5 attempts, then skip+flag rather than risk a send.
          let _identityVerified = false;
          let _verifiedIdentityMeta = null;
          // Gate every URL that will become a connect: plain /in/ AND Sales-Nav
          // /sales/lead|people/ URLs (performOutreach rewrites those to /in/ and
          // connects, so they carry the same mis-load risk — v2.96.2).
          const _isConnectHint = (hint === 'force_connect' || hint === 'force_connect_op_fallback');
          const _gateableUrl = /\/in\//i.test(url) || /\/sales\/(?:lead|people)\//i.test(url);
          if (_isConnectHint && _gateableUrl) {
            const _srcName = `${data.firstName || ''} ${data.lastName || ''}`.trim();
            // v2.113: pass the operator's safeguard choice. When OFF the gate
            // blind-passes (404-check only) and returns navigated:true/false.
            const _gate = await gateConnectIdentity(page, { url, row, sourceName: _srcName, log, verifyIdentity: campaign.identityGateEnabled !== false });
            if (!_gate.ok) {
              // v2.112.26 (#4): a dead profile (404 / "this page doesn't exist")
              // is a DATA problem, not a degrading session. Stamp it clearly and
              // move on WITHOUT escalating the degradation backoff or parking the
              // account — a sheet full of bad URLs must never park a healthy one.
              // The gate already bailed on attempt 1, so no 5× retry was burned.
              if (_gate.notFound) {
                log(`  ✗ [${pName}] Profile not found (404) — skipping (no retry). ${url}`);
                _ops('WARN', 'profile_not_found_404', {
                  account: pName, leadUrl: url, phase: 'Connect', outcome: 'skipped',
                  reason: 'profile_not_found_404 (page does not exist / linkedin.com/404)',
                });
                // v2.112.27: stamp the VISIBLE columns (Stage + the mode's
                // status column) via buildSkipSheetData — the audit-only write
                // landed in a column most sheets don't show, so the 404 looked
                // un-marked (William/Philip rows stayed blank). This also makes
                // the row terminal: next run's pre-filter skips a row whose
                // status is set, so a dead URL is never re-attempted.
                await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                  ...buildSkipSheetData(mode, 'Skipped: Profile not found (404)', pName),
                  dateLastAction: formatLocalDate(new Date()),
                  auditAction: 'Skipped: Profile not found (404)',
                }, linkedinColumn);
                delete state.processed[url];
                await saveState(state);
                // Normal inter-lead pacing (NOT the escalated degradation
                // backoff): a 404 returns instantly but a navigation still
                // happened. Abort-aware so Stop breaks out immediately.
                const _ndWaitMs = Math.floor((delayMin + delayMax) / 2) * 1000;
                const _ndEnd = Date.now() + _ndWaitMs;
                while (Date.now() < _ndEnd && !campaign._abort) {
                  await new Promise((r) => setTimeout(r, 2000));
                }
                continue;
              }
              const _intended = `${_srcName || '?'} / ${readSourceMemberId(row) || 'no-member#'}`;
              const _got = `${_gate.loaded.name || '?'} / ${_gate.loaded.memberNumber || 'no-member#'}`;
              log(`  ✗ [${pName}] IDENTITY UNVERIFIED after ${MAX_IDENTITY_ATTEMPTS} tries — NOT sending. Intended: ${_intended} · Loaded: ${_got} · ${_gate.reason}`);
              recordSkip({ url, leadName: _srcName || '(no name)', reason: IDENTITY_UNCONFIRMED, profileId, profileName: pName, detail: `IDENTITY UNVERIFIED after ${MAX_IDENTITY_ATTEMPTS} tries — intended=[${_intended}] loaded=[${_got}] (${_gate.reason})` });
              // Fold everything into `reason`: the Ops Log bridge writes
              // `reason || details` to one column, so keep it all here and make
              // it greppable for "identity_unverified".
              _ops('WARN', 'identity_unverified', {
                account: pName,
                leadUrl: url,
                phase: 'Connect',
                outcome: 'skipped',
                reason: `identity_unverified (${_gate.reason}) — intended=[${_intended}] loaded=[${_got}]`,
              });
              // Audit breadcrumb only (NOT a terminal Stage): the row stays
              // eligible so a future, non-degraded run can retry a genuine lead
              // whose page merely failed to load this time.
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                auditAction: `Skipped: Identity unverified (${MAX_IDENTITY_ATTEMPTS}×) — loaded "${_gate.loaded.name || '?'}"`,
              }, linkedinColumn);
              // Phase 2: an unverified profile is a degradation signal — escalate
              // the inter-lead backoff, and park the account if it never recovers
              // (this path bypasses the generic consecutive-skip park below).
              degradationStreak.set(profileId, (degradationStreak.get(profileId) || 0) + 1);
              const _idSkips = (consecutiveSkips.get(profileId) || 0) + 1;
              consecutiveSkips.set(profileId, _idSkips);
              const _unconfirmedCount = bumpUnconfirmed(profileId, 'identity_unconfirmed');
              delete state.processed[url];
              await saveState(state);
              if (_unconfirmedCount >= UNCONFIRMED_PARK_THRESHOLD && !weeklyLimited.has(profileId)) {
                log(`  ${pName}: 5 identity checks in a row could not be confirmed — parking this account; the campaign continues with other senders.`);
                weeklyLimited.add(profileId);
                recordProfileEnd(profileId, pName, 'Parked after 5 consecutive unconfirmed identity checks');
                campaign.parkedProfiles.push({
                  profileId, pName, parkedAt: Date.now(), reason: 'unconfirmed_streak',
                  issue: 'identity_unconfirmed', skipCount: _unconfirmedCount,
                });
                break;
              }
              // v2.96.2: this `continue` jumps past the end-of-iteration delay
              // block, so honor the exponential backoff HERE — otherwise a run
              // where the gate keeps failing (the exact incident signature)
              // would spin through leads at gate-internal speed with no inter-lead
              // pacing. Abort-aware sleep.
              const _gateBase = Math.floor((delayMin + delayMax) / 2) * 1000;
              const _gateWaitMs = degradationBackoffMs(_gateBase, degradationStreak.get(profileId) || 0, { maxMult: DEGRADE_MAX_MULT, maxMs: DEGRADE_MAX_WAIT_MS });
              log(`  ⏳ ${(_gateWaitMs / 1000).toFixed(0)}s (degradation backoff after unverified lead)`);
              const _gateSleepEnd = Date.now() + _gateWaitMs;
              while (Date.now() < _gateSleepEnd && !campaign._abort) {
                await new Promise((r) => setTimeout(r, 2000));
              }
              continue;
            }
            // Reuse the gate's navigation for the send UNLESS blind mode hit a
            // nav glitch (navigated:false) — then let performOutreach navigate.
            // The full-verify path returns no `navigated` field → defaults to
            // reuse (skipNavigation:true), preserving prior behavior.
            _identityVerified = _gate.navigated !== false;
            _verifiedIdentityMeta = _gate.identity || null;
          }

          // performOutreach with retry
          let result;
          let _preempted = false;
          // v2.112.7 (Fix B): set when the throttle-OFF branch already slept its
          // jittered backoff for this lead, so the end-of-iteration delay below
          // skips a second wait. Declared at lead scope so both points see it.
          let _throttleHandled = false;
          const MAX_RETRIES = 3;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            // Phase 2.8.20 (W2-A1): wrap with watchdog so a Puppeteer hang
            // can't freeze the loop indefinitely. On timeout, returns a
            // skipped result with the lead_timeout_watchdog signal which
            // the existing TRANSIENT_SIGNALS allow-list (extended below)
            // routes through the normal 3-retry/backoff flow.
            // v2.97: also race a preempt promise so a manual "solo check" can
            // abandon this lead immediately (preemptCurrentLead) and let the
            // campaign hit its pause boundary within ~1s.
            try {
              // v2.97 preempt race (solo-check abandons this lead in ~1s) combined
              // with v2.96 identity gate: when the pre-send gate already verified the
              // lead's identity on a navigated page, performOutreach reuses it
              // (skipNavigation) so verify+send share one navigation.
              const _preemptP = new Promise((_, reject) => { _leadPreemptReject = reject; });
              try {
                result = await Promise.race([
                  withWatchdog(
                    performOutreach(page, url, { ...tpl, data }, {
                      profileId, skipNavigation: _identityVerified,
                      onProgress: (event) => {
                        const e = (event && typeof event === 'object') ? event : {};
                        setAction(e.stepLabel || 'Processing lead', {
                          lead: _liveLeadName, account: pName, phase: 'sending',
                          step: e.step || '', stepLabel: e.stepLabel || '',
                          stepDetail: e.stepDetail || '',
                        });
                      },
                    }, hint),
                    LEAD_TIMEOUT_MS,
                    profileId,
                  ),
                  _preemptP,
                ]);
              } finally {
                _leadPreemptReject = null;
              }
            } catch (err) {
              if (err && err.kind === 'preempt') {
                // Solo check is taking over. Leave the lead unstamped (no result
                // handling below) so the next pass re-attempts it on resume.
                log(`  ⏭ ${pName}: lead preempted for a solo bulk check — will retry on resume — ${url}`);
                _preempted = true;
                break;
              } else if (err && err.kind === 'watchdog') {
                log(`  ⏱ ${pName}: lead timed out after ${LEAD_TIMEOUT_MS / 1000}s — ${url}`);
                result = { action: 'skipped', error: 'lead_timeout_watchdog' };
              } else {
                throw err;
              }
            }

            // Phase 2.8.17 (H-03): allow-list for transient (retryable) errors.
            // Replaces the previous deny-list which let any unforeseen new error
            // string default to "transient" — burning 45s of retries on terminal
            // outcomes like "URL not in member-URN format", "session expired",
            // or "Profile not found". Anything not matched here = treated as
            // terminal (single attempt, no retry). Comments per signal:
            //   detached / Target closed / Session closed → puppeteer lost the page
            //   Protocol error                            → CDP transport blip
            //   Execution context was destroyed           → page navigated mid-action
            //   Navigation timeout / net::ERR_            → flaky network or LinkedIn slow
            //   timed out                                 → generic puppeteer wait timeout
            //   rate_limited                              → LinkedIn told us to slow down
            //                                                — backing off then retrying is
            //                                                exactly the right response
            const TRANSIENT_SIGNALS = [
              'detached',
              'Target closed',
              'Session closed',
              'Connection closed',
              'Protocol error',
              'Execution context was destroyed',
              'Navigation timeout',
              'net::ERR_',
              'timed out',
              'rate_limited',
              'lead_timeout_watchdog',
            ];
            const isTransient = result.action === 'skipped' && !!result.error &&
              TRANSIENT_SIGNALS.some(sig => result.error.includes(sig));

            if (!isTransient || attempt === MAX_RETRIES) break;
            // Phase 2.8.10: bail retries entirely if user clicked Stop —
            // no point retrying a dead browser, and the 15s/30s sleeps were
            // the dominant source of "loop won't exit" lag after Stop.
            if (campaign._abort) { log('  ■ Abort detected — skipping retry.'); break; }

            // v2.112.7 (Fix B): a retry is about to happen — classify the prior
            // failure and route. Only a `transient` glitch warrants an inline
            // retry (with a REAL page reset + identity re-verify). `throttle`
            // (LinkedIn told us to slow down), `invite_cap` (quota spent), and
            // `challenge` (checkpoint) must NOT be retried inline — break out
            // and let the per-lead failure routing below handle them.
            const _cls = classifyConnectFailure(result.error);
            if (_cls === 'throttle' || _cls === 'invite_cap' || _cls === 'challenge') {
              log(`  ⏹ ${pName}: ${_cls} — not retrying this lead inline (${result.error}).`);
              break;
            }

            const backoff = attempt * 15000;
            log(`  ⟳ Retry ${attempt}/${MAX_RETRIES} in ${backoff / 1000}s — ${result.error}`);
            setAction(`Retrying lead (${attempt}/${MAX_RETRIES})`, { lead: data.firstName || '?', account: pName, durationMs: backoff });
            // Abort-aware sleep: 1s polling chunks so Stop interrupts within ~1s.
            const retryEnd = Date.now() + backoff;
            while (Date.now() < retryEnd && !campaign._abort) {
              await new Promise(r => setTimeout(r, 1000));
            }
            if (campaign._abort) { log('  ■ Abort during retry backoff.'); break; }

            try {
              const pages = await browser.pages();
              if (pages.length > 1) {
                page = pages[pages.length - 1];
                for (let i = 0; i < pages.length - 1; i++) {
                  try { await pages[i].close(); } catch { /* */ }
                }
              } else if (pages.length === 1) {
                page = pages[0];
              }
              session.page = page;
              // v2.14.x: re-apply CDP focus emulation on retry path.
              await applyFocusEmulation(page, profileId);
            } catch { /* */ }

            // v2.112.7 (Fix B): for a `transient` glitch on a gated connect, a
            // soft page re-acquisition is not enough — an SPA same-URL goto can
            // be a no-op and the wedged page never reloads. Force a real teardown
            // (about:blank) then RE-RUN the identity gate (fresh load + re-verify)
            // so the wrong-person safeguard fires on every fresh load. If the gate
            // confirms, mark verified so the next performOutreach reuses the
            // navigation (skipNavigation:true). If the gate now fails, treat it as
            // the existing identity-unverified skip: synthesize a skipped result
            // (routed by isDegradationSignal/the failure handler below — same
            // streak/park/backoff behavior as the pre-send gate failure) and stop
            // retrying. Only on gated connect URLs; other modes keep the old retry.
            if (_isConnectHint && _gateableUrl) {
              await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
              const _srcNameRetry = `${data.firstName || ''} ${data.lastName || ''}`.trim();
              const _gateRetry = await gateConnectIdentity(page, { url, row, sourceName: _srcNameRetry, log, verifyIdentity: campaign.identityGateEnabled !== false });
              if (_gateRetry.ok) {
                _identityVerified = _gateRetry.navigated !== false;
                _verifiedIdentityMeta = mergeProfileMeta(_verifiedIdentityMeta, _gateRetry.identity);
              } else if (_gateRetry.notFound) {
                // v2.112.26 (#4): the profile went dead (404) on the re-load —
                // a 'profile_not_found_404' error routes through normalizeSkipReason
                // to the same "Skipped: Profile not found (404)" sheet stamp.
                log(`  ✗ [${pName}] Profile not found (404) on transient retry — skipping. ${url}`);
                result = { action: 'skipped', error: 'profile_not_found_404' };
                break;
              } else {
                const _intendedR = `${_srcNameRetry || '?'} / ${readSourceMemberId(row) || 'no-member#'}`;
                const _gotR = `${_gateRetry.loaded.name || '?'} / ${_gateRetry.loaded.memberNumber || 'no-member#'}`;
                log(`  ✗ [${pName}] IDENTITY UNVERIFIED on transient retry — NOT sending. Intended: ${_intendedR} · Loaded: ${_gotR} · ${_gateRetry.reason}`);
                result = { action: 'skipped', error: `identity_unverified (${_gateRetry.reason}) — intended=[${_intendedR}] loaded=[${_gotR}]` };
                break;
              }
            }
          }
          // v2.97: preempted by a solo bulk check — skip ALL result handling
          // (stamping, already-connected probe, the inter-lead delay) and let
          // the inner loop fall through to awaitUnpause() at the next iteration,
          // which flips _paused=true so the sweep can run. The lead stays
          // unstamped and is re-attempted on resume.
          if (_preempted) continue;

          // 2.9.8: surface a normalized "Skipped: <reason>" in the dashboard
          // log too, so the operator sees the same wording the Audit Log uses.
          if (result.action === 'skipped' && result.error) {
            log(`  ${normalizeSkipReason(result.error)}`);
            // Record in skip ledger so the post-campaign report can surface it.
            {
              const _errStr = String(result.error).toLowerCase();
              let _skipReason;
              if (_errStr.includes('lead_timeout_watchdog') || _errStr.includes('lead timeout')) {
                _skipReason = WATCHDOG_TIMEOUT;
              } else if (_errStr.includes('identity_unverified') || _errStr.includes('identity-unverified')) {
                _skipReason = IDENTITY_UNCONFIRMED;
              } else {
                _skipReason = OTHER;
              }
              recordSkip({
                url,
                leadName: `${data.firstName || ''} ${data.lastName || ''}`.trim() || '(no name)',
                reason: _skipReason,
                profileId,
                profileName: pName,
                detail: normalizeSkipReason(result.error),
              });
            }
          } else {
            log(`  ${result.action}${result.error ? ' — ' + result.error : ''}`);
          }

          // Already-Connected detection: if the connect attempt was skipped
          // but a Voyager network-info call shows the lead is 1st-degree,
          // they're already in the account's network. Override the result
          // to a synthetic 'already_connected' action so the success branch
          // runs (stamps Already Connected + captures URN/openProfile).
          // Only checked for connect-mode runs to avoid extra Voyager calls
          // on message-only / inmail / check-status flows.
          if (result.action === 'skipped' && mode === 'connect_only') {
            try {
              const meta = await captureProfileMeta(page);
              if (meta.connectionDegree === 1) {
                log(`  ↪ Already 1st-degree connection — recording as Already Connected.`);
                result = {
                  action: 'already_connected',
                  _meta: meta,
                };
              } else if (meta.urn || meta.memberId) {
                // Stash meta even on non-1st-degree skips so we don't
                // re-fetch later (currently unused but cheap to keep).
                result._meta = meta;
              }
            } catch { /* best-effort */ }
          }

          // 2.9.2: human-readable local time for the sheet ("May 4th, 13:43"),
          // not the UTC ISO timestamp logs use.
          const now = formatLocalDate(new Date());

          // v2.86.9 — connect-time identity guard (src/profile-identity.js;
          // 2026-06-08 CC+IC incident). A /in/ACwAA… lead URL that fails to load
          // (rate-limit / session degradation) makes the connect flow read a
          // stray fallback profile as "already connected" and capture someone
          // else's URN. The stamp below would then write "Already Connected" +
          // that wrong URN, bulk-check would match the lead to a stranger's
          // acceptance, and CC+IC would fire a doomed intro. Verify the captured
          // identity is THIS lead first; on failure, downgrade to a retryable
          // skip so the row is re-attempted on a healthy pass instead of being
          // falsely stamped. The fingerprint of the bad case: no numeric member
          // id was resolvable off the loaded page.
          if (result.action === 'already_connected') {
            let _idMeta = result._meta || {};
            if (!_idMeta.memberNumber) {
              try { _idMeta = await captureProfileMeta(page); }
              catch { _idMeta = result._meta || {}; }
            }
            const _idCheck = verifyConnectIdentity({
              capturedMemberNumber: _idMeta.memberNumber,
              capturedUrn: _idMeta.memberId,
              leadUrl: url,
              sourceMemberId: readSourceMemberId(row),
            });
            if (!_idCheck.ok) {
              log(`  ⚠ ${pName}: "${data.firstName || '?'}" — loaded profile is not this lead (${_idCheck.reason}); NOT stamping connected, will retry.`);
              result = { action: 'skipped', error: `identity-unverified: ${_idCheck.reason}` };
            } else {
              result._meta = _idMeta; // hand the verified meta to the stamp below
            }
          }

          // v2.93 — mirror every attempted lead outcome into the central
          // Operations Log as one structured, attributable event, and tally the
          // run funnel/leaks. Pure classification + fire-and-forget; a telemetry
          // failure must never affect the outreach loop.
          try {
            const _cls = classifyOutcome({
              action: result.action,
              reason: result.error || result.reason || result.message || '',
              mode,
            });
            campaign.tally = applyOutcome(campaign.tally || emptyTally(), _cls);
            _ops(
              _cls.outcome === 'error' ? 'ERROR'
                : (_cls.outcome === 'skipped' || _cls.outcome === 'rate_limited' || _cls.outcome === 'parked') ? 'WARN'
                : 'INFO',
              'Outcome',
              { account: pName, leadUrl: url, details: _cls.reason,
                phase: _cls.phase, outcome: _cls.outcome, reason: _cls.reason },
            );
            // Refresh the live Dashboard row early (first lead) then every 15.
            campaign._dashTick = (campaign._dashTick || 0) + 1;
            if (campaign._dashTick === 1 || campaign._dashTick % 15 === 0) _pushDashboard(false);
          } catch (_) { /* telemetry never blocks the loop */ }

          if (SUCCESS_ACTIONS.has(result.action)) {
            // v2.10.0: stash the invitationUrn returned by Approach A's network
            // listener so the start-of-run reconcile pass can match this row
            // against Voyager's sent-invitations list later.
            state.processed[url] = {
              profileId,
              profileName: pName,
              action: result.action,
              date: now,
              ...(result.invitationUrn ? { invitationUrn: result.invitationUrn } : {}),
            };
            bumpCampaignCount(profileId);
            if (result.action === 'connection_sent') bumpCampaignSendCount(profileId);
            if (SENT_ACTIONS.has(result.action) && result.action !== 'connection_sent') {
              bumpCampaignMessageCount(profileId);
            }
            totalDone++;
            campaign.processedToday++;
            // Keep the lifetime/run total monotonic when a campaign is resumed
            // or handed back from the VM. `processedToday` is only this local
            // process' contribution; resetting the headline to it made the UI
            // briefly claim e.g. "1 of 200" after 20 leads were already done.
            campaign.totalProcessed = _resumeTotal + campaign.processedToday;
            const _tSave = Date.now();
            await saveState(state);
            if (Date.now() - _tSave > 3000) log(`  ⏱ saveState took ${((Date.now() - _tSave) / 1000).toFixed(0)}s`);
            // v2.95: SoO write-back — on the account's first credit-consuming
            // send (connection_sent / inmail_sent per mode), flip its SoO credit
            // cell to In Use + stamp the operator. No-op for every other action.
            const _tSoo = Date.now();
            await flipSoOInUse(pName, result.action);
            if (Date.now() - _tSoo > 3000) log(`  ⏱ SoO flip took ${((Date.now() - _tSoo) / 1000).toFixed(0)}s`);
            // v2.124: tick the per-account weekly connection tally in the SoO
            // (col AX). Fires on EVERY connect send, not just the first.
            await bumpSoOConnCount(pName, result.action);

            // 2.8.28: For check_status, do NOT overwrite Sender — preserving
            // the original sender attribution is essential. The audit log
            // append is also conditionally suppressed for check_status reads.
            // 2.9.3 / v2.11.11: always stamp Sender on non-check-status writes.
            // Without this, action paths that didn't explicitly set sender
            // (like 'already_processed') left the Sender column empty even
            // though the row WAS handled by an account.
            const sheetData = (mode === 'check_status')
              ? { dateLastAction: now }
              : { dateLastAction: now, sender: pName };
            // 2.8.50: when Introduction Messages mode is active, stamp the DM
            // column with "sent IC" instead of "sent" so introductions are
            // visually distinct from standard DMs in the sheet.
            // v2.11.17: introMode is implicit in introduce_back mode but
            // tpl.introMode also carries it (set in template normalization).
            const sentLabel = (tpl.introMode && (mode === 'message_only' || mode === 'introduce_back')) ? 'sent IC' : 'sent';
            const hyperSent = `=HYPERLINK("${url}","${sentLabel}")`;

            // v2 multi-status: pure helper builds the field-routed payload.
            // Merge into sheetData so meta/sender/date fields from outer scope
            // are preserved.
            Object.assign(sheetData, buildSheetDataForAction({
              action: result.action,
              mode,
              profileName: pName,
              hyperSent,
              introMode: !!tpl.introMode,
              messageOpenProfiles,
              creditsLeft: typeof result.creditsLeft === 'number' ? result.creditsLeft : undefined
            }));

            // Per-action side effects the pure helper can't capture.
            // Count profiles with a monitorable pending invite this run — new
            // (connection_sent) OR pre-existing (already_processed in CC+DM /
            // CC+IC) — so a re-run on already-invited leads still transitions
            // to monitoring instead of "0 sent → nothing to monitor".
            if (countsAsMonitorableInvite(result.action, mode)) {
              profilesThatSentAtLeastOne.add(profileId);
            }
            // Ortus Basics 1.0: connection notes are disabled, so every invite is
            // sent bare by design. The old check read LinkedIn's free-invite state
            // off the page after each send and logged "invite sent WITHOUT the
            // note", which now reports a non-event as if something had failed —
            // and cost a page read per lead to do it. The branch itself stays:
            // the URN capture below belongs to it.
            if (result.action === 'connection_sent') {
              try {
                // Start with the metadata captured on the VERIFIED pre-send
                // page, then enrich it from the post-send page. Never replace a
                // known value with a blank late response.
                let meta = mergeProfileMeta(_verifiedIdentityMeta);
                const post = await captureProfileMeta(page);
                // v2.86.9 — only stamp the captured URN when it provably belongs
                // to this lead. A mis-loaded /in/ACwAA… profile yields a stray
                // URN that would poison future bulk-check matching. An invite DID
                // go out, so we keep the connection_sent stamp — we just withhold
                // the unreliable URN/member-id rather than write a wrong one.
                const _v = verifyConnectIdentity({
                  capturedMemberNumber: post.memberNumber,
                  capturedUrn: post.memberId,
                  leadUrl: url,
                  sourceMemberId: readSourceMemberId(row),
                });
                if (_v.ok) {
                  meta = mergeProfileMeta(meta, post);
                  // One short, missing-fields-only retry catches LinkedIn's
                  // delayed top-card/Voyager paint without slowing healthy rows.
                  if (!meta.memberId || !meta.memberNumber || meta.isOpenProfile == null || meta.connectionDegree == null) {
                    await new Promise((r) => setTimeout(r, 1200));
                    const retry = await captureProfileMeta(page);
                    const retryV = verifyConnectIdentity({
                      capturedMemberNumber: retry.memberNumber,
                      capturedUrn: retry.memberId,
                      leadUrl: url,
                      sourceMemberId: readSourceMemberId(row),
                    });
                    if (retryV.ok) meta = mergeProfileMeta(meta, retry);
                  }
                } else if (_verifiedIdentityMeta) {
                  // The current page moved or returned a partial response after
                  // the click. The gate's earlier data is still verified and is
                  // safe to write; only the unverified post-send read is dropped.
                  log(`  ℹ ${pName}: post-send metadata read was incomplete (${_v.reason}); using the verified pre-send identity.`);
                  if (!meta.memberId || !meta.memberNumber || meta.isOpenProfile == null || meta.connectionDegree == null) {
                    await new Promise((r) => setTimeout(r, 1200));
                    const retry = await captureProfileMeta(page);
                    const retryV = verifyConnectIdentity({
                      capturedMemberNumber: retry.memberNumber,
                      capturedUrn: retry.memberId,
                      leadUrl: url,
                      sourceMemberId: readSourceMemberId(row),
                    });
                    if (retryV.ok) meta = mergeProfileMeta(meta, retry);
                  }
                } else {
                  log(`  ⚠ ${pName}: connect sent but profile identity unverified (${_v.reason}) — withholding URN.`);
                  meta = null;
                }

                if (meta) {
                  if (meta.memberId)     sheetData.linkedinUrn       = meta.memberId;
                  if (meta.memberNumber) sheetData.linkedinMemberId  = meta.memberNumber;
                  if (meta.isOpenProfile !== null) sheetData.openProfile     = meta.isOpenProfile ? 'Yes' : 'No';
                  // A confirmed new invitation proves this account was not
                  // already 1st-degree, even if LinkedIn omitted the degree.
                  sheetData.connectedAlready = meta.connectionDegree === 1 ? 'Yes' : 'No';
                  const missing = [
                    !meta.memberId && 'LinkedIn URN',
                    !meta.memberNumber && 'LinkedIn Membership ID',
                    meta.isOpenProfile == null && 'Open Profile',
                  ].filter(Boolean);
                  if (missing.length) log(`  ⚠ ${pName}: metadata captured partially; still unavailable: ${missing.join(', ')}. It will be retried during monitoring.`);
                }
              } catch { /* best-effort */ }
            } else if (result.action === 'already_connected') {
              const meta = result._meta || {};
              if (meta.memberId)     sheetData.linkedinUrn      = meta.memberId;
              if (meta.memberNumber) sheetData.linkedinMemberId = meta.memberNumber;
              if (meta.isOpenProfile !== null && meta.isOpenProfile !== undefined) {
                sheetData.openProfile = meta.isOpenProfile ? 'Yes' : 'No';
              }
            } else if (result.action === 'inmail_sent') {
              if (typeof result.creditsLeft === 'number') {
                log(`  💳 InMail credits left: ${result.creditsLeft}`);
                if (result.creditsLeft <= 0) {
                  log(`  ⚠ ${pName} has 0 InMail credits — removing from InMail rotation.`);
                  weeklyLimited.add(profileId);
                  recordProfileEnd(profileId, pName, 'No InMail credits left');
                }
              }
            } else if (result.action === 'status_pending') {
              // Preserve legacy timestamp on the CC column for operators
              // who scroll the legacy column. Helper already set checkStatus
              // for v2 sheets. Status mirrors 'Check Done.' on both schemas.
              const _n = new Date();
              const _pad = (n) => String(n).padStart(2, '0');
              const _stamp = `${_n.getFullYear()}-${_pad(_n.getMonth() + 1)}-${_pad(_n.getDate())} ${_pad(_n.getHours())}:${_pad(_n.getMinutes())}`;
              sheetData.status = 'Check Done.';
              sheetData.cc = `Still Pending (${_stamp})`;
              sheetData.auditAction = 'Still pending';
            }
            if (result.action === 'status_declined') {
              // Defensive fallback — outreach.js no longer emits this since
              // Check Status went two-state in 2.8.39. Treat as "Connection
              // Declined" so the operator sees the explicit verdict.
              sheetData.status = 'Check Done.';
              sheetData.cc = 'Connection Declined';
              sheetData.auditAction = 'Not confirmed connected';
            }
            // status_unknown: no connected field — leave CC text alone
            await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), sheetData, linkedinColumn);

            // The people this account actually reached, by name, for the
            // per-account panel AND for the log. Only real sends count: a
            // status check that confirmed somebody is not somebody who was
            // written to. The old line here was a bare "(3/50)" counter that
            // named neither the person nor what happened to them.
            const _who = `${data.firstName || ''} ${data.lastName || ''}`.trim();
            if (SENT_ACTIONS.has(result.action)) {
              log(plainLine('sent', {
                account: pName,
                who: _who || 'Someone with no name in the sheet',
                what: SENT_WORDS[result.action] || 'a message',
                done: leadInBatch + 1,
                size: Number.isFinite(innerLimit) ? innerLimit : null,
                today: getCampaignSendCount(profileId),
                dailyLimit: campaign.dailyLimit,
              }));
              if (_who) {
                campaign._reachedByProfile = campaign._reachedByProfile || {};
                const _list = campaign._reachedByProfile[profileId] || (campaign._reachedByProfile[profileId] = []);
                _list.push(_who);
                if (_list.length > 200) _list.splice(0, _list.length - 200);
              }
            } else {
              // Nothing was sent to this person, but their row was brought up
              // to date (a status check, an already-connected match, and so on).
              log(`  ✓ [${pName}] ${_who || 'That row'} is now up to date in the sheet.`);
            }
            consecutiveSkips.set(profileId, 0);
            consecutiveUnconfirmed.delete(profileId);
            consecutiveNotOp.delete(profileId);
            consecutive429s.set(profileId, 0);
            cooldowns429.set(profileId, 0);
            campaign._cooldown429.delete(profileId);
            // v2.96.2 (Phase 2): clear the backoff only on outcomes that PROVE
            // a healthy page interaction — not cheap early-returns like
            // 'already_processed' (which can short-circuit before any real page
            // work and would mask an ongoing degradation streak).
            if (['connection_sent', 'message_sent', 'inmail_sent', 'op_message_sent', 'already_connected', 'status_accepted'].includes(result.action)) {
              degradationStreak.set(profileId, 0);
            }
            // v2.84: a successful action proves this account is logged in again —
            // clear any Needs Login = Y flag it carried (no-op unless flagged).
            await setAccountNeedsLogin(pName, false);

            // Connect + Introduce Back / Connect + DM: piggy-back a bulk
            // acceptance sweep on this profile's turn, but with two gates:
            // (a) first-hour blackout — no sweep in the first 60 min of the
            //     campaign at all (gives LinkedIn time to actually start
            //     accepting; sweeping at minute 1 is wasted Voyager calls).
            // (b) per-(sheetId, profileId) cap — at most 1 sweep / hour.
            // The Connected column flip in bulk-check is what triggers the
            // phase-2 follow-up (intro DM for CC+IC, plain DM for CC+DM).
            // Manual /api/bulk-check-now bypasses both (operator override).
            if (AUTOMATIC_CHECKS_ENABLED && (mode === 'connect_and_introduce' || mode === 'connect_and_message') && result.action === 'connection_sent') {
              try {
                const _campaignStartMs = campaign.startedAt ? Date.parse(campaign.startedAt) : Date.now();
                const _campaignAgeMs = Date.now() - _campaignStartMs;
                const _sheetId = _extractSheetIdFromUrl(sheetUrl);
                const cooldown = await readBulkCheckCooldown();
                const _key = bulkCheckKey(_sheetId, profileId);
                const last = cooldown[_key] || 0;
                if (_campaignAgeMs < FIRST_HOUR_BLACKOUT_MS) {
                  // first-hour blackout — skip silently to avoid log spam
                } else if (Date.now() - last >= campaign.checkIntervalMinutes * 60_000) {
                  log(`  📡 [${pName}] In-batch bulk Connection Status check (${campaign.checkIntervalMinutes}-min cadence elapsed)…`);

                  // Dual-stamp avoidance: when phase-2 will fire for newly-
                  // Connected rows, suppress the Connection Accepted Status
                  // stamp for those so the phase-2 status column (Introduction
                  // Status / DM Status) is the single source of truth.
                  const willAutoIntro = mode === 'connect_and_introduce' && _primaryIntroAllowed(profileId) && !!(
                    tpl && tpl.primaryName && tpl.primaryName.trim() &&
                    tpl.primaryIntroBody && tpl.primaryIntroBody.trim()
                  );
                  const willAutoDm = mode === 'connect_and_message' && !!(
                    tpl && tpl.ccDmBody && tpl.ccDmBody.trim()
                  );

                  const r = await bulkCheckConnections(page, sheetUrl, linkedinColumn, pName, {
                    // v2.14.x: stamp Connection Accepted immediately at bulk-check detection
                    // so the operator sees acceptance in the sheet BEFORE the intro DM fires.
                    // The auto-intro pass then only stamps Introduction Status (no longer
                    // batched into a single Apps Script write).
                    suppressAcceptedStamp: false,
                  });
                  if (r.error) {
                    log(`  ⚠ [${pName}] Bulk check: ${r.error}`);
                  } else {
                    log(r.plain || `  📡 [${pName}] Bulk check: ${r.matched} marked Connected, ${r.stamped || 0} marked Still Pending (of ${r.fetched} recent connections fetched)`);
                  }
                  cooldown[_key] = Date.now();
                  await writeBulkCheckCooldown(cooldown);

                  // Phase-2 dispatch — same helper pattern, mode-routed.
                  if (willAutoIntro && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
                    await runAutoIntros({
                      page,
                      profileId,
                      profileName: pName,
                      sheetUrl,
                      linkedinColumn,
                      connectedUrls: r.connectedUrls,
                      templates,
                      senderFirstNames,
                      log,
                    });
                  } else if (willAutoDm && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
                    await runAutoDms({
                      page,
                      profileId,
                      profileName: pName,
                      sheetUrl,
                      linkedinColumn,
                      connectedUrls: r.connectedUrls,
                      templates,
                      senderFirstNames,
                      log,
                    });
                  }
                }
              } catch (err) {
                log(`  ⚠ [${pName}] Bulk check threw: ${err.message}`);
              }
            }

            // v2.59.x: CC+DM — leads found ALREADY connected at send time never
            // went through the acceptance→bulk-check→auto-DM chain (they were
            // never "pending"), so they were never messaged. Route them
            // straight to the auto-DM here. The content-dedup inside runAutoDms
            // prevents re-sending an identical message across reruns, and the
            // existing "DM Sent" terminal skip keeps already-messaged rows out.
            if (mode === 'connect_and_message' && result.action === 'already_connected') {
              const ccBody = ((tpl && tpl.ccDmBody) || '').trim();
              if (ccBody) {
                try {
                  await runAutoDms({
                    page, profileId, profileName: pName, sheetUrl, linkedinColumn,
                    connectedUrls: [url], templates, senderFirstNames, log,
                  });
                } catch (err) {
                  log(`  ⚠ [${pName}] Auto-DM (already-connected) threw: ${err.message}`);
                }
              }
            }
            // Record end reason when an account completes its per-run quota.
            // The candidate filter at line ~1289 will silently exclude it
            // from the next round; this gives operators a visible "why" on
            // the dashboard's Done row.
            if (!skipsDailyLimit && getCampaignSendCount(profileId) >= campaign.dailyLimit) {
              recordProfileEnd(profileId, pName, `Reached campaign limit (${campaign.dailyLimit})`);
            }
          } else {
            const errorMsg = result.error || result.action || '';
            // v2.112.7 (Fix B): classify the failure once and route the three
            // account-level outcomes that need distinct treatment. `invite_cap`
            // (quota spent) falls through to the existing WEEKLY_LIMIT / 429
            // parking paths below — those already mark the account done-sending
            // for the cycle while monitoring continues. `challenge` and
            // `throttle` are handled here.
            const _failCls = classifyConnectFailure(errorMsg);
            // `challenge` — a LinkedIn checkpoint/captcha/unusual-activity wall.
            // Halt the account immediately and surface to a human; NEVER auto-
            // retry through it. weeklyLimited.add stops further sends this cycle
            // and turns the is429/skip/WEEKLY_LIMIT parks below into no-ops
            // (all guarded by !weeklyLimited.has), so there's no double-park.
            if (_failCls === 'challenge' && !weeklyLimited.has(profileId)) {
              log(`  ⛔ ${pName}: LinkedIn checkpoint/challenge — halting account, needs a human. (${errorMsg})`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'LinkedIn checkpoint — needs a human');
              campaign.parkedProfiles.push({
                profileId,
                pName,
                parkedAt: Date.now(),
                reason: 'challenge',
              });
              _ops('ERROR', 'challenge', {
                account: pName,
                leadUrl: url,
                phase: 'Connect',
                outcome: 'halted',
                reason: `challenge — LinkedIn checkpoint, needs a human (${errorMsg})`,
              });
              pushSoftWarning(campaign, {
                profileId,
                pName,
                kind: 'challenge',
                message: 'LinkedIn checkpoint — needs a human',
              });
            } else if (_failCls === 'throttle' && !weeklyLimited.has(profileId)) {
              // `throttle` — LinkedIn is rate-limiting this account. Escalate the
              // degradation streak and back off (jittered, anti-thundering-herd /
              // anti-fingerprint per B3). If the operator left pauseOnThrottle ON
              // (default), park the account so the OTHER accounts keep running;
              // if OFF, keep this account going after the abort-aware backoff.
              degradationStreak.set(profileId, (degradationStreak.get(profileId) || 0) + 1);
              const _tStreak = degradationStreak.get(profileId) || 0;
              const _tBase = Math.floor((delayMin + delayMax) / 2) * 1000;
              const _tWaitMs = degradationBackoffMs(_tBase, _tStreak, { jitter: true, maxMult: DEGRADE_MAX_MULT, maxMs: DEGRADE_MAX_WAIT_MS });
              if (campaign.pauseOnThrottle) {
                // A 429 on a connect is the weekly invitation cap ~9 times in 10
                // (field logs, 2026-09-19) — say so instead of a bare "throttled",
                // which left 37 accounts reading just "Stopped".
                const _is429 = /HTTP\s*429/i.test(errorMsg);
                log(_is429
                  ? `  ⏸ ${pName}: LinkedIn refused its invite (HTTP 429) — SUSPECTED WEEKLY INVITATION LIMIT. Pausing this account, others continue. Use "Try again on the next round" to test it.`
                  : `  ⏸ ${pName}: throttled by LinkedIn — pausing account (pauseOnThrottle ON), others continue. (${errorMsg})`);
                weeklyLimited.add(profileId);
                recordProfileEnd(profileId, pName, _is429 ? 'Suspected weekly invitation limit (HTTP 429)' : 'Paused — LinkedIn throttling (resumes next run)');
                campaign.parkedProfiles.push({
                  profileId,
                  pName,
                  parkedAt: Date.now(),
                  reason: _is429 ? 'suspected_weekly_limit' : 'throttle_paused',
                });
                pushSoftWarning(campaign, {
                  profileId,
                  pName,
                  kind: 'rate_limited',
                  message: 'Paused on LinkedIn throttling',
                });
                _ops('WARN', 'throttle', {
                  account: pName,
                  leadUrl: url,
                  phase: 'Connect',
                  outcome: 'paused',
                  reason: `throttle — account paused (streak ${_tStreak}) (${errorMsg})`,
                });
              } else {
                log(`  ⏳ ${pName}: throttled — backing off ${(_tWaitMs / 1000).toFixed(0)}s (streak ${_tStreak}, pauseOnThrottle OFF) then continuing.`);
                _ops('WARN', 'throttle', {
                  account: pName,
                  leadUrl: url,
                  phase: 'Connect',
                  outcome: 'backoff',
                  reason: `throttle — backoff ${(_tWaitMs / 1000).toFixed(0)}s (streak ${_tStreak}) (${errorMsg})`,
                });
                // Abort-aware backoff sleep in 2s chunks so Stop interrupts ~2s.
                const _tSleepEnd = Date.now() + _tWaitMs;
                while (Date.now() < _tSleepEnd && !campaign._abort) {
                  await new Promise((r) => setTimeout(r, 2000));
                }
                _throttleHandled = true;
              }
            }
            // v2.96.0 (Phase 2): escalate backoff when this looks like session
            // degradation (nav race / timeout / not-found / rate-limit) rather
            // than a benign skip. A clean success (above) resets the streak.
            // v2.112.7: skip the increment for failures the Fix-B routing above
            // already escalated (throttle) so the streak isn't double-counted.
            if (_failCls !== 'throttle' && isDegradationSignal(errorMsg)) {
              degradationStreak.set(profileId, (degradationStreak.get(profileId) || 0) + 1);
            }
            // Session expired = cookies are dead until the operator logs in
            // again. No point waiting for SKIP_PARK_THRESHOLD strikes —
            // every subsequent lead will fail the same way. Park on the
            // first occurrence so the loop rotates to a healthier account.
            const isSessionExpired = /session\s*expired/i.test(errorMsg);
            if (isSessionExpired && !weeklyLimited.has(profileId)) {
              // Local-browser session expiry (2026-06-15): recover in place —
              // pop the window + the in-app "Done" popup and wait for re-login.
              // Only on a 5-min no-response timeout do we fall back to the same
              // park-and-flag below. GoLogin profiles skip recovery entirely.
              let recovered = false;
              if (profileId === 'local-browser') {
                log(`  ⚠ ${pName}: session expired mid-run — opening browser for you to log in.`);
                const recovery = await awaitLocalLogin(page, profileId, pName);
                recovered = recovery.ok;
                if (recovered) { page = recovery.page || page; session.page = page; }
              }
              if (recovered) {
                log(`  ✓ ${pName}: re-logged in — staying in rotation.`);
              } else {
                log(`  ⚠ ${pName}: session expired — parking account for rest of run (re-login required).`);
                weeklyLimited.add(profileId);
                recordProfileEnd(profileId, pName, 'Session expired — log in again');
                campaign.parkedProfiles.push({
                  profileId,
                  pName,
                  parkedAt: Date.now(),
                  reason: 'session_expired',
                });
                // v2.84: flag every LEAD row handled by this account (Sender column)
                // as Needs Login = Y in the campaign sheet, so the operator can filter
                // to the stalled leads.
                await setAccountNeedsLogin(pName, true);
                // v2.95: ALSO flag this account on the SoO "LinkedIn Accounts" board
                // (matched by Email == profile name) so the LinkedIn team re-logs it.
                // Never auto-cleared. Best-effort — cannot affect the loop.
                await markSoONeedsLogin(pName);
              }
            }
            // 429-specific tracker. Three strikes = treat as weekly cap and
            // park the profile, well before the generic SKIP_PARK_THRESHOLD
            // would catch it (which can be 5+ and burns more API quota).
            const is429 = /HTTP\s*429|VOYAGER_REJECTED.*429/i.test(errorMsg);
            if (is429) {
              const c429 = (consecutive429s.get(profileId) || 0) + 1;
              consecutive429s.set(profileId, c429);
              // An account that has reached NOBODY this run and gets a 429 is at its
              // weekly cap: 24 of 24 such cases in the field logs (2026-09-19) never
              // sent again that run. Don't spend a second invite confirming it.
              const _reachedSoFar = ((campaign._reachedByProfile || {})[profileId] || []).length;
              if ((c429 >= HTTP_429_PARK_THRESHOLD || _reachedSoFar === 0) && !weeklyLimited.has(profileId)) {
                const episodesSoFar = cooldowns429.get(profileId) || 0;
                const _reached = _reachedSoFar;
                const { action, waitMs } = decide429({
                  consecutive429s: c429,
                  cooldownsSoFar: episodesSoFar,
                  reachedThisRun: _reached,
                });
                if (action === 'cooldown') {
                  const newEpisodes = episodesSoFar + 1;
                  cooldowns429.set(profileId, newEpisodes);
                  const untilTs = Date.now() + waitMs;
                  profileCooldownUntil.set(profileId, untilTs);
                  campaign._cooldown429.set(profileId, { until: untilTs, pName, reason: '429' });
                  consecutive429s.set(profileId, 0);
                  // v2.137 (final-review part 1+2): signal the inner loop to break
                  // immediately after this lead's error handling completes — avoids
                  // burning remaining batch slots against a cooling account.
                  // Also reset consecutiveSkips so 429-triggered cooldowns never
                  // accumulate toward SKIP_PARK_THRESHOLD and falsely park the profile.
                  cooling429 = true;
                  consecutiveSkips.set(profileId, 0);
                  log(`  ⏳ [${pName}] rate-limited (HTTP 429) — cooling down ${Math.round(waitMs / 60000)}min, will retry automatically (attempt ${newEpisodes}/3)`);
                } else {
                  // action === 'park': 3rd episode, treat as real weekly cap
                  const _capWhy = _reached === 0
                    ? `its ${c429 === 1 ? 'first invite was' : 'invites were all'} refused (HTTP 429) and nobody reached this run`
                    : `${HTTP_429_PARK_THRESHOLD} consecutive HTTP 429s (3rd cooldown episode)`;
                  log(`  ⚠ ${pName} has hit its WEEKLY INVITATION LIMIT — ${_capWhy}. It sends nothing more until LinkedIn resets it; the rest of its leads go to the other accounts.`);
                  weeklyLimited.add(profileId);
                  campaign._cooldown429.delete(profileId);
                  recordProfileEnd(profileId, pName, `Weekly invitation limit reached (${_reached === 0 ? 'every invite refused with HTTP 429' : HTTP_429_PARK_THRESHOLD + '× HTTP 429'})`);
                  campaign.parkedProfiles.push({
                    profileId,
                    pName,
                    parkedAt: Date.now(),
                    reason: 'weekly_limit_429',
                  });
                }
              }
            } else {
              consecutive429s.set(profileId, 0);
            }
            // v2.137: don't count the cooldown-triggering 429 toward consecutiveSkips —
            // the reset inside the cooldown branch above is overridden here without this guard.
            if (!cooling429) {
              const skipCount = (consecutiveSkips.get(profileId) || 0) + 1;
              consecutiveSkips.set(profileId, skipCount);
              if (skipCount >= SKIP_PARK_THRESHOLD && !weeklyLimited.has(profileId)) {
                log(`  ⚠ ${pName}: ${SKIP_PARK_THRESHOLD} consecutive non-success outcomes — parking account for rest of run.`);
                weeklyLimited.add(profileId);
                recordProfileEnd(profileId, pName, `Parked after ${skipCount} consecutive skips`);
                recordSkip({ url, leadName: `${data.firstName || ''} ${data.lastName || ''}`.trim() || '(no name)', reason: FAILED_REPEATEDLY, profileId, profileName: pName, detail: `Account parked after ${skipCount} consecutive non-success outcomes — this lead was the trigger` });
                campaign.parkedProfiles.push({
                  profileId,
                  pName,
                  parkedAt: Date.now(),
                  reason: 'consecutive_skips',
                  skipCount,
                });
              }
            }

            let _parkedForUnconfirmed = false;
            const _unconfirmedKind = errorMsg.includes('SEND_NOT_CONFIRMED') ? 'send_not_confirmed' : '';
            if (_unconfirmedKind) {
              const _unconfirmedCount = bumpUnconfirmed(profileId, _unconfirmedKind);
              if (_unconfirmedCount >= UNCONFIRMED_PARK_THRESHOLD && !weeklyLimited.has(profileId)) {
                weeklyLimited.add(profileId);
                recordProfileEnd(profileId, pName, 'Parked after 5 consecutive unconfirmed sends');
                campaign.parkedProfiles.push({
                  profileId, pName, parkedAt: Date.now(), reason: 'unconfirmed_streak',
                  issue: _unconfirmedKind, skipCount: _unconfirmedCount,
                });
                log(`  ${pName}: 5 sends in a row could not be confirmed — parking this account; the campaign continues with other senders.`);
                _parkedForUnconfirmed = true;
              }
            } else {
              consecutiveUnconfirmed.delete(profileId);
            }
            if (!errorMsg.includes('NOT_OPEN_PROFILE')) consecutiveNotOp.delete(profileId);

            if (errorMsg.includes('WEEKLY_LIMIT')) {
              log(`  ⚠ WEEKLY LIMIT reached for ${pName}. Removing from rotation.`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'Weekly invitation limit hit (~100/week)');
              pushSoftWarning(campaign, {
                profileId,
                pName,
                kind: 'weekly_limit',
                message: 'Weekly invitation limit reached',
              });
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                ...buildSkipSheetData(mode, normalizeSkipReason('Weekly invitation limit reached'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('Weekly invitation limit reached'),
              }, linkedinColumn);
            } else if (errorMsg.includes('NOTE_LIMIT_REACHED')) {
              // v2.112.32 — account is out of FREE custom notes (monthly cap on
              // personalized invites). Distinct from the weekly invite cap: the
              // account can still send note-LESS invites, just not noted ones.
              // Operator rule: when a note is required, do NOT silently send
              // without it — bench the account and leave the lead RETRYABLE so an
              // account that still has note credits sends it (this run or next).
              log(`  ⚠ ${pName}: out of free custom notes — benching account (can't send noted invites). Lead stays retryable.`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'Out of note credits');
              pushSoftWarning(campaign, {
                profileId,
                pName,
                kind: 'note_limit',
                message: 'Out of note credits',
              });
              // Audit breadcrumb ONLY (no terminal Stage/Status) so the row stays
              // eligible for another account/run — mirrors the identity-skip path.
              delete state.processed[url];
              await saveState(state);
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                auditAction: 'Skipped: Account out of free notes',
              }, linkedinColumn);
            } else if (errorMsg.includes('NOTE_TOO_LONG')) {
              // v2.112.x — the note exceeds LinkedIn's free 200-char custom-note
              // cap and this account isn't Premium, so it can NEVER send this (or
              // any) noted invite — the template length is the same for every
              // lead. Operator choice (2026-06-22, revised): BENCH the account on
              // the first hit (mirrors NOTE_LIMIT_REACHED) so the run halts loudly
              // with "shorten the note / not Premium" instead of stamping a whole
              // column of skips. Leave the lead RETRYABLE (audit breadcrumb only,
              // no terminal Stage/Status) so a Premium account in the pool — or a
              // later run with a shortened note — can still take it.
              log(`  ⚠ ${pName}: note over LinkedIn's 200-char limit (account not Premium) — benching account (can't send noted invites). Lead stays retryable.`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'Not Premium — custom note over 200-char limit');
              pushSoftWarning(campaign, {
                profileId,
                pName,
                kind: 'note_too_long',
                message: 'Not Premium — custom note over 200 chars',
              });
              // Audit breadcrumb ONLY (no terminal Stage/Status) so the row stays
              // eligible for another account/run — mirrors the note-limit path.
              delete state.processed[url];
              await saveState(state);
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                auditAction: 'Skipped: Profile not premium, custom notes limit',
              }, linkedinColumn);
            } else if (errorMsg.includes('INMAIL_NO_CREDITS_NOT_OP')) {
              // v2.11.3: dual-fact signal — account is out of InMail credits
              // (eject for run) AND lead is confirmed non-OP (mark in sheet).
              // The lead-level fact takes precedence in the sheet write because
              // it's permanent across runs; the account-level fact is run-only.
              log(`  ⚠ ${pName}: 0 InMail credits + lead not Open Profile. Removing account from rotation, marking lead Not OP.`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'No InMail credits left');
              state.processed[url] = { profileId, profileName: pName, action: 'not_open_profile', date: now };
              await saveState(state);
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                ...buildSkipSheetData(mode, normalizeSkipReason('Not Open Profile'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('Not Open Profile'),
              }, linkedinColumn);
            } else if (errorMsg.includes('INMAIL_NO_CREDITS')) {
              log(`  ⚠ InMail credits exhausted for ${pName}. Removing from rotation.`);
              weeklyLimited.add(profileId);
              recordProfileEnd(profileId, pName, 'InMail credits exhausted');
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                ...buildSkipSheetData(mode, normalizeSkipReason('InMail credits exhausted'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('InMail credits exhausted'),
              }, linkedinColumn);
            } else if (errorMsg.includes('EMAIL_REQUIRED')) {
              // Per-lead skip — LinkedIn asked for the recipient's email.
              // Not an account-level issue, so no soft-warning chip; the log
              // line + sheet stamp below carry all the info the operator needs.
              log(`  ⚠ Email required for ${data.firstName || '?'}. Skipping lead, moving on.`);
              state.processed[url] = { profileId, profileName: pName, action: 'email_required', date: now };
              await saveState(state);
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                ...buildSkipSheetData(mode, normalizeSkipReason('Email required to connect'), pName),
                cc: 'Unreachable',
                dateLastAction: now,
                auditAction: normalizeSkipReason('Email required to connect'),
              }, linkedinColumn);
            } else if (errorMsg.includes('Not yet connected')) {
              log('  ↷ Not yet connected — will retry after acceptance.');
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                status: normalizeSkipReason('Not yet connected'),
                sender: pName,
                dateLastAction: now,
                auditAction: normalizeSkipReason('Not yet connected'),
              }, linkedinColumn);
            } else if (errorMsg.includes('SEND_NOT_CONFIRMED')) {
              log(`  ⚠ Send clicked but Pending NOT confirmed for ${data.firstName || '?'}. LinkedIn may have silently dropped it.`);
              delete state.processed[url];
              await saveState(state);
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                ...buildSkipSheetData(mode, normalizeSkipReason('Send not confirmed'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('Send not confirmed'),
              }, linkedinColumn);
            } else if (errorMsg.includes('LINKEDIN_ERROR_TOAST')) {
              log(`  ⚠ LinkedIn showed an error toast for ${data.firstName || '?'}.`);
              delete state.processed[url];
              await saveState(state);
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                ...buildSkipSheetData(mode, normalizeSkipReason('LinkedIn error toast'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('LinkedIn error toast'),
              }, linkedinColumn);
            } else if (errorMsg.includes('NOT_OPEN_PROFILE')) {
              log(`  ✗ Skipped — ${data.firstName || 'this contact'} is either not an Open Profile, or ${pName} has reached its monthly OP credit limit.`);
              const _notOp = (consecutiveNotOp.get(profileId) || 0) + 1;
              consecutiveNotOp.set(profileId, _notOp);
              if (_notOp >= NOT_OP_BENCH_THRESHOLD && !weeklyLimited.has(profileId)) {
                log(`  ⚠ ${pName}: ${_notOp} contacts in a row skipped as not Open Profile — suspected OP credits limit reached. Benching this account; choose Retry to unbench it.`);
                weeklyLimited.add(profileId);
                recordProfileEnd(profileId, pName, 'Suspected OP credits limit reached');
                campaign.parkedProfiles.push({ profileId, pName, parkedAt: Date.now(), reason: 'op_credit_limit', skipCount: _notOp });
                pushSoftWarning(campaign, { profileId, pName, kind: 'op_credit_limit', message: 'Suspected OP credits limit reached' });
              }
              state.processed[url] = { profileId, profileName: pName, action: 'not_open_profile', date: now };
              await saveState(state);
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                ...buildSkipSheetData(mode, normalizeSkipReason('Not Open Profile'), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason('Not Open Profile'),
              }, linkedinColumn);
            } else if (errorMsg.includes('rate_limited')) {
              pushSoftWarning(campaign, {
                profileId,
                pName,
                kind: 'rate_limited',
                message: 'LinkedIn rate-limit page shown',
              });
              log('  ✗ Retry next run.');
              pushError(new Error(`${url}: ${errorMsg}`));
              delete state.processed[url];
              await saveState(state);
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                ...buildSkipSheetData(mode, normalizeSkipReason(errorMsg), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason(errorMsg),
              }, linkedinColumn);
            } else {
              log('  ✗ Retry next run.');
              pushError(new Error(`${url}: ${errorMsg}`));
              delete state.processed[url];
              await saveState(state);
              await trackedSheetWrite(sheetUrl, url, `${data.firstName || ''} ${data.lastName || ''}`.trim(), {
                ...buildSkipSheetData(mode, normalizeSkipReason(errorMsg), pName),
                dateLastAction: now,
                auditAction: normalizeSkipReason(errorMsg),
              }, linkedinColumn);
            }

            if (_parkedForUnconfirmed) break;
          }

          // v2.137 (final-review): if a 429 cooldown fired for this lead, break
          // immediately — no delay, no further leads. The profile stays off weeklyLimited
          // so it is re-enqueued at ~4671 and re-picked by pickNextProfile once the
          // profileCooldownUntil window expires.
          if (cooling429) break;

          totalVisited++;

          // ── Phase 11.1: park the idle profile on a low-RAM page during the delay window (D-10, D-11) ──
          // Always parks, regardless of throttle state. IDLE_PARKING_ENABLED env kill switch wins.
          // Swallows errors (parkProfile itself catches + logs).
          if (rmCfg.IDLE_PARKING_ENABLED) {
            await parkProfile(page, rmCfg.PARK_PAGE);
          }

          // Within-batch delay between leads (interruptible by abort).
          // Phase 11.2 (D-04): session-break branch removed — between-batch
          // gap is handled after the inner BATCH_SIZE loop, derived from
          // batchesPerHour.
          // v2.81: if this lead just parked the account (e.g. 2nd HTTP 429 →
          // weekly-limit park), skip the delay entirely and let the inner-loop
          // guard rotate to the next account immediately — no point waiting
          // 15-45s for a lead the parked account will never get.
          // v2.97: also skip the delay when a pause has been requested (e.g. a
          // solo bulk check is taking precedence) so the loop reaches its pause
          // boundary within ~1s instead of sleeping 15-45s first.
          // v2.112.7 (Fix B): also skip when the throttle-OFF branch above already
          // performed the jittered backoff sleep for this lead — no double-wait.
          if (!campaign._abort && !campaign._pauseRequested && !weeklyLimited.has(profileId) && !_throttleHandled) {
            // Messaging existing 1st-degree connections is much lower risk than
            // sending new connection requests, so use a faster cadence and skip
            // the single-account slowdown.
            // 2.9.8: extended unlimited-pacing set. Was only message_only;
            // now also inmail_only + open_profile_only per user request
            // (no daily/hourly caps for non-Connect sends).
            const isMessageMode = mode === 'message_only';
            const isFastMode = isMessageMode || mode === 'inmail_only' || mode === 'open_profile_only';
            const delayMultiplier = computeDelayMultiplier({
              mode,
              profileCount: profileIds.length,
              throttleActive:     campaign._throttle?.active     ?? false,
              throttleMultiplier: campaign._throttle?.multiplier ?? 1,
            });

            let waitMs;
            if (mode === 'check_status' || isFastMode) {
              // 2.8.29 / 2.9.8: read-only modes (check_status) and low-risk
              // send modes (message_only, inmail_only, open_profile_only)
              // use a tiny 1-3s breath instead of the 15-45s connect cadence.
              waitMs = (1 + Math.floor(Math.random() * 2)) * 1000;
              const label = (mode === 'check_status')
                ? 'check-only — no rate limits apply'
                : `${mode.replace('_only', '')} — no rate limits apply`;
              log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s (${label})`);
            } else {
              waitMs = Math.floor(Math.random() * (delayMax - delayMin + 1) + delayMin) * 1000;
              waitMs = Math.floor(waitMs * delayMultiplier);
              // v2.96.0 (Phase 2): exponential degradation backoff — give a
              // degrading LinkedIn session time to recover instead of hammering
              // it at fixed pace. Cleared by a clean success.
              const _dStreak = degradationStreak.get(profileId) || 0;
              const _preDegrade = waitMs;
              waitMs = degradationBackoffMs(waitMs, _dStreak, { maxMult: DEGRADE_MAX_MULT, maxMs: DEGRADE_MAX_WAIT_MS });
              const _degraded = waitMs > _preDegrade;
              if (delayMultiplier > 1 || _degraded) {
                const parts = [];
                if (!isFastMode && profileIds.length === 1) parts.push('single-account 2x');
                if (campaign._throttle?.active) parts.push(`throttled ${campaign._throttle.multiplier}x`);
                if (_degraded) parts.push(`degradation backoff (streak ${_dStreak})`);
                log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s (${parts.join(' + ')})`);
              } else {
                log(`  ⏳ ${(waitMs / 1000).toFixed(0)}s`);
              }
            }

            // v2.79: ~10% chance (was 30%) to browse the feed during the wait —
            // cheap realism cover, kept light so the connect phase moves faster.
            // Skip entirely in message mode AND check_status mode.
            if (!isFastMode && mode !== 'check_status' && Math.random() < 0.1 && !campaign._abort) {
              setAction('Organic browsing', { account: pName });
              await browseFeedOrganically(page, pName);
            }
            // Sleep in 2s chunks so abort is checked frequently
            setAction('Waiting before next lead', { account: pName, durationMs: waitMs });
            const sleepEnd = Date.now() + waitMs;
            while (Date.now() < sleepEnd && !campaign._abort) {
              await new Promise(r => setTimeout(r, 2000));
            }
            if (campaign._abort) log('  ■ Abort detected during delay.');
          }
        } catch (err) {
          log(`  ✗ ${err.message}`);
          pushError(err);
        }
        }  // end inner BATCH_SIZE for-loop

        log(plainLine('turn-end', {
          account: pName,
          sent: Math.max(0, getCampaignSendCount(profileId) - _turnSentAtStart),
          size: Number.isFinite(innerLimit) ? innerLimit : null,
        }));

        // ── End-of-turn close ──
        // 2.9.9: in the worker-pool model, profiles always close at end of
        // turn. Their next turn is at the back of the queue, so the wait is
        // longer than any "park and reuse" gap. Fast modes (check_status,
        // message_only) skip cooldown so they re-enter immediately.
        if (campaign._abort || leadsExhausted) {
          if (sessions.has(profileId)) await closeSession(profileId);
          return;
        }

        const stayOpen = (mode === 'check_status' || mode === 'message_only')
          && profileQueue.length === 0
          && profilesBeingRun.size <= 1;

        if (stayOpen) {
          if (rmCfg.IDLE_PARKING_ENABLED && !page.isClosed?.()) {
            await parkProfile(page, rmCfg.PARK_PAGE);
          }
          log(`  ⏸ ${pName}: parked (sole runner this round).`);
        } else {
          log(`  ⊗ ${pName}: turn complete — closing browser.`);
          await closeSession(profileId);
        }
    }  // end runProfileTurn

    // ── Worker dispatcher: spawn N concurrent workers ──
    // "Free for all Friday" — true once the cutoff has passed; stops the campaign
    // (once) at a lead boundary, never mid-lead.
    function weeklyCutoffReached() {
      if (campaign._abort) return false;
      if (campaign.monthlyCutoffAt) {
        const mCutoff = Date.parse(campaign.monthlyCutoffAt);
        if (Number.isFinite(mCutoff) && Date.now() >= mCutoff) {
          const mReset = new Date(nextMonthlyResetMs(mCutoff)).toLocaleString();
          log(`🛑 Free for all 25th — stopping before LinkedIn's monthly message allowance renews (${mReset}, the 1st at 00:00 UTC). Nothing more is sent, so next month's credits are untouched. Remaining leads stay queued.`);
          stopCampaign({ reason: 'monthly-reset-cutoff' });
          return true;
        }
      }
      if (!campaign.weeklyCutoffAt) return false;
      const cutoff = Date.parse(campaign.weeklyCutoffAt);
      if (!Number.isFinite(cutoff) || Date.now() < cutoff) return false;
      const reset = new Date(nextWeeklyResetMs(cutoff)).toLocaleString();
      log(`🛑 Free for all Friday — it is Sunday midday California time, so this campaign is stopping well before LinkedIn's weekly invitation limit resets (${reset}). Nothing more is sent, so next week's invitations are untouched. Remaining leads stay queued.`);
      stopCampaign({ reason: 'weekly-reset-cutoff' });
      return true;
    }

    async function worker(workerId) {
      // v2.14 idle-check cooldown cache — refresh every 2s to avoid disk thrash
      let _idleCooldownCache = null;
      let _idleCooldownCacheAt = 0;

      while (!campaign._abort && !leadsExhausted && !isOrphan()) {
        if (weeklyCutoffReached()) break;
        // Adaptive RAM throttle: drop browser cap to 1 when throttle engages,
        // restore on release (Q1=(a) "drain to 1").
        const t = campaign._throttle;
        if (t?.active) browserSemaphore.setMax(1);
        else browserSemaphore.setMax(MAX_CONCURRENT_PROFILES);

        // v2.14: connect_and_introduce idle bulk-check pass. Each pool iteration,
        // for every profileId that's parked between batches, check if its 5-min
        // cooldown has elapsed and a semaphore slot is free — if so, briefly
        // reopen the profile to fire a bulk-check + auto-intros/auto-DMs, then
        // close. All seven gates live in shouldFireIdleBulkCheck (pure, unit-
        // tested) which now also covers connect_and_message.
        if (mode === 'connect_and_introduce' || mode === 'connect_and_message') {
          const _idleSheetId = _extractSheetIdFromUrl(sheetUrl);
          // Refresh cooldown cache if stale (2s TTL)
          if (!_idleCooldownCache || Date.now() - _idleCooldownCacheAt > 2000) {
            _idleCooldownCache = await readBulkCheckCooldown();
            _idleCooldownCacheAt = Date.now();
          }
          const _idleCooldown = _idleCooldownCache;
          const _semStatus = browserSemaphore.getStatus();
          const _semAvailable = _semStatus.max - _semStatus.count - _semStatus.waiting;
          for (const _profileId of profileIds) {
            // v2.74: bail the instant the operator hits Stop, instead of
            // grinding through every remaining account's bulk-check first.
            if (campaign._abort) break;
            const _pName = profileNameCache[_profileId] || (_profileId === 'local-browser' ? 'You' : _profileId);
            const _lastBulkCheckAt = _idleCooldown[bulkCheckKey(_idleSheetId, _profileId)] || 0;
            const _fire = shouldFireIdleBulkCheck({
              mode,
              campaignStartTime,
              profileBrowserOpen: sessions.has(_profileId),
              profileWeeklyLimited: weeklyLimited.has(_profileId),
              semaphoreAvailable: _semAvailable,
              lastBulkCheckAt: _lastBulkCheckAt,
              intervalMs: campaign.checkIntervalMinutes * 60_000,
              now: Date.now(),
            });
            if (!_fire) continue;
            // Fire and await — keeps pool iteration order predictable.
            // The helper acquires its own semaphore slot internally.
            await runIdleBulkCheck(_profileId, _pName);
          }
        }

        const profileId = pickNextProfile();
        if (!profileId) {
          if (noProfilesLeftEver()) {
            const dailyCapped = profileQueue.some((id) => !weeklyLimited.has(id)
              && !skipsDailyLimit && getCampaignSendCount(id) >= campaign.dailyLimit);
            if (dailyCapped && !leadsExhausted && !campaign._abort) {
              const resume = new Date();
              resume.setDate(resume.getDate() + 1);
              resume.setHours(0, 2, 0, 0);
              campaign.dailyResetNeeded = true;
              campaign.resumeAt = resume.toISOString();
              campaign.state = 'waiting_daily_reset';
              log(`◷ Daily invitation limit reached · remaining leads stay queued · sending resumes ${resume.toLocaleString()}.`);
            }
            break;
          }
          // Eligible profiles exist but they're all in cooldown or mid-turn.
          // Idle briefly and retry.
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        try {
          await runProfileTurn(profileId);
        } catch (err) {
          log(`✗ Worker ${workerId} crashed running ${profileId}: ${err.message}`);
          pushError(err);
        } finally {
          profilesBeingRun.delete(profileId);
          // Cooldown timestamp is set even on error, so a flapping profile
          // doesn't get re-picked instantly by another worker.
          profileCooldownUntil.set(profileId, Date.now() + cooldownMs);
          // Re-enqueue at the back unless the profile got ejected mid-turn.
          if (!weeklyLimited.has(profileId) && !campaign._abort && !leadsExhausted) {
            profileQueue.push(profileId);
          }
        }
      }
    }

    // ── Pre-flight primary handshake (Phase 0 → 0.5) ─────────────────────
    // Runs ONCE before the rotation, for CC+IC + auto-accept campaigns only.
    // Phase 0: each not-yet-connected account opens (sequentially) and sends a
    //   bare connect to the primary, capturing its own identity → an accept task.
    // Phase 0.5: the primary's browser opens ALONE and accepts those invitations
    //   with a bounded ~2-min poll.
    // Best-effort — NEVER blocks the campaign: any error or straggler falls back
    // to the existing idle-runner queue via enqueuePrimaryTask().
    async function runPreflightHandshake() {
      // Ortus Basics 1.0: automatic acceptance at campaign start is removed —
      // no sender→primary connects, no primary-inbox accept sweep. The primary
      // is now just "who the lead gets introduced to"; if a sender is not
      // 1st-degree with them, the intro is skipped and the lead is still
      // connected. Kept as a no-op so its call sites stay untouched.
      return;
      /* eslint-disable no-unreachable */
      const primaryUrl = (tpl && tpl.primaryUrl || '').trim();
      if (mode !== 'connect_and_introduce' || !tpl?.autoAcceptPrimary || !primaryUrl) return;
      // NOTE: campaign.participatingProfileIds is empty here (only filled at
      // end-of-run), so plan over the run's profileIds directly.
      const participating = profileIds || [];
      const need = planAccountsNeedingConnect(participating, campaign._primaryConn);
      // With accept-all on we still open the primary to sweep the inbox even when
      // every sender is already connected (need is empty) — otherwise accept-all
      // would silently never run on repeat runs of already-connected senders.
      const wantAcceptAll = !!(tpl && tpl.autoAcceptAllPending);
      if (need.length === 0 && !wantAcceptAll) return; // self-eliminating
      campaign.phase = 'preflight';
      if (need.length) log(`🤝 Preparing introductions — ${need.length} account(s) need to connect to the primary`);
      else log('🤝 Pre-flight: senders already connected — running the accept-all sweep on the primary');
      setAction('Preparing introductions', {
        phase: 'starting', step: 'primary_preflight',
        stepDetail: need.length
          ? `${need.length} account${need.length === 1 ? '' : 's'} must connect to the primary before outreach starts`
          : 'Sender connections are ready · checking the primary inbox',
      });
      const sender = tpl.primarySource || 'local-browser';
      const queuedAccepts = [];
      for (const profileId of need) {
        if (campaign._abort) break;
        // ensureOpen() returns { profileId, pName, browser, page, warmedUp } or
        // null. It launches fresh on a cache miss and holds a semaphore slot;
        // closeSession() (below) deletes it from `sessions` AND releases that
        // slot, so the later rotation re-opens this account cleanly in its turn.
        const session = await ensureOpen(profileId);
        if (!session) { campaign._primaryConn.set(profileId, 'unverified'); continue; }
        const pName = session.pName;
        try {
          const _res = await checkAndConnectPrimary(session.page, primaryUrl, { log, pName, attemptConnect: true });
          {
            const _live = primaryConnState(_res.connected);
            const _entry = campaign._primaryKey
              ? getEntry(campaign._primaryStore, profileId, campaign._primaryKey) : null;
            const _disp = resolveDisplayState(_entry, _live);
            campaign._primaryConn.set(profileId, _disp.state);
            campaign._primaryConnSource.set(profileId, _disp.source);
            if (campaign._primaryKey && _live !== 'unverified') {
              const _now = new Date().toISOString();
              campaign._primaryStore = campaign._primaryStore || {};
              campaign._primaryStore[storeKey(profileId, campaign._primaryKey)] =
                mergeLiveRead(_entry, _live, _now, primaryUrl || '');
              await savePrimaryStatus(PRIMARY_STATUS_FILE, campaign._primaryStore);
            }
          }
          // autoAcceptPrimary is implicitly true here (runPreflightHandshake
          // early-returns otherwise). Queue an accept when the account left an
          // OUTSTANDING invite to the primary — freshly sent this run ('sent')
          // OR already pending from a prior run that was never accepted
          // ('already_pending'). The latter is the 2026-06-16 gap: a stale
          // pending invite was detected, NOT re-sent (good), but also never
          // accepted, so the account stayed non-1st-degree and its intros held.
          if (_shouldQueueAutoAccept({ autoAcceptPrimary: true, connectAttempted: _res.connectAttempted, connectResult: _res.connectResult })) {
            const _self = await readSelfIdentity(session.page, { log });
            if (_self.name || _self.profileUrl) {
              // 'sent' is a TRANSIENT pre-flight-only state (request out, not yet
              // accepted) — used for both freshly-sent and already-pending invites.
              // It is deliberately NOT in the _primaryIntroAllowed hold-set — no
              // intros fire during pre-flight, and the account's first rotation turn
              // re-reads the degree and reclassifies it via primaryConnState()
              // (→ 'pending'/'connected') BEFORE any intro gate.
              campaign._primaryConn.set(profileId, 'sent');
              queuedAccepts.push(buildAcceptTask({
                campaignProfileId: profileId, campaignProfileName: pName,
                sheetId: _extractSheetIdFromUrl(sheetUrl) || '', sheetUrl,
                account: _self, primaryUrl, sender,
              }));
            } else {
              // Don't silently drop it (the 2026-06-16 bug): the invite IS
              // outstanding, but with no identity the primary can't match it,
              // so this account won't be auto-accepted — surface it.
              log(`  ⚠ [${pName}] Couldn't read this account's identity — not queuing its auto-accept (invite is outstanding; accept manually if needed).`);
            }
          }
        } catch (e) {
          log(`  ⚠ [${pName}] Pre-flight connect error: ${e.message}`);
        } finally {
          // Real single-account close: closeSession() closes the browser,
          // removes it from `sessions`, and releases the semaphore slot.
          try { await closeSession(profileId); } catch { /* */ }
        }
      }
      // Open the primary's session when there are matched senders to accept OR
      // the operator turned on accept-all (which sweeps the rest of the inbox).
      if (queuedAccepts.length || tpl.autoAcceptAllPending) {
        const CAP_MS = 120_000, POLL_MS = 30_000;
        const startedAt = Date.now();
        try {
          try {
            await browserSemaphore.acquire({ signal: campaign._abortController?.signal });
          } catch (err) {
            if (campaign._abort || err?.name === 'AbortError') return;
            throw err;
          }
          const launched = (sender === 'local-browser')
            ? await launchLocalBrowser()
            : await launchProfile(sender, token);
          const page = launched.page;
          let pending = [...queuedAccepts];
          while (pending.length && !campaign._abort) {
            const still = [];
            for (const t of pending) {
              campaign._primaryConn.set(t.campaignProfileId, 'accepting');
              const r = await acceptInvitationFrom(page, t.account, { log })
                .catch((e) => { log(`  ⚠ [${t.campaignProfileName}] primary accept errored: ${e.message}`); return { accepted: false }; });
              if (r.accepted) { campaign._primaryConn.set(t.campaignProfileId, 'connected'); log(`  ✓ primary accepted ${t.campaignProfileName}`); }
              else { campaign._primaryConn.set(t.campaignProfileId, 'sent'); still.push(t); }
            }
            pending = still;
            const { accepted, total } = handshakeProgress(campaign._primaryConn, queuedAccepts.map(t => t.campaignProfileId));
            if (shouldProceed({ startedAt, now: Date.now(), capMs: CAP_MS, accepted, total })) break;
            if (pending.length) await new Promise(r => setTimeout(r, POLL_MS));
          }
          for (const t of pending) { try { await enqueuePrimaryTask(t); } catch { /* */ } }
          if (pending.length) log(`  ⏳ ${pending.length} link(s) finishing in the background — outreach starting anyway`);
          // Accept-all sweep (opt-in, default OFF): after the matched senders are
          // handled, accept every OTHER pending invite in the primary's inbox —
          // strangers included. Bounded internally so a huge inbox can't stall
          // pre-flight. Best-effort: a sweep error never blocks outreach.
          if (tpl.autoAcceptAllPending && !campaign._abort) {
            log('🧹 Accept-all: clearing remaining pending invitations on the primary…');
            try { await acceptAllPendingInvitations(page, { log }); }
            catch (e) { log(`  ⚠ Accept-all sweep error: ${e.message}`); }
          }
        } catch (e) {
          log(`  ⚠ Pre-flight: primary accept session failed (${e.message}) — queuing for the idle runner`);
          for (const t of queuedAccepts) { try { await enqueuePrimaryTask(t); } catch { /* */ } }
        } finally {
          try { (sender === 'local-browser') ? await closeLocalBrowser() : await closeProfile(sender); } catch { /* */ }
          browserSemaphore.release();
        }
      }
      log('✅ Primary connections ready — starting outreach');
      setAction('Primary connections ready', {
        phase: 'starting', step: 'primary_ready',
        stepDetail: 'Pre-flight complete · selecting the first sender and lead',
      });
    }

    // #8: seed connection-to-primary from the persistent store so confirmed-
    // connected accounts skip re-verification this run (and survive restarts).
    {
      const _pUrl = (tpl && tpl.primaryUrl || '').trim();
      campaign._primaryKey = primaryKeyFromUrl(_pUrl);
      campaign._primaryStore = await loadPrimaryStatus(PRIMARY_STATUS_FILE);
      if (campaign._primaryKey) {
        const ids = seedConnectedIds(campaign._primaryStore, campaign._primaryKey);
        const run = new Set(profileIds || []);
        for (const pid of ids) {
          if (run.has(pid)) {
            campaign._primaryConn.set(pid, 'connected');
            campaign._primaryConnSource.set(pid, 'remembered');
          }
        }
        if (ids.length) log(`🧠 Remembered ${ids.filter((i) => run.has(i)).length} account(s) already connected to the primary — skipping their re-check.`);
      }
    }

    if (!_deferPrimary) { try { await runPreflightHandshake(); } finally { campaign.phase = null; } }

    const workerCount = Math.max(1, Number(concurrency) || 1);
    await Promise.all(
      Array.from({ length: workerCount }, (_, i) => worker(i))
    );

    // #7: deferred primary step — all accounts have finished sending their
    // connections for the day; now run the same handshake (connect + accept)
    // before entering monitoring, restoring the pre-2102 "after connections" order.
    if (_deferPrimary && !campaign._abort) {
      campaign.phase = 'primary';
      try { await runPreflightHandshake(); } finally { campaign.phase = null; }
    }

    // Log per-profile stats (from the sessions Map — covers both still-open
    // and already-closed profiles via campaignCounts).
    for (const profileId of profileIds) {
      // 2.9.2: never let the raw profileId 'local-browser' leak to the sheet
      // (it bypasses profileNameCache when that's stale). Force 'You'.
      const pName = profileNameCache[profileId] || (profileId === 'local-browser' ? 'You' : profileId);
      log(`■ ${pName}: ${getCampaignCount(profileId)} processed.`);
    }

    // STEP 3: Close all remaining browsers (with 2-minute timeout).
    // Profiles that were closed between batches are already out of `sessions`.
    log('Closing all browsers...');
    const closeTimeout = setTimeout(() => {
      log('⚠ Browser close timed out after 2 minutes. Force-ending campaign.');
    }, 120000);

    for (const profileId of [...sessions.keys()]) {
      await closeSession(profileId);
    }

    clearTimeout(closeTimeout);

    // Transition to monitoring for CC+IC runs that sent ≥1 connect. The
    // end-of-list bulk-check that used to live here was removed: the
    // immediate close-then-reopen pattern on the same profile is a clear
    // bot signature, and in-campaign idle bulk-checks already catch
    // mid-run acceptances while the 6h post-campaign scheduler catches
    // the rest.
    if (!campaign._skipCleanup && (mode === 'connect_and_introduce' || mode === 'connect_and_message') && profilesThatSentAtLeastOne.size > 0) {
      // Ortus Basics 1.0: the campaign does NOT enter monitoring — it simply
      // ends. Nothing watches, nothing is scheduled, no 7-day window is armed.
      // The accounts that sent are still recorded, because that is what
      // ⚡ Check now sweeps when the operator asks for a check.
      // (was: Object.assign(campaign, transitionToMonitoring(campaign, …)))
      campaign.participatingProfileIds = Array.from(profilesThatSentAtLeastOne);
      campaign.monitoringUntil = null;
      campaign.nextCheckAt = null;
      _ops('INFO', 'Campaign finished', {
        details: `${profilesThatSentAtLeastOne.size} account(s) sent · checks are manual (⚡ Check now)`,
      });

      try {
        const _sheetId = _extractSheetIdFromUrl(sheetUrl);
        const _appender = buildAppendLogger({ logs: campaign.logs, capLines: 5000 });
        for (const _pid of profilesThatSentAtLeastOne) {
          registerAppender(_sheetId, _pid, _appender);
        }
      } catch (busErr) {
        console.warn('[monitoring] Log bus registration failed:', busErr.message);
      }

      try {
        await writeMonitoringState(campaign);
      } catch (persistErr) {
        console.warn('[monitoring] persistence write failed:', persistErr.message);
      }
      // v2.14.x: arm the 15s pre-fire heads-up for the first auto-check.
      _preFireNotifiedFor = null;
      schedulePreFireHeadsUp();
    }
  } catch (err) {
    log(`Fatal: ${err.message}`);
    pushError(err);
    endReason = 'errored';
  } finally {
    // v2.11.7: if neither catch nor a fatal error fired, but operator hit
    // Stop, mark accordingly. campaign._abort is set by stopCampaign().
    if (endReason !== 'errored' && campaign._abort) endReason = 'stopped';

    // Sheet writes are coalesced, so the last few can still be sitting in the
    // buffer when the loop ends. Land them before anything reports the run
    // finished — otherwise the final leads of every campaign go unwritten.
    // Writes are fired without waiting during the run, so drain them here before
    // the campaign reports itself finished — otherwise the last few leads' rows
    // would still be in flight when the summary is written.
    if (_pendingSheetWrites.size) {
      log(`  ⏳ Finishing ${_pendingSheetWrites.size} sheet write(s)…`);
      await drainSheetWrites();
    }
    await flushSheetWrites().catch((e) => log(`  ⚠ Final sheet flush failed: ${e.message}`));

    // v2.72: build a one-shot "why did it stop" notice the dashboard turns into
    // a popup. Covers every end reason — errored, operator-stopped, all accounts
    // parked (self-stop), or simply no more rows to process. The frontend
    // decides which to surface (it skips the operator-Stop case as redundant).
    {
      const _profileCount = (campaign.profileIds || []).length || 0;
      const _parked = campaign.parkedProfiles || [];
      const _parkedCount = _parked.length;
      let _reason, _detail = '';
      if (endReason === 'errored') {
        _reason = 'error';
        const _lastErr = (campaign.errors || [])[campaign.errors.length - 1];
        _detail = (_lastErr && _lastErr.message) ? String(_lastErr.message) : 'An unexpected error stopped the campaign.';
      } else if (endReason === 'stopped') {
        _reason = 'operator_stopped';
        _detail = 'You stopped the campaign.';
      } else if (_parkedCount > 0 && _parkedCount >= _profileCount) {
        // Every account was parked (weekly limit, logged out, out of credits) —
        // the campaign couldn't continue even if rows remain.
        _reason = 'all_parked';
        _detail = _parked
          .map((p) => `${p.pName || p.profileId || 'Account'}: ${prettyParkReason(p.reason)}`)
          .slice(0, 6).join(' · ');
      } else {
        _reason = 'no_more_rows';
      }
      campaign._endNotice = {
        reason: _reason,
        detail: _detail,
        endReason,
        mode,
        name: campaign.name || '',
        sheetUrl: sheetUrl || '',
        processed: campaign.totalProcessed || 0,
        targets: campaign.totalTargets || 0,
        parkedCount: _parkedCount,
        ts: Date.now(),
      };
    }

    // Save campaign history (D-10)
    try {
      await appendHistory({
        campaignId: campaign.campaignId,
        logIdentityVersion: 1,
        runId: campaign.executionId,
        executionId: campaign.executionId,
        date: new Date().toISOString(),
        name: campaign.name || '',
        mode: campaign.mode,
        profiles: campaign.profileNames,
        dailyLimit: dailyLimit,
        totalProcessed: campaign.totalProcessed,
        successCount: campaign.processedToday,
        errorCount: campaign.errors.length,
        duration: Math.round((Date.now() - campaignStartTime) / 1000),
        templateNames: Object.entries(tpl).filter(([_, v]) => v && (typeof v === 'string' ? v : v.subject)).map(([k]) => k),
        // v2.11.7: badge state in the dashboard's Past list.
        endReason,
        // v2.14.x: true when operator chose "Stop everything" in the CC+IC
        // stop-choice modal. The past-list hides the Resume button on these
        // entries — "Stop everything" semantically means the operator is
        // done with this campaign, not pausing it.
        fullStop: !!campaign._skipCleanup,
        // Campaign debrief: persist a compact end-of-run snapshot (skip ledger
        // + parked accounts + error samples + why-it-stopped notice) so the
        // Debrief panel survives app restarts — the skip ledger itself is
        // in-memory and cleared on the next run. Skips capped at 100.
        debrief: buildDebrief({
          skips: getSkips(),
          parked: campaign.parkedProfiles || [],
          errors: campaign.errors || [],
          endNotice: campaign._endNotice || null,
          // Per-account Sent + end reason — no invented accept/reply data.
          perAccount: (() => {
            const ids = new Set([
              ...Object.keys(campaignCounts),
              ...(campaign.profileEndReasons || []).map((e) => e.profileId),
            ]);
            return [...ids].filter(Boolean).map((pid) => ({
              profileId: pid,
              name: profileNameCache[pid] || (pid === 'local-browser' ? 'You' : pid),
              sent: getCampaignSendCount(pid) + getCampaignMessageCount(pid),
              endReason: (campaign.profileEndReasons || []).find((e) => e.profileId === pid)?.reason || '',
            }));
          })(),
        }),
        // v2.11.7: settings snapshot for the "Re-run with same settings" CTA.
        // Operator already trusts this machine with the templates (they're
        // typed into the wizard), and the file is in the user-only data
        // dir. Future privacy hardening can hash/encrypt these later.
        settings: {
          campaignId: campaign.campaignId,
          profileIds: Array.isArray(profileIds) ? [...profileIds] : [],
          sheetUrl: sheetUrl || '',
          // Lead-source guard: persist the chosen tab so Re-run reads the
          // SAME tab the operator launched with (not Google's first-tab default).
          sheetGid: campaign.sheetGid || '',
          templates: {
            connectionNote: tpl.connectionNote || '',
            followUpMessage: tpl.followUpMessage || '',
            inmailSubject: tpl.inmail?.subject || '',
            inmailBody: tpl.inmail?.message || '',
            openProfileSubject: tpl.openProfileSubject || '',
            openProfileBody: tpl.openProfileBody || '',
            introMode: !!tpl.introMode,
            introName: tpl.introName || '',
            introTitle: tpl.introTitle || '',
            // CC+IC primary-person fields. Persisted here so Re-run can
            // restore them on the wizard — without these the "Intro DM
            // body" + "Primary person — Full name" inputs come back blank.
            primaryName:      (templates && templates.primaryName)      || '',
            primaryIntroBody: (templates && templates.primaryIntroBody) || '',
            primaryUrl:       (templates && templates.primaryUrl)       || '',
            ccDmBody:         (templates && templates.ccDmBody)         || '',
          },
          dailyLimit,
          messageOpenProfiles: !!messageOpenProfiles,
          delayMin,
          delayMax,
          linkedinColumn: linkedinColumn || '',
          concurrency: concurrency || 1,
          // v2.52.0: persist the operator-chosen monitoring cadence so resume
          // flows can carry it forward. Pre-2.52 history entries don't have
          // this field — resume falls back to the server's 60-min default.
          checkIntervalMinutes: campaign.checkIntervalMinutes || undefined,
        },
      });
    } catch (histErr) {
      console.error('Failed to save campaign history:', histErr.message);
    }

    // Central Operations Log + Campaign Activity Log mirrors. Both are
    // fire-and-forget — failures never block the campaign-end cleanup.
    const _durationSec = Math.round((Date.now() - campaignStartTime) / 1000);
    _ops('INFO', `Campaign ended (${endReason})`, {
      details: `${campaign.totalProcessed} processed · ${campaign.errors.length} errors · ${_durationSec}s`,
    });
    // v2.96.2 — drain the Ops Log buffer at end-of-run so a short campaign's
    // events (incl. reckless_daily_limit fired at startup) aren't left waiting
    // on the 30s timer if the app is quit immediately after.
    try { await flushOpsLog(); } catch { /* fire-and-forget */ }
    try {
      // Mode-aware template preview. Only dump fields the running mode
      // actually uses — wizard form state may carry leftover values
      // (e.g. OP body from a previous preset) that the campaign never
      // sent, and logging those would mislead anyone reading the
      // Campaign Activity sheet.
      const _templateBlocks = [];
      const _wantsConnect  = (mode === 'connect_only' || mode === 'connect_and_introduce' || mode === 'connect_and_message');
      const _wantsMessage  = (mode === 'message_only' || mode === 'introduce_back');
      const _wantsInmail   = (mode === 'inmail_only');
      const _wantsOp       = (mode === 'open_profile_only')
                          || (mode === 'connect_only' && !!messageOpenProfiles);
      const _wantsAutoIntro = (mode === 'connect_and_introduce');
      const _wantsAutoDm    = (mode === 'connect_and_message');
      if (_wantsConnect && tpl.connectionNote)
        _templateBlocks.push(`Connection note: "${tpl.connectionNote}"`);
      if (_wantsMessage && tpl.followUpMessage)
        _templateBlocks.push(`Follow-up: "${tpl.followUpMessage}"`);
      if (_wantsInmail && tpl.inmail?.subject)
        _templateBlocks.push(`InMail subject: "${tpl.inmail.subject}"`);
      if (_wantsInmail && tpl.inmail?.message)
        _templateBlocks.push(`InMail body: "${tpl.inmail.message}"`);
      if (_wantsOp && tpl.openProfileSubject)
        _templateBlocks.push(`OP subject: "${tpl.openProfileSubject}"`);
      if (_wantsOp && tpl.openProfileBody)
        _templateBlocks.push(`OP body: "${tpl.openProfileBody}"`);
      // IC mode (introduce_back) → group-DM intro
      if (_wantsMessage && tpl.introMode && tpl.introName)
        _templateBlocks.push(`Intro recipient (IC): ${tpl.introName}`);
      // CC+IC → post-acceptance auto-intro to a primary person
      if (_wantsAutoIntro) {
        const _pName = (templates && templates.primaryName ? templates.primaryName : '').trim();
        const _pBody = (templates && templates.primaryIntroBody ? templates.primaryIntroBody : '').trim();
        if (_pName) _templateBlocks.push(`Primary person: ${_pName}`);
        if (_pBody) _templateBlocks.push(`Intro DM body: "${_pBody}"`);
      }
      // CC+DM → post-acceptance plain 1:1 DM. No primary person.
      if (_wantsAutoDm) {
        const _ccDmBody = (templates && templates.ccDmBody ? templates.ccDmBody : '').trim();
        if (_ccDmBody) _templateBlocks.push(`CC+DM body: "${_ccDmBody}"`);
      }
      campaignLogAppendRun({
        ts: new Date().toISOString(),
        operator: campaign.createdBy || '',
        name: campaign.name || '',
        mode: campaign.mode || '',
        profiles: campaign.profileNames || [],
        totalLeads: campaign.totalTargets || 0,
        processed: campaign.totalProcessed || 0,
        errors: campaign.errors.length || 0,
        // v2.93 — funnel + leak counters for Campaign Activity v2.
        sent: campaign.tally?.sent || 0,
        accepted: campaign.tally?.accepted || 0,
        intro: campaign.tally?.intro || 0,
        dm: campaign.tally?.dm || 0,
        replied: campaign.tally?.replied || 0,
        rateLimited: campaign.tally?.rateLimited || 0,
        parked: campaign.tally?.parked || 0,
        skipped: campaign.tally?.skipped || 0,
        durationSec: _durationSec,
        endReason,
        templatePreview: _templateBlocks.join('\n\n'),
        sheetUrl: sheetUrl || '',
      }).catch(() => {}); // fire-and-forget — network errors are non-fatal
    } catch (logErr) {
      console.warn('[log-writer] campaign-end mirror threw:', logErr.message);
    }
    _pushDashboard(true, endReason); // flip the campaign to ⚪ Done on the board

    // Register a post-campaign acceptance-tracking window for every profile
    // that actually sent at least one connect. Skipped when
    // acceptanceTrackingDays is 0 or for non-connect modes where the
    // bulk-check doesn't make sense.
    // v2.14.x: also skipped when operator chose "Stop everything" in the
    // CC+IC stop-choice modal (_skipCleanup) — the operator has explicitly
    // opted out of post-campaign monitoring.
    try {
      const trackingApplies = (mode === 'connect_only' || mode === 'connect_and_introduce' || mode === 'connect_and_message');
      if (!campaign._skipCleanup && trackingApplies && acceptanceTrackingDays > 0) {
        const _sheetId = _extractSheetIdFromUrl(sheetUrl);
        // v2.14 verified: per-profile registration ensures every participating
        // account's post-campaign 6h × 7d sweep fires independently, including
        // auto-intros for connect_and_introduce campaigns.
        for (let i = 0; i < (campaign.profileIds || []).length; i++) {
          const pid = campaign.profileIds[i];
          if (getCampaignSendCount(pid) === 0) continue;
          const pName = (campaign.profileNames || [])[i] || pid;
          await registerPostCampaignSweep({
            sheetId: _sheetId,
            sheetUrl,
            profileId: pid,
            profileName: pName,
            linkedinColumn,
            days: acceptanceTrackingDays,
            operatorEmail: campaign.createdBy,
            // Persist Connect + Introduce Back primary fields so each
            // post-campaign sweep can fire the auto-intro DM.
            mode,
            primaryName: (templates && templates.primaryName) || '',
            primaryIntroBody: (templates && templates.primaryIntroBody) || '',
            primaryUrl: (templates && templates.primaryUrl) || '',
            introTitle: (templates && templates.introTitle) || '',
            // v2.59.x: persist the CC+DM body so the post-campaign sweep can
            // fire the 1:1 auto-DM (shouldFirePostCampaignDm + runAutoDms).
            ccDmBody: (templates && templates.ccDmBody) || '',
            // v2.91: primary-side automation — carry auto-accept + follow-up
            // config so the post-campaign sweep can drive them post-acceptance.
            autoAcceptPrimary: !!(templates && templates.autoAcceptPrimary),
            followUpEnabled: !!(templates && templates.followUpEnabled),
            followUpBody: (templates && templates.followUpBody) || '',
            followUpDelayMinutes: (templates && templates.followUpDelayMinutes) || 10,
            primarySource: (templates && templates.primarySource) || 'local-browser',
            // The nice name this account sent under during the campaign, so an
            // intro fired days later by the background sweep signs off the same
            // way. Read off the campaign (not the closure) because that copy is
            // the one startCampaign froze at launch.
            senderFirstName: (campaign.senderFirstNames || {})[pid] || '',
            // v2.148 cleanup: sweep at the operator-configured cadence instead
            // of the hardcoded 6h. Entries without this field (old builds /
            // unset cadence) keep the scheduler's 6h SWEEP_COOLDOWN_MS fallback.
            sweepIntervalMs: Number(campaign.checkIntervalMinutes) > 0
              ? resolveBulkCheckIntervalMs(campaign.checkIntervalMinutes)
              : null,
          });
        }
      }
    } catch (regErr) {
      console.error('Failed to register post-campaign tracking:', regErr.message);
    }

    // v2.72: Register an hourly reply-tracking window for every profile that
    // sent at least one message. Applies to the message-sending modes (the
    // unified Message Campaign + Introduction + the Connect+message variants).
    // Independent of acceptanceTrackingDays — defaults to a 7-day window so
    // replies are still caught even when the operator didn't set a tracking
    // window. Skipped on the explicit "Stop everything" opt-out.
    try {
      // 2026-06-08: reply-tracking disabled for the Message Campaign
      // (open_profile_only) ONLY, at operator request — its post-campaign reply
      // sweep was reopening profile browsers unprompted. Every OTHER mode keeps
      // its original v2.72 reply-tracking untouched: Direct Messages
      // (message_only), Introduction (introduce_back), CC+IC and CC+DM. To
      // restore the Message Campaign's reply sweep, add 'open_profile_only' back.
      const _REPLY_MODES = new Set(['introduce_back', 'message_only', 'connect_and_introduce', 'connect_and_message']);
      if (!campaign._skipCleanup && _REPLY_MODES.has(mode)) {
        const _sheetId = _extractSheetIdFromUrl(sheetUrl);
        const _replyDays = acceptanceTrackingDays > 0 ? acceptanceTrackingDays : 7;
        // Scan back to the campaign's first send-out minus a 12h safety buffer.
        const _startMs = campaign.startedAt ? Date.parse(campaign.startedAt) : Date.now();
        const _scanSinceMs = (Number.isFinite(_startMs) ? _startMs : Date.now()) - 12 * 60 * 60 * 1000;
        for (let i = 0; i < (campaign.profileIds || []).length; i++) {
          const pid = campaign.profileIds[i];
          const participated = (mode === 'connect_and_introduce' || mode === 'connect_and_message')
            ? getCampaignSendCount(pid) > 0
            : getCampaignMessageCount(pid) > 0;
          if (!participated) continue;
          const pName = (campaign.profileNames || [])[i] || pid;
          await registerReplyTracking({
            sheetId: _sheetId,
            sheetUrl,
            profileId: pid,
            profileName: pName,
            linkedinColumn,
            days: _replyDays,
            operatorEmail: campaign.createdBy,
            scanSinceMs: _scanSinceMs,
          });
        }
      }
    } catch (regErr) {
      console.error('Failed to register reply tracking:', regErr.message);
    }

    campaign.running = false;
    campaign.currentProfile = null;
    campaign._unparkProfile = null;
    campaign._requeueProfile = null;
    campaign._addProfile = null;
    campaign._reloadTargets = null;
    campaign._urlOf = null;
    campaign._isTarget = null;
    campaign._currentTargets = null;
    campaign._refetchRows = null;
    campaign._pauseSnapshot = null;
    // v2.14.x: reset abort flag at campaign-end. Without this, _abort stays
    // true after any operator-initiated Stop and bleeds into subsequent
    // manual /api/bulk-check-now, post-campaign sweeps, and monitoring
    // ticks — auto-intro.js's `if (campaign._abort)` guard then fires
    // immediately and stamps every newly-Connected lead as
    // 'Skipped — Stop pressed' (repro 2026-05-17T20:19:11: manual bulk
    // check called runAutoIntros, log shows 'Auto-introducing 3' then
    // 'Stop detected — marking remaining 3' in the SAME millisecond).
    campaign._abort = false;
    log('=== Campaign ended ===');
    campaign.currentAction = null; // clear cockpit
    const journal = readRuntimeInterruption();
    if (!journal || journal.reason === 'active-run') clearRuntimeInterruption();
  }
}

// Rename the in-flight campaign. Called from POST /api/campaign/name. Empty
// strings are allowed — operator can clear a name.
export function setCampaignName(name) {
  campaign.name = (typeof name === 'string' ? name : '').trim();
  return campaign.name;
}

// Operator-initiated retry of a parked profile. Removes it from the in-run
// "do not pick" sets so the next campaign rotation tries it again. Returns
// the profile name (or null if not found / not currently running).
//
// Caller (server.js endpoint) is responsible for actually opening the
// GoLogin browser so the operator can re-authenticate before the next
// rotation hits.
export function retryParkedProfile(profileId) {
  if (!campaign.running) return { ok: false, reason: 'no-campaign-running' };
  // Find profile name from the parked entry (preferred) or current name list.
  const parkedEntry = campaign.parkedProfiles.find((p) => p.profileId === profileId);
  const pName = parkedEntry?.pName || (campaign.profileNames || []).find(
    (n) => n === profileId
  ) || profileId;
  // Remove all gating that would skip this profile next rotation.
  campaign.parkedProfiles = campaign.parkedProfiles.filter((p) => p.profileId !== profileId);
  campaign.profileEndReasons = campaign.profileEndReasons.filter((p) => p.profileId !== profileId);
  // The internal weeklyLimited / consecutive429s / consecutiveSkips are
  // local to the running campaign closure (see startCampaign body) — exposed
  // here via a side-channel so retry can reset them mid-run.
  if (typeof campaign._unparkProfile === 'function') {
    campaign._unparkProfile(profileId);
  }
  if (typeof campaign._requeueProfile === 'function') campaign._requeueProfile(profileId);
  log(`▶ Retry requested for ${pName} — will attempt again on next rotation.`);
  return { ok: true, profileName: pName };
}

/**
 * v2.78: bench / un-bench an account in the sending rotation for the rest of
 * THIS run. skip=true removes it from rotation; skip=false re-includes it AND
 * clears any auto-park (weekly cap / "no invites left" / consecutive skips) via
 * retryParkedProfile, so the same toggle re-enables a parked account too. Reset
 * each startCampaign, so a new campaign starts with every account active.
 */
export function setProfileSkip(profileId, skip) {
  if (!profileId) return { ok: false, reason: 'no-profile' };
  if (!campaign._skippedProfiles) campaign._skippedProfiles = new Set();
  const idx = (campaign.profileIds || []).indexOf(profileId);
  const pName = idx >= 0 ? (campaign.profileNames || [])[idx] : profileId;
  if (skip) {
    campaign._skippedProfiles.add(profileId);
    log(`⏭ ${pName} benched — skipped for the rest of this campaign.`);
  } else {
    campaign._skippedProfiles.delete(profileId);
    // If it was auto-parked (weekly cap / no invites / skips), clear that too
    // so the same toggle forces it back into rotation.
    if (campaign.running) retryParkedProfile(profileId);
    else { if (typeof campaign._requeueProfile === 'function') campaign._requeueProfile(profileId); log(`▶ ${pName} re-enabled — back in the rotation.`); }
  }
  _persistRunSettings();
  return { ok: true, skipped: [...campaign._skippedProfiles] };
}

/**
 * Take an account OUT of this campaign for good: it stops sending (after the
 * lead it is on), disappears from the account list, and is dropped from the
 * campaign's saved settings so a restart does not bring it back. Its unsent
 * leads go to the other accounts. Never the last sending account.
 */
export function removeProfileFromCampaign(profileId) {
  if (!profileId) return { ok: false, reason: 'no-profile' };
  const ids = campaign.profileIds || [];
  const idx = ids.indexOf(profileId);
  if (idx < 0) return { ok: false, reason: 'This account is not in the campaign.' };
  const removed = campaign._removedProfiles || (campaign._removedProfiles = new Set());
  const stillIn = ids.filter((id) => id !== profileId && !removed.has(id) && !campaign._skippedProfiles?.has(id));
  if (!stillIn.length) return { ok: false, reason: 'This is the last sending account — a campaign needs at least one. Stop the campaign instead.' };
  const pName = (campaign.profileNames || [])[idx] || profileId;
  if (!campaign._skippedProfiles) campaign._skippedProfiles = new Set();
  campaign._skippedProfiles.add(profileId);
  removed.add(profileId);
  log(`🗑 ${pName} removed from this campaign — its remaining leads go to the other accounts.`);
  _persistRunSettings();
  try {
    const saved = campaign.campaignId ? getConfigById(campaign.campaignId) : null;
    if (saved && Array.isArray(saved.config?.profileIds)) {
      saveConfig(saved.name, { ...saved.config, profileIds: saved.config.profileIds.filter((id) => id !== profileId) }, { campaignId: saved.campaignId });
    }
  } catch (err) { log(`  ⚠ Could not update the saved settings: ${err.message}`); }
  return { ok: true, profileName: pName };
}

// v2.112: keep the restore snapshot current so a mid-run bench / added account survives an
// app restart. Best-effort, atomic (same path as start). No-op if no snapshot yet.
function _persistRunSettings() {
  if (!_lastRunSettings) return;
  _lastRunSettings.profileIds = (campaign.profileIds || []).filter((id) => !campaign._removedProfiles?.has(id));
  _lastRunSettings.benchedProfileIds = [...(campaign._skippedProfiles || [])];
  try { writeLastRun(LAST_RUN_FILE, _lastRunSettings); } catch { /* non-fatal */ }
}

// `quitting` says the app is closing rather than an operator pressing Stop. It
// deliberately does NOT ride on `reason`: campaign.stopReason is read by the
// dashboard (app.js compares it to 'operator-stopped' to decide "deliberately
// stopped" and "waiting here"), so changing it to say 'shutdown' would move UI
// state to fix a log line.
export function stopCampaign({ full = false, reason = 'operator-stopped', quitting = false } = {}) {
  campaign._abort = true;
  if (campaign._abortController && !campaign._abortController.signal.aborted) {
    campaign._abortController.abort(new DOMException('Campaign stopped', 'AbortError'));
  }
  // Distinguish operator-initiated stop from natural completion so the
  // dashboard can surface a "Stopped" badge + Restart button on the history
  // entry that gets written when the loop unwinds.
  campaign._stoppedManually = true;
  campaign.stopReason = reason;
  // v2.14.x: when `full` is true (operator picked "Stop everything" in the
  // CC+IC stop-choice modal), the finally block skips the end-of-list
  // bulk-check, the running→monitoring transition, and the per-account
  // post-campaign sweep registration. Default false preserves the existing
  // "Stop sending, keep monitoring" semantics.
  campaign._skipCleanup = !!full;
  // Wake any in-flight awaitUnpause() so the loop can exit cleanly.
  campaign._paused = false;
  campaign._pauseRequested = false;
  // v2.74: force-close any connection-check browser open right now so checking
  // stops within a second or two. Without this the in-flight bulk-check runs to
  // completion (a page fetch can't be cancelled), so Stop felt like it grinded
  // through every remaining account. Closing the browser makes the in-flight
  // check throw → its loop sees _abort and breaks.
  _forceCloseActiveBulkChecks();
  // v2.76: "Stop everything" (full) is a true full halt — also cancel this
  // campaign's background reply/accept tracking so the schedulers stop
  // reopening browsers for the next 7 days. Fire-and-forget (this fn is sync).
  if (full) {
    // Preserve the snapshot until the operator deletes/abandons the campaign.
    // A forced stop may still need it after Electron restarts; clearing it here
    // made the promised Continue action impossible precisely on the worst path.
    // Background schedules are removed by stopCampaignBackgroundTracking(),
    // which the HTTP route awaits with a deadline before claiming full stop.
  }
  // Say what actually happened, in the campaign's OWN log, including when the
  // answer is "nothing". Pressing Stop on a card showing a CLOUD campaign lands
  // here, flips _abort on an in-memory singleton that holds no campaign, and
  // used to log '■ Stop requested (full halt…)' — a line that reads like a stop
  // and is written to a file the operator never sees. COLL_CHI_ANTONIO2 was
  // pressed twice on 2026-09-01 (10:19:16 and 10:19:40 UTC) and kept monitoring
  // on the VM for the rest of the day, with nothing anywhere to say why.
  const nothingRunningHere = !campaign.running && campaign.state !== 'monitoring';
  // Quitting the app calls this too (server.js gracefulShutdown), and it used to
  // borrow the operator wording: every quit ended the log with "Stop pressed,
  // but nothing is running", which nobody had pressed (Sam, 1 Sep). Closing the
  // app is not a stop the operator made, so it gets its own sentence.
  log(quitting
    ? (nothingRunningHere
      ? '■ The app is closing. Nothing was running here, so nothing was interrupted.'
      : '■ The app is closing, so this campaign is stopping on this Mac. A campaign running on the Cloud VM keeps going.')
    : (nothingRunningHere
      ? '■ Stop pressed, but nothing is running or monitoring on this Mac — nothing here was stopped. If the campaign you meant runs on the Cloud VM, stop it from that campaign\'s own card.'
      : (full
        ? '■ Stop requested (full halt — no monitoring, no auto-intros).'
        : '■ Stop requested.')));
  // An operator stop ANSWERS any outstanding interruption journal. Without this
  // a journal written hours earlier (app quit, Mac asleep) outlived the campaign
  // it described and re-labelled every later stop as "Stopped because this Mac
  // became unavailable" — the card said that while the log directly above it
  // said the operator had stopped it, 2.5 hours after the journal was written
  // (operator, 2026-08-28 15:09).
  try { clearRuntimeInterruption(); } catch { /* absent is already clear */ }
  // P-02 fix (2.8.18): return a real shape instead of undefined so
  // /api/campaign/stop sends `{ok:true}` like every other endpoint.
  return { ok: true, full: !!full };
}

export async function stopCampaignBackgroundTracking() {
  const sheetId = _extractSheetIdFromUrl(campaign.sheetUrl);
  const profileIds = (campaign.profileIds || []).slice();
  if (!sheetId) return { ok: true, removed: false };
  const results = await Promise.allSettled([
    removeReplySchedules(sheetId, profileIds),
    removeBulkSchedules(sheetId, profileIds),
  ]);
  const failed = results.filter((r) => r.status === 'rejected');
  return failed.length
    ? { ok: false, error: failed.map((r) => r.reason?.message || String(r.reason)).join('; ') }
    : { ok: true, removed: true };
}

// Phase 2.8.9: pause/resume.
// Pause sets a request flag — the loop checks at lead boundaries (top of the
// inner BATCH_SIZE loop) and only then flips _paused = true. Browsers stay
// open during pause; resume clears both flags and the awaitUnpause loop exits.
export function pauseCampaign() {
  if (!campaign.running) return { ok: false, reason: 'not-running' };
  if (campaign._paused || campaign._pauseRequested) {
    return { ok: true, alreadyPausing: true };
  }
  campaign._pauseRequested = true;
  // v2.112: snapshot the settings the paused editors can change, so the resume review can
  // diff them honestly. Deep-copy templates (setLiveTemplates mutates it in place).
  campaign._pauseSnapshot = {
    dailyLimit: campaign.dailyLimit,
    checkIntervalMinutes: campaign.checkIntervalMinutes,
    templates: JSON.parse(JSON.stringify(campaign.templates || {})),
  };
  log('⏸ Pause requested — will pause after current lead completes.');
  return { ok: true };
}

export function resumeCampaign({ applyPending = false } = {}) {
  if (!campaign.running) return { ok: false, reason: 'not-running' };
  if (!campaign._paused && !campaign._pauseRequested) {
    return { ok: true, notPaused: true };
  }
  if (applyPending) {
    try { _applyPendingResume(); } catch (err) { log(`⚠ resume apply failed: ${err.message}`); }
  }
  campaign._pauseSnapshot = null;
  campaign._pauseRequested = false;
  campaign._paused = false; // awaitUnpause's while-loop will exit on next tick
  log('▶ Resume requested.');
  return { ok: true };
}

// v2.112: apply staged paused edits at the boundary (loop parked in awaitUnpause).
function _applyPendingResume() {
  const p = campaign._pendingResume;
  if (!p) return;
  if (p.reloadSheet && p.newRows && typeof campaign._reloadTargets === 'function') {
    const r = campaign._reloadTargets(p.newRows);
    log(`⟳ Sheet reloaded on resume — +${r.added} new, ${r.updated} updated (total ${campaign.totalTargets}).`);
  }
  for (const { id, name } of p.addProfiles || []) {
    if (typeof campaign._addProfile === 'function') campaign._addProfile(id, name);
  }
  for (const [id, skip] of Object.entries(p.benchToggles || {})) {
    setProfileSkip(id, !!skip);
  }
  campaign._pendingResume = { reloadSheet: false, newRows: null, addProfiles: [], benchToggles: {} };
}

// v2.14.x: Restore — "panic button" for when the campaign is stuck and
// neither Stop nor Pause are responding. Force-kills browsers, lies to the
// rest of the system about `running` being false (even if the in-flight
// loop is hung mid-await), then re-launches the same campaign with the
// snapshotted settings. Today's per-account counts are seeded from
// state.processed by startCampaign so accounts pick up where they left
// off, not from 0/dailyLimit.
//
// The old (potentially hung) loop is left in memory — its awaits will
// resolve to errors as browsers die under it. State writes from that loop
// are tolerated because saveState() atomically overwrites; the worst-case
// race is one slightly-stale write, which the next live save corrects.
//
// Returns { ok, restartedFrom, reason? }:
//   restartedFrom: 'running' | 'history' | null (idle no-op)
export async function restoreCampaign() {
  const wasRunning = campaign.running;
  let settings = _lastRunSettings;

  // Force-kill browser processes synchronously. closeAllProfiles handles
  // the SIGTERM + SIGKILL fallback path inside gologin-launcher.
  try { await closeAllProfiles(); } catch (err) { console.warn('[restore] closeAllProfiles:', err.message); }
  try { await closeLocalBrowser(); } catch (err) { console.warn('[restore] closeLocalBrowser:', err.message); }

  // Lie to the rest of the system: the old loop's `running = false` may
  // never fire if it's hung. Set it ourselves so UI + status endpoints
  // immediately reflect idle. Mark _skipCleanup so any awakening from the
  // hung loop short-circuits without touching state.
  campaign._abort = true;
  campaign._skipCleanup = true;
  campaign.running = false;
  campaign.currentProfile = null;
  campaign.currentAction = null;
  log('↻ Restore: campaign engine force-reset.');

  // If we weren't running but have a persisted snapshot, restore from there
  // (covers the "app restarted after crash" case). Prefer last-run-settings.json —
  // it's authoritative (carries benchedProfileIds, templates, senderFirstNames and all
  // start args, kept current by _persistRunSettings) — over the lossy history.json
  // reconstruction below. This is what makes a mid-run bench/added account survive a
  // true app restart (#2c), not just the in-memory Restore button.
  if (!settings) {
    const fromDisk = readLastRun(LAST_RUN_FILE);
    if (fromDisk && Array.isArray(fromDisk.profileIds) && fromDisk.profileIds.length) {
      settings = { ...fromDisk };
      // Lead-source guard: backfill the chosen tab for snapshots written
      // before sheetGid was persisted.
      if (!settings.sheetGid) settings.sheetGid = extractSheetGid(settings.sheetUrl || '');
    }
  }
  // Last resort: rebuild from the most recent history entry (lossy — no benchedProfileIds,
  // templates, or senderFirstNames; kept for back-compat when no snapshot file exists).
  if (!settings) {
    try {
      const raw = await readFile(HISTORY_PATH, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) {
        const last = arr[arr.length - 1];
        if (last && last.settings) {
          const s = last.settings;
          settings = {
            profileIds: Array.isArray(s.profileIds) ? s.profileIds : [],
            sheetUrl: s.sheetUrl || '',
            // Lead-source guard: carry the chosen tab; backfill from the URL
            // for pre-feature history entries that lack it.
            sheetGid: s.sheetGid || extractSheetGid(s.sheetUrl || ''),
            templates: s.templates || {},
            dailyLimit: s.dailyLimit ?? 50,
            mode: last.mode,
            messageOpenProfiles: !!s.messageOpenProfiles,
            delayMin: s.delayMin ?? 10,
            delayMax: s.delayMax ?? 20,
            linkedinColumn: s.linkedinColumn || '',
            concurrency: s.concurrency ?? 1,
            name: last.name ? `${last.name} (restored)` : '',
          };
        }
      }
    } catch { /* no history → nothing to restore from */ }
  }

  if (!settings) {
    log('↻ Restore: no settings to restart with — engine is idle now.');
    return { ok: true, restartedFrom: null, reason: 'nothing-to-restore' };
  }

  // Brief wait so the old loop's pending I/O has a chance to fail out
  // before the new loop starts touching the same files.
  await new Promise((r) => setTimeout(r, 1500));

  // Re-launch. Fire-and-forget — startCampaign awaits the full lifecycle
  // and we don't want to block the HTTP response on that.
  const restartedFrom = wasRunning ? 'running' : 'history';
  const launchName = wasRunning
    ? `${settings.name || ''} (restored)`.trim()
    : settings.name;
  startCampaign({ ...settings, name: launchName }).catch((err) => {
    log(`↻ Restore: restart failed — ${err.message}`);
  });

  return { ok: true, restartedFrom };
}

async function awaitUnpause(myGen) {
  if (!campaign._pauseRequested && !campaign._paused) return;
  campaign._paused = true;
  setAction('Paused — awaiting resume');
  log('⏸ Campaign paused — browsers stay open. Press Resume to continue.');
  // v2.52.0: also exit when the generation no longer matches (orphan loop
  // left over from a restoreCampaign re-launch). Without this an orphan
  // sitting in awaitUnpause would block forever on a 1s poll that only
  // checked _abort — which startCampaign reset to false.
  while (campaign._paused && !campaign._abort && (myGen === undefined || campaign._generation === myGen)) {
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!campaign._abort && (myGen === undefined || campaign._generation === myGen)) {
    log('▶ Campaign resumed.');
  }
  campaign._paused = false;
  campaign._pauseRequested = false;
}

// v2.83: expose the live settings snapshot of the running/last campaign so
// the dashboard "Open" button can pre-fill the wizard the same way the past
// "Edit & resume" flow does (which reads a history entry's .settings). This
// is the in-memory snapshot captured at startCampaign — it carries templates
// (primary name/url, intro body, connection note), concurrency, delays,
// linkedinColumn and senderFirstNames, none of which getCampaignStatus emits.
// Returns null when no campaign has run this process lifetime.
export function getLastRunSettings() {
  if (_lastRunSettings) return { ..._lastRunSettings };
  // In-memory snapshot is gone (server restarted / campaign resumed from disk
  // for monitoring). Fall back to the persisted copy so "Open" still restores.
  const fromDisk = readLastRun(LAST_RUN_FILE);
  return fromDisk ? { ...fromDisk } : null;
}

/** mm:ss for the one live step. */
function _mmss(ms) {
  const n = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
}

/**
 * One entry per account for the per-account panel.
 *
 * Scope: the campaign's own accounts, PLUS any account a monitoring sweep found
 * a problem with. A sweep run with the "all senders" scope resolves its
 * accounts from the sheet's Sender column, so it can hit accounts this campaign
 * never selected. Dropping those would hide exactly the failure this panel
 * exists to show, so they are appended at the end.
 *
 * Every number here is one of two, and they are never mixed: batchDone against
 * batchSize is this account's position in ONE turn, sentToday against
 * dailyLimit is its whole day.
 */
function buildAccountPanel() {
  let ids = (campaign.profileIds && campaign.profileIds.length)
    ? campaign.profileIds.slice()
    : (campaign.participatingProfileIds || []).slice();
  const health = campaign.accountHealth || {};
  for (const pid of Object.keys(health)) if (!ids.includes(pid)) ids.push(pid);
  if (campaign._removedProfiles?.size) ids = ids.filter((id) => !campaign._removedProfiles.has(id));
  if (!ids.length) return [];

  const names = campaign.profileNames || [];
  const skips = getSkips();
  const parked = campaign.parkedProfiles || [];
  const ends = campaign.profileEndReasons || [];
  const benched = campaign._skippedProfiles || new Set();
  const restricted = campaign._restrictedProfiles || new Map();
  const cooldowns = campaign._cooldown429 || new Map();
  const turns = campaign._turnByProfile || {};
  const reachedBy = campaign._reachedByProfile || {};
  const liveName = campaign.currentProfile || '';
  const action = campaign.currentAction || null;

  return ids.map((pid) => {
    const idx = (campaign.profileIds || []).indexOf(pid);
    // The account's display name (operators name their GoLogin profiles by
    // email), never the raw profile id, which means nothing to anybody.
    const email = (idx >= 0 && names[idx]) || (health[pid] && health[pid].profileName) || profileNameCache[pid] || '';
    const live = !!(campaign.running && !campaign._paused && email && email === liveName);

    const cool = cooldowns.get ? cooldowns.get(pid) : null;
    const end = ends.find((e) => e.profileId === pid);
    const park = parked.find((p) => p.profileId === pid);
    const h = health[pid];

    let state = 'idle';
    let sub = '';
    if (campaign.awaitingLogin && campaign.awaitingLogin.profileId === pid) {
      state = 'needs-login'; sub = NEEDS_LOGIN_LINE;
    } else if (h) {
      state = h.state; sub = h.note;
    } else if (end || park) {
      state = 'stopped'; sub = parkSentence((end && end.reason) || (park && park.reason));
    } else if (cool && cool.until > Date.now()) {
      state = 'rate-limited'; sub = SLOW_DOWN_LINE;
    } else if (restricted.has && restricted.has(pid)) {
      state = 'identity-restricted';
      sub = `${restricted.get(pid) || 'Identity Restricted'} in the SoO. Removed from rotation; queued leads are safe.`;
    } else if (benched.has && benched.has(pid)) {
      state = 'benched'; sub = 'You took this account out of the rotation.';
    } else if (live) {
      state = 'working'; sub = 'Working now.';
    } else if (campaign.running) {
      state = 'waiting'; sub = 'Waiting for its turn.';
    }

    const turn = turns[pid] || {};
    const mine = skips.filter((s) => s.profileId === pid);
    // The panel lists the most recent misses; the result line below carries the
    // true total, so a long list is never mistaken for the whole story.
    const missed = mine.slice(-25).map((s) => ({
      who: s.leadName || 'someone in the sheet',
      why: missReason(s.reason, s.detail),
    }));

    // What the counters cannot say: how many were missed, and whether anything
    // is wrong. Never the sent count, which the counters already show.
    const problem = (state === 'needs-login' || state === 'cannot-open' || state === 'rate-limited' || state === 'trouble' || state === 'identity-restricted') ? sub : '';
    const missedLine = mine.length
      ? `${mine.length} ${mine.length === 1 ? 'person was' : 'people were'} not reached.`
      : '';
    const result = [missedLine, problem].filter(Boolean).join(' ');

    // Two states the operator has to be able to act on, said as booleans rather
    // than left for the browser to sniff out of prose. The weekly line reads
    // "used up its invitations for the week", which the UI's old /weekly/ test
    // never matched, so a capped account rendered as a bare "Stopped" with no
    // reason on the pill (operator, 2026-09-03).
    const _why = String((end && end.reason) || (park && park.reason) || '')
      .toLowerCase().replace(/_/g, ' ');
    const weeklyCap = /weekly|invitation limit|invite limit|invitations for the week/
      .test(`${_why} ${sub}`.toLowerCase());
    const needsLogin = state === 'needs-login'
      || /log ?in|logged out|session expired|authwall|checkpoint/.test(_why);

    return {
      email,
      state,
      live,
      weeklyCap,
      // Inferred from HTTP 429s rather than stated by LinkedIn — the UI says "suspected".
      weeklySuspected: weeklyCap && /429|suspected/.test(_why),
      needsLogin,
      batchDone: turn.done == null ? null : turn.done,
      batchSize: turn.size == null ? null : turn.size,
      sentToday: getCampaignSendCount(pid),
      // An account a sweep found but that this campaign never selected has no
      // cap of its own here, so it shows none rather than borrowing this
      // campaign's.
      dailyLimit: idx >= 0 ? (campaign.dailyLimit || 0) : 0,
      sub,
      reached: (reachedBy[pid] || []).slice(),
      missed,
      // Only the working account carries steps, and the only step with a real
      // source is what it is doing right now. A six-row checklist would have to
      // be invented, and an invented checklist on an idle account is the frozen
      // card all over again.
      steps: (live && action && action.label)
        ? [['now', action.label, _mmss(Date.now() - (action.startedAt || Date.now()))]]
        : [],
      result,
    };
  });
}

export function recordRuntimeInterruption(reason = 'unexpected-exit', extra = {}) {
  const active = !!campaign.running || campaign.state === 'monitoring' || !!campaign._paused;
  if (!active || campaign.runsOn === 'vm') return { ok: true, recorded: false };
  const phase = campaign.state === 'monitoring' ? 'monitoring' : 'sending';
  const value = writeRuntimeInterruption({
    permanentCampaignId: campaign.campaignId,
    reason,
    phase,
    name: campaign.name || '',
    mode: campaign.mode || '',
    campaignId: campaign.id || SINGLETON_CAMPAIGN_ID,
    totalProcessed: Number(campaign.totalProcessed) || 0,
    totalTargets: Number(campaign.totalTargets) || 0,
    profileIds: Array.isArray(campaign.profileIds) ? campaign.profileIds.slice() : [],
    participatingProfileIds: Array.isArray(campaign.participatingProfileIds)
      ? campaign.participatingProfileIds.slice() : [],
    sheetUrl: campaign.sheetUrl || '',
    currentProfile: campaign.currentProfile || '',
    currentAction: campaign.currentAction || null,
    ...extra,
  });
  return { ok: true, recorded: true, interruption: value };
}

export function acknowledgeRuntimeResume() {
  clearRuntimeInterruption();
  return { ok: true };
}

export function getCampaignStatus() {
  // Prefer campaign-loop samples (include browser PIDs) but fall back to the
  // ambient sampler so tiles populate the moment the server starts.
  const amb = getAmbient();
  const smp = campaign._lastSample || amb.sample;
  const thr = campaign._throttle   || amb.throttle;
  const panel = buildAccountPanel();
  const working = panel.find((a) => a.live) || null;
  // Two gates, both learned the hard way (2026-08-28):
  //   isInterruption      — an `active-run` heartbeat is not a stop.
  //   interruptionMatches — a journal must describe THIS campaign. A stale one
  //                         gave an empty local cockpit the name and state of a
  //                         campaign that had moved on, and the board then drew
  //                         that campaign twice: once real, once as a ghost row.
  const _journal = (!campaign.running && campaign.state !== 'monitoring')
    ? readRuntimeInterruption() : null;
  const interruption = (isInterruption(_journal)
    && interruptionMatches(_journal, campaign.id || SINGLETON_CAMPAIGN_ID))
    ? _journal : null;
  const interrupted = !!interruption;
  const interruptedCopy = interrupted ? interruptionCopy(interruption) : null;
  const interruptionLog = interrupted
    // No "STOPPED " prefix: the title already starts with "Stopped because …",
    // so the line read "STOPPED Stopped because this Mac became unavailable" —
    // and the card, which uses this line as its headline, shouted it twice
    // (operator, 2026-08-28 15:09).
    ? `[${interruption.recordedAt}] ${interruptedCopy.title}. ${interruptedCopy.detail}`
    : null;
  // Evidence that this singleton describes a real campaign on THIS Mac, rather
  // than the empty placeholder the endpoint returns when nothing has ever run.
  // A name is enough on its own: a finished or stopped local campaign still ran
  // here, and its card must keep saying so.
  const _holdsACampaign = !!(campaign.running
    || campaign.state === 'monitoring'
    || campaign.state === 'interrupted'
    || campaign.state === 'waiting_daily_reset'
    || String(campaign.name || '').trim());

  return {
    campaignId: interrupted ? (interruption.permanentCampaignId || null) : campaign.campaignId,
    lifecycle: campaignLifecycle({ ...campaign, interrupted, stopping: campaign.running && campaign._abort }),
    // The per-account panel, and the three live fields the sending banner reads.
    // Until now only the cloud engine produced them, so a run on this Mac could
    // never say who was being contacted from which account.
    accountPanel: panel,
    live: !!working,
    liveAccount: working ? working.email : '',
    // This account's position in its CURRENT turn. Absent stays absent: a
    // confident "1 of 8" on an account that has not started is worse than a
    // blank. dailyLimit below is the other number, the whole day's cap.
    batchDone: working ? working.batchDone : null,
    batchSize: working ? working.batchSize : null,
    sentToday: working ? working.sentToday : 0,
    running: interrupted ? false : campaign.running,
    // The cloud id when this Mac ADOPTED a cloud campaign's monitoring; the
    // singleton id otherwise. The board needs it to tell "a local campaign" from
    // "the cloud campaign that now lives here" — without it the same campaign was
    // listed twice, once RUNNING/local and once MONITORING/VM.
    id: campaign.id || SINGLETON_CAMPAIGN_ID,
    paused: interrupted ? true : campaign._paused,
    pauseRequested: campaign._pauseRequested,
    // v2.78: accounts the operator has benched from the rotation this run.
    skippedProfiles: [...(campaign._skippedProfiles || [])],
    // v2.78: CC+IC per-account connection-to-primary status for Live Status.
    primaryConn: Object.fromEntries(campaign._primaryConn || []),
    primaryConnSource: Object.fromEntries(campaign._primaryConnSource || []),
    primaryName: (campaign.templates && campaign.templates.primaryName) || '',
    primaryCheckTiming: campaign.primaryCheckTiming || 'immediately',
    // v2.13.14: surface monitoring fields so the cockpit + run-bar can
    // reflect post-campaign monitoring state without a second poll.
    state: interrupted ? 'interrupted' : (campaign.state || 'idle'),
    dailyResetNeeded: !!campaign.dailyResetNeeded,
    resumeAt: campaign.resumeAt || null,
    stoppedManually: !!campaign._stoppedManually,
    interrupted,
    interruption: interrupted ? { ...interruption, ...interruptedCopy } : null,
    // v2.105: pre-flight primary handshake sub-phase ('preflight' | null) —
    // drives the gold is-preflight card state. Distinct from `state` (running
    // stays true through pre-flight).
    phase: campaign.phase || null,
    monitoringUntil: campaign.monitoringUntil || null,
    nextCheckAt: campaign.nextCheckAt || null,
    monitorCheckError: campaign.monitorCheckError || '',
    // v2.52.0: surface the operator-chosen cadence so the cockpit tips +
    // the dashboard Monitoring tab show the ACTUAL running value, not the
    // wizard dropdown's default. Was missing entirely → tips fell back to
    // the wizard's HTML default (60 min) regardless of campaign reality.
    //
    // Review finding 4: checkIntervalMinutes here is the EFFECTIVE (possibly
    // stretched) cadence, checkIntervalBaseMinutes the operator's own setting
    // — same pair the engine's buildCadenceFields sends (campaign-api.js), so
    // public/js/live-activity.mjs's checkSlowdown() reads one shape for both
    // cloud and local. campaign.checkIntervalMinutes itself is NEVER the
    // stretched value (see tickMonitoringNow) — this is where the two are
    // combined for display only.
    checkIntervalMinutes: campaign.checkIntervalMinutes
      ? checkCadenceMin({ baseMin: campaign.checkIntervalMinutes, emptyStreak: campaign.emptyCheckStreak })
      : null,
    checkIntervalBaseMinutes: campaign.checkIntervalMinutes || null,
    // "Free for all Friday": when this run stops itself, or null when the option is off.
    weeklyCutoffAt: campaign.weeklyCutoffAt || null,
    monthlyCutoffAt: campaign.monthlyCutoffAt || null,
    emptyCheckStreak: Math.max(0, Number(campaign.emptyCheckStreak) || 0),
    // Which side owns this campaign, and when it last changed hands. Stamped by
    // the handover routes in server.js (and by launchCampaign for any run that
    // starts here), so its PRESENCE is the evidence.
    //
    // The old rule was "an absent runsOn means nobody has ever moved this
    // campaign, which is 'local'". That reads absence of evidence as evidence.
    // This endpoint answers with id 'legacy-singleton', state 'idle' and no
    // name when there is no campaign on this Mac at all, and still claimed
    // 'local' — and the live card polls it every 2s, so a card showing a VM
    // campaign lit up "This Mac" over it. COLL_CHI_ANTONIO2 (e4f26bc2) sat in
    // monitoring on the VM from 28 Aug to 1 Sep 2026 while the card said it was
    // here, and Stop, reading the same claim, went to the local singleton and
    // did nothing. Twice.
    //
    // Only answer when this singleton actually holds a campaign. Otherwise say
    // nothing, and the card renders "where this runs is not known".
    runsOn: interrupted ? 'local' : (campaign.runsOn || (_holdsACampaign ? 'local' : null)),
    handoverAt: campaign.handoverAt || null,
    stopReason: campaign.stopReason || null,
    // v2.14.x: surface the tick re-entrancy guard so the cockpit + run-bar
    // can flip to "Checking now…" while a bulk-check is mid-fire.
    monitoringCheckInProgress: _checkInProgress,
    accountsDone: campaign._monitoringAccountDone || null,
    accountsTotal: campaign._monitoringAccountTotal || null,
    // The banner shows STOPPING between the press and the browsers actually
    // closing, so the operator does not press Stop three more times.
    checkStopping: !!campaign._abortCheck,
    participatingProfileIds: campaign.participatingProfileIds || [],
    currentAction: campaign.currentAction,
    currentProfile: campaign.currentProfile,
    processedToday: campaign.processedToday,
    totalProcessed: interrupted ? (Number(interruption.totalProcessed) || 0) : campaign.totalProcessed,
    totalTargets: interrupted ? (Number(interruption.totalTargets) || 0) : (campaign.totalTargets || 0),
    mode: interrupted ? (interruption.mode || '') : (campaign.mode || ''),
    name: interrupted ? (interruption.name || '') : (campaign.name || ''),
    sheetUrl: interrupted ? (interruption.sheetUrl || '') : (campaign.sheetUrl || ''),
    // Feature ⑩ Team status: real start timestamp (set in the run loop),
    // surfaced here so the admin table can show "Started" instead of "—".
    startedAt: campaign.startedAt || null,
    // v2.72: one-shot end-of-run notice (no more rows) for the dashboard popup.
    endNotice: campaign._endNotice || null,
    profileNames: campaign.profileNames || [],
    profileIds: interrupted ? (interruption.profileIds || []) : (campaign.profileIds || []),
    dailyLimit: campaign.dailyLimit || 0,
    campaignCounts: { ...campaignCounts },
    logs: interruptionLog ? [...campaign.logs.slice(-99), interruptionLog] : campaign.logs.slice(-100),
    errors: campaign.errors.slice(-20),
    parked: campaign.parkedProfiles.slice(),
    // Local-browser re-login recovery: drives the "log into LinkedIn" popup.
    awaitingLogin: campaign.awaitingLogin || null,
    softWarnings: campaign.softWarnings.slice(),
    sheetWriteFailures: campaign.sheetWriteFailures || 0,
    profileEndReasons: campaign.profileEndReasons.slice(),
    // v2.137: 429 cooldown surfacing — profileId -> { until, pName, reason:'429' }.
    // Expired entries filtered so the UI never renders a stale countdown.
    cooldown429: Object.fromEntries(
      [...(campaign._cooldown429 || new Map())].filter(([, v]) => v && v.until > Date.now())
    ),
    disk: { ..._diskStatusCache },
    resources: smp ? {
      ramPct:            smp.ramPct,
      load1:             smp.load1,
      cpuPct:            smp.cpuPct,
      cpuCount:          smp.cpuCount,
      browsers:          smp.browsers,
      totalBrowserRssMb: smp.totalBrowserRssMb,
      sampledAt:         smp.sampledAt,
    } : null,
    throttle: thr ? {
      active:     thr.active,
      reason:     thr.reason,
      multiplier: thr.multiplier,
    } : null,
  };
}

/**
 * Ends the Monitoring phase early. Stamps still-pending leads Closed -
 * Not Connected in the sheet, transitions the campaign to 'done', and
 * unregisters the log-bus appenders.
 *
 * Called by:
 *   - Operator clicks "Stop monitoring" in the UI (reason: 'operator-stopped')
 *   - T+7d auto-end watcher (reason: 'window-elapsed')
 *   - Restart resume finds an expired monitoringUntil (reason: 'window-elapsed-on-restart')
 */
export async function stopMonitoring({ reason = 'operator-stopped' } = {}) {
  // v2.14.x DIAG: trace which step fires (or doesn't) when the cockpit's
  // "stale monitoring view after Stop" symptom recurs. Captured in
  // /tmp/dev-app.log via server stdout. Pure additive — no behaviour change.
  console.log(`[stopMonitoring] called: reason=${reason}, state=${campaign.state}, monitoringUntil=${campaign.monitoringUntil}, nextCheckAt=${campaign.nextCheckAt}`);

  // v2.52.0: idempotent. A double-click (or in-flight first call finishing
  // after a second click arrives) used to surface "Campaign is not in
  // monitoring state" — alarming because the first call already succeeded.
  // Now we treat state='done' as the no-op success case so the UI never
  // misleads the operator about whether monitoring is still running.
  if (campaign.state === 'done') {
    console.log(`[stopMonitoring] idempotent: state already 'done', no-op`);
    // v2.52.0: surface idempotent stop in the user-facing log so the
    // operator sees their click reflected (was previously silent —
    // only the alarming "already ended" toast appeared with no log
    // trace, leaving the operator unsure whether their action landed).
    const tsIdem = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${tsIdem} 🛏 Stop monitoring clicked — already ended (no-op).`);
    return { ok: true, alreadyStopped: true, stampedCount: 0, reason };
  }
  if (campaign.state !== 'monitoring') {
    console.log(`[stopMonitoring] early-return: state="${campaign.state}" is not 'monitoring'`);
    return { ok: false, error: 'Campaign is not in monitoring state' };
  }

  console.log('[stopMonitoring] passed state guard, flipping state BEFORE slow sheet work');

  // Capture context before state flip — protects against a new campaign
  // overwriting campaign.sheetUrl while the stamp call is in flight.
  const sheetUrl = campaign.sheetUrl;
  const linkedinColumn = campaign.linkedinColumn || '';
  const sheetId = _extractSheetIdFromUrl(sheetUrl);
  const participatingProfileIds = Array.isArray(campaign.participatingProfileIds)
    ? campaign.participatingProfileIds.slice() : [];

  // ── State transition + timer cleanup FIRST ──────────────────────────
  // Move state to 'done' BEFORE the sheet stamp. Without this, the 60s
  // monitoring watcher tick fires a fresh runMonitoringCheckAll during
  // the stamp call (its state guard at line 3237 still sees 'monitoring'),
  // and the cockpit + dashboard show "monitoring" until the stamp finishes.
  campaign.state = 'done';
  campaign.stopReason = reason;
  console.log(`[stopMonitoring] state set to 'done'`);
  // v2.74: force-close any in-flight monitoring-check browser so a running
  // sweep stops within a second or two rather than finishing the current
  // account. The state flip above already stops the NEXT account from opening.
  _forceCloseActiveBulkChecks();
  _ops('INFO', `Monitoring ended (${reason})`);

  // v2.52.0: kick a "stopping…" line into the user-facing log immediately,
  // BEFORE the slow Apps Script batch stamp (5-10s). Without this, the
  // operator clicks Stop and sees zero log activity for the duration of
  // the stamp call, leaving them unsure whether their action landed —
  // which is what drives the multi-click → idempotent-path loop.
  const tsStopping = `[${new Date().toISOString()}]`;
  campaign.logs = campaign.logs || [];
  campaign.logs.push(`${tsStopping} 🛏 Stopping monitoring (${reason}) — finalizing sheet stamps…`);

  // v2.14.x: cancel any armed pre-fire heads-up (we just left monitoring).
  if (_preFireTimer) { clearTimeout(_preFireTimer); _preFireTimer = null; }
  _preFireNotifiedFor = null;

  // Unregister log-bus appenders for every participating profile.
  for (const pid of participatingProfileIds) {
    unregisterAppender(sheetId, pid);
  }

  // Clear the on-disk monitoring slice so a crash-then-restart doesn't
  // resume monitoring on a stopped campaign.
  try { await clearMonitoringState(); } catch { /* */ }

  // v2.86.13: also remove this campaign's persisted post-campaign reply/bulk
  // schedules so the dashboard's "● Monitoring · N days" chip clears. The chip
  // reads these schedule files (server.js _monitoringForEntry), NOT in-memory
  // state — without this a stopped campaign keeps showing monitoring for ~7d.
  if (sheetId) {
    try { await removeReplySchedules(sheetId, participatingProfileIds); } catch { /* */ }
    try { await removeBulkSchedules(sheetId, participatingProfileIds); } catch { /* */ }
  }

  // ── No sheet stamping on stop ───────────────────────────────────────
  // v2.6x (operator rule 2026-05): monitoring-stop no longer stamps
  // 'Closed - Not Connected'. Stopping monitoring does NOT withdraw the
  // LinkedIn invitation — it just stops us watching — so a still-pending lead
  // must keep reading 'Connection Request Sent'. They may still accept later,
  // at which point a fresh bulk-check flips them to 'Connected'. (Any legacy
  // 'Closed - Not Connected' cells written by older builds are healed back to
  // 'Connection Request Sent' by the next bulk-check pass — see
  // computeBulkCheckUpdates in bulk-check-connections.js.)
  const stampedCount = 0;

  // Append a final log line.
  const ts = `[${new Date().toISOString()}]`;
  campaign.logs = campaign.logs || [];
  campaign.logs.push(`${ts} 🛏 Monitoring ended (reason: ${reason}) · still-pending leads kept as "Connection Request Sent"`);

  console.log(`[stopMonitoring] return ok=true, stampedCount=${stampedCount}, reason=${reason}`);
  return { ok: true, stampedCount, reason };
}

/**
 * v2.14 — Module-level tick callback. Two duties on each fire:
 *   1. T+7d auto-end: if monitoringUntil has elapsed, stop monitoring.
 *   2. Auto-check: if nextCheckAt is overdue, fire runMonitoringCheckAll
 *      and reschedule nextCheckAt by the operator-chosen cadence.
 *
 * Re-entrancy guard (_checkInProgress) prevents double-fire when the bulk
 * check takes longer than the heartbeat interval.
 *
 * The `_testStub` param is for unit tests only — when provided, it
 * replaces runMonitoringCheckAll. Production callers omit it.
 */
let _monitoringWatcherTimer = null;
let _checkInProgress = false;

/**
 * v2.59.15 — let the MANUAL bulk-check (/api/bulk-check-now) report the same
 * "a check is running" state the scheduled auto-check already does. The
 * dashboard monitoring hero reads getCampaignStatus().monitoringCheckInProgress
 * (= _checkInProgress) and flips to the gold pulsing "CHECKING / now" while
 * it's true. server.js wraps its sweep loop in try/finally around this so a
 * manual sweep shows CHECKING (collapsed or open) AND can't collide with a
 * scheduled tick (tickMonitoringNow early-returns when _checkInProgress).
 */
export function setBulkCheckInProgress(on) {
  _checkInProgress = !!on;
  // A stop belongs to the sweep that was in flight. Clear it as that sweep
  // unwinds, never before, so the next check can't start already stopped.
  if (!_checkInProgress) {
    campaign._abortCheck = false;
    campaign._checkingLead = null;
  }
}

/**
 * Stop an acceptance check that is in flight. Immediate: the abort is read
 * between leads inside the sweep, so it lands within one person rather than at
 * the end of the account.
 *
 * The interrupted person is left UNSTAMPED and named in the log. A lead that
 * was read but not written must never be recorded as finished, or the next
 * sweep skips them and their acceptance is lost.
 */
export function stopMonitoringCheck() {
  if (!_checkInProgress) return { ok: true, wasRunning: false, interrupted: null };
  campaign._abortCheck = true;
  const who = campaign._checkingLead || null;
  log(who
    ? `🛑 Check stopped by you while reading ${who}. Nothing was recorded for ${who}, so the next check reads them again.`
    : '🛑 Check stopped by you. Closing the browsers now.');
  return { ok: true, wasRunning: true, interrupted: who };
}
// v2.14.x: pre-fire heads-up. 15 s before each auto-check, fire a
// desktop notification + cockpit log line so the operator can context-
// switch out of LinkedIn before the bulk-check tab opens.
const PRE_FIRE_OFFSET_MS = 15_000;
let _preFireTimer = null;
let _preFireNotifiedFor = null; // ISO of the nextCheckAt we've already notified for

function _firePreCheckNotification() {
  try {
    const names = (campaign.participatingProfileIds || [])
      .map((pid) => {
        const idx = (campaign.profileIds || []).indexOf(pid);
        return idx >= 0 ? (campaign.profileNames || [])[idx] || pid : pid;
      })
      .filter(Boolean)
      .join(', ');
    const title = 'Bulk check fires in 15s';
    const body = names
      ? `About to check connections for ${names}.`
      : 'About to fire monitoring auto-check.';
    enqueueDesktopNotification({ title, body, audience: campaign.createdBy || null });
    const ts = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts} ⏰ ${title} — ${body}`);
  } catch (err) {
    console.warn('[pre-fire] notification failed:', err.message);
  }
}

export function schedulePreFireHeadsUp() {
  if (_preFireTimer) {
    clearTimeout(_preFireTimer);
    _preFireTimer = null;
  }
  if (campaign.state !== 'monitoring' || !campaign.nextCheckAt) return;
  if (_preFireNotifiedFor === campaign.nextCheckAt) return; // already done for this cycle
  const targetMs = new Date(campaign.nextCheckAt).getTime();
  const delay = targetMs - PRE_FIRE_OFFSET_MS - Date.now();
  if (delay <= 0) return; // already inside the 15s window or past it
  _preFireTimer = setTimeout(() => {
    _preFireNotifiedFor = campaign.nextCheckAt;
    _firePreCheckNotification();
  }, delay);
  // Don't keep the Node event loop alive solely on this timer — otherwise
  // `node --test` processes hang after their assertions pass.
  if (_preFireTimer && typeof _preFireTimer.unref === 'function') {
    _preFireTimer.unref();
  }
}

export async function tickMonitoringNow({ _testStub = null } = {}) {
  try {
    if (campaign.state !== 'monitoring') return;

    // Duty 1: 7-day window expiry (existing behavior)
    if (campaign.monitoringUntil) {
      const until = new Date(campaign.monitoringUntil).getTime();
      if (Date.now() >= until) {
        await stopMonitoring({ reason: 'window-elapsed' }).catch((err) => {
          console.warn('[monitoring-tick] stopMonitoring threw:', err.message);
        });
        return;
      }
    }

    // Duty 2: fire bulk-check + auto-intros when nextCheckAt is overdue —
    // unless the operator turned automatic checks off (they then run them
    // manually via the Check now button). 7-day expiry above is unaffected.
    if (!shouldAutoFireCheck({
      autoChecksEnabled: campaign.autoChecksEnabled,
      nextCheckAt: campaign.nextCheckAt,
      now: Date.now(),
    })) return;
    if (_checkInProgress) return;

    _checkInProgress = true;
    const cadenceMin = campaign.checkIntervalMinutes || 60;
    const ts = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts} 🛏 Monitoring · auto-check starting (cadence=${cadenceMin}m)`);

    // Reset before the sweep, not after: if the try below throws, the catch
    // must not leave the PREVIOUS sweep's count sitting here for the finally
    // to read. Without this, one successful sweep followed by a run of
    // throwing ones pins the streak at 0 forever (finding 5).
    campaign._lastCheckNewlyAccepted = 0;
    campaign._lastCheckLooked = false;

    try {
      if (_testStub) {
        await _testStub();
      } else {
        const checkOutcome = await runMonitoringCheckAll();
        const results = (checkOutcome && Array.isArray(checkOutcome.results)) ? checkOutcome.results : [];
        const summary = summarizeMonitoringSweep(results);
        campaign._lastCheckNewlyAccepted = summary.newlyAccepted;
        campaign._lastCheckLooked = summary.looked;
        campaign._lastCheckIncomplete = !checkOutcome.ok;
        campaign.monitorCheckError = checkOutcome.error || '';
      }
    } catch (err) {
      console.warn('[monitoring-tick] runMonitoringCheckAll threw:', err.message);
    } finally {
      // Reschedule ONLY if still in monitoring state (operator may have stopped mid-fire)
      if (campaign.state === 'monitoring') {
        // Adaptive cadence, mirroring the VM: consecutive sweeps that find nobody
        // stretch the interval, any acceptance snaps it straight back. The base is
        // always the operator's own setting, never the stretched value, or the
        // slowdown would compound every cycle. A sweep that never actually looked
        // (all accounts need re-login, everything busy, aborted) leaves the streak
        // untouched instead of advancing it — see the `looked` guard above.
        const baseMin = campaign.checkIntervalMinutes || 60;
        if (campaign._lastCheckLooked) {
          campaign.emptyCheckStreak = nextEmptyStreak({
            newlyAccepted: campaign._lastCheckNewlyAccepted || 0,
            current: campaign.emptyCheckStreak,
          });
        }
        const cadenceMin = checkCadenceMin({ baseMin, emptyStreak: campaign.emptyCheckStreak });
        const ms = campaign._lastCheckIncomplete ? 10 * 60_000 : cadenceMin * 60_000;
        // v2.14.x: schedule the next tick from the PREVIOUS nextCheckAt
        // boundary, not from "now" (which is whenever the bulk-check
        // happened to finish). Without this, a 1-2 min bulk-check
        // compounded drift on every cycle (15min → 17min → 19min → …).
        // If the bulk-check ran long and the next boundary is already in
        // the past, advance forward by whole intervals so the watcher
        // fires immediately on the next 60s tick to catch up.
        const prevNext = campaign.nextCheckAt ? new Date(campaign.nextCheckAt).getTime() : Date.now();
        let nextNext = prevNext + ms;
        const _now = Date.now();
        if (nextNext <= _now) {
          // Skipped one or more cadence boundaries — advance to the
          // smallest boundary strictly AFTER now. Mirrors the
          // floor(elapsed/ms)+1 formula in recomputeNextCheckAt
          // (monitoring-time.js:23) so behaviour matches the boot/wake
          // resume path. Earlier ceil-based formula was off-by-one when
          // _now landed mid-interval (prev=0, ms=15, now=20 → returned
          // 45 instead of 30).
          const ticksPassed = Math.floor((_now - prevNext) / ms) + 1;
          nextNext = prevNext + ticksPassed * ms;
        }
        campaign.nextCheckAt = new Date(nextNext).toISOString();
        _preFireNotifiedFor = null; // new cycle — re-arm the pre-fire heads-up
        try { await writeMonitoringState(campaign); } catch { /* */ }
        campaign.logs.push(`[${new Date().toISOString()}] ${nextCheckLogLine(campaign.nextCheckAt)}`);
        schedulePreFireHeadsUp();
      }
      // Clear the stop AFTER the sweep unwinds, never before: an early clear
      // lets the next account start while the browsers from this one are still
      // closing. nextCheckAt is deliberately untouched above, so a stopped
      // check does not shift the cadence.
      campaign._abortCheck = false;
      campaign._checkingLead = null;
      _checkInProgress = false;
    }
  } catch (err) {
    console.warn('[monitoring-tick] outer threw:', err.message);
    campaign._abortCheck = false;
    campaign._checkingLead = null;
    _checkInProgress = false;
  }
}

export function startMonitoringWatcher() {
  // Ortus Basics 1.0: no monitoring watcher at all — nothing polls on a 60s
  // timer looking for a due check. Manual "Check now" is the only trigger.
  return;
  /* eslint-disable no-unreachable */
  if (_monitoringWatcherTimer) return;
  _monitoringWatcherTimer = setInterval(() => {
    tickMonitoringNow().catch((err) => console.warn('[monitoring-watcher] tick threw:', err.message));
  }, 60 * 1000);
}

export function stopMonitoringWatcher() {
  if (_monitoringWatcherTimer) {
    clearInterval(_monitoringWatcherTimer);
    _monitoringWatcherTimer = null;
  }
}

/**
 * Called at app boot. Reads the persisted monitoring slice (if any),
 * rehydrates `campaign` with its fields, then decides whether to resume
 * or expire based on monitoringUntil vs now.
 *
 * Idempotent — safe to call multiple times.
 */
export async function resumeMonitoringFromDisk() {
  const slice = await readMonitoringState();
  if (!slice) return { action: 'noop', reason: 'no-persisted-state' };

  // Rehydrate the campaign global with the persisted slice fields
  Object.assign(campaign, slice);

  const decision = decideResumeAction(campaign, new Date());
  if (decision.action === 'expire') {
    await stopMonitoring({ reason: 'window-elapsed-on-restart' });
    return { action: 'expire' };
  }
  if (decision.action === 'resume') {
    campaign.nextCheckAt = decision.recomputedNextCheckAt.toISOString();
    _preFireNotifiedFor = null; // resume after restart — re-arm
    const ts = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    // Idempotent function, idempotent log: this runs on every app boot, so a
    // day of restarts stamped ten identical "Monitoring resumed · next check at
    // 14:36" lines into the same campaign (operator, 2026-08-28). Only write it
    // when it actually says something new.
    const _resumeLine = '🛏 Monitoring resumed on this Mac.';
    const _lastLine = campaign.logs.length ? String(campaign.logs[campaign.logs.length - 1]) : '';
    if (!_lastLine.endsWith(_resumeLine)) campaign.logs.push(`${ts} ${_resumeLine}`);
    // The event says WHAT happened; the schedule always follows it in the one
    // sentence every writer uses, so the newest line is the same shape wherever
    // the campaign has been.
    campaign.logs.push(`${ts} ${nextCheckLogLine(decision.recomputedNextCheckAt)}`);
    schedulePreFireHeadsUp();
    try {
      const _sheetId = _extractSheetIdFromUrl(campaign.sheetUrl);
      const _appender = buildAppendLogger({ logs: campaign.logs, capLines: 5000 });
      for (const _pid of (campaign.participatingProfileIds || [])) {
        registerAppender(_sheetId, _pid, _appender);
      }
    } catch (busErr) {
      console.warn('[monitoring-resume] log bus re-registration failed:', busErr.message);
    }
    // Persist the updated nextCheckAt
    await writeMonitoringState(campaign);
    return { action: 'resume' };
  }
  return { action: 'noop' };
}

/**
 * Adopt a campaign that has finished sending into monitoring ON THIS MACHINE.
 *
 * Same rehydration resumeMonitoringFromDisk does at boot, but the slice comes
 * from a handover (the VM's campaign record) instead of from disk. It exists
 * because routing such a campaign through startCampaign does NOT work: with
 * every lead already sent the loop finds 0 targets, profilesThatSentAtLeastOne
 * stays empty, and transitionToMonitoring drops it straight to 'done'
 * (campaign-state-transitions.js) — the campaign would be stranded on a Mac
 * doing nothing while the VM had already let go of it.
 *
 * `slice` is MONITORING_FIELDS-shaped (monitoring-persistence.js). Two fields
 * are decided here rather than carried:
 *   - emptyCheckStreak resets to 0, because the adaptive backoff re-earns
 *     itself on every switch (operator decision, 2026-08-21).
 *   - nextCheckAt is the base cadence from NOW, not the old side's boundary:
 *     an operator who moves a campaign wants to see a check happen.
 * monitoringUntil IS carried: the 7-day window belongs to the campaign, not to
 * the side running it.
 */
export async function adoptMonitoring(slice = {}) {
  if (campaign.running) return { ok: false, error: 'A campaign is still running on this machine.' };
  const now = new Date();
  const cadence = clampCadenceMinutes(slice.checkIntervalMinutes);
  const sendingEndedAt = slice.sendingEndedAt || now.toISOString();
  Object.assign(campaign, slice, {
    state: 'monitoring',
    checkIntervalMinutes: cadence,
    emptyCheckStreak: 0,
    sendingEndedAt,
    nextCheckAt: new Date(now.getTime() + cadence * 60_000).toISOString(),
    monitoringUntil: slice.monitoringUntil || computeMonitoringUntil(sendingEndedAt).toISOString(),
    autoChecksEnabled: slice.autoChecksEnabled !== false,
    totalTargets: Math.max(0, Number(slice.totalTargets) || 0),
    totalProcessed: Math.max(0, Number(slice.totalProcessed) || 0),
    _abort: false,
    stopReason: null,
  });
  campaign.logs = campaign.logs || [];
  const nextLocal = new Date(campaign.nextCheckAt).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const endsLocal = new Date(campaign.monitoringUntil).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  campaign.logs.push(`[${now.toISOString()}] 🖥 Monitoring moved to this Mac · checks every ${cadence} min · monitoring ends ${endsLocal}`);
  campaign.logs.push(`[${now.toISOString()}] ${nextCheckLogLine(campaign.nextCheckAt)}`);

  // Log bus, same registration resume does, so sheet writes narrate into this
  // campaign's log instead of disappearing.
  try {
    const _sheetId = _extractSheetIdFromUrl(campaign.sheetUrl);
    const _appender = buildAppendLogger({ logs: campaign.logs, capLines: 5000 });
    for (const _pid of (campaign.participatingProfileIds || [])) {
      registerAppender(_sheetId, _pid, _appender);
    }
  } catch (busErr) {
    console.warn('[monitoring-adopt] log bus registration failed:', busErr.message);
  }

  _preFireNotifiedFor = null;
  schedulePreFireHeadsUp();
  try { await writeMonitoringState(campaign); } catch (e) { console.warn('[monitoring-adopt] persistence write failed:', e.message); }
  startMonitoringWatcher();
  return { ok: true, nextCheckAt: campaign.nextCheckAt, monitoringUntil: campaign.monitoringUntil, checkIntervalMinutes: cadence };
}

/**
 * Test-only state setter. DO NOT call from production code.
 * Exposed so tests/status-payload.test.js can assert shape without
 * driving the full campaign loop.
 */
export function _setTestState(patch) {
  if (patch && typeof patch === 'object') {
    Object.assign(campaign, patch);
  }
}

/**
 * Operator toggle for the periodic monitoring auto-check. enabled=false stops
 * the watcher from auto-firing (manual "Check now" still works); enabled=true
 * resumes it. Persisted so it survives an app restart.
 */
export async function setMonitoringAutoChecks(enabled) {
  // Ortus Basics 1.0: checks are manual-only, so this cannot switch them back on.
  campaign.autoChecksEnabled = false;
  try { await writeMonitoringState(campaign); } catch { /* persistence is best-effort */ }
  return campaign.autoChecksEnabled;
}

/**
 * Returns the current campaign global (shallow reference).
 * Used by the monitoring HTTP routes in server.js.
 */
export function getCampaignState() {
  return campaign;
}

/**
 * Module-level monitoring bulk-check helper. Mirrors the inside-startCampaign
 * `runIdleBulkCheck` closure but reads its config from the persisted
 * `campaign` global rather than closure-bound locals. Used by:
 *   - The Check now button (immediate, no cooldown gate)
 *   - The T+7d auto-end watcher (when it wants to fire a final pass — future)
 *
 * Acquires browserSemaphore, opens profile, fires bulkCheck +
 * runAutoIntros, updates cooldown, closes. Failures non-fatal — logs to the
 * campaign log via the bus.
 */
/**
 * The one sentence this app uses to say when the next acceptance check is.
 *
 * It is byte-identical to the line the cloud engine writes
 * (campaign-runtime.js: "⏱ Next check … · nothing happens until then, the
 * campaign stays running."), and that is the whole point. The app used to have
 * four phrasings of its own — "Monitoring · next check at 18:08", "Monitoring
 * active · next check at 17:08.", "Monitoring resumed · next check at 17:08",
 * "Monitoring moved to this Mac · next check Fri, 28 Aug, 17:12 (every 60 min)"
 * — so three cards in the identical state read three different headlines and
 * every new phrasing needed its own banner rule to be understood. Operator,
 * 2026-08-28: "why do they say 2 different things despite them being in the
 * exact same state?!"
 *
 * Date-carrying and in UTC, like the engine's: a bare "HH:MM" on a multi-hour
 * backoff reads as "later today" when it is not.
 */
export function nextCheckLogLine(at) {
  // new Date(null) is the epoch, not an error — a missing schedule must produce
  // no line at all rather than "Next check 1970-01-01".
  if (at === null || at === undefined || at === '') return '';
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const txt = d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `⏱ Next check ${txt} · nothing happens until then, the campaign stays running.`;
}

export async function runMonitoringCheck(profileId, profileName) {
  if (campaign.state !== 'monitoring') {
    return { ok: false, error: 'Campaign not in monitoring state' };
  }
  const sheetUrl = campaign.sheetUrl;
  const linkedinColumn = campaign.linkedinColumn || '';
  const templates = campaign.templates || {};
  const token = process.env.GOLOGIN_API_TOKEN;

  await browserSemaphore.acquire();
  // v2.74: Stop landed while we queued for a slot — don't open the browser.
  if (campaign._abort) { browserSemaphore.release(); return { ok: false, aborted: true }; }
  let launched;
  // v2.74: register so stopMonitoring()/stopCampaign() can force-close this
  // in-flight check's browser.
  activeBulkChecks.add(profileId);
  try {
    const ts = `[${new Date().toISOString()}]`;
    const msg = `📡 [${profileName}] Check now — bulk check pass starting…`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts} ${msg}`);

    setAction(`Opening ${profileName} for an acceptance check`, {
      account: profileName, phase: 'checking', step: 'opening_account',
      stepLabel: 'Opening the account browser', stepDetail: 'Preparing to read sent invitations',
    });
    campaign.currentAction.done = campaign._monitoringAccountDone || 1;
    campaign.currentAction.total = campaign._monitoringAccountTotal || 1;
    // The card can only ever say what the log says. This path used to write ONE
    // line per account (the "pass starting" line above) and then nothing until
    // the account finished, so for the whole browser launch plus the whole
    // sweep the newest line was still "pass starting" and the card was pinned
    // to "Browser not open yet" — measured 2026-08-28, 54 seconds after
    // riccardo's browser was demonstrably open on the connections page.
    // Same two lines the manual bulk check already writes (server.js), so the
    // banner maps them with no new UI.
    campaign.logs.push(`[${new Date().toISOString()}] 📡 [${profileName}] Launching browser…`);
    launched = await launchProfile(profileId, token);
    campaign.logs.push(`[${new Date().toISOString()}] 📡 [${profileName}] Sweeping recent connections…`);
    setAction(`Checking ${profileName} for new acceptances`, {
      account: profileName, phase: 'checking', step: 'loading_invitations',
      stepLabel: 'Loading sent invitations', stepDetail: 'Comparing LinkedIn results with the campaign sheet',
    });
    campaign.currentAction.done = campaign._monitoringAccountDone || 1;
    campaign.currentAction.total = campaign._monitoringAccountTotal || 1;

    // v2.62: phase-2 mode-routing — CC+IC fires runAutoIntros, CC+DM fires
    // runAutoDms. campaign.mode is persisted in monitoring state so this
    // works on resume after restart.
    const _campaignMode = campaign.mode || '';
    const willAutoIntro = _campaignMode === 'connect_and_introduce' && _primaryIntroAllowed(profileId) && !!(
      templates.primaryName && templates.primaryName.trim() &&
      templates.primaryIntroBody && templates.primaryIntroBody.trim()
    );
    const willAutoDm = _campaignMode === 'connect_and_message' && !!(
      templates.ccDmBody && templates.ccDmBody.trim()
    );
    const r = await bulkCheckConnections(launched.page, sheetUrl, linkedinColumn, profileName, {
      // v2.14.x: stamp Connection Accepted immediately at bulk-check detection
      // so the operator sees acceptance in the sheet BEFORE the intro DM fires.
      // The auto-intro pass then only stamps Introduction Status (no longer
      // batched into a single Apps Script write).
      suppressAcceptedStamp: false,
    });
    setAction(`Matching acceptances for ${profileName}`, {
      account: profileName, phase: 'checking', step: 'acceptances_matched',
      stepLabel: 'Acceptance check complete', stepDetail: `${Number(r.freshConnected ?? r.matched) || 0} newly accepted connection(s) found`,
    });

    const ts2 = `[${new Date().toISOString()}]`;
    if (r.error) {
      campaign.logs.push(`${ts2} ⚠ [${profileName}] Check now: ${r.error}`);
      // The log line scrolls away within a minute and the account then reads
      // as healthy for the rest of the run. Keep the finding where the card
      // can see it until this account's next check succeeds.
      noteAccountHealth(profileId, profileName, r.error);
    } else {
      campaign.logs.push(`${ts2} ${r.plain || `📡 [${profileName}] Check now: ${r.matched} Connected, ${r.stamped || 0} Still Pending (of ${r.fetched})`}`);
      noteAccountHealth(profileId, profileName, null);
    }

    if (willAutoIntro && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
      await runAutoIntros({
        page: launched.page,
        profileId,
        profileName,
        sheetUrl,
        linkedinColumn,
        connectedUrls: r.connectedUrls,
        templates,
        senderFirstNames: campaign.senderFirstNames || {},
        log: (line) => {
          const ts3 = `[${new Date().toISOString()}]`;
          campaign.logs.push(`${ts3} ${line}`);
        },
      });
    } else if (willAutoDm && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
      await runAutoDms({
        page: launched.page,
        profileId,
        profileName,
        sheetUrl,
        linkedinColumn,
        connectedUrls: r.connectedUrls,
        templates,
        senderFirstNames: campaign.senderFirstNames || {},
        log: (line) => {
          const ts3 = `[${new Date().toISOString()}]`;
          campaign.logs.push(`${ts3} ${line}`);
        },
      });
    }

    // Update cooldown — same as runIdleBulkCheck
    const _sheetId = _extractSheetIdFromUrl(sheetUrl);
    const cooldown = await readBulkCheckCooldown();
    cooldown[bulkCheckKey(_sheetId, profileId)] = Date.now();
    await writeBulkCheckCooldown(cooldown);

    await writeMonitoringState(campaign);
    // freshConnected + error forwarded so the monitoring tick can tell "looked
    // and found nobody" from "session expired / write failed, didn't really
    // check" — see monitoring-cadence.js and its caller in tickMonitoringNow.
    return { ok: true, matched: r.matched, freshConnected: r.freshConnected || 0, error: r.error || null, stamped: r.stamped, connectedUrls: r.connectedUrls || [] };
  } catch (err) {
    const ts4 = `[${new Date().toISOString()}]`;
    campaign.logs = campaign.logs || [];
    campaign.logs.push(`${ts4} ⚠ [${profileName}] Check now failed: ${err.message}`);
    // Same reason as the soft failure above: a thrown launch failure left the
    // card with nothing at all to show for this account.
    noteAccountHealth(profileId, profileName, err.message || 'check failed');
    return { ok: false, error: err.message };
  } finally {
    activeBulkChecks.delete(profileId);
    try {
      if (profileId === 'local-browser') await closeLocalBrowser();
      else await closeProfile(profileId);
    } catch { /* */ }
    browserSemaphore.release();
    if (campaign.currentAction && ['checking', 'introducing'].includes(campaign.currentAction.phase)) {
      campaign.currentAction = null;
    }
  }
}

/**
 * Orchestrator: fire runMonitoringCheck for ALL participating profiles
 * sequentially. Returns an array of per-profile results.
 */
export async function runMonitoringCheckAll() {
  if (campaign.state !== 'monitoring') {
    return { ok: false, error: 'Campaign not in monitoring state' };
  }
  const results = [];
  const monitoringProfiles = campaign.participatingProfileIds || [];
  // Monitoring opens the same sender browsers as outreach, so the SoO safety
  // rule applies here too. Refresh once per sweep and skip restricted accounts
  // before a browser opens; a restriction never prevents the other accounts
  // from checking their acceptances.
  const restrictedNow = new Map();
  try {
    const soo = await fetchSoOData();
    const accounts = ((soo && soo.accounts) || []).filter((a) => a && a.email);
    const emails = accounts.map((a) => a.email);
    for (const pid of monitoringProfiles) {
      const idx = (campaign.profileIds || []).indexOf(pid);
      const name = idx >= 0 ? (campaign.profileNames || [])[idx] : pid;
      const resolved = resolveSoOEmail(name, emails);
      if (!resolved || !resolved.email || resolved.ambiguous) continue;
      const row = accounts.find((a) => String(a.email).toLowerCase().trim() === String(resolved.email).toLowerCase().trim());
      const label = identityRestrictionLabel(row);
      if (label) restrictedNow.set(pid, label);
    }
  } catch (err) {
    campaign.logs.push(`[${new Date().toISOString()}] SoO restriction check unavailable (${err.message}) — continuing with the last known account state.`);
  }
  campaign._monitoringAccountTotal = monitoringProfiles.length;
  for (let monitorIndex = 0; monitorIndex < monitoringProfiles.length; monitorIndex++) {
    const pid = monitoringProfiles[monitorIndex];
    // v2.74: stop sweeping the moment the operator stops monitoring (state
    // flips off 'monitoring') or hits Stop (_abort), instead of walking every
    // remaining account.
    // _abortCheck stops only this sweep: monitoring, the cadence and the next
    // check time all survive it.
    if (campaign._abort || campaign._abortCheck || campaign.state !== 'monitoring') break;
    const idx = (campaign.profileIds || []).indexOf(pid);
    const pName = idx >= 0 ? (campaign.profileNames || [])[idx] : pid;
    if (restrictedNow.has(pid)) {
      const note = `${restrictedNow.get(pid)} in the SoO. Monitoring skipped this account; the other accounts continue.`;
      campaign._restrictedProfiles.set(pid, restrictedNow.get(pid));
      campaign.logs.push(`[${new Date().toISOString()}] ${pName} — ${note}`);
      results.push({ profileId: pid, ok: false, skipped: true, reason: 'identity-restricted', note });
      continue;
    }
    campaign._monitoringAccountDone = monitorIndex + 1;
    const r = await runMonitoringCheck(pid, pName || pid);
    results.push({ profileId: pid, ...r });
  }
  campaign._monitoringAccountDone = 0;
  campaign._monitoringAccountTotal = 0;
  if (!monitoringProfiles.length) {
    return { ok: false, results, error: 'Action required: no monitoring accounts are configured. Add or restore an eligible sender.' };
  }
  const available = results.filter((r) => !r.skipped);
  const failed = available.filter((r) => !r.ok || r.error);
  const unavailable = results.filter((r) => r.skipped);
  const actions = [];
  for (const r of failed) actions.push(`${r.profileId}: ${r.error || 'recent-connections data was not retrieved'}; open the account and retry`);
  for (const r of unavailable) actions.push(`${r.profileId}: ${r.note || r.reason}; restore or replace this account`);
  const complete = available.length > 0 && failed.length === 0;
  return {
    ok: complete,
    results,
    error: actions.length ? `${complete ? 'Action required' : 'Incomplete check'}: ${actions.join(' | ')}` : '',
  };
}
