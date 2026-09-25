import { ensureCampaignIdentity, getConfigById } from './src/campaign-configs.js';
import { migrateCampaignIdentities } from './src/campaign-identity-migration.js';
import { campaignLifecycle } from './public/js/campaign-lifecycle.mjs';
import 'dotenv/config';

// ── Startup env validation (D-06) ──────────────────────────────────
// v2.52.0: SHEETS_WEBAPP_URL removed from REQUIRED_ENV. The URL is now
// hard-coded in src/sheets-webapp-url.js and the .env value is ignored.
// Ortus Basics 1.0: a missing GoLogin token is no longer fatal. The packaged app
// ships with no secrets, so a first launch legitimately has none — the operator
// pastes what they have into Settings and the app applies it live. Exiting here
// would mean a downloaded app could never reach the screen that fixes it.
const { applyCredentials } = await import('./src/gologin-credentials.js');
const _appliedCreds = applyCredentials();
if (_appliedCreds.length) {
  console.log(`  ✦ GoLogin workspaces from Settings: ${_appliedCreds.join(', ')}`);
}
if (!process.env.GOLOGIN_API_TOKEN) {
  console.warn('\n  ⚠ No GoLogin token yet — open Settings in the app and paste one.\n    Which accounts you can use follows from which tokens you add.\n');
}

import express from 'express';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { appendFileSync, createWriteStream, existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { startCampaign, stopCampaign, stopCampaignBackgroundTracking, pauseCampaign, resumeCampaign, preemptCurrentLead, restoreCampaign, getCampaignStatus, getLastRunSettings, setCampaignName, retryParkedProfile, campaign, extractLinkedInUrl, log as campaignLog, startMonitoringWatcher, stopMonitoringWatcher, stopMonitoring, resumeMonitoringFromDisk, adoptMonitoring, SINGLETON_CAMPAIGN_ID, setBulkCheckInProgress, addActiveBulkCheck, removeActiveBulkCheck, forceCloseActiveBulkChecks, setProfileSkip, removeProfileFromCampaign, setLiveTemplates, setLiveDailyLimit, setLiveCadence, confirmLogin, nextCheckLogLine } from './src/campaign.js';
import { getQueue, addToQueue, removeFromQueue, moveInQueue, reorderQueue, updateQueueEntry, popNextReady } from './src/campaign-queue.js';
import { computeSheetDiff, computeAccountDiff, computeSettingsDiff, summarizeResumeChanges } from './src/resume-diff.js';
// Sales Nav Scrape — control-panel client to the GKE scraper engine. The app
// dispatches scrape jobs here; it never launches a scraper browser locally.
import { isScraperConfigured, getEngineUrl as getScrapeEngineUrl, startScrape, pauseScrape, resumeScrape, stopScrape, getJobs as getScrapeJobs, getAllJobs as getAllScrapeJobs, getAllJobsFast as getAllScrapeJobsFast, getLogs as getScrapeLogs, getRunLogs as getScrapeRunLogs, extractSalesNavUrls, extractSalesNavUrlsWithRows, openJobViewStream as openScrapeJobViewStream } from './src/scraper-client.js';
import { addScrapeCampaign, listScrapeCampaigns, getScrapeCampaign, updateScrapeCampaign } from './src/scrape-campaigns.js';
import { getScrapeOverride, saveScrapeOverride } from './src/scrape-config-overrides.js';
import { appendAction, appendScrapeLog, readScrapeLog } from './src/scrape-campaign-logs.js';
import {
  mergeCampaignsWithJobs, groupJobsIntoCampaigns, scrapeCampaignId, diffBoardEvents, baseTabName,
  slimBoard,
} from './public/js/scrape-board.mjs';
import { getOperatorId } from './src/operator-id.js';
import { relaunchHistoryEntry, archiveHistoryEntry, listHistory, readCampaignLog } from './src/history-helpers.js';
import { getDrafts, getDraft, addDraft, updateDraft, removeDraft, trashDraft, trashAllDrafts, purgeTrashedDrafts, DRAFT_IDENTITY_MISMATCH } from './src/drafts.js';
import { startScheduler as startPostCampaignScheduler, listSchedule as listPostCampaignSchedule, removeSchedulesForSheet as removeBulkSchedules } from './src/post-campaign-bulk-check.js';
import { startScheduler as startReplyCheckScheduler, listSchedule as listReplyCheckSchedule, removeSchedulesForSheet as removeReplySchedules, registerReplySchedule } from './src/post-campaign-reply-check.js';
import { startPrimaryTaskRunner } from './src/primary-task-runner.js';
import { startCloudFollowupPoller, lastLateCount } from './src/cloud-followup-poller.js';
import { loadTasks as loadPrimaryTasks, saveTasks as savePrimaryTasks, summarizeFollowUps, markTask as markPrimaryTask } from './src/primary-tasks.js';
import { belongsToCampaign, healthForCampaign, countFollowUpHealth, groupStaleFollowUps, discardGroups, restoreDiscarded } from './src/followup-groups.js';
import { heldSummary } from './src/followup-dnc.js';
import { isAwaitingAccept, sendersToAcceptTasks, computeAcceptedIds, hasSignaled, markSignaled } from './src/cloud-primary-handshake.js';
import { buildAcceptTask, enqueuePrimaryTask, loadTasks } from './src/primary-tasks.js';
import { listReplies, unseenCount as unseenReplyCount, markAllSeen as markRepliesSeen } from './src/replies-log.js';
import { startAmbientSampling } from './src/resource-monitor.js';
import { personalizeTemplate } from './src/linkedin/helpers.js';
import { primaryKeyFromUrl, loadPrimaryStatus, seedConnectedIds } from './src/primary-status-store.js';
import { checkProfileDms, checkProfileDmsPerLead } from './src/linkedin/check-dms.js';
import { sweepProfileInbox, applyReplyWriteBack, makeInitialSweepStatus, loadSalesNavConversations, classifyConversations } from './src/linkedin/inbox-sweep.js';
import { runAmplification as runPostAmplification } from './src/linkedin/post-amplification.js';
import { fetchSheet, fetchSheetWithRows, listSheetTabs } from './src/sheets.js';
import { processedLeadUrls, sheetProcessedUrls, handoverTargetForCampaign, reclaimableCloudId, reclaimRefusal } from './src/handover.js';
import { startCloudCampaign, isCloudMode, listCloudCampaigns, getCloudCapacity, getCloudPreflight, getCloudCampaign, getCloudCampaignLeads, getCloudCampaignAccounts, stopCloudCampaign, cloudCheckStop, releaseCloudCampaign, reclaimCloudCampaign, resumeCloudCampaign, restartCloudCampaign, openCampaignViewStream, signalPrimaryAcceptDone, cloudCheckNow, setCloudAutoChecks, syncCloudLeadStatuses, unbenchCloudAccount, recordCloudPrimaryConn, setCloudCampaignAccounts, extractPrimarySlug, getPrimarySession } from './src/campaigns-client.js';
import { startHandshakeJob, getHandshakeJob } from './src/cloud-handshake-job.js';
import { runCloudPreflightHandshake } from './src/cloud-preflight-handshake.js';
import { aggregateTeamStatus, bucketForCloudStatus, countLeadsSentToday } from './src/team-status.js';
import { spreadsheetIdFromUrl, extractSheetGid, withGid } from './src/utils.js';
import { INTRO_FAILED_PRIMARY_NOT_CONNECTED, INTRO_RETRY_RECONNECT } from './src/linkedin/intro-constants.js';
import { getProfiles, closeAllProfiles, getActiveBrowserPids, getProfilePid, launchProfile, closeProfile, accountOfProfile, resolveProfileId } from './src/gologin-launcher.js';
import { accountForEmail, canOperatorUseProfile, usesProfileAsGuest, accountLabel, configuredAccounts, accountAllowsMode, accountModes, POST_AMPLIFICATION_MODE } from './src/gologin-accounts.js';
import { launchLocalBrowser, closeLocalBrowser } from './src/local-launcher.js';
import { clampCadenceMinutes, isRetiredMode } from './public/js/campaign-modes.mjs';
import { validatePrimaryUrl } from './public/js/primary-url-validation.mjs';
import { unhideByPids } from './src/mac-window.js';
import { preventSleep, allowSleep } from './src/caffeinate.js';
import { initNotifier, notifyAll, notifyEmail, getRecentNotifications } from './src/notifier.js';
import { flushOpsLog, _setAlertImpl } from './src/log-writer.js';
import { getFailures, retryFailures } from './src/sheet-write-tracker.js';
import { getSkips } from './src/skip-ledger.js';
import { createStopWatchdog } from './src/stop-watchdog.js';
import { clearRuntimeInterruption, readRuntimeInterruption } from './src/runtime-interruption.js';
import { launchValidation } from './src/launch-validation.js';
import { terminalPresentation } from './public/js/campaign-terminal.mjs';

// Surface a repeated Operations Log write failure instead of letting it die
// silently (the 2026-06-10 → 06-11 blackout). Routed to the fatal-error log
// the app already displays; no external auto-send.
_setAlertImpl((msg) => {
  console.error(`[log-writer][ALERT] ${msg}`);
  try { appendFatalErrorSync({ at: new Date().toISOString(), source: 'log-writer', message: msg }); } catch (_) { /* */ }
});
import { getPrefs as getNotificationPrefs, setPrefs as setNotificationPrefs } from './src/notification-prefs.js';
import { getPrefs as getOperatorPrefs, setPrefs as setOperatorPrefs, identityGateEnabled } from './src/operator-prefs.js';
import { getOperatorEmail, setOperatorEmail, isPlausibleEmail } from './src/operator-identity.js';
import { saveCloudLaunchConfig, getCloudLaunchConfig, getPrimaryPeople } from './src/cloud-launch-configs.js';
import { fetchSoOData, fetchSoOStatusData } from './src/soo.js';
import { dataPath } from './src/paths.js';
import { jobIdsForCampaign, scopeLiveLines } from './src/scrape-log-scope.js';
import { readBlocklist, addEntry as addBlocklistEntry, removeEntry as removeBlocklistEntry } from './src/blocklist.js';
import { listPresets, getPreset, savePreset, deletePreset, getLastUsed as getLastUsedPreset, saveLastUsed as saveLastUsedPreset } from './src/presets.js';
import { lintLeads, blocklistExcludedUrls, normalizeProfileUrl } from './src/preflight-lint.js';
import { ackFor, decidePreflightGate } from './src/preflight-gate.js';
import { checkDiskFree } from './src/disk-check.js';
import { LATEST_RELEASE_API, parseVersion, isBehind, archLabel, dmgAssetName, latestDownloadUrl, latestReleaseUrl } from './src/updater.js';
import {
  createUser, verifyCredentials, userExists,
  issueSessionCookie, clearSessionCookie, readSessionFromRequest,
  isEmailAllowed, deleteUser,
} from './src/auth.js';
import { getConnectionsStats, searchConnections, exportConnections, buildLeadRows, buildFgTargets, listOperators, listFgColleagues, listFgColleaguesMatched, parseRolesParam, listMasterRecords } from './src/connections/search-service.js';
import { dbCall } from './src/connections/db-client.js';
import { runTeamLaunch, makeInitialStatus } from './src/connections/fg-team-launch.js';
import { getFgState, queueFgInvites, markFgInvited, markFgFailed, observeFgCredits, FG_DEFAULT_MONTHLY_ALLOWANCE, invitedKeysFromState, writeFgList, readFgList, updateFgListLedger, postFg, writeFgMaster, readFgMasterKeys } from './src/connections/fg-sync.js';
import { buildMasterRows, invitedIndexFromFgInvites, newRowsOnly } from './src/connections/fg-master.js';
import { readSeedDir, mergeFunnelSeeds } from './src/connections/fg-funnel-seed.js';
import { startTeamLaunchCloud, makeRunStore, reconcileCloudRun, invitedWritebackFromLeads, duplicateFgRun } from './src/connections/fg-cloud-launch.js';
import { fgListTabName, ledgerUpdatesFromLeads, gridFromSheetRows, fgLedgerTracking, listRunShouldRetire, parseListRows, emailsInCell } from './src/connections/fg-list.js';
import { buildListRows, dispatchFromRows, resolveListSource } from './src/connections/fg-list-launch.js';
import { generateListRows } from './src/connections/fg-list-generate.js';
import { pageById, FG_PAGE_LIST, FG_PAGES, sendersForPage } from './src/fg-pages.js';
import * as magellan from './src/connections/magellan-run.js';
import { listCollected as magellanListCollected,
  migrateLegacyConnections as magellanMigrateLegacy } from './src/connections/magellan-pull.js';
import { sheetUrl as magellanSheetUrl } from './src/connections/magellan-sheet.js';
import { connectionsPropOptions, addConnectionsOptions, tokenScopes } from './src/connections/hubspot-client.js';
import { normMonth } from './src/connections/fg-export.js';
import { startSync as startConnectionsSync, getSyncState as getConnectionsSyncState, createWorkbookTab } from './src/connections/drive-sync.js';
import { runFollowerInvites } from './src/linkedin/follower-invite.js';
import { ORTUS_PAGE_INVITE_URL, SHEETS_WEBAPP_URL, SOO_SHEET_ID, SOO_SHEET_GID } from './src/sheets-webapp-url.js';
import { resolveSoOEmail, resolveSoOTarget, resolveOperatorStamp, flipAccountInUse, cloudFlipAction } from './src/soo-writer.js';
import { reconcileCloudConnections, reconcileCloudInUse } from './src/cloud-soo-reconcile.js';
import { cloudLeadToLocalSheetData } from './src/cloud-sheet-reconcile.js';
import { buildAutopilotConfig, nextRun, cycleKey } from './src/fg-autopilot.js';
import { publishAutopilotConfig } from './src/fg-autopilot-publish.js';
import { pickUnreconciled } from './src/fg-autopilot-reconcile.js';
import { FG_ROSTER_URL, FG_ROSTER_TOKEN } from './src/fg-roster-url.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
// UI-preview instance (ORTUS_UI_PREVIEW=1): serves the real app against a COPY
// of a data dir so a change can be looked at in the real UI, with every actor
// that touches the outside world switched off. Without this, a second instance
// drains the operator's personal follow-ups into its own throwaway queue and
// ACKs them to the engine — the real app would then never send them — and its
// queue drain can start a campaign nobody asked for.
const UI_PREVIEW = process.env.ORTUS_UI_PREVIEW === '1';

const pkg = JSON.parse(await readFile(resolve(__dirname, 'package.json'), 'utf8'));
const APP_VERSION = pkg.version;

// API responses are live state, never cacheable. They carried only an ETag and
// no Cache-Control, which lets Chromium apply heuristic freshness and serve
// them from its own disk cache — a cache that lives in the user-data dir and
// survives restarting the app. Campaign settings edited on disk kept coming
// back as the previous values, and an updated app kept reporting its old
// version, because the renderer never asked the server (operator, 2026-09-04).
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.json());
app.use(cookieParser());

// ── Public auth endpoints (no session required) ────────────────────
const PUBLIC_PATHS = new Set([
  '/login.html', '/signup.html', '/electron-login.html',
  '/api/auth/login', '/api/auth/signup', '/api/auth/logout', '/api/auth/electron-login',
  '/api/auth/reset',
  '/api/health',
  // help.html is a static onboarding manual with zero sensitive content —
  // safe to expose without auth so Electron's target="_blank" link works
  // from any browser (the link opens in the system browser, which lacks
  // the Electron session cookie and would otherwise bounce through login).
  '/help.html',
]);

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const verified = await verifyCredentials(email, password);
    if (!verified) return res.status(401).json({ error: 'Invalid email or password' });
    await issueSessionCookie(res, verified);
    res.json({ ok: true, email: verified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (await userExists(normalized)) return res.status(409).json({ error: 'An account already exists for this email' });

    let allowed;
    try {
      allowed = await isEmailAllowed(normalized);
    } catch (err) {
      return res.status(503).json({ error: `Could not verify email: ${err.message}` });
    }
    if (!allowed) return res.status(403).json({ error: 'This email isn\'t authorized — operators must use an @ortusclub.com or @ortus.solutions email.' });

    await createUser(normalized, password);
    await issueSessionCookie(res, normalized);
    res.json({ ok: true, email: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.57.x — Forgot-password reset. Wipes the user's password record so
// they can re-sign-up with a new one. Campaigns, sheets, presets, and
// notification prefs are NOT touched — they live in separate files keyed
// by email and survive the wipe. Email must still pass isEmailAllowed,
// so this can't be abused to wipe arbitrary accounts.
app.post('/api/auth/reset', async (req, res) => {
  try {
    const { email } = req.body || {};
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized.includes('@')) return res.status(400).json({ error: 'Enter a valid email' });

    let allowed;
    try {
      allowed = await isEmailAllowed(normalized);
    } catch (err) {
      return res.status(503).json({ error: `Could not verify email: ${err.message}` });
    }
    if (!allowed) return res.status(403).json({ error: 'This email isn\'t authorized — operators must use an @ortusclub.com or @ortus.solutions email.' });

    await deleteUser(normalized);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Electron-only frictionless login — email-only, no password. Verified against
// the SoO allowlist. Disabled outside Electron to keep the web/dev flow as-is.
app.post('/api/auth/electron-login', async (req, res) => {
  try {
    if (process.env.ORTUS_ELECTRON_MODE !== '1') {
      return res.status(404).json({ error: 'Not available outside Electron' });
    }
    const { email } = req.body || {};
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized.includes('@')) return res.status(400).json({ error: 'Enter a valid email' });

    let allowed;
    try {
      allowed = await isEmailAllowed(normalized);
    } catch (err) {
      return res.status(503).json({ error: `Could not verify email: ${err.message}` });
    }
    if (!allowed) return res.status(403).json({ error: 'This email isn\'t authorized — operators must use an @ortusclub.com or @ortus.solutions email.' });

    if (!(await userExists(normalized))) {
      // Auto-create with a random unguessable password — never used (no
      // password login path exists in Electron mode), just satisfies the
      // existing user-store schema so /api/me etc. continue to work.
      const placeholder = (await import('node:crypto')).randomBytes(32).toString('hex');
      await createUser(normalized, placeholder);
    }
    await issueSessionCookie(res, normalized);
    res.json({ ok: true, email: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve login/signup assets + their CSS/JS/fonts before the auth gate so
// unauthenticated browsers can actually render the login page. The app.js
// and style.css are public by nature (client code) — no secrets there.
const PUBLIC_PREFIXES = ['/css/', '/js/', '/fonts/', '/images/'];
app.get('/login.html', (_req, res) => res.sendFile(resolve(__dirname, 'public', 'login.html')));
app.get('/signup.html', (_req, res) => res.sendFile(resolve(__dirname, 'public', 'signup.html')));
app.get('/electron-login.html', (_req, res) => res.sendFile(resolve(__dirname, 'public', 'electron-login.html')));
app.use((req, res, next) => {
  if (PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) {
    return express.static(resolve(__dirname, 'public'))(req, res, next);
  }
  next();
});

// ── Session gate ───────────────────────────────────────────────────
app.use(async (req, res, next) => {
  // Electron mode: no login required — the app is a local desktop tool.
  if (process.env.ORTUS_ELECTRON_MODE === '1') {
    req.user = req.user || 'operator@ortusclub.com';
    return next();
  }
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith('/sketches/') || req.path === '/sketches.html') return next();
  const email = await readSessionFromRequest(req);
  if (!email) {
    // API calls get 401 JSON; page navigations get redirected to the right login page.
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login.html');
  }
  req.user = email;
  next();
});

// Who-am-I endpoint used by the dashboard to show the logged-in user
// Admin list — ADMIN_EMAILS env (comma-separated), with antonio as the default
// so an unset env still has one admin. Used by the client for the admin-vs-own
// campaigns view + Conductor filter.
const ADMIN_EMAIL_SET = new Set(
  String(process.env.ADMIN_EMAILS || 'antonio@ortusclub.com,antoniov@ortusclub.com,sam@ortusclub.com')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
);
function isAdminEmail(email) {
  return ADMIN_EMAIL_SET.has(String(email || '').trim().toLowerCase());
}
// The admin decision MUST use the per-machine operator identity, not req.user:
// every install logs in with the SAME shared dashboard credential, so req.user
// can't tell operators apart. getOperatorEmail() is the authoritative "who's
// actually here" (antonio@ / antoniov@ / …); fall back to the login only when
// no operator email is set.
function viewerIsAdmin(req) {
  return isAdminEmail(viewerEmail(req));
}

// Who is actually sitting at this install. Same precedence as viewerIsAdmin and
// for the same reason: the dashboard login is shared across installs, so only
// the per-machine operator identity distinguishes people. This is the email the
// GoLogin-account rule reads — an @linkedvelocity.com operator gets the Linked
// Velocity workspace, everyone else gets Ortus.
function viewerEmail(req) {
  return getOperatorEmail() || (req && req.user) || '';
}

// The GoLogin account this viewer may drive.
function viewerAccount(req) {
  return accountForEmail(viewerEmail(req));
}

/**
 * Refuse a launch that includes profiles from a GoLogin account this operator
 * doesn't belong to. Responds and returns true when it rejects.
 *
 * The picker already greys those tiles, but the picker is not the only way a
 * profileId reaches a launch: saved drafts, presets, the queue and re-launched
 * history all carry raw ids. Without this the request would reach GoLogin with
 * the wrong workspace's token and fail as an opaque 404 mid-campaign.
 *
 * Fail-open on purpose. A single-account install and an unlistable GoLogin API
 * both mean "we cannot prove this profile is foreign" — and blocking every
 * launch on that would turn a second-account outage into a total outage.
 */
async function rejectIfForeignProfiles(req, res, profileIds, mode) {
  const ids = (profileIds || []).filter((id) => id && id !== 'local-browser');
  if (!ids.length) return false;
  if (configuredAccounts().length < 2) return false;
  try { await getProfiles(); } catch { return false; }

  const email = viewerEmail(req);

  // Two independent reasons an account can be refused, reported separately —
  // "wrong workspace" and "this workspace doesn't do that" are different
  // problems and a merged message would send the operator looking in the wrong
  // place. Wrong-workspace is checked first because it is the harder block:
  // switching campaign type cannot fix it.
  const foreign = ids.filter((id) => !canOperatorUseProfile(email, accountOfProfile(id), id));
  if (foreign.length) {
    const theirs = accountLabel(viewerAccount(req));
    res.status(403).json({
      error: `${foreign.length} selected account(s) belong to a different GoLogin workspace. `
        + `You are signed in as ${email || 'an unknown operator'}, which can only run ${theirs} accounts.`,
    });
    return true;
  }

  const wrongMode = ids.filter((id) => !accountAllowsMode(accountOfProfile(id), mode));
  if (wrongMode.length) {
    const label = accountLabel(accountOfProfile(wrongMode[0]));
    const allowed = (accountModes(accountOfProfile(wrongMode[0])) || [])
      .map((m) => (m === POST_AMPLIFICATION_MODE ? 'Post Amplification' : 'Follower Growth'))
      .join(' and ');
    res.status(403).json({
      error: `${wrongMode.length} selected account(s) are ${label} accounts, which can only run ${allowed}.`,
    });
    return true;
  }

  return false;
}

app.get('/api/me', (req, res) => {
  res.json({ email: req.user, operatorEmail: getOperatorEmail() || '', admin: viewerIsAdmin(req) });
});

// The SPA entry document must NEVER be cached. index.html carries the
// `app.js?v=<version>` cache-buster, so if the browser 304-revalidates and
// keeps a stale index.html, the renderer stays pinned to the OLD app.js build
// no matter how many times we bump the version — the operator sees the same
// old code after a normal reload (this is exactly the "app is still at 2.145"
// symptom). Serving it no-store means every reload fetches a fresh 200 with
// the current cache-buster, and app.js?v=<version> handles app.js caching.
// Placed after the session gate so it still requires auth.
app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(resolve(__dirname, 'public', 'index.html'));
});

app.use(express.static(resolve(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Server log capture (ring buffer for dashboard)
// ---------------------------------------------------------------------------
const serverLogs = [];
const MAX_SERVER_LOGS = 500;
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function captureLog(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
  serverLogs.push(line);
  if (serverLogs.length > MAX_SERVER_LOGS) serverLogs.shift();
}

console.log = (...args) => { captureLog('LOG', args); origLog.apply(console, args); };
console.warn = (...args) => { captureLog('WARN', args); origWarn.apply(console, args); };
console.error = (...args) => { captureLog('ERR', args); origError.apply(console, args); };

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  // Make the runtime target visible in the app. A development Electron build
  // can point at a frozen engine image without moving the team's live engine.
  const scraperEngineUrl = getScrapeEngineUrl();
  const productionEngineUrl = 'https://scraper.ortusclub.com';
  const isProductionEngine = scraperEngineUrl.replace(/\/+$/, '') === productionEngineUrl;
  const productionEngineVersion = process.env.PRODUCTION_ENGINE_VERSION || 'v139';
  const scraperEngineVersion = process.env.SCRAPER_ENGINE_VERSION
    || (isProductionEngine ? productionEngineVersion : 'unverified');
  res.json({
    ok: true,
    time: new Date().toISOString(),
    version: APP_VERSION,
    scraperConfigured: isScraperConfigured(),
    scraperEngineUrl,
    scraperEngineVersion,
    scraperEngineEnvironment: isProductionEngine ? 'production' : 'development',
    productionEngineUrl,
    productionEngineVersion,
  });
});

// ---------------------------------------------------------------------------
// In-app updater — check GitHub Releases, download + open the matching DMG.
// Unsigned builds can't silently self-update, so "update" = fetch the newest
// DMG and open it for the operator to drag into /Applications.
// ---------------------------------------------------------------------------
let _updateCheckCache = null; // { ts, payload }
const UPDATE_CHECK_TTL_MS = 5 * 60 * 1000;

app.get('/api/update-check', async (req, res) => {
  // Serve a recent cached result to avoid hammering GitHub's unauthenticated
  // 60-req/hr limit when the UI re-checks on every dashboard load / 30-min
  // poll. ?force=1 (the manual "Check for updates" button) bypasses the cache
  // so the operator gets an up-to-the-second answer.
  const force = req.query.force === '1' || req.query.force === 'true';
  if (!force && _updateCheckCache && Date.now() - _updateCheckCache.ts < UPDATE_CHECK_TTL_MS) {
    return res.json(_updateCheckCache.payload);
  }
  const arch = archLabel(process.arch);
  try {
    const resp = await fetch(LATEST_RELEASE_API, {
      headers: { 'User-Agent': 'ortus-outreach-app', Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    const rel = await resp.json();
    const latest = parseVersion(rel.tag_name);
    const payload = {
      ok: true,
      current: APP_VERSION,
      latest,
      behind: isBehind(APP_VERSION, latest),
      arch,
      asset: dmgAssetName(arch),
      downloadUrl: latestDownloadUrl(arch),
      releaseUrl: latestReleaseUrl(),
    };
    _updateCheckCache = { ts: Date.now(), payload };
    res.json(payload);
  } catch (err) {
    // Network/API failure → tell the UI we couldn't check; it just hides the
    // pill rather than showing a false "up to date".
    res.json({ ok: false, current: APP_VERSION, arch, error: err.message });
  }
});

// Live download state so the UI can show a progress bar under the button.
// The DMG is ~108 MB; a full download takes a while on slow connections and
// the operator otherwise can't tell how long it'll take. The POST kicks the
// download off and returns immediately; the UI polls GET /api/update-progress.
let _downloadState = { active: false, received: 0, total: 0, done: false, error: null, path: null };

app.post('/api/update-download', (_req, res) => {
  if (_downloadState.active) return res.json({ ok: true, alreadyRunning: true });
  const arch = archLabel(process.arch);
  const asset = dmgAssetName(arch);
  const url = latestDownloadUrl(arch);
  // Prefer ~/Downloads so the operator can find the DMG; fall back to a temp dir.
  const downloads = join(homedir(), 'Downloads');
  const destDir = existsSync(downloads) ? downloads : tmpdir();
  const dest = join(destDir, asset);
  _downloadState = { active: true, received: 0, total: 0, done: false, error: null, path: dest };

  // Run the download in the background, streaming chunk counts into
  // _downloadState. Not awaited — the response returns right away.
  (async () => {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'ortus-outreach-app' } });
      if (!resp.ok || !resp.body) throw new Error(`download failed: HTTP ${resp.status}`);
      _downloadState.total = Number(resp.headers.get('content-length')) || 0;
      const nodeStream = Readable.fromWeb(resp.body);
      nodeStream.on('data', (chunk) => { _downloadState.received += chunk.length; });
      await pipeline(nodeStream, createWriteStream(dest));
      _downloadState.done = true;
      // NB: the DMG is NOT opened here anymore. The client calls
      // /api/update-install next, which either auto-swaps + relaunches
      // (packaged) or opens the DMG for a manual drag (dev/fallback).
    } catch (err) {
      _downloadState.error = err.message;
    } finally {
      _downloadState.active = false;
    }
  })();

  res.json({ ok: true, started: true });
});

app.get('/api/update-progress', (_req, res) => res.json(_downloadState));

// v2.77: one-click auto-install. After the DMG has downloaded, swap the new
// build into /Applications and relaunch — no manual quit/drag. Works on the
// unsigned build because we strip the quarantine flag exactly like
// install-mac.sh does, so Gatekeeper doesn't block. Only runs when the app is
// launched from a packaged .app bundle; otherwise the caller falls back to
// opening the DMG.
function _packagedAppBundlePath() {
  // process.execPath in a packaged build:
  //   /Applications/<productName>.app/Contents/MacOS/<productName>
  const m = String(process.execPath || '').match(/^(.*\.app)\/Contents\/MacOS\//);
  if (!m) return null;
  // In dev (`electron .`) execPath points at node_modules/.../Electron.app —
  // never swap that. Only the real installed bundle qualifies.
  if (!m[1].endsWith(`/${pkg.productName}.app`)) return null;
  return m[1];
}

app.post('/api/update-install', (_req, res) => {
  const appBundle = _packagedAppBundlePath();
  const dmg = _downloadState.path;
  // Not packaged (dev) or no downloaded DMG → open the DMG for a manual
  // drag-install and tell the UI to show the drag hint.
  if (process.platform !== 'darwin' || !appBundle || !dmg || !existsSync(dmg)) {
    if (process.platform === 'darwin' && dmg && existsSync(dmg)) {
      spawn('open', [dmg], { detached: true, stdio: 'ignore' }).unref();
    }
    return res.json({ ok: true, fallback: true });
  }

  // A detached helper survives this app quitting: it waits for the process to
  // exit, swaps the bundle (with a backup for rollback), strips quarantine,
  // and relaunches. Keeps the DMG so the curl installer is always a fallback.
  const logPath = join(tmpdir(), 'ortus-update.log');
  const scriptPath = join(tmpdir(), 'ortus-update.sh');
  const script = `#!/bin/bash
DMG="$1"; APP="$2"; LOG="$3"
exec >"$LOG" 2>&1
echo "[updater] waiting for app to quit…"
for i in $(seq 1 120); do
  pgrep -f "$APP/Contents/MacOS/" >/dev/null || break
  sleep 0.5
done
# Never swap the bundle underneath a still-running app: it keeps showing the old
# version and "relaunch" only re-focuses it. Ask it to quit, then insist.
if pgrep -f "$APP/Contents/MacOS/" >/dev/null; then
  echo "[updater] app still running after 60s — asking it to quit"
  osascript -e 'tell application "${pkg.productName}" to quit' >/dev/null 2>&1
  for i in $(seq 1 40); do pgrep -f "$APP/Contents/MacOS/" >/dev/null || break; sleep 0.5; done
  if pgrep -f "$APP/Contents/MacOS/" >/dev/null; then
    echo "[updater] still running — terminating"; pkill -TERM -f "$APP/Contents/MacOS/"; sleep 3
  fi
fi
cd /tmp 2>/dev/null
sleep 1
MNT="$(mktemp -d /tmp/ortus-mnt.XXXXXX)"
if ! hdiutil attach "$DMG" -nobrowse -noautoopen -mountpoint "$MNT" >/dev/null 2>&1; then
  echo "[updater] mount failed — opening DMG for manual install"; open "$DMG"; exit 1
fi
# Pick the REAL app by explicit name — the DMG also contains
# "Ortus Outreach Setup.app", which sorts BEFORE the real bundle.
# The old "ls *.app | head -1" grabbed that helper and clobbered the real app,
# so the update installed the Setup helper instead (install-mac.sh always
# copied by explicit name, which is why the terminal installer was immune).
SRC="$MNT/${pkg.productName}.app"
if [ ! -d "$SRC" ]; then
  SRC="$(/bin/ls -d "$MNT/"*.app 2>/dev/null | grep -vi 'Setup' | head -1)"
fi
if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  SRC="$(/bin/ls -d "$MNT/"*.app 2>/dev/null | head -1)"
fi
if [ -z "$SRC" ]; then
  echo "[updater] no .app in DMG"; hdiutil detach "$MNT" >/dev/null 2>&1; open "$DMG"; exit 1
fi
PARENT="$(dirname "$APP")"
STAGE="$PARENT/.ortus-update-stage.app"
BK="$PARENT/.ortus-update-backup.app"
rm -rf "$STAGE" "$BK"
echo "[updater] staging copy…"
if ! cp -R "$SRC" "$STAGE"; then
  echo "[updater] copy failed — opening DMG for manual install"
  rm -rf "$STAGE"; hdiutil detach "$MNT" >/dev/null 2>&1; open "$DMG"; exit 1
fi
hdiutil detach "$MNT" >/dev/null 2>&1
echo "[updater] swapping bundle…"
mv "$APP" "$BK" && mv "$STAGE" "$APP"
if [ ! -d "$APP" ]; then
  echo "[updater] swap failed — restoring backup"
  [ -d "$BK" ] && mv "$BK" "$APP"
  open "$DMG"; exit 1
fi
rm -rf "$BK"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
echo "[updater] relaunching"
# One open call is not enough. macOS sometimes refuses to launch a bundle it has
# just watched get replaced — LaunchServices is still holding the old record —
# and the helper exits "successfully" with no app on screen (operator,
# 2026-09-04: swap logged, /Applications on the new version, nothing running).
# Re-register the bundle, then retry until a process actually appears.
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREG" ] && "$LSREG" -f "$APP" >/dev/null 2>&1
for i in 1 2 3 4 5; do
  open "$APP" 2>&1 && sleep 2
  if pgrep -f "$APP/Contents/MacOS/" >/dev/null; then
    echo "[updater] relaunched on attempt $i"; exit 0
  fi
  echo "[updater] relaunch attempt $i did not stick — retrying"
  sleep 2
done
echo "[updater] could not relaunch — the update IS installed; open Ortus Basics from Applications"
`;
  try {
    writeFileSync(scriptPath, script, 'utf8');
    chmodSync(scriptPath, 0o755);
    spawn('bash', [scriptPath, dmg, appBundle, logPath], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }

  // Respond first, then quit so the helper can swap + relaunch. Quitting needs
  // app.isQuitting=true to bypass the tray "hide on close" behavior.
  res.json({ ok: true, relaunching: true });
  // This server is a CHILD of the Electron main process (ELECTRON_RUN_AS_NODE),
  // so it has no `app` to quit — the old import('electron') here silently did
  // nothing, the app never quit, and the helper swapped the bundle underneath a
  // still-running old version (operator, 2026-09-19). Exit with the code main.js
  // reads as "quit the whole app for an update".
  if (process.env.ORTUS_ELECTRON_MODE === '1') setTimeout(() => process.exit(76), 400);
});

// v2.112: expose the detached install-helper log so a failed update is
// diagnosable. The helper runs AFTER the app quits during a bundle swap, so
// its log is read on the NEXT launch. Read-only; no secrets in this log.
app.get('/api/update-log', async (_req, res) => {
  const logPath = join(tmpdir(), 'ortus-update.log');
  try {
    if (!existsSync(logPath)) {
      return res.json({ exists: false, downloadError: _downloadState.error || null });
    }
    const [text, st] = await Promise.all([readFile(logPath, 'utf8'), stat(logPath)]);
    res.json({ exists: true, text, mtimeMs: st.mtimeMs, downloadError: _downloadState.error || null });
  } catch (err) {
    res.json({ exists: false, error: err.message });
  }
});

app.get('/api/server-log', (_req, res) => {
  res.json(serverLogs.slice(-200));
});

app.delete('/api/server-log', (_req, res) => {
  serverLogs.length = 0;
  res.json({ cleared: true });
});

// ---------------------------------------------------------------------------
// GoLogin profiles
// ---------------------------------------------------------------------------
// v2.160.138 — the list now spans every configured GoLogin account (Ortus +
// Linked Velocity). Each profile carries `account` (who owns it) and
// `available` (whether THIS operator may use it). Profiles from the other
// account are still returned, not filtered out: the operator decision was to
// keep the whole roster legible and mark the rest unavailable, so nobody
// wonders where an account went.
app.get('/api/profiles', async (req, res) => {
  try {
    const profiles = await getProfiles();
    const email = viewerEmail(req);
    res.json(profiles.map((p) => ({
      ...p,
      available: canOperatorUseProfile(email, p.account, p.id),
      // Reached through a grant or a named membership rather than by owning the
      // workspace. The picker uses it to stop applying the Ortus SoO to an
      // account another team runs — see usesProfileAsGuest.
      guest: usesProfileAsGuest(email, p.account, p.id),
      accountLabel: accountLabel(p.account),
      // null = runs anything. An array means the picker must re-check on every
      // campaign-type change, which is why this ships with the list rather than
      // being resolved server-side: the server doesn't know the selected mode.
      allowedModes: accountModes(p.account),
    })));
  } catch (err) {
    console.error('Error fetching profiles:', err.message);
    const unauthorized = /GoLogin API 401|unauthori[sz]ed/i.test(String(err && err.message));
    const devEngine = /^dev-/.test(String(process.env.SCRAPER_ENGINE_VERSION || ''));
    res.status(unauthorized ? 401 : 500).json({
      error: unauthorized
        ? (devEngine
          ? 'DEV GOLOGIN TOKEN REJECTED (HTTP 401). No development profiles can be loaded, so campaign browsers cannot open. Replace DEV_GOLOGIN_API_TOKEN in the engine .env and Kubernetes salesnav-secrets-dev, then restart this app. Production profiles are intentionally hidden here.'
          : 'GoLogin rejected the configured API token (HTTP 401). Replace the token, then restart the app.')
        : err.message,
      code: unauthorized ? 'GOLOGIN_UNAUTHORIZED' : 'PROFILE_LOAD_FAILED',
      environment: devEngine ? 'development' : 'production',
    });
  }
});

// ---------------------------------------------------------------------------
// SoO (State of Operations) — account status from internal sheet
// ---------------------------------------------------------------------------
// Admin-email debouncing: send one email per failure streak. Reset on success.
let sooFailureNotified = false;

async function emailAdminsOnSoOFailure(err) {
  if (sooFailureNotified) return;
  sooFailureNotified = true;
  const recipients = (process.env.ADMIN_EMAILS || 'antonio@ortusclub.com')
    .split(',').map(s => s.trim()).filter(Boolean);
  await Promise.all(recipients.map(to => notifyEmail(to, {
    title: 'SoO status unavailable',
    body:
      `The State of Operations endpoint is failing.\n\n` +
      `Error code: ${err.code}\nMessage: ${err.message}\n\n` +
      `GDs will see a "SoO unavailable — click refresh to try again" pill\n` +
      `in the right pane until this is fixed. No further emails will be sent\n` +
      `for this failure streak; a new email will only fire after a successful\n` +
      `fetch is observed in between.`,
    link: '/',
  }).catch(() => {})));
}

app.get('/api/soo-status', async (req, res) => {
  try {
    const result = await fetchSoOStatusData({ force: req.query.refresh === '1' });
    if (result.state === 'fresh') {
      sooFailureNotified = false; // reset on success
    } else if (result.error) {
      console.error(`SoO refresh failed [${result.error.code}]; serving last successful snapshot:`, result.error.message);
      emailAdminsOnSoOFailure(result.error).catch(() => {});
    }
    res.json({
      ...result.data,
      _sooMeta: { state: result.state, fetchedAt: result.fetchedAt },
    });
  } catch (err) {
    console.error(`SoO fetch error [${err.code}]:`, err.message);
    emailAdminsOnSoOFailure(err).catch(() => {});
    res.status(503).json({ error: err.message, errorCode: err.code });
  }
});

// ---------------------------------------------------------------------------
// Google Sheet preview
// ---------------------------------------------------------------------------
app.get('/api/sheet/preview', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });

    const rows = await fetchSheet(url);
    res.json({
      totalRows: rows.length,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      preview: rows.slice(0, 5),
    });
  } catch (err) {
    console.error('Sheet preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Tab enumeration — used by the frontend tab picker (Task 4, Fix A).
// Returns the list of sheets/tabs in the workbook so the operator can choose
// which tab is the lead source. Delegates to the Apps Script listTabs action
// via listSheetTabs(); requires the script to be redeployed with that action.
// ---------------------------------------------------------------------------
app.get('/api/sheet/tabs', async (req, res) => {
  try {
    const sheetUrl = (req.query.sheetUrl || '').toString().trim();
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
    if (!spreadsheetIdFromUrl(sheetUrl)) {
      return res.status(400).json({ error: 'sheetUrl required' });
    }
    const tabs = await listSheetTabs(sheetUrl);
    res.json({ tabs });
  } catch (err) {
    console.error('Sheet tabs error:', err.message);
    res.status(502).json({ error: `Could not read tabs — is the Apps Script redeployed? (${err.message})` });
  }
});

// 2.8.29: Check Status preview. Reads the sheet, counts rows where Account
// Used (column D) is filled — that's the signal an invite went out. CC text
// is no longer the source of truth. Cross-references the senders with
// available GoLogin profile names and returns per-account coverage.
app.get('/api/check-status/preview', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });

    const [rows, profiles] = await Promise.all([
      fetchSheet(url),
      (async () => {
        try {
          const { getProfiles } = await import('./src/gologin-launcher.js');
          const token = process.env.GOLOGIN_API_TOKEN;
          if (!token) return [];
          return await getProfiles(token);
        } catch { return []; }
      })(),
    ]);

    const knownNames = new Set(profiles.map(p => p.name));
    // 2.8.29: local-browser variants are valid pseudo-profiles.
    const LOCAL_BROWSER_NAMES = new Set(['Local Browser', 'local-browser', 'local-browser - manual']);

    // 2.8.32: same endpoint serves both check_status (Account Used filled)
    // and message_only (CC ends with " Y") via ?mode= query param.
    const mode = (req.query.mode || 'check_status').toString();

    const byAccount = {};
    const unmatched = {};
    let totalPending = 0;
    for (const row of rows) {
      // v2.11.11: Sender is canonical; Account Used is legacy.
      const acct = (row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').toString().trim();
      if (!acct) continue;
      if (mode === 'message_only') {
        // Filter: CC ends with " Y" (Voyager-confirmed acceptance from a
        // prior Check Status run). Sender drives routing.
        const ccRaw = (row['CC'] || row['cc'] || '').toString();
        if (!/\sY\s*$/.test(ccRaw)) continue;
      }
      totalPending++;
      if (LOCAL_BROWSER_NAMES.has(acct)) {
        byAccount['Local Browser'] = (byAccount['Local Browser'] || 0) + 1;
      } else if (knownNames.has(acct)) {
        byAccount[acct] = (byAccount[acct] || 0) + 1;
      } else {
        unmatched[acct] = (unmatched[acct] || 0) + 1;
      }
    }

    // Rough runtime estimate: ~25s per lead with the 2.8.29 fast-path
    // (domcontentloaded nav + Voyager API, no DOM settle for degree-1 hits).
    const runtimeSeconds = totalPending * 25;

    res.json({
      totalPending,
      byAccount: Object.entries(byAccount).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      unmatched: Object.entries(unmatched).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      accountsCount: Object.keys(byAccount).length,
      runtimeSeconds,
    });
  } catch (err) {
    console.error('Check status preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Template preview — render current templates against the first 3 leads so
// the operator can spot missing variables / over-limit messages before launch.
// Same body shape as /api/campaign/start so the client can reuse its form-
// state gatherer. Errors are returned as 200 + { previews: [], error } so the
// UI can always render a readable message.
// ---------------------------------------------------------------------------
app.post('/api/templates/preview', async (req, res) => {
  try {
    const {
      sheetUrl,
      linkedinColumn = '',
      templates = {},
      profileIds = [],
      senderFirstNames = {},
      // Account id → the account's NAME, resolved by the app (it rendered the
      // picker with them). See the pName comment below for why.
      senderNames = {},
      // v2.59.x — IC + message_only resolve {senderFirstName} per-row from
      // the sheet's sender column (the real send path does this). Without
      // mode + senderColumn the preview falls back to the operator's
      // locally-selected profile, which is the wrong identity for these
      // modes (each row can have a different sender).
      mode = '',
      senderColumn = '',
    } = req.body || {};

    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    // Mirror campaign.js:280-289 template normalization so legacy aliases work.
    // v2.11.14: introTitle joins as a 7th preview field so operators can
    // sanity-check the LinkedIn group thread title before launching an IC run.
    const tpl = {
      connectionNote: templates.connectionNote || templates.note || '',
      followUpMessage: templates.followUpMessage || templates.followUp1 || '',
      inmailSubject: templates.inmail?.subject || templates.inmailSubject || '',
      inmailBody: templates.inmail?.message || templates.inmailBody || '',
      opProfileSubject: templates.openProfileSubject || templates.opSubject || '',
      opProfileBody: templates.openProfileBody || templates.opBody || '',
      introTitle: templates.introTitle || '',
      // v2.59.x — Render the Intro DM Body as its own preview field so IC
      // and CC+IC operators can see what they typed. Send-path routing
      // differs by mode (IC via followUpMessage, CC+IC via runAutoIntros'
      // primaryIntroBody) but the preview just needs to show the text.
      primaryIntroBody: templates.primaryIntroBody || '',
      // v2.160.127 — CC+IC automated first follow-up, sent into the group thread
      // after the last intro. Rendered here so {First Name} etc. resolve and
      // unresolved placeholders raise the same warnings as every other field.
      // The client blanks it unless the follow-up toggle is actually on.
      followUpBody: templates.followUpBody || '',
      // v2.62 — CC+DM (connect_and_message) phase-2 body. Plain 1:1 DM
      // after acceptance, no primary person.
      ccDmBody: templates.ccDmBody || '',
    };

    // v2.11.14: extract intro-mode signals so the preview can mirror the
    // runtime substitution in outreach.js (introData construction).
    const introMode = !!templates.introMode;
    const introName = (templates.introName || '').toString().trim();
    const introTokens = introName.split(/\s+/);
    const introFirst = introMode ? (introTokens[0] || '') : '';
    const introLast  = introMode ? (introTokens.slice(1).join(' ')) : '';

    const anyFilled = Object.values(tpl).some(v => v && v.trim());
    if (!anyFilled) {
      return res.status(400).json({ error: 'At least one template field must be provided' });
    }

    // Fetch the sheet — if this fails we return 200 + error so the UI can
    // show it without parsing error codes (mirrors the general pattern).
    let rows;
    try {
      rows = await fetchSheet(sheetUrl);
    } catch (err) {
      console.error('Templates preview — sheet fetch error:', err.message);
      return res.json({ previews: [], error: err.message });
    }

    // Pick the first 3 rows with an extractable LinkedIn URL.
    const picked = [];
    for (const row of rows) {
      if (picked.length >= 3) break;
      const url = extractLinkedInUrl(row, linkedinColumn);
      if (url) picked.push({ row, url });
    }

    const profileId = profileIds[0] || '';
    // {senderName} resolves at send time to the GoLogin account's NAME
    // (campaign.js: profileNameCache[profileId]). There is no live GoLogin
    // session in a preview, so this used to stand the raw profile id in for the
    // name — and an operator's preview signed off "Thanks,
    // 6a5ee8d17da88c4708b30689" (2026-09-01). A preview that does not match what
    // will actually be sent is worse than no preview: it hid that the template
    // was using {senderName} where {senderFirstName} was meant.
    //
    // The app knows every selected account's name and now sends it. Falling back
    // to the id would reintroduce the same lie, so when the name is genuinely
    // unknown {senderName} resolves to nothing rather than to a hash.
    const pName = (senderNames && senderNames[profileId]) || '';

    // v2.59.x — Build SoO email → firstName map for per-row sender lookup
    // in IC and message_only previews. Done once per request, so picking 3
    // rows from a sheet of any size costs one SoO fetch. Failures are
    // logged but non-fatal — preview falls back to the old profileIds[0]
    // resolution if SoO is unreachable.
    const _wantsPerRowSender = (mode === 'introduce_back' || mode === 'message_only');
    const _soOFirstByName = {};
    if (_wantsPerRowSender) {
      try {
        const soo = await fetchSoOData();
        for (const acct of (soo && soo.accounts) || []) {
          if (acct && acct.email) {
            _soOFirstByName[acct.email.toLowerCase().trim()] = (acct.firstName || '').toString().trim();
          }
        }
      } catch (err) {
        console.warn('[preview] SoO fetch for per-row sender failed:', err.message);
      }
    }

    const previews = picked.map(({ row, url }) => {
      // Mirror campaign.js:603-612 data construction.
      const data = { ...row };
      data.firstName = row['First Name'] || row['firstName'] || row['first_name'] || '';
      data.lastName  = row['Last Name']  || row['lastName']  || row['last_name']  || '';
      data.company   = row['Company']    || row['company']   || '';
      data.title     = row['Title']      || row['title']     || row['Job Title']  || '';
      // v2.59.x — Per-row sender lookup for IC and message_only. The sheet
      // tells us which account owns each lead; the real send path uses
      // getSenderName(row, senderColumn) — we mirror that exactly here so
      // {senderFirstName} and {senderName} in the preview match what will
      // actually be sent. For CC+IC and other modes we keep the old logic
      // (resolvedFirst from selectedProfileIds → senderFirstNames map).
      let _perRowSender = '';
      if (_wantsPerRowSender) {
        if (senderColumn && row[senderColumn] != null) {
          _perRowSender = row[senderColumn].toString().trim();
        }
        if (!_perRowSender) {
          _perRowSender = (row.Sender || row.sender || '').toString().trim();
        }
      }
      const _perRowFirst = _perRowSender
        ? (_soOFirstByName[_perRowSender.toLowerCase()] || '')
        : '';

      data.senderName = _perRowSender || pName || '';
      const resolvedFirst = _perRowFirst || senderFirstNames[profileId];
      // v2.11.14: friendlier fallback for local-browser — if the operator
      // hasn't set a localBrowserFirstName yet, prefer "You" over the raw
      // profile id string so the preview reads naturally.
      const fallbackFirst = (profileId === 'local-browser')
        ? 'You'
        : ((pName || '').split(/\s+/)[0] || '');
      data.senderFirstName = (resolvedFirst && resolvedFirst.trim()) || fallbackFirst;

      // v2.11.14: when intro mode is on, mirror outreach.js:462's introData
      // injection so {intro name} / {intro first name} / {intro last name}
      // resolve in the preview the same way they will at send time. Keys
      // cover all three naming conventions used in the message templates.
      if (introMode && introName) {
        data['intro name']      = introName;
        data['introName']       = introName;
        data['intro_name']      = introName;
        data['intro first name']  = introFirst;
        data['introFirstName']    = introFirst;
        data['intro_first_name']  = introFirst;
        data['intro last name']   = introLast;
        data['introLastName']     = introLast;
        data['intro_last_name']   = introLast;
      }

      // v2.59.x — Primary-person substitution for CC+IC (and IC, which
      // shares the same chip vocabulary). Mirrors what auto-intro.js does
      // at send time so {primary full name} / {primary first name} /
      // {primary last name} / {primary url} resolve in the preview.
      const primaryName = (templates.primaryName || '').toString().trim();
      const primaryUrl  = (templates.primaryUrl  || '').toString().trim();
      if (primaryName) {
        const pTokens = primaryName.split(/\s+/);
        const pFirst  = pTokens[0] || '';
        const pLast   = pTokens.slice(1).join(' ');
        data['primary full name'] = primaryName;
        data['primary name']      = primaryName; // legacy alias
        data['primary first name'] = pFirst;
        data['primaryFirstName']   = pFirst;
        data['primary last name']  = pLast;
        data['primaryLastName']    = pLast;
      }
      if (primaryUrl) {
        data['primary url'] = primaryUrl;
        data['primaryUrl']  = primaryUrl;
      }

      // For each field, scan the raw template for {placeholders}, compute
      // unresolved ones, then render.
      const warnings = [];
      const rendered = {};
      const fieldLabels = {
        connectionNote: 'Connection Note',
        followUpMessage: 'Follow-up Message',
        inmailSubject: 'InMail Subject',
        inmailBody: 'InMail Body',
        opProfileSubject: 'Open Profile Subject',
        opProfileBody: 'Open Profile Body',
        introTitle: 'Group conversation title',
        primaryIntroBody: 'Intro DM Body',
        followUpBody: 'First follow-up message',
        ccDmBody: 'CC+DM body',
      };
      for (const [key, raw] of Object.entries(tpl)) {
        if (!raw) { rendered[key] = ''; continue; }
        const placeholderMatches = raw.match(/\{([a-zA-Z0-9_ ]+)\}/g) || [];
        const unresolved = placeholderMatches
          .map(m => m.slice(1, -1))
          .filter(name => {
            const val = data[name];
            return val === undefined || val === null || val === '';
          });
        for (const name of unresolved) {
          warnings.push(`{${name}} not resolved for ${fieldLabels[key]}`);
        }
        rendered[key] = personalizeTemplate(raw, data);
      }

      return {
        lead: {
          firstName: data.firstName,
          lastName: data.lastName,
          company: data.company,
          url,
        },
        rendered,
        warnings,
      };
    });

    res.json({ previews });
  } catch (err) {
    console.error('Templates preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Campaign control
// ---------------------------------------------------------------------------
// Build a clean campaign config from a request body. Shared between the
// /api/campaign/start handler and the queue runner so a queued campaign
// v2.104: server-side mirror of the wizard's primary-URL hard-lock (defense in
// depth — covers re-run/restore/queue-only paths that don't go through the
// browser gate). For the intro flows only (v2.112): the primaryUrl is REQUIRED
// (blank rejected) and, when present, must be a real personal /in/ profile.
// Shares validatePrimaryUrl with the client, so
// the reject reason matches the inline error the operator saw. Returns true
// (and sends a 400) when the request should be rejected.
function rejectIfBadPrimaryUrl(body, res) {
  const mode = body && body.mode;
  if (mode !== 'connect_and_introduce' && mode !== 'introduce_back') return false;
  const url = ((body && body.templates && body.templates.primaryUrl) || '').toString().trim();
  if (!url) {
    // v2.119: ICB's URL is optional (leads are already connected; the URL only
    // feeds the {primary url} placeholder). Blank is allowed for introduce_back;
    // CC+IC still requires it for the connected-to-primary check + auto-accept.
    if (mode === 'introduce_back') return false;
    res.status(400).json({ error: 'Primary person URL is required for this mode.' });
    return true;
  }
  const v = validatePrimaryUrl(url);
  if (!v.ok) {
    res.status(400).json({ error: `Primary person URL is invalid — ${v.reason}` });
    return true;
  }
  return false;
}

// Mandatory operator-identity gate. The shared dashboard login can't identify
// who's operating, so every reservation would mislabel; we hard-block campaign
// start until this machine's operator email is set. Returns true (and sends a
// 409 the UI turns into the mandatory modal) when it's missing.
function rejectIfNoOperatorEmail(res) {
  if (getOperatorEmail()) return false;
  res.status(409).json({ error: 'operator-email-required', code: 'OPERATOR_EMAIL_REQUIRED' });
  return true;
}

// Unattended-path guard. The HTTP start routes prompt with the mandatory modal
// (rejectIfNoOperatorEmail); but campaigns also launch WITHOUT an HTTP request —
// the queue drain, scheduled cron fires, and monitoring resume. Those paths
// funnel through here: no operator email → refuse to run and notify, so a
// scheduled/queued/resumed run can never write an anonymous "In Use" row to the
// SoO (the root cause of blank "CC App User" stamps). Returns true when blocked.
// `notifyTo` is the owner/createdBy to email; falls back to notifyAll when null.
function blockIfNoOperatorEmail(context, notifyTo) {
  if (getOperatorEmail()) return false;
  console.error(`[operator-gate] blocked ${context} — no operator email set on this machine`);
  const payload = {
    title: 'Blocked — set your operator email',
    body: `A campaign (${context}) could not run because this machine has no operator email set. Open the app, enter your work email, then start it again.`,
    link: '/',
  };
  (notifyTo ? notifyEmail(notifyTo, payload) : notifyAll(payload)).catch(() => {});
  return true;
}

// runs with exactly the same shape as a directly-launched one.
function buildCampaignConfig(body) {
  const identity = ensureCampaignIdentity({ campaignId: body?.campaignId, name: body?.name, config: body });
  const { profileIds, sheetUrl, templates, dailyLimit, mode, messageOpenProfiles,
          delayMin, delayMax, linkedinColumn, senderFirstNames, concurrency, name,
          acceptanceTrackingDays, preflightCheckStatus, checkIntervalMinutes,
          // v2.112: launch with the after-sending automatic checks off (default on).
          autoChecksEnabled,
          // v2.78: accounts to start benched (out of the rotation).
          benchedProfileIds,
          // v2.58.x — Introduction Campaign (introduce_back) sheet-mapping overrides.
          // Read for every campaign but only honored downstream when mode === 'introduce_back'.
          senderColumn, allLeadsConnected,
          // v2.59 (resume support): { totalProcessed } from the past history
          // entry being resumed. Seeded into campaign counters so the cockpit
          // continues counting from the saved total instead of zero.
          resumeContext,
          // #7: when the primary connect/check happens.
          primaryCheckTiming,
          // Fix A Task 4: explicit tab selection from the frontend picker.
          sheetGid: sheetGidRaw,
          // Fix A Task 4: frontend signals whether the workbook has multiple tabs.
          multiTab,
          // Fix B Task 3: pause the campaign when a 429/throttle is detected.
          // Defaults to true when absent or undefined so legacy clients opt-in automatically.
          pauseOnThrottle: pauseOnThrottleRaw, stopBeforeWeeklyReset, stopBeforeMonthlyReset, skipIntroductions } = body || {};
  const pauseOnThrottle = pauseOnThrottleRaw === false ? false : true;
  // Coerce sheetGid to digits only; fall back to extracting from the URL.
  const sheetGid = sheetGidRaw != null
    ? String(sheetGidRaw).replace(/\D/g, '')
    : extractSheetGid(sheetUrl || '');
  let concurrencyClean = 1;
  if (Number.isFinite(Number(concurrency)) && Number(concurrency) >= 2) {
    const n = Math.min(5, Number(concurrency));
    if ((profileIds?.length || 0) >= 5) concurrencyClean = n;
  }
  return {
    campaignId: identity.campaignId,
    profileIds,
    benchedProfileIds: Array.isArray(benchedProfileIds) ? benchedProfileIds.filter((x) => typeof x === 'string') : [],
    sheetUrl,
    templates: templates || {},
    dailyLimit: Number(dailyLimit),
    mode: mode || 'auto',
    messageOpenProfiles: !!messageOpenProfiles,
    delayMin: delayMin ? Number(delayMin) : undefined,
    delayMax: delayMax ? Number(delayMax) : undefined,
    linkedinColumn: linkedinColumn || '',
    // v2.58.x — IC-only overrides. Frontend already clears these for
    // non-IC modes; backend coerces here too for defence-in-depth.
    // v2.61: extended to include 'message_only' (Direct Messages) which
    // now mirrors IC's wizard extras (sender column + all-connected).
    senderColumn: (mode === 'introduce_back' || mode === 'message_only')
      ? (typeof senderColumn === 'string' ? senderColumn : '')
      : '',
    allLeadsConnected: (mode === 'introduce_back' || mode === 'message_only')
      ? !!allLeadsConnected
      : false,
    senderFirstNames: senderFirstNames || {},
    concurrency: concurrencyClean,
    name: identity.name,
    acceptanceTrackingDays: Math.max(0, Math.min(30, Number(acceptanceTrackingDays) || 0)),
    checkIntervalMinutes: clampCadenceMinutes(checkIntervalMinutes),
    // v2.112: default-on; only false when the operator explicitly turned it off.
    autoChecksEnabled: autoChecksEnabled !== false,
    // Honoured only when mode is message_only or introduce_back. campaign.js
    // gates further so other modes silently ignore the flag.
    preflightCheckStatus: !!preflightCheckStatus,
    // v2.59 resume — passed through to startCampaign which seeds counters.
    // Shape: { totalProcessed: number }. Other fields ignored for now.
    resumeContext: (resumeContext && typeof resumeContext === 'object') ? {
      totalProcessed: Number(resumeContext.totalProcessed) || 0,
    } : null,
    // #7: when the primary connect/check happens. 'immediately' (default) =
    // pre-loop handshake (today's behavior); 'after_connections' = after all
    // accounts finish sending connections. Any other value coerces to default.
    primaryCheckTiming: primaryCheckTiming === 'after_connections' ? 'after_connections' : 'immediately',
    // Fix A Task 4: resolved tab GID (digits only). Empty string means unknown /
    // single-tab workbook; campaign.js will apply withGid when non-empty.
    sheetGid,
    // Fix B Task 3: pause campaign on 429/throttle detection. Default true.
    pauseOnThrottle,
    // "Free for all Friday" — opt-in only.
    stopBeforeWeeklyReset: stopBeforeWeeklyReset === true,
    // "Free for all 25th" — opt-in only.
    stopBeforeMonthlyReset: stopBeforeMonthlyReset === true,
    // "Connections only" — CC+IB without the introduction step. Opt-in only.
    skipIntroductions: skipIntroductions === true,
    // Pre-flight hard exclusions (blocklist URLs): set by the /api/campaign/start gate.
    excludedUrls: Array.isArray(body._preflightExcludedUrls) ? body._preflightExcludedUrls : [],
  };
}

// Launch a campaign and chain into the queue when it finishes. Calling
// this while another campaign is still running will throw downstream from
// startCampaign — callers must check campaign.running first and queue
// instead if they want fire-and-forget semantics.
function launchCampaign(config, owner) {
  // Central operator-identity gate — both the HTTP start route AND the ungated
  // queue drain (runNextFromQueue) funnel through here. No identity → refuse.
  if (blockIfNoOperatorEmail(`campaign "${(config && config.name) || ''}"`, owner)) return;
  // Anything that launches HERE runs here. Without this a campaign moved to the
  // VM leaves campaign.runsOn === 'vm' behind, and the next local run would show
  // the card's RUNNING ON control filled on the wrong side. handoverToLocal
  // re-stamps both fields immediately after it calls this, so "moved N min ago"
  // survives the reset.
  campaign.runsOn = 'local';
  campaign.handoverAt = null;
  preventSleep('campaign');
  // Ortus Basics 1.0: snapshot the wizard config for LOCAL runs too. This was
  // only ever written on the cloud dispatch path (saveCloudLaunchConfig at the
  // /api/campaign/cloud/start route), so opening a finished local campaign had
  // nothing to restore and came back with an empty sheet URL and no accounts.
  // Best-effort: a failed snapshot must never stop a campaign starting.
  try {
    const _lcId = campaign.id || SINGLETON_CAMPAIGN_ID;
    if (_lcId) {
      saveCloudLaunchConfig(_lcId, (config && config.name) || '', config)
        .catch((e) => console.warn(`[launch-config] local snapshot failed: ${e.message}`));
    }
  } catch (e) {
    console.warn(`[launch-config] local snapshot skipped: ${e.message}`);
  }
  startCampaign({ ...config, createdBy: owner }).then(async () => {
    const status = getCampaignStatus();
    if (status.dailyResetNeeded && status.resumeAt && !status.stoppedManually) {
      await addToQueue({ ...config, _dailyContinuation: true, resumeContext: { totalProcessed: status.totalProcessed || 0 } }, owner, {
        scheduledAt: status.resumeAt,
      });
      console.log(`[queue] Daily-limit continuation scheduled for ${status.resumeAt}`);
    }
    const terminal = terminalPresentation(status);
    notifyEmail(owner, {
      title: `Campaign ${terminal.label.toLowerCase()}`,
      body: `${terminal.explanation} ${status.processedToday || 0} actions, ${terminal.pending} pending, ${(status.errors || []).length} error(s).`,
      link: '/',
    }).catch(() => {});
  }).catch(err => {
    console.error('Campaign error:', err.message);
    notifyEmail(owner, {
      title: 'Campaign failed',
      body: `Your campaign failed: ${err.message}`,
      link: '/',
    }).catch(() => {});
  }).finally(() => {
    allowSleep();
    // Chain into the queue. The next entry (if any) launches as soon as
    // the previous one fully cleans up. Sequential by design — we don't
    // run two campaigns in parallel.
    runNextFromQueue().catch(err => {
      console.error('Queue chain error:', err.message);
    });
  });
}

async function runNextFromQueue() {
  if (campaign.running) return;
  const queued = await getQueue();
  const next = await popNextReady();
  if (!next) {
    const futureTimes = queued.map((entry) => new Date(entry.scheduledAt).getTime())
      .filter((due) => Number.isFinite(due) && due > Date.now());
    const due = futureTimes.length ? Math.min(...futureTimes) : null;
    if (due) {
      const waitMs = Math.min(due - Date.now(), 2_147_000_000);
      clearTimeout(runNextFromQueue._scheduledTimer);
      runNextFromQueue._scheduledTimer = setTimeout(() => {
        runNextFromQueue().catch((err) => console.error('Scheduled queue drain failed:', err.message));
      }, waitMs);
      runNextFromQueue._scheduledTimer.unref?.();
      return;
    }
    return;
  }
  console.log(`[queue] Launching queued campaign "${next.name || '(unnamed)'}" (${next.id})`);
  launchCampaign(next.config, next.owner);
}

// Cloud dispatch logging — console ONLY, deliberately NOT the local campaign
// status log (campaignLog → campaign.logs). Cloud campaigns have no local
// campaign, so writing to campaign.logs made a dispatch spawn a ghost
// "FINISHED (UNNAMED)" card in the dashboard's active-card (renderActiveCard
// treats any logs with no running campaign as a finished run). Console keeps
// the [cloud] lines for debugging without touching the dashboard.
function cloudLog(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// ─── Cloud dispatch — run this campaign on the GKE engine, not locally ──────
// The "Run in cloud" toggle routes here. We reuse the app's OWN sheet reader
// (fetchSheet + extractLinkedInUrl) to build the leads, then hand the campaign
// to the engine via campaigns-client. The engine runs it in the cloud (survives
// the laptop closing). No local browser is launched. The regular local
// /api/campaign/start path below is untouched.
// Named so /api/campaign/cloud/:id/edit-redispatch can re-enter the same
// pipeline after stopping the original campaign (excludeLeadUrls set).
async function handleStartCloud(req, res) {
  try {
    const body = req.body || {};
    const { profileIds, sheetUrl, linkedinColumn, mode, dailyLimit, templates, name, senderColumn,
      delayMin, delayMax, launchId, startAt } = body;
    if (!isCloudMode(mode)) return res.status(400).json({ error: `Mode "${mode}" can't run in the cloud yet.` });
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
    // "Schedule on the VM": validate the instant HERE so a typo fails at the
    // click, not silently at 6am. The engine ignores a past startAt (starts now),
    // which for a scheduled launch is the one outcome the operator can't see.
    if (startAt !== undefined && startAt !== null && startAt !== '') {
      const t = new Date(startAt).getTime();
      if (!Number.isFinite(t)) return res.status(400).json({ error: `startAt is not a date: ${startAt}` });
      if (t <= Date.now()) return res.status(400).json({ error: 'That start time has already passed — pick a future one.' });
    }
    if (rejectIfNoOperatorEmail(res)) return;
    if (await rejectIfForeignProfiles(req, res, profileIds, mode)) return;

    // Ortus Basics 1.0: pre-flight gate disabled — the linter's blocker list
    // (missing columns, sender mismatches, blocklist) targets the full Outreach
    // SoO-driven workflow and fires false positives on Basics sheets.
    // if (!await runPreflightGate(req, res)) return;

    // Auto-routed modes derive the account per-row from the sheet's sender
    // column (the picker is hidden for them), so we pin each lead to its
    // account (routeAccount = GoLogin profile id). Other modes use the picker.
    const AUTO_ROUTED = new Set(['message_only', 'introduce_back', 'check_status']);
    const autoRouted = AUTO_ROUTED.has(mode);
    // Profiles are fetched for ALL modes now (not just auto-routed): the engine
    // needs an accountEmails map (profileId -> SoO email) so it can stamp SoO
    // Needs-Login when a cloud session dies. Best-effort — [] on failure.
    const profs = await getProfiles(process.env.GOLOGIN_API_TOKEN).catch(() => []);
    const idToName = new Map((profs || []).map((p) => [p.id, String(p.name || '').trim()]));
    let nameToId = null;
    if (autoRouted) {
      nameToId = new Map((profs || []).map((p) => [String(p.name || '').trim().toLowerCase(), p.id]));
    } else if (!profileIds?.length) {
      return res.status(400).json({ error: 'Select at least one GoLogin account.' });
    }
    // Per-row sender name (mirrors campaign.js getSenderName): the chosen sender
    // column first, else the canonical 'Sender' / 'Account Used' columns.
    const senderName = (row) => {
      if (senderColumn && row[senderColumn] != null) return String(row[senderColumn]).trim();
      return String(row['Sender'] || row['Account Used'] || '').trim();
    };

    // Build leads from the sheet exactly as the local campaign does.
    // Resolve the correct tab (mirrors runPreflightGate + campaign.js withGid).
    const cloudGid = body.sheetGid != null ? String(body.sheetGid).replace(/\D/g, '') : '';
    const cloudSheetUrl = withGid(sheetUrl, cloudGid);
    const rows = await fetchSheet(cloudSheetUrl);

    // Hard-exclude blocklisted + client-pre-flight-excluded URLs. Applies to
    // ALL modes now (operator decision 2026-07-10) — blocklistExcludedUrls is no
    // longer a no-op for warm modes. This is the REAL cloud guard: the engine
    // only ever receives the leads built below, so an excluded lead never
    // reaches the VM. Mirrors the central guard in campaign.js (local path).
    const blExcluded = new Set(blocklistExcludedUrls(rows, { linkedinColumn, mode, blocklist: readBlocklist() }).map((u) => normalizeProfileUrl(u)));
    const clientExcluded = new Set((req.body._preflightExcludedUrls || []).map((u) => normalizeProfileUrl(u)));
    const totalExcluded = blExcluded.size + clientExcluded.size;
    if (totalExcluded) {
      cloudLog(`[cloud] pre-flight excluded ${totalExcluded} URL(s) (blocklist: ${blExcluded.size}, client: ${clientExcluded.size})`);
    }

    const leads = [];
    const skippedNoAccount = [];
    for (const row of rows) {
      const leadUrl = extractLinkedInUrl(row, linkedinColumn);
      if (!leadUrl) continue;
      // Skip blocklisted / client-excluded URLs.
      if (blExcluded.has(normalizeProfileUrl(leadUrl)) || clientExcluded.has(normalizeProfileUrl(leadUrl))) continue;
      const first = row['First Name'] || row['first name'] || '';
      const last = row['Last Name'] || row['last name'] || '';
      const fullName = String(row['Full Name'] || row['Name'] || `${first} ${last}`).trim();
      let routeAccount = '';
      if (autoRouted) {
        routeAccount = nameToId.get(senderName(row).toLowerCase()) || '';
        if (!routeAccount) { skippedNoAccount.push(senderName(row) || '(blank)'); continue; }
      }
      // `row` = the FULL sheet row, so the engine personalizes templates against
      // every column header exactly like a local campaign ({company}, {Event}, …).
      leads.push({ leadUrl, fullName, memberUrn: row['LinkedIn URN'] || row['Member ID'] || null, routeAccount, row });
    }
    // Edit-redispatch: drop leads the ORIGINAL run already processed, so a
    // "Save edits & resume" only redispatches what was still pending when the
    // operator paused. Normal launches never set excludeLeadUrls.
    const editExcluded = new Set((Array.isArray(body.excludeLeadUrls) ? body.excludeLeadUrls : []).map((u) => normalizeProfileUrl(u)));
    if (editExcluded.size) {
      const before = leads.length;
      for (let i = leads.length - 1; i >= 0; i--) {
        if (editExcluded.has(normalizeProfileUrl(leads[i].leadUrl))) leads.splice(i, 1);
      }
      cloudLog(`[cloud] edit-redispatch: skipped ${before - leads.length} already-processed lead(s), ${leads.length} remaining`);
      if (!leads.length) return res.status(400).json({ error: 'Nothing left to send — every lead in the sheet was already processed by the original run.' });
    }
    if (!leads.length) {
      const why = autoRouted && skippedNoAccount.length
        ? `No leads matched a known GoLogin account by sender name (e.g. ${[...new Set(skippedNoAccount)].slice(0, 3).join(', ')}). Check the sender column.`
        : 'No leads with LinkedIn URLs found in the sheet.';
      return res.status(400).json({ error: why });
    }

    // Ensure the sheet has the tracking columns before the cloud engine writes
    // back to them (the engine's write skips columns that don't exist). Same
    // step the local campaign flow does at start. Best-effort — never blocks.
    try {
      const { ensureTrackingColumns } = await import('./src/sheets-writer.js');
      // cloudSheetUrl (NOT the raw sheetUrl) — the operator's chosen tab. The raw
      // URL field can carry a stale gid from a different tab; columns must be
      // ensured on the SAME tab the engine reads + writes back to.
      await ensureTrackingColumns(cloudSheetUrl, mode);
    } catch (e) { cloudLog(`[cloud] ensureColumns skipped: ${e.message}`); }
    // Accounts: picker for normal modes; distinct routed accounts otherwise.
    const accounts = autoRouted
      ? [...new Set(leads.map((l) => l.routeAccount).filter(Boolean))]
      : profileIds;

    // accountEmails: profileId -> SoO Email, resolved with the same fuzzy
    // matcher (+ skip-on-doubt) local flipSoOInUse uses. Lets the engine stamp
    // SoO Needs-Login for a dead cloud session. Best-effort — {} on failure.
    const accountEmails = {};
    try {
      const soo = await fetchSoOData();
      const sooEmails = (((soo && soo.accounts) || []).map((a) => a && a.email).filter(Boolean));
      for (const id of accounts) {
        const label = idToName.get(id) || '';
        if (!label) continue;
        const r = resolveSoOEmail(label, sooEmails);
        if (r && r.email) accountEmails[id] = r.email;
        else if (r && r.ambiguous) cloudLog(`[cloud] SoO email ambiguous for "${label}" — skipped (no Needs-Login stamping for it)`);
      }
    } catch (e) { cloudLog(`[cloud] accountEmails skipped: ${e.message}`); }

    // SoO "In Use" flip at DISPATCH. The engine has no SoO code, so the app does
    // here what a local campaign does at its first send: flip each account's
    // credit cell Available -> In Use and stamp the operator into the paired User
    // column (write-once). resolveSoOTarget returns null for message_only /
    // introduce_back / follower_growth / check_status — so those flip nothing,
    // identical to local. Best-effort: a SoO failure NEVER blocks the dispatch.
    // Reuses accountEmails (already fuzzily resolved, skip-on-doubt) so an
    // ambiguous GoLogin label is left untouched rather than reserving the wrong
    // person's account.
    // cloudFlipAction lives in soo-writer.js so the reconcile-time retry
    // (cloud-soo-reconcile.reconcileCloudInUse) reads the SAME mode map — two
    // copies would eventually disagree about which cloud modes touch the SoO.
    const flipAction = cloudFlipAction(mode);
    const flipTarget = flipAction ? resolveSoOTarget(mode, flipAction) : null;
    if (flipTarget) {
      const stampEmail = resolveOperatorStamp({
        perMachineEmail: getOperatorEmail(),
        loginEmail: req.user || '',
      });
      for (const id of accounts) {
        const label = idToName.get(id) || id;
        const email = accountEmails[id];
        if (!email) { cloudLog(`[cloud] SoO In-Use skipped for "${label}" — no unambiguous SoO email.`); continue; }
        try {
          const r = await flipAccountInUse({
            email,
            creditHeader: flipTarget.creditHeader,
            userHeader: flipTarget.userHeader,
            operatorEmail: stampEmail,
          });
          if (r && r.ok && r.matched && r.written && r.written.length) {
            cloudLog(`[cloud] SoO: ${label} → ${flipTarget.creditHeader} = In Use (${stampEmail || '—'}).`);
          } else if (r && r.ok && r.matched) {
            const why = (Array.isArray(r.skipped) && r.skipped.length) ? r.skipped.join('; ') : `${flipTarget.creditHeader} not Available`;
            cloudLog(`[cloud] SoO: ${label} not flipped — ${why}.`);
          } else if (r && r.disabled) {
            cloudLog(`[cloud] SoO: write-back OFF (ORTUS_SOO_WRITEBACK) — ${label} left as-is.`);
          } else if (r && r.ok && r.matched === false) {
            cloudLog(`[cloud] SoO: no row matched "${label}" (${email}) — nothing flipped.`);
          } else {
            cloudLog(`[cloud] SoO: ${label} flip failed — ${(r && r.error) || 'unknown'}.`);
          }
        } catch (e) { cloudLog(`[cloud] SoO In-Use flip error for "${label}": ${e.message}`); }
      }
    }

    // Map the wizard's template names to the keys the engine modes read. The
    // wizard already uses engine-compatible names for most fields (connectionNote,
    // ccDmBody, primaryName/IntroBody/Url, introTitle, autoAccept/followUp*); the
    // one gap is message_only, where the engine reads `message` but the wizard
    // stores the DM body in `followUp1`. Keep originals; add engine aliases.
    const t = templates || {};
    const config = {
      ...t,
      message: t.message || t.followUp1 || '',            // message_only DM body
      followUpMessage: t.followUpMessage || t.followUp1 || '',
      senderFirstNames: body.senderFirstNames || t.senderFirstNames || {},
      // Sheet write-back: the engine pushes per-lead status back to this
      // operator's Apps Script web app (same one local campaigns use), matching
      // rows by this linkedin column — so cloud results land in the Sheet too.
      sheetsWebappUrl: SHEETS_WEBAPP_URL,
      linkedinColumn: linkedinColumn || 'LinkedIn URL',
      // Ban-safety: randomized inter-send delay (seconds) the engine's worker
      // waits between sends per account — same knob local campaigns use. The
      // engine defaults to 30–60s (1–3s for check_status) when absent.
      ...(Number.isFinite(Number(delayMin)) && Number(delayMin) > 0 ? { delayMin: Number(delayMin) } : {}),
      ...(Number.isFinite(Number(delayMax)) && Number(delayMax) > 0 ? { delayMax: Number(delayMax) } : {}),
      // SoO Needs-Login stamping: the engine matches accounts by email in the
      // SoO sheet when a cloud session dies. Graceful no-op engine-side if empty.
      accountEmails,
      sooSheetId: SOO_SHEET_ID,
      sooGid: SOO_SHEET_GID,
      // Which GoLogin workspace owns these profiles. The engine holds a token
      // per account and picks by this id; absent (older app build) it falls
      // back to its default account, which is exactly the pre-2026-08-07
      // behaviour. Sent as an ID, never a token — secrets stay in the engine's
      // k8s secret, not in a campaign document.
      glAccount: viewerAccount(req),
    };
    // Operator timezone → engine → GAS stamps "Date/Time of Last Action" in the
    // operator's local clock (parity with local runs, where sheets-writer attaches
    // tz). Best-effort: a missing pref falls back to the Apps Script's script tz.
    try {
      const _ownerEmail = getOperatorEmail() || req.user || '';
      const _prefs = _ownerEmail ? await getOperatorPrefs(_ownerEmail) : null;
      if (_prefs && _prefs.tz) config.tz = _prefs.tz;
      // Identity safeguard → engine. This was never sent, so the sidebar toggle
      // governed local runs only: the engine reads `identityGateEnabled !== false`
      // and an absent key resolved to ON, forcing the gate on every cloud send
      // while the UI read "Off". Send the SAME boolean local computes
      // (src/campaign.js: `prefs.identityGate === true`, default OFF) so the two
      // sides can't diverge — never a bare `undefined`, which the engine reads
      // as ON. See the VM-mirrors-local rule.
      config.identityGateEnabled = identityGateEnabled(_prefs);
    } catch {
      // A prefs read failure resolves to OFF, exactly as local's catch does.
      config.identityGateEnabled = false;
    }
    // Follower Growth needs the page invite URL + a monthly credit budget. The
    // operator can override the URL from the wizard; otherwise use the Ortus
    // Club page invite URL the local FG flow already uses.
    if (mode === 'follower_growth') {
      config.inviteUrl = body.inviteUrl || t.inviteUrl || ORTUS_PAGE_INVITE_URL;
      config.monthlyBudget = Number(body.monthlyBudget || t.monthlyBudget || 30);
    }

    // Hand the engine what THIS machine already knows about each sender's
    // connection to the primary. The engine's campaign_primary_conn is keyed per
    // CAMPAIGN, so without this a new campaign starts blank and every account
    // shows "Primary not yet connected" — even ones connected in an earlier run.
    // primary-status.json is keyed per account+primary, so it remembers across
    // campaigns; seed only the CONNECTED ones (a fact), never a guess.
    let primaryConn;
    if (mode === 'connect_and_introduce') {
      try {
        const _pKey = primaryKeyFromUrl(String(t.primaryUrl || '').trim());
        if (_pKey) {
          const _pStore = await loadPrimaryStatus(dataPath('primary-status.json'));
          const _connected = seedConnectedIds(_pStore, _pKey).filter((pid) => accounts.includes(pid));
          if (_connected.length) {
            primaryConn = Object.fromEntries(_connected.map((pid) => [pid, 'connected']));
            cloudLog(`[cloud] seeding primary-connection for ${_connected.length} account(s) already connected to the primary`);
          }
        }
      } catch (e) { cloudLog(`[cloud] primary-connection seed skipped: ${e.message}`); }
    }

    // Owner MUST be the per-machine operator identity, because that is exactly
    // what the dashboard's cloud board filters "mine" against (snCurrentEmail =
    // /api/operator-identity). Tagging with req.user (the shared login) made a
    // running campaign show as "someone else's" → hidden → unstoppable from the
    // UI. Fall back to the login only when no operator email is set.
    const result = await startCloudCampaign({
      // Idempotency: a duplicated POST (operator re-click, retry, second window)
      // with the same launchId collapses to ONE campaign engine-side.
      id: launchId || undefined,
      mode, name: name || '', owner: getOperatorEmail() || req.user || '',
      profileIds: accounts, leads, config,
      // sheet_url handed to the engine for WRITE-BACK must be the operator's
      // CHOSEN tab (cloudSheetUrl = withGid(sheetUrl, sheetGid)), NOT the raw
      // sheetUrl. The read above already uses cloudSheetUrl; passing the raw
      // sheetUrl here made the engine stamp a DIFFERENT tab whenever the URL
      // field's gid differed from the picked tab (operator picked Sheet2 but a
      // stale gid=Sheet5 in the URL field → all stamps landed on Sheet5).
      dailyLimit: dailyLimit || 50, sheetUrl: cloudSheetUrl,
      primaryConn,
      startAt: startAt || undefined,
    });
    if (result.error) return res.status(502).json({ error: result.error, cloud: true });
    cloudLog(`[cloud] campaign ${result.id} (${mode}) ${result.scheduled ? `SCHEDULED for ${result.startAt}` : 'dispatched'} to engine — ${result.leadsAdded} leads, ${accounts.length} account(s)${autoRouted ? ' (auto-routed)' : ''}`);
    // Snapshot the wizard config so the campaign can be duplicated later (the
    // engine doesn't return templates/delays). Best-effort — never blocks dispatch.
    saveCloudLaunchConfig(result.id, name || '', body).catch((e) => cloudLog(`[cloud] launch-config save failed: ${e.message}`));
    res.json({ ok: true, cloud: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
const CLOUD_MEMO_TTL_MS = 10_000;
const _cloudMemo = new Map(); // key -> { at, val, inflight }
function memoCloud(key, fetcher, { ttlMs = CLOUD_MEMO_TTL_MS, onFresh } = {}) {
  const e = _cloudMemo.get(key) || {};
  _cloudMemo.set(key, e);
  if (!e.inflight && (!e.val || Date.now() - e.at >= ttlMs)) {
    e.inflight = fetcher().then((v) => {
      e.inflight = null;
      // Never cache (or act on) an error — keep serving the last good value.
      if (v && !v.error) {
        e.val = v; e.at = Date.now();
        // Side effects belong to the REFRESH, not to every cache hit, or a
        // reconcile would re-run on every poll against unchanged data.
        if (onFresh) { try { onFresh(v); } catch { /* best-effort */ } }
      }
      return v;
    }, (err) => { e.inflight = null; throw err; });
  }
  return e.val ? Promise.resolve(e.val) : e.inflight;
}


// Mutations invalidate only the affected campaign lanes. Clearing the entire
// board cache made an account retry trigger a new 89-campaign fan-out.
app.use('/api/campaign', (req, _res, next) => {
  if (req.method !== 'GET') {
    _cloudMemo.delete('capacity');
    for (const key of _cloudMemo.keys()) {
      if (key.startsWith('list:')) _cloudMemo.delete(key);
    }
    const match = req.path.match(/^\/cloud\/([^/]+)/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      _cloudMemo.delete(`campaign:${id}`);
      _cloudMemo.delete(`leads:${id}`);
      _cloudMemo.delete(`accounts:${id}`);
    }
    if (req.path.includes('preflight') || req.path.includes('accounts')) {
      for (const key of _cloudMemo.keys()) {
        if (key.startsWith('preflight:')) _cloudMemo.delete(key);
      }
    }
  }
  next();
});

app.post('/api/campaign/start-cloud', handleStartCloud);

// Cloud-campaign observability — proxied through the local server so the
// frontend never handles the engine token (it lives in campaigns-client). The
// "Cloud Campaigns" panel polls these.
//
// Every one of these is a round trip to the engine, measured at 4.8-8.5s each on
// 2026-08-13 with 89 cloud campaigns on the board. The panel re-polls all of them
// every 4s, so the browser sat permanently at its six-connections-per-host limit
// and starved every other poller in the page (the Sales Nav board managed one
// request in 75 seconds). Memoised with a short TTL: the first caller pays, the
// rest are served instantly from the last good value while a single refresh runs
// behind them.
app.get('/api/campaign/cloud-list', async (req, res) => {
  const r = await memoCloud(`list:${req.query.owner || ''}`, () => listCloudCampaigns(req.query.owner));
  if (r.error) return res.status(502).json(r);
  res.json(r);
});
// Cloud load + the global queue order, for the "why hasn't it started" block on
// a waiting campaign. Memoised on the same lane as the list: every queued strip
// on the board wants the same answer, and the board re-polls every few seconds.
//
// A 502 here is not an error worth showing — the card simply falls back to its
// old wording. Answer with an empty shape so the renderer has one code path.
app.get('/api/campaign/cloud-capacity', async (_req, res) => {
  const r = await memoCloud('capacity', () => getCloudCapacity());
  if (r.error) return res.json({ queue: [], unavailable: true });
  res.json(r);
});

// One browser request supplies the board's list, detail snapshots and global
// capacity. Server-side memo lanes still refresh independently and with bounded
// concurrency, without occupying the Electron renderer's connection pool.
app.get('/api/campaign/cloud-board-summary', async (req, res) => {
  const list = await memoCloud(`list:${req.query.owner || ''}`, () => listCloudCampaigns(req.query.owner));
  if (list && list.error) return res.status(502).json(list);
  const campaigns = Array.isArray(list?.campaigns) ? list.campaigns : [];
  const details = {};
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < campaigns.length) {
      const id = campaigns[nextIndex++]?.id;
      if (!id) continue;
      try {
        const value = await memoCloud(`campaign:${id}`, () => getCloudCampaign(id), {
          onFresh: (fresh) => { reconcilePrimaryHandshake(id, fresh).catch(() => {}); },
        });
        if (value && !value.error) details[id] = value;
      } catch { /* preserve the usable remainder of the board */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, campaigns.length) }, worker));
  const live = campaigns.some((c) => ['queued', 'running', 'stopping', 'monitoring', 'paused'].includes(c.status));
  const capacity = live ? await memoCloud('capacity', () => getCloudCapacity()) : { queue: [] };
  res.json({ campaigns, details, capacity: capacity?.error ? { queue: [], unavailable: true } : capacity });
});
// Per-account block truth for the Waiting card and the Start prompt.
//
// Memo key is the sorted account SET, not the campaign: the card polls every few
// seconds and campaigns share accounts, so this collapses to one engine call per
// distinct set rather than one per campaign per poll.
app.get('/api/campaign/cloud-preflight', async (req, res) => {
  const ids = String(req.query.profiles || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return res.json({ accounts: [], usable: 0, earliest: null });
  // dailyLimit rides along (optional) — without it the engine cannot tell a
  // daily-capped account from a free one. Part of the memo key: two campaigns on
  // the same accounts with different limits get different answers.
  const dl = Math.max(0, Math.floor(Number(req.query.dailyLimit) || 0));
  const r = await memoCloud(`preflight:${ids.slice().sort().join(',')}:${dl}`, () => getCloudPreflight(ids, dl));
  // A 502 must NOT read as "nothing can send" — that would fire the Start prompt
  // on an engine blip and block a launch that is perfectly fine. usable:null is
  // the "we don't know" signal both callers fail open on. Deliberately different
  // from cloud-capacity above, which can safely answer with an empty shape.
  if (r.error) return res.json({ accounts: [], usable: null, earliest: null, unavailable: true });
  // Defensive normalization: a malformed/partial 200 (e.g. `{}`) carries no
  // `.error`, so memoCloud caches it verbatim and `usable` would leak through
  // as `undefined` instead of `null`. Tasks 6/7 branch on `usable === null` to
  // fail open — an `undefined` would silently miss that check and let a
  // blocking "nothing can send" prompt fire on a malformed response, the exact
  // bug the null-vs-zero split exists to prevent. Normalized here, not in
  // requestWithRetry, since other callers of that helper rely on its current
  // pass-through behaviour.
  res.json({
    accounts: Array.isArray(r.accounts) ? r.accounts : [],
    usable: typeof r.usable === 'number' ? r.usable : null,
    earliest: typeof r.earliest === 'string' ? r.earliest : null,
  });
});
app.get('/api/campaign/cloud/:id', async (req, res) => {
  const id = req.params.id;
  const r = await memoCloud(`campaign:${id}`, () => getCloudCampaign(id), {
    onFresh: (v) => { reconcilePrimaryHandshake(id, v).catch(() => {}); },
  });
  if (r.error) return res.status(502).json(r);
  res.json(r);
});
// ── Cloud sheet reconcile (parity fix #1) ─────────────────────────────────
// The engine writes SENT rows back to the source sheet, but leaves ERROR /
// SKIPPED rows blank — unlike a local campaign, which stamps every skip reason
// (buildSkipSheetData → updateSheetRow). We can't change the engine from here,
// so the app reconciles: whenever it pulls a cloud campaign's per-lead rows
// (running/expanded strips), it stamps the error/skip rows the engine left
// blank, using the SAME primitives + wording local uses. Eventually-consistent:
// it catches up whenever an operator's app is looking at the campaign.
//
// Idempotent + throttled: a per-campaign `written` set means each (lead,status)
// is stamped once per app session; a 20s throttle keeps the 4s board poll from
// re-reconciling. Best-effort — never blocks the /leads response.
const _cloudReconcile = new Map(); // campaignId -> { at:number, writtenRows:Set<string> }
const CLOUD_RECONCILE_THROTTLE_MS = 20 * 1000;

// The dedup set used to live only in memory, so every app restart re-stamped
// every terminal row of every cloud campaign the operator then looked at —
// thousands of pointless Apps Script executions, and the single biggest
// contributor to the write storm. It is now on disk, keyed by campaign.
const CLOUD_RECONCILE_FILE = dataPath('cloud-reconcile.json');
let _cloudReconcileLoaded = false;

async function loadCloudReconcile() {
  if (_cloudReconcileLoaded) return;
  _cloudReconcileLoaded = true;
  try {
    const saved = JSON.parse(await readFile(CLOUD_RECONCILE_FILE, 'utf8'));
    for (const [id, keys] of Object.entries(saved || {})) {
      if (!Array.isArray(keys)) continue;
      _cloudReconcile.set(id, { at: 0, writtenRows: new Set(keys) });
    }
  } catch { /* first run, or unreadable — an empty set just re-stamps once */ }
}

let _cloudReconcileSaving = null;
function saveCloudReconcile() {
  // Coalesced: a burst of reconciles writes the file once, on the next tick.
  if (_cloudReconcileSaving) return _cloudReconcileSaving;
  _cloudReconcileSaving = (async () => {
    await new Promise((r) => setTimeout(r, 1000));
    _cloudReconcileSaving = null;
    const out = {};
    for (const [id, st] of _cloudReconcile) out[id] = [...st.writtenRows];
    try {
      await writeFile(`${CLOUD_RECONCILE_FILE}.tmp`, JSON.stringify(out));
      await rename(`${CLOUD_RECONCILE_FILE}.tmp`, CLOUD_RECONCILE_FILE);
    } catch (err) {
      cloudLog(`[cloud] reconcile dedup save failed: ${err.message}`);
    }
  })();
  return _cloudReconcileSaving;
}
async function reconcileCloud(id, leads) {
  try {
    if (!Array.isArray(leads) || !leads.length) return;
    await loadCloudReconcile();
    let state = _cloudReconcile.get(id);
    if (state && Date.now() - state.at < CLOUD_RECONCILE_THROTTLE_MS) return; // throttle both writes
    if (!state) { state = { at: 0, writtenRows: new Set() }; _cloudReconcile.set(id, state); }
    state.at = Date.now();
    // mode + sheetUrl + linkedinColumn + accountEmails come from the detail (one fetch).
    const detail = await getCloudCampaign(id);
    const c = (detail && detail.campaign) || {};
    const mode = c.mode || 'connect_only';

    // (A) SHEET — reproduce local's EXACT stamp for every terminal row so the
    // cloud sheet is 1:1 with a local run. The engine writes some rows with its
    // own wording (Stage 'CC', blank Sender) and leaves error/skip rows blank;
    // cloudLeadToLocalSheetData maps each engine row to local's own builders.
    // Dedup key includes stage so a lead advancing (CC → IC/DM) re-stamps.
    const sheetUrl = c.sheet_url;
    const terminal = leads.filter((l) => l && ['sent', 'error', 'skipped'].includes(l.status) && (l.leadUrl || '').trim());
    const freshRows = terminal.filter((l) => !state.writtenRows.has(`${l.id}:${l.status}:${l.stage || ''}`));
    if (sheetUrl && freshRows.length) {
      const linkedinColumn = (c.config && c.config.linkedinColumn) || 'linkedin url';
      const { updateSheetRow } = await import('./src/sheets-writer.js');
      const profs = await getProfiles(process.env.GOLOGIN_API_TOKEN).catch(() => []);
      const idToName = new Map((profs || []).map((p) => [p.id, String(p.name || '').trim()]));
      // Issued together, NOT awaited one at a time: sheets-writer coalesces
      // concurrent row writes into 100-row executions, and an await-per-row
      // loop would hand it one row at a time and get one execution each —
      // which is exactly what used to melt the per-spreadsheet limit here.
      const settled = await Promise.all(freshRows.map(async (l) => {
        try {
          const sheetData = cloudLeadToLocalSheetData(mode, l, idToName.get(l.account) || '');
          if (!sheetData) return null;
          const ok = await updateSheetRow(sheetUrl, l.leadUrl, sheetData, linkedinColumn);
          return ok ? `${l.id}:${l.status}:${l.stage || ''}` : null;
        } catch { return null; } // per-row best-effort
      }));
      const stamped = settled.filter(Boolean);
      stamped.forEach((k) => state.writtenRows.add(k));
      if (stamped.length) {
        saveCloudReconcile();
        cloudLog(`[cloud] sheet reconcile: stamped ${stamped.length} row(s) 1:1 with local for ${id} (${mode}).`);
      }
    }

    // (B) SoO — bump each account's weekly connection tally from the engine's
    // CC-sent leads (parity #3). Durable dedup + current-week gating live in the
    // module; here we just hand it the detail's accountEmails map.
    try {
      await reconcileCloudConnections({
        id, mode,
        accountEmails: (c.config && c.config.accountEmails) || {},
        leads, log: cloudLog,
      });
    } catch (e) { cloudLog(`[cloud] SoO connections reconcile skipped for ${id}: ${e.message}`); }

    // (C) SoO — In-Use flip for any account that has sent but isn't reserved on
    // the board yet. The dispatch-time flip is one shot: if the SoO was
    // unreachable then, nothing else ever retried it and the account stayed
    // "Available" for the campaign's whole life. Same trigger as a local run
    // (first actual send), durable settle-list so this doesn't re-POST forever.
    try {
      await reconcileCloudInUse({
        id, mode,
        accountEmails: (c.config && c.config.accountEmails) || {},
        leads,
        operatorEmail: resolveOperatorStamp({
          perMachineEmail: getOperatorEmail(),
          loginEmail: c.owner || '',
        }),
        log: cloudLog,
      });
    } catch (e) { cloudLog(`[cloud] SoO In-Use reconcile skipped for ${id}: ${e.message}`); }
  } catch (e) { cloudLog(`[cloud] reconcile skipped for ${id}: ${e.message}`); }
}

// ── Cloud primary-handshake (parity: local-only primary auto-accept) ──────────
// When a cloud CC+IC / CC+DM campaign's primary lives only in the local browser,
// the engine pauses in state:'awaiting_primary_accept' and lists the sender
// invitations it fired at the primary. THIS machine (the campaign's owner) accepts
// them with its local browser, then signals the engine to resume. We reuse the
// primary-task runner WITHOUT editing it: enqueue one local-browser accept per
// sender (tagged `${id}:${senderProfileId}` so dedupeKey stays unique per sender),
// let the already-running 60s idle-gated runner drain them, then — once every
// tagged accept is terminal — read the statuses back and signal the engine ONCE
// (hasSignaled guard). Targeted accepts only: safer than blanket-accepting the
// primary's whole pending-invite inbox, and the reused runner does exactly this.
// Inert until the engine ships state:'awaiting_primary_accept' (isAwaitingAccept
// early-returns). Never throws into the request path.
async function reconcilePrimaryHandshake(id, detail) {
  try {
    if (!isAwaitingAccept(detail)) return;
    if (await hasSignaled(id)) return;
    const camp = (detail && detail.campaign) || {};
    const cfg = camp.config || {};
    // Only a cloud campaign whose primary is the LOCAL browser + auto-accept on.
    if (!(cfg.autoAcceptPrimary && cfg.primarySource === 'local-browser')) return;
    // Owner gate: only the machine that launched it drives ITS local browser.
    // Require a non-empty operator identity that matches the owner (so a missing
    // owner can never accidentally match a machine with no operator set).
    const me = getOperatorEmail();
    if (!me || String(camp.owner || '') !== String(me)) return;

    const wanted = sendersToAcceptTasks(detail); // senders still needing a local accept
    const alreadyAcceptedIds = ((camp.senders) || [])
      .filter((s) => s && s.accepted).map((s) => s.profileId);

    // Match our tasks by the `${id}:` prefix. Engine campaign ids are opaque
    // `cmp_…` tokens that are never a prefix of one another, so this can't
    // cross-match a different campaign's accept tasks.
    const tag = `${id}:`;
    const mine = (await loadTasks()).filter(
      (t) => t && t.type === 'accept' && String(t.campaignProfileId).startsWith(tag),
    );

    // First engagement WITH senders that still need accepting: queue one local
    // accept per sender; the boot-started 60s idle-gated runner drains them, and
    // we signal on a later poll once they finish.
    if (wanted.length && mine.length === 0) {
      for (const w of wanted) {
        await enqueuePrimaryTask(buildAcceptTask({
          campaignProfileId: `${id}:${w.profileId}`,
          campaignProfileName: (w.account && w.account.name) || '',
          account: w.account,
          primaryUrl: (camp.primary && camp.primary.url) || '',
          sender: 'local-browser',
        }));
      }
      cloudLog(`[cloud] primary-handshake: queued ${wanted.length} local accept(s) for ${id}.`);
      return; // signal on a later poll once they finish
    }

    // If we queued accepts, wait until EVERY one is terminal before signaling.
    const terminal = (s) => s === 'done' || s === 'skipped' || s === 'failed';
    if (mine.length && !mine.every((t) => terminal(t.status))) return;

    // Ready to signal. Accepted = the senders the engine already had accepted PLUS
    // the ones our local browser just accepted. This also covers the all-already-
    // accepted case (wanted empty, mine empty) so the campaign never stalls in
    // awaiting_primary_accept. Signal exactly once (hasSignaled guards re-entry).
    const freshResults = mine.map((t) => ({
      profileId: String(t.campaignProfileId).slice(tag.length),
      accepted: t.status === 'done',
    }));
    const acceptedIds = [...new Set([...alreadyAcceptedIds, ...computeAcceptedIds(detail, freshResults)])];
    const r = await signalPrimaryAcceptDone(id, acceptedIds);
    if (!r || !r.error) {
      await markSignaled(id);
      cloudLog(`[cloud] primary-handshake: signaled engine — ${acceptedIds.length} accepted for ${id}.`);
    } else {
      cloudLog(`[cloud] primary-handshake: signal failed for ${id}: ${r.error} (will retry next poll).`);
    }
  } catch (e) {
    cloudLog(`[cloud] primary-handshake reconcile skipped for ${id}: ${e.message}`);
  }
}

// Per-lead status rows for one cloud campaign — powers the strip's live log
// (parity with a local campaign's per-lead log). Proxied so the engine token
// stays server-side. The dashboard fetches this only for running/expanded
// cloud strips, so it's not on the hot path for the whole board. After
// responding, best-effort reconciles error/skip rows into the source sheet.
// ONE request for the whole board's per-campaign detail.
//
// The panel used to fetch /api/campaign/cloud/:id once per campaign — 89 of them
// on this install. A browser opens at most six connections per host, so that fan-
// out held the pool for minutes at a time and every other poller in the page
// (the Sales Nav board, the FG status poll, drafts) queued behind it. Node has no
// such limit, so the fan-out belongs here, where it is also memoised.
app.get('/api/campaign/cloud-details', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 500);
  const details = {};
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const v = await memoCloud(`campaign:${id}`, () => getCloudCampaign(id), {
          onFresh: (fresh) => { reconcilePrimaryHandshake(id, fresh).catch(() => {}); },
        });
        if (v && !v.error) details[id] = v;
      } catch { /* one bad id must not fail the board */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
  res.json({ details });
});

app.get('/api/campaign/cloud/:id/leads', async (req, res) => {
  const id = req.params.id;
  const r = await memoCloud(`leads:${id}`, () => getCloudCampaignLeads(id), {
    onFresh: (v) => { reconcileCloud(id, v.leads).catch(() => {}); }, // never blocks
  });
  if (r.error) return res.status(502).json(r);
  res.json(r);
});
app.get('/api/campaign/cloud/:id/accounts', async (req, res) => {
  const r = await memoCloud(`accounts:${req.params.id}`, () => getCloudCampaignAccounts(req.params.id));
  if (r && r.error) return res.status(502).json(r);
  res.json(r);
});
// Operator Retry on a benched (weekly-cap) account — proxied so the engine
// token stays server-side.
app.post('/api/campaign/cloud/:id/accounts/:pid/unbench', async (req, res) => {
  const r = await unbenchCloudAccount(req.params.id, req.params.pid);
  if (r && r.error) return res.status(502).json(r);
  res.json(r || { ok: true });
});
// Operator "Check primary" on ONE account of a running cloud campaign.
//
// This runs HERE, on the operator's Mac, not on the VM — the same handshake the
// campaign runs before launch, through the same function. Two reasons, both
// found the hard way on 2026-09-02: the VM cannot accept an invitation to a
// local-browser primary (that browser is on this Mac, so anything it sent sat
// pending forever), and its browser frequently renders no Connect button at
// all, so the send failed after 60s and was reported as an invitation that had
// been sent. The operator's invitations inbox was empty.
//
// The result is then recorded on the engine, so the accounts panel shows it.
app.post('/api/campaign/cloud/:id/accounts/:pid/primary-check', async (req, res) => {
  const { id, pid } = req.params;
  try {
    const detail = await getCloudCampaign(id);
    const c = (detail && detail.campaign) || {};
    const cfg = c.config || {};
    const primaryUrl = String(cfg.primaryUrl || '');
    if (!primaryUrl) return res.status(400).json({ error: 'This campaign has no primary person.' });
    const who = (cfg.accountEmails || {})[pid] || pid;

    const out = await runCloudPreflightHandshake({
      senderProfileIds: [pid],
      primaryUrl,
      primarySource: cfg.primarySource || 'local-browser',
      autoAcceptAllPending: !!cfg.autoAcceptAllPending,
      log: (line) => console.log(`[primary-check ${pid}]`, line),
    });
    const sender = ((out && out.senders) || []).find((x) => x && x.profileId === pid) || {};
    // The handshake's own vocabulary, mapped to what the engine stores. 'sent'
    // and 'sent-no-identity' both mean an invitation exists; 'not-sent' means
    // one does not, and is never called pending.
    const STATE = {
      connected: 'connected',
      sent: 'pending',
      'sent-no-identity': 'pending',
      'not-sent': 'not_connected',
    };
    const state = STATE[sender.state] || 'unverified';
    const LINE = {
      connected: `🔗 ${who} — connected to the primary`,
      pending: `🔗 ${who} — invitation sent from this Mac, waiting for the primary to accept it`,
      not_connected: `🔗 ${who} — not connected to the primary, and the invitation could not be sent`,
      unverified: `🔗 ${who} — could not tell whether it is connected to the primary · nothing was sent`,
    };
    const rec = await recordCloudPrimaryConn(id, pid, { state, primaryUrl, line: LINE[state] });
    if (rec && rec.error) return res.status(502).json(rec);
    res.json({ ok: true, state, who, senderState: sender.state || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Local check of a CLOUD campaign — write-back step. After the operator runs
// the local GoLogin sweep (POST /api/bulk-check-now) against a cloud campaign's
// sheet, this re-reads that sheet and mirrors each lead's Connection Accepted
// Status + Introduction Status into the engine (fill-only there), so the VM's
// next sweep won't double-intro anyone the local check already introduced.
app.post('/api/campaign/cloud/:id/sync-sheet-status', async (req, res) => {
  try {
    const d = await getCloudCampaign(req.params.id);
    const camp = d && d.campaign;
    if (!camp || !camp.sheet_url) return res.status(404).json({ error: 'Cloud campaign (or its sheet) not found.' });
    const cfg = camp.config || {};
    const linkedinColumn = ((req.body && req.body.linkedinColumn) || cfg.linkedinColumn || '').toString();
    const rows = await fetchSheet(camp.sheet_url);
    const urlOf = (row) => ((linkedinColumn && row[linkedinColumn]) || row['Linkedin URL'] || row['LinkedIn URL'] || row['linkedin url'] || '').toString().trim();
    const leads = [];
    for (const row of rows) {
      const leadUrl = urlOf(row);
      if (!leadUrl) continue;
      const acc = (row['Connection Accepted Status'] || '').toString().trim();
      const intro = (row['Introduction Status'] || '').toString().trim();
      if (!acc && !intro) continue;
      leads.push({ leadUrl, connectionAcceptedStatus: acc, introductionStatus: intro });
    }
    const r = await syncCloudLeadStatuses(req.params.id, leads);
    if (r && r.error) return res.status(502).json(r);
    res.json({ ok: true, sheetRows: rows.length, candidates: leads.length, matched: (r && r.matched) || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Team status (feature ⑩ — ADMIN-ONLY) ─────────────────────────────────
// Per-operator aggregate over the engine cloud list + this machine's local
// campaign/queue. HARD-GATED: only viewers whose login email is in
// ADMIN_EMAILS get data — everyone else gets a 403, same admin source as
// /api/me. Cached for 30s so the dashboard poll never hammers the engine.
let _teamStatusCache = { at: 0, payload: null };
const TEAM_STATUS_CACHE_MS = 30 * 1000;
app.get('/api/team-status', async (req, res) => {
  if (!viewerIsAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  if (_teamStatusCache.payload && Date.now() - _teamStatusCache.at < TEAM_STATUS_CACHE_MS) {
    return res.json(_teamStatusCache.payload);
  }
  const entries = [];
  let cloudError = null;
  // "Today" window in the OPERATOR's local day — this server runs on the
  // operator's own machine (Electron), so local midnight IS their day boundary
  // (no timezone gymnastics, and it matches the sheet stamps' operator tz).
  const _todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const _todayEnd = _todayStart + 24 * 60 * 60 * 1000;
  let _leadsChecked = 0, _leadsSkipped = 0;
  try {
    const r = await listCloudCampaigns(); // no owner filter — team-wide
    if (r && r.error) {
      cloudError = r.error;
    } else {
      const cloudCamps = (r && r.campaigns) || [];
      // Per-campaign detail only to read leadCounts.sent; capped so a long
      // engine history can't turn one poll into hundreds of round-trips.
      const details = await Promise.all(cloudCamps.slice(0, 60).map(async (c) => {
        try { const d = await getCloudCampaign(c.id); return d && !d.error ? d : { campaign: c, leadCounts: {} }; }
        catch { return { campaign: c, leadCounts: {} }; }
      }));
      for (const d of details) {
        const c = d.campaign || {};
        // TODAY'S sends — count per-lead rows whose sentAt is today. Only fetch
        // leads for campaigns that COULD have sent today (running/monitoring/
        // paused, or created today); a campaign done days ago contributes 0
        // without a fetch, so the extra round-trips stay bounded to today-active
        // work. The engine exposes no last-activity timestamp, so this gate can
        // miss a campaign that started >1 day ago, isn't running now, yet sent
        // earlier today (e.g. paused mid-morning) — rare; logged below.
        const _st = String(c.status || '').toLowerCase();
        const _createdMs = c.created_at ? Date.parse(c.created_at) : NaN;
        const _activeToday = _st === 'running' || _st === 'monitoring' || _st === 'paused'
          || (Number.isFinite(_createdMs) && _createdMs >= _todayStart);
        let todaySent = 0;
        if (_activeToday) {
          _leadsChecked++;
          try {
            const lr = await getCloudCampaignLeads(c.id);
            if (lr && !lr.error && Array.isArray(lr.leads)) todaySent = countLeadsSentToday(lr.leads, _todayStart, _todayEnd);
          } catch { /* per-campaign best-effort — leave todaySent 0 */ }
        } else { _leadsSkipped++; }
        // Cloud campaign object (engine campaign-api.js) uses snake_case field
        // names (mirrors renderCampaignsBoard()'s usage of c.profile_ids /
        // c.created_at). It does NOT carry account display names — only raw
        // GoLogin profile ids — so accountNames stays unset here; the client
        // labels ids via its own allProfilesData (shared GoLogin team) lookup.
        entries.push({
          owner: c.owner || '',
          bucket: bucketForCloudStatus(c.status),
          sent: Number((d.leadCounts || {}).sent || 0),   // cumulative
          todaySent,                                       // sent today only
          campaignName: c.name || '',
          mode: c.mode || '',
          accounts: Array.isArray(c.profile_ids) ? c.profile_ids : [],
          // c.created_at is the closest available timestamp — the engine does
          // not expose a separate "started running" time on the campaign
          // object, so this doubles as startedAt. null when absent.
          startedAt: c.created_at || null,
        });
      }
    }
  } catch (e) { cloudError = e.message; }
  // This machine's local activity (other operators' local campaigns are not
  // visible here — cloud is the only cross-machine source).
  const localOwner = getOperatorEmail() || req.user || '';
  // Local machine's own TODAY (mirrors the header "Today (sent)" KPI): sum of
  // successCount for campaigns that STARTED today (finished ones from history +
  // the currently-running one, which isn't written to history until it ends).
  let localTodaySent = 0;
  try {
    for (const h of await listHistory({ includeArchived: true })) {
      const t = Date.parse(h.startedAt || h.date || '');
      if (Number.isFinite(t) && t >= _todayStart && t < _todayEnd) {
        localTodaySent += (h.successCount != null ? h.successCount : (h.totalProcessed || 0));
      }
    }
  } catch { /* history best-effort */ }
  try {
    const s = getCampaignStatus();
    if (s && (s.running || s.state === 'monitoring')) {
      const t = s.startedAt ? Date.parse(s.startedAt) : NaN;
      if (Number.isFinite(t) && t >= _todayStart && t < _todayEnd) localTodaySent += (s.totalProcessed || 0);
      // Local campaign status DOES carry parallel profileIds/profileNames
      // arrays, so a real id→name map is available here (unlike cloud).
      const accountNames = {};
      const ids = Array.isArray(s.profileIds) ? s.profileIds : [];
      const names = Array.isArray(s.profileNames) ? s.profileNames : [];
      ids.forEach((id, i) => { if (id && names[i]) accountNames[id] = names[i]; });
      entries.push({
        owner: localOwner,
        bucket: 'running',
        sent: s.totalProcessed || 0,
        todaySent: localTodaySent,     // carry the whole machine's today on the running row
        campaignName: s.name || '',
        mode: s.mode || '',
        accounts: ids,
        accountNames,
        startedAt: s.startedAt || null,
      });
      localTodaySent = 0;              // consumed by the running entry — don't double-count below
    }
  } catch { /* local status best-effort */ }
  // No local campaign running but the machine still sent locally today → carry
  // the count on a minimal done entry so the operator's row reflects it.
  if (localTodaySent > 0) entries.push({ owner: localOwner, bucket: 'done', sent: 0, todaySent: localTodaySent });
  try {
    for (const _q of await getQueue()) entries.push({ owner: localOwner, bucket: 'queued', sent: 0 });
  } catch { /* queue best-effort */ }
  if (_leadsChecked || _leadsSkipped) {
    cloudLog(`[team-status] today's-sends: fetched leads for ${_leadsChecked} today-active campaign(s), skipped ${_leadsSkipped} inactive (0 today).`);
  }
  const payload = {
    ok: true,
    rows: aggregateTeamStatus(entries),
    cloudError,               // surfaced, not fatal — local rows still render
    generatedAt: Date.now(),
  };
  _teamStatusCache = { at: Date.now(), payload };
  res.json(payload);
});

// Primary people the operator has actually launched with, newest first, derived
// from those same snapshots. Feeds the name type-ahead in the CC+IC Primary
// Person card so a known name recalls its LinkedIn URL instead of being retyped.
app.get('/api/primary-people', async (_req, res) => {
  try {
    res.json({ people: await getPrimaryPeople() });
  } catch (err) {
    // Recall is a convenience: a broken store must never block the wizard.
    res.json({ people: [], error: err.message });
  }
});

// The wizard config snapshotted at dispatch — used to Duplicate a cloud campaign.
app.get('/api/campaign/cloud/:id/launch-config', async (req, res) => {
  const rec = await getCloudLaunchConfig(req.params.id);
  if (!rec) return res.status(404).json({ error: 'No saved launch config for this campaign.' });
  res.json({ name: rec.name || '', config: rec.config || {} });
});
// v2.160.44: persist edits made in the OPEN-to-edit wizard back onto the
// campaign's own launch-config snapshot (creating one for older campaigns that
// never had it), so re-opening the stopped campaign shows the edits. The
// campaign's engine status is untouched — it stays stopped.
app.post('/api/campaign/cloud/:id/launch-config', async (req, res) => {
  const body = req.body || {};
  const config = body.config;
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing config.' });
  }
  try {
    await saveCloudLaunchConfig(req.params.id, body.name || '', config);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to save launch config.' });
  }
});
app.post('/api/campaign/cloud/:id/stop', async (req, res) => {
  // NOTE: monitoringScope is computed and passed for the day the engine honours
  // it; stopCloudCampaign does not forward it, and the engine's stop route has
  // no scope parameter at all. The scope pill only affects "Check now" today.
  const how = req.query.keepMonitoring ? 'stop sending, keep monitoring'
    : req.query.pause ? 'pause'
    : req.query.immediate ? 'stop now' : 'stop after the current person';
  // The stop left no trace anywhere: not here, not in the campaign's live log.
  // A control the operator presses must say it was heard, and say what came back.
  cloudLog(`[cloud] stop requested for ${req.params.id} — ${how}`);
  const r = await stopCloudCampaign(req.params.id, {
    pause: !!req.query.pause,
    keepMonitoring: !!req.query.keepMonitoring, // "Stop sending, keep monitoring"
    monitoringScope: req.query.monitoringScope === 'tab' ? 'tab' : 'campaign',
    immediate: !!req.query.immediate,
  });
  if (r.error) {
    cloudLog(`[cloud] stop for ${req.params.id} was NOT accepted by the VM: ${r.error} — sending may still be running.`);
    return res.status(502).json(r);
  }
  cloudLog(`[cloud] stop for ${req.params.id} accepted by the VM — now ${r.status || (r.campaign && r.campaign.status) || 'unknown'}`);
  res.json(r);
});
// Resume a paused cloud campaign (mirror of local Resume).
app.post('/api/campaign/cloud/:id/resume', async (req, res) => {
  const r = await resumeCloudCampaign(req.params.id);
  if (r.error) return res.status(502).json(r);
  res.json(r);
});
// Restart a cancelled/stopped/errored cloud campaign — re-activate the same
// record (engine flips terminal status → running; sent leads skipped). Surface
// the engine's error (incl. 404 until it ships /restart) so the UI degrades.
app.post('/api/campaign/cloud/:id/restart', async (req, res) => {
  // startAt → schedule the restart instead of running it now. Validated here for
  // the same reason as /start-cloud: a past or malformed instant must fail at the
  // click, not silently restart the campaign immediately.
  const startAt = req.body && req.body.startAt;
  if (startAt) {
    const t = new Date(startAt).getTime();
    if (!Number.isFinite(t)) return res.status(400).json({ error: `startAt is not a date: ${startAt}` });
    if (t <= Date.now()) return res.status(400).json({ error: 'That start time has already passed — pick a future one.' });
  }
  const r = await restartCloudCampaign(req.params.id, {
    fromStart: !!(req.body && req.body.fromStart),
    dailyLimit: req.body && req.body.dailyLimit,
    startAt: startAt || undefined,
    // This is a phase command, not a generic restart. The VM must retire or
    // abort acceptance checking before it returns the campaign to sending.
    resumeSending: !!(req.body && req.body.resumeSending),
  });
  if (r && r.error) return res.status(r.status || 502).json(r);
  res.json(r);
});
// Edit a dispatched cloud campaign (OPEN → wizard → pause → Save edits &
// resume). The engine has no in-place update, so "edit" = stop the paused
// original and redispatch its still-pending leads as a NEW campaign with the
// edited wizard config. Already-processed leads are excluded via
// excludeLeadUrls so nobody is contacted twice.
app.post('/api/campaign/cloud/:id/edit-redispatch', async (req, res) => {
  try {
    const id = req.params.id;
    const cur = await getCloudCampaign(id);
    if (cur && cur.error) return res.status(502).json(cur);
    const status = String(((cur && cur.campaign) || cur || {}).status || '');
    if (status === 'running') return res.status(409).json({ error: 'Pause the campaign first — edits redispatch its remaining leads.' });
    const got = await getCloudCampaignLeads(id);
    if (got && got.error) return res.status(502).json(got);
    const processed = (got.leads || [])
      .filter((l) => String(l.status || '') !== 'pending')
      .map((l) => l.leadUrl)
      .filter(Boolean);
    // Stop the original for good BEFORE dispatching the replacement — two live
    // campaigns sending to the same pending leads is the worst failure mode.
    const stopped = await stopCloudCampaign(id);
    if (stopped && stopped.error) return res.status(502).json({ error: `Could not stop the original campaign: ${stopped.error}` });
    cloudLog(`[cloud] edit-redispatch: ${id} stopped (${processed.length} already-processed lead(s)) — redispatching remainder with edited config`);
    req.body = { ...(req.body || {}), excludeLeadUrls: processed };
    return handleStartCloud(req, res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Handover: move a live campaign between the Cloud VM and this Mac ────────
// Same shape as edit-redispatch above (stop one side, resume the remainder on
// the other with the already-processed leads excluded), generalised into a
// durable ownership change in either direction.
//
// THE RULE, and it is not negotiable for speed: the target side may not begin
// while the source might still be working the same leads. Two sides sweeping at
// once both read a blank Introduction Status and both fire an intro DM to the
// same person. So every failure here ABORTS and leaves the campaign where it
// was. A 409 from the engine means abort, never retry-anyway.
//
// Order of operations (src/handover.js handoverPlan encodes it, and its test
// fails if it is ever reversed): confirm the target can take the campaign,
// release the source, read what is already done, start the target, reset the
// adaptive check cadence.

// Stop whatever this Mac is doing for the current campaign and WAIT until it is
// observably finished: not running, not monitoring, no bulk check in flight.
// Reuses the existing stop paths rather than adding a new one. stopMonitoring
// stamps nothing in the sheet (see its comment), so a monitoring campaign can
// leave this Mac without its still-pending leads being closed off.
async function stopLocalAndConfirm({ timeoutMs = 120000 } = {}) {
  if (campaign.running) stopCampaign({ full: true, reason: 'handover-to-vm' });
  else if (campaign.state === 'monitoring') await stopMonitoring({ reason: 'handover-to-vm' });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = getCampaignStatus();
    if (!s.running && s.state !== 'monitoring' && !s.monitoringCheckInProgress) return { ok: true };
    if (Date.now() >= deadline) return { ok: false };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// VM → this Mac. `id` is the cloud campaign id.
async function handoverToLocal(id, req, res) {
  // One campaign at a time on this Mac. Checked BEFORE the release, or the
  // engine hands ownership to a machine that cannot actually run it and the
  // campaign sits released and idle.
  if (campaign.running || campaign.state === 'monitoring') {
    return res.status(409).json({ error: 'This Mac is already running a campaign. Finish or stop that one first, then move this campaign here.' });
  }
  const cur = await getCloudCampaign(id);
  if (cur && cur.error) return res.status(502).json({ error: `Could not read the campaign on the VM: ${cur.error}` });
  const camp = (cur && cur.campaign) || cur || {};
  const cfg = camp.config || {};
  if (!camp.sheet_url) return res.status(400).json({ error: 'That cloud campaign has no source sheet, so it cannot be rebuilt here.' });

  // Release FIRST. Fails closed: a live sweep, a lost race, or an engine too old
  // to know the route all answer 409 and the campaign stays on the VM.
  const rel = await releaseCloudCampaign(id);
  if (!rel || rel.error || !rel.released) {
    if (rel && rel.status === 409) {
      return res.status(409).json({
        reason: 'sweep_in_flight',
        error: 'The VM is part-way through a check on this campaign, so it will not hand it over yet. Wait for that check to finish, then move it again.',
      });
    }
    return res.status(502).json({ error: `The VM would not hand this campaign over: ${(rel && rel.error) || 'no confirmation'}. It is still running there.` });
  }

  // What the VM already did. The engine's per-lead table is its ledger; the
  // in-flight lead reads as still-to-do and is retried here on purpose.
  const got = await getCloudCampaignLeads(id);
  if (got && got.error) {
    return res.status(502).json({ error: `The VM released the campaign but its lead list could not be read (${got.error}), so nothing was started here. The campaign is now waiting on this Mac: move it back, or start it here yourself.` });
  }
  const allLeads = (got && got.leads) || [];
  const excluded = processedLeadUrls(allLeads);
  const remaining = allLeads.length - excluded.length;
  const profileIds = Array.isArray(camp.profile_ids) ? camp.profile_ids : [];

  // A campaign with nothing left to send is the case this whole feature was
  // asked for: everything is out, the operator wants the ACCEPTANCE CHECKS on
  // his own machine. It must be adopted straight into local monitoring —
  // startCampaign would find 0 targets and land it on 'done', stranded.
  // A recovery card can carry stronger phase evidence than an old engine row:
  // next_check_at/monitoring_until, or the explicit operator action "Resume
  // checks". In that case never let the stale status word `running` resurrect
  // sender work on this Mac.
  const preserveMonitoring = String(req.body && req.body.phase || '').toLowerCase() === 'monitoring'
    || !!camp.next_check_at || !!camp.monitoring_until;
  if (preserveMonitoring || handoverTargetForCampaign(camp.status, allLeads) === 'monitor') {
    let profileNames = [];
    try {
      const profs = await getProfiles(process.env.GOLOGIN_API_TOKEN);
      const byId = new Map((profs || []).map((p) => [p.id, String(p.name || '').trim()]));
      profileNames = profileIds.map((pid) => byId.get(pid) || pid);
    } catch { profileNames = profileIds.slice(); }
    const adopted = await adoptMonitoring({
      id,
      name: camp.name || '',
      mode: camp.mode,
      sheetUrl: camp.sheet_url,
      sheetGid: cfg.sheetGid || '',
      linkedinColumn: cfg.linkedinColumn || '',
      profileIds,
      profileNames,
      participatingProfileIds: profileIds,
      sendingEndedAt: camp.sending_ended_at || null,
      monitoringUntil: camp.monitoring_until || null,
      templates: cfg,
      senderFirstNames: cfg.senderFirstNames || {},
      checkIntervalMinutes: cfg.checkIntervalMinutes,
      autoChecksEnabled: camp.auto_checks_enabled !== false,
      totalTargets: allLeads.length,
      totalProcessed: excluded.length,
    });
    if (!adopted.ok) {
      return res.status(409).json({ error: `${adopted.error} The campaign is now waiting on this Mac: move it back, or free this machine and try again.` });
    }
    campaign.runsOn = 'local';
    campaign.handoverAt = Date.now();
    cloudLog(`[cloud] handover: ${id} → local (monitoring adopted, next check ${adopted.nextCheckAt})`);
    return res.json({ ok: true, to: 'local', id, remaining, excluded: excluded.length, adopted: 'monitoring', nextCheckAt: adopted.nextCheckAt });
  }

  const config = buildCampaignConfig({
    profileIds,
    sheetUrl: camp.sheet_url,
    sheetGid: cfg.sheetGid,
    templates: cfg,
    dailyLimit: camp.daily_limit,
    mode: camp.mode,
    linkedinColumn: cfg.linkedinColumn || '',
    senderColumn: cfg.senderColumn || '',
    name: camp.name || '',
    delayMin: cfg.delayMin,
    delayMax: cfg.delayMax,
    checkIntervalMinutes: cfg.checkIntervalMinutes,
    primaryCheckTiming: cfg.primaryCheckTiming,
    // The hard exclusion list startCampaign already honours and persists for a
    // restore. Named for the pre-flight gate that usually fills it; here it
    // carries what the VM finished.
    _preflightExcludedUrls: excluded,
    // This is a continuation, not a new run: keeps the campaign's log, its
    // Recent Connections tab and its counters instead of wiping them.
    resumeContext: { totalProcessed: excluded.length },
  });

  // Decision 2: an operator who moves a campaign wants to see something happen,
  // so the adaptive backoff re-earns itself from scratch on this side too. The
  // engine reset its own streak inside handover-release.
  campaign.emptyCheckStreak = 0;
  campaignLog(`⇄ Moved here from the Cloud VM: ${remaining} lead(s) still to do, ${excluded.length} already done there. Acceptance checks restart at ${config.checkIntervalMinutes} min.`);
  cloudLog(`[cloud] handover: ${id} → local (${remaining} remaining, ${excluded.length} excluded)`);
  // After launchCampaign, which stamps local ownership itself and would clear
  // handoverAt: this is the move, so it keeps the timestamp.
  launchCampaign(config, req.user);
  campaign.runsOn = 'local';
  campaign.handoverAt = Date.now();
  return res.json({ ok: true, to: 'local', id, remaining, excluded: excluded.length });
}

// This Mac → VM. The local campaign is the singleton, so `id` is only used for
// the log line: what moves is whatever is running here.
async function handoverToVm(id, req, res) {
  const running = campaign.running;
  const monitoring = !running && campaign.state === 'monitoring';
  if (!running && !monitoring) {
    // Recovery after sleep/quit: the engine row still exists and says it was
    // handed to This Mac, but the local singleton is gone. Reclaim that durable
    // row instead of refusing because there is no process left to stop.
    const cur = await getCloudCampaign(id);
    const camp = (cur && cur.campaign) || cur || {};
    if (String(camp.runs_on || '') !== 'local') {
      return res.status(409).json({ error: 'Nothing is running on this Mac, and this campaign is not waiting for this Mac, so nothing was moved.' });
    }
    const rec = await reclaimCloudCampaign(id);
    if (!rec || rec.error || !rec.reclaimed) {
      const rr = reclaimRefusal(rec && rec.reason);
      return res.status(rec && rec.status === 409 ? 409 : 502).json({ reason: (rec && rec.reason) || undefined, error: rr.error });
    }
    if (String(req.body && req.body.phase || '') === 'sending') {
      const resumed = await restartCloudCampaign(id, { fromStart: false });
      if (!resumed || resumed.error) {
        return res.status((resumed && resumed.status) || 502).json({ error: (resumed && resumed.error) || 'The VM reclaimed monitoring, but could not resume sending. Monitoring remains safe on the VM.' });
      }
    }
    cloudLog(`[cloud] handover recovery: ${id} → vm (${req.body && req.body.phase === 'sending' ? 'sending resumed' : 'monitoring reclaimed'})`);
    return res.json({ ok: true, to: 'vm', id, reclaimed: true, phase: (req.body && req.body.phase) || 'monitoring' });
  }

  // A campaign this Mac ADOPTED from the VM still has its engine row intact:
  // handover-release never cancelled it, because it was monitoring rather than
  // running. So hand that row back rather than dispatching a new campaign, which
  // would be impossible anyway (nothing left to send) and would mint a second
  // card on the board. Checked FIRST: an adopted campaign has no local launch
  // snapshot, so the settings check below would refuse it.
  const cloudId = monitoring ? reclaimableCloudId(campaign, SINGLETON_CAMPAIGN_ID) : '';
  if (cloudId) {
    const rec = await reclaimCloudCampaign(cloudId);
    if (!rec || rec.error || !rec.reclaimed) {
      const r = reclaimRefusal(rec && rec.reason);
      // Only the VM-already-owns-it case touches this side, and it does so to
      // remove an owner, never to half-move a campaign.
      if (r.stopLocal) await stopMonitoring({ reason: 'handover-vm-already-owns' });
      return res.status(rec && rec.status === 409 ? 409 : 502).json({ reason: (rec && rec.reason) || undefined, error: r.error });
    }
    // Reclaimed. The engine armed its own sweep one base interval out, so stop
    // this side now: two armed watchers is the two-intros case.
    await stopMonitoring({ reason: 'handover-to-vm' });
    campaign.emptyCheckStreak = 0;
    campaign.runsOn = 'vm';
    campaign.handoverAt = Date.now();
    cloudLog(`[cloud] handover: ${cloudId} → vm (monitoring reclaimed, status ${rec.status})`);
    return res.json({ ok: true, to: 'vm', id: cloudId, reclaimed: true, status: rec.status });
  }

  const last = getLastRunSettings();
  if (!last || !last.sheetUrl) {
    return res.status(409).json({ error: 'This Mac has no record of how this campaign was launched, so the VM cannot be given the same settings. Stop it here and start it in the cloud instead.' });
  }
  if (!isCloudMode(last.mode)) return res.status(400).json({ error: `Mode "${last.mode}" cannot run in the cloud, so this campaign has to stay on this Mac.` });

  // What this Mac already did. The local side keeps no per-lead table: the sheet
  // is its ledger, stamped as it goes, so that is what the VM must skip.
  const gid = String(last.sheetGid || '').replace(/\D/g, '');
  const rows = await fetchSheet(withGid(last.sheetUrl, gid));
  const urlOf = (row) => extractLinkedInUrl(row, last.linkedinColumn || '');
  const excluded = sheetProcessedUrls(rows, urlOf);
  const excludedSet = new Set(excluded);
  const remaining = rows.filter((r) => { const u = urlOf(r); return u && !excludedSet.has(String(u).trim()); }).length;
  if (!remaining) {
    // Started here and finished sending here: there is no engine row to reclaim
    // (the reclaim path above already handled the ones that have one), and the
    // engine only takes campaigns that have leads.
    return res.status(409).json({ error: 'Every lead in the sheet has already been sent, so there is nothing for the VM to run. Keep the acceptance checks on this Mac.' });
  }

  const cloudBody = {
    profileIds: Array.isArray(last.profileIds) ? last.profileIds : [],
    sheetUrl: last.sheetUrl,
    sheetGid: gid,
    linkedinColumn: last.linkedinColumn || '',
    mode: last.mode,
    dailyLimit: last.dailyLimit,
    templates: last.templates || {},
    name: last.name || '',
    senderColumn: last.senderColumn || '',
    senderFirstNames: last.senderFirstNames || {},
    delayMin: last.delayMin,
    delayMax: last.delayMax,
    excludeLeadUrls: excluded,
  };
  req.body = cloudBody;
  // Ortus Basics 1.0: pre-flight gate disabled.
  // if (!await runPreflightGate(req, res)) return;

  // Now, and only now, stop this side, and prove it stopped.
  const stopped = await stopLocalAndConfirm();
  if (!stopped.ok) {
    return res.status(409).json({
      reason: 'source_still_running',
      error: 'This Mac has not finished stopping the campaign, so it was not moved. Nothing was started on the VM. Wait for the browsers to close, then try again.',
    });
  }

  campaign.emptyCheckStreak = 0;
  campaign.runsOn = 'vm';
  campaign.handoverAt = Date.now();
  campaignLog(`⇄ Moved to the Cloud VM: ${remaining} lead(s) still to do, ${excluded.length} already done here.`);
  cloudLog(`[cloud] handover: ${id} → vm (${remaining} remaining, ${excluded.length} excluded)`);
  return handleStartCloud(req, res);
}

app.post('/api/campaign/:id/handover', async (req, res) => {
  const to = String((req.body && req.body.to) || '');
  if (to !== 'local' && to !== 'vm') return res.status(400).json({ error: 'Say which side to move to: "local" or "vm".' });
  try {
    return to === 'local'
      ? await handoverToLocal(req.params.id, req, res)
      : await handoverToVm(req.params.id, req, res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});
// Monitoring controls (Task 3 Part B) — proxy ⚡ Check now / auto-checks toggle to
// the engine. Surface the engine's error (incl. 404 until it ships these routes)
// so the client degrades gracefully rather than throwing.
// ── follow-up health: what the card's follow-up line and banner read ──
// Counts straight off the local primary-task queue. `blocked` is the number
// parked because the follow-up browser is signed out — the one state the
// operator can clear in a click, and the one that used to be invisible.
// Follow-up counts. Pass campaignId (and profileIds, for follow-ups queued
// before campaignId was stamped) to get ONE campaign's numbers; pass neither
// and you get the app's lifetime totals, which is what the card used to show on
// every campaign — a run minutes old reporting another campaign's 48 failures
// as its own (Sam, 2026-09-02). Scoping is opt-in so nothing else breaks.
app.get('/api/followups/health', async (req, res) => {
  try {
    const tasks = await loadPrimaryTasks();
    const fu = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.type === 'follow-up');
    const campaignId = String(req.query.campaignId || '').trim();
    const profileIds = String(req.query.profileIds || '').split(',').map((x) => x.trim()).filter(Boolean);
    const scoped = !!(campaignId || profileIds.length);
    // Unscoped keeps the old whole-app answer for any caller that has not been
    // updated. Scoped counts one campaign, which is what the card now asks for.
    const startedAt = Number(req.query.startedAt || 0) || 0;
    // Unscoped keeps the old whole-app answer for any caller that has not been
    // updated. Scoped counts one campaign, which is what the card now asks for.
    const mine = scoped ? fu.filter((t) => belongsToCampaign(t, { campaignId, profileIds, startedAt })) : fu;
    res.json({ ok: true, scoped, ...countFollowUpHealth(mine, { heldSummaryOf: heldSummary }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Everything the board needs about follow-ups, in ONE request per render:
//   health — per campaign, for EVERY campaign on the board. Both live status
//     cards render per campaign (the dashboard strip's card #2 from its own
//     strip's status, and the campaign tab's #active-card), so each needs its
//     own numbers. Fetching only the campaign being viewed would leave every
//     other strip's follow-up row blank.
//   groups — stuck follow-ups whose campaign is NOT on the board. Those have no
//     card to live on; the strip above the rails is their only home. Excluding
//     the board's own campaigns is what keeps a follow-up in exactly one place.
// One reading of "which campaigns are live on the board", shared by the board
// route and by Discard. Discard has to apply the SAME ownership test that kept a
// follow-up out of the strip, or it would reach into a campaign still running:
// legacy groups are keyed by their message, and sibling campaigns reuse one
// template. startedAt is what stops a live campaign adopting an older orphan
// that merely shares its LinkedIn account.
function liveCampaignScope(campaigns) {
  return (Array.isArray(campaigns) ? campaigns : [])
    .map((c) => ({
      id: String((c && c.id) || ''),
      profileIds: Array.isArray(c && c.profileIds) ? c.profileIds : [],
      startedAt: Number((c && c.startedAt) || 0) || 0,
    }))
    .filter((c) => c.id || c.profileIds.length);
}

app.post('/api/followups/board', async (req, res) => {
  try {
    const tasks = await loadPrimaryTasks();
    const campaigns = Array.isArray(req.body && req.body.campaigns) ? req.body.campaigns : [];
    const live = liveCampaignScope(campaigns);
    const health = {};
    for (const c of live) {
      if (!c.id) continue;
      health[c.id] = { ok: true, scoped: true, ...healthForCampaign(tasks, c, { heldSummaryOf: heldSummary }) };
    }
    const groups = groupStaleFollowUps(tasks, { liveCampaigns: live });
    res.json({ ok: true, health, groups, total: groups.reduce((a, g) => a + g.count, 0) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Drop a group of follow-ups. selectDue() only ever takes 'pending', so a
// discarded task can never be sent — it is not deleted, so Undo can put it back
// exactly as it was (the response carries what to hand to /restore).
app.post('/api/followups/discard', async (req, res) => {
  try {
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
    if (!keys.length) return res.status(400).json({ error: 'keys required' });
    const live = liveCampaignScope(Array.isArray(req.body && req.body.campaigns) ? req.body.campaigns : []);
    const { tasks, discarded } = discardGroups(await loadPrimaryTasks(), keys, { liveCampaigns: live });
    if (discarded.length) await savePrimaryTasks(tasks);
    console.log(`[followups] discarded ${discarded.length} follow-up(s) the operator decided not to send`);
    res.json({ ok: true, discarded: discarded.length, undo: discarded });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The operator has read the reply and wants it sent anyway. Held → pending is
// all it takes: the runner's next drain picks it up like any other due task.
app.post('/api/followups/send-held', async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const want = new Set(ids);
    let released = 0;
    const tasks = (await loadPrimaryTasks()).map((t) => {
      if (!t || t.status !== 'held' || !want.has(t.id)) return t;
      released += 1;
      const { heldReason, heldPhrase, heldQuote, heldAt, ...rest } = t;
      // dueAt in the past so it goes on the very next drain, not in ten minutes.
      return { ...rest, status: 'pending', dueAt: Date.now() - 1000, attempts: 0, lastError: null };
    });
    if (released) await savePrimaryTasks(tasks);
    console.log(`[followups] the operator read the reply and released ${released} held follow-up(s) to send`);
    res.json({ ok: true, released });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/followups/restore', async (req, res) => {
  try {
    const undo = Array.isArray(req.body && req.body.undo) ? req.body.undo : [];
    if (!undo.length) return res.status(400).json({ error: 'undo required' });
    await savePrimaryTasks(restoreDiscarded(await loadPrimaryTasks(), undo));
    console.log(`[followups] put ${undo.length} discarded follow-up(s) back in the queue`);
    res.json({ ok: true, restored: undo.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── open the follow-up browser ON SCREEN so the operator can sign in ──
// Same Chrome profile the follow-up runner uses, so signing in here is what
// unblocks the parked follow-ups. Deliberately left OPEN: closing it is the
// operator's signal that they are done.
app.post('/api/followups/open-login', async (_req, res) => {
  try {
    const { page } = await launchLocalBrowser({ visible: true });
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 })
      .catch(() => { /* the window is open either way — that is the point */ });
    console.log('[followups] opened the follow-up browser on screen for sign-in');
    res.json({ ok: true });
  } catch (e) {
    console.warn(`[followups] could not open the follow-up browser: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── put failed / parked follow-ups back in the queue ──
// Revives BOTH: tasks parked on a signed-out browser, and tasks that already
// burned their three attempts before parking existed (1 Sep left five of those).
app.post('/api/followups/retry', async (_req, res) => {
  try {
    const tasks = await loadPrimaryTasks();
    const targets = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.type === 'follow-up'
      && (t.status === 'failed' || (t.status === 'pending' && t.blockedBySession)));
    for (const t of targets) {
      await markPrimaryTask(t.id, 'pending', { attempts: 0, lastError: '', blockedBySession: false, dueAt: Date.now() });
    }
    console.log(`[followups] revived ${targets.length} follow-up(s) to pending`);
    res.json({ ok: true, revived: targets.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/campaign/cloud/:id/check-now', async (req, res) => {
  const r = await cloudCheckNow(req.params.id, (req.body && req.body.scope) === 'all' ? 'all' : 'campaign');
  if (r && r.error) return res.status(r.status || 502).json(r);
  res.json(r);
});
// Stop the sweep running on the VM. Counterpart to check-now above; the engine
// halts at its next account boundary and leaves the campaign alone.
app.post('/api/campaign/cloud/:id/check/stop', async (req, res) => {
  const r = await cloudCheckStop(req.params.id);
  if (r && r.error) return res.status(r.status || 502).json(r);
  res.json(r);
});
// Edit a cloud campaign's account set (paused/stopped only) — the cloud twin of
// the local pause-edit panel. Body: { add: [{profileId,email}], remove: [id] }.
// For CC+IC the client runs the LOCAL primary handshake for an added account
// BEFORE calling this, so the new sender is already connected to the primary.
app.post('/api/campaign/cloud/:id/accounts', async (req, res) => {
  const b = req.body || {};
  const add = Array.isArray(b.add) ? b.add : [];
  // Resolve each added account's REAL SoO email here, exactly as handleStartCloud
  // does at launch (fuzzy match + skip-on-doubt). The client can only offer the
  // GoLogin profile NAME, which is not always the SoO email — sending that through
  // put a display name into config.accountEmails, so the accounts panel labelled
  // the row with it and the engine's SoO Needs-Login stamping (matched by email)
  // never found the account. Best-effort: a SoO failure leaves the client's value.
  if (add.length) {
    try {
      const profs = await getProfiles(process.env.GOLOGIN_API_TOKEN).catch(() => []);
      const idToName = new Map((profs || []).map((p) => [p.id, String(p.name || '').trim()]));
      const soo = await fetchSoOData();
      const sooEmails = (((soo && soo.accounts) || []).map((a) => a && a.email).filter(Boolean));
      for (const a of add) {
        const label = idToName.get(a.profileId) || String(a.email || '').trim();
        if (!label) continue;
        const r2 = resolveSoOEmail(label, sooEmails);
        if (r2 && r2.email) a.email = r2.email;
        else if (r2 && r2.ambiguous) cloudLog(`[cloud] SoO email ambiguous for "${label}" — added without an email (no Needs-Login stamping for it)`);
      }
    } catch (e) { cloudLog(`[cloud] add-account SoO email resolve skipped: ${e.message}`); }
  }
  const r = await setCloudCampaignAccounts(req.params.id, {
    add,
    remove: Array.isArray(b.remove) ? b.remove : [],
  });
  if (r && r.error) return res.status(r.status || 502).json(r);
  res.json(r);
});
app.post('/api/campaign/cloud/:id/auto-checks', async (req, res) => {
  const r = await setCloudAutoChecks(req.params.id, !!(req.body && req.body.enabled));
  if (r && r.error) return res.status(r.status || 502).json(r);
  res.json(r);
});
// Cloud primary-handshake: the local app POSTs which senders its local primary
// browser accepted; forwarded to the engine which re-verifies + resumes.
app.post('/api/campaign/cloud/:id/primary-accept-done', async (req, res) => {
  const ids = Array.isArray(req.body?.accepted) ? req.body.accepted : [];
  const r = await signalPrimaryAcceptDone(req.params.id, ids);
  if (r.error) return res.status(r.status || 502).json(r);
  res.json(r);
});
// Cloud primary-handshake — Path A (local pre-dispatch). Before a cloud CC+IC
// campaign with a LOCAL-ONLY primary is dispatched, the client runs this to
// connect the GoLogin senders to the primary and accept them in the local
// primary browser (the engine can't — no operator Chrome on the VM). Single-
// flight; the wizard polls /status for live per-sender progress. See
// docs/superpowers/specs/2026-07-11-cloud-handshake-path-a-local-predispatch-design.md
app.post('/api/campaign/cloud-preflight-handshake', (req, res) => {
  const r = startHandshakeJob(req.body || {});
  res.status(r.status || 200).json(r);
});
app.get('/api/campaign/cloud-preflight-handshake/status', (_req, res) => {
  res.json(getHandshakeJob());
});
// Live "Show campaign happening" — proxies the engine's MJPEG screencast of the
// campaign's active browser session straight to the dashboard <img> (mirrors
// /api/scrape/view/:jobId). Long-lived stream; abort upstream on disconnect.
// Returns a clean 501 JSON until the engine ships /api/campaign/:id/view (see
// docs/cloud-engine-campaign-view-spec.md).
app.get('/api/campaign/cloud/:id/view', async (req, res) => {
  const stream = await openCampaignViewStream(req.params.id);
  if (!stream.ok) return res.status(stream.status || 502).json({ error: stream.error });
  res.writeHead(200, {
    'Content-Type': stream.contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Accel-Buffering': 'no',
  });
  const nodeStream = Readable.fromWeb(stream.body);
  const cleanup = () => {
    try { stream.abort(); } catch { /* */ }
    try { nodeStream.destroy(); } catch { /* */ }
  };
  req.on('close', cleanup);
  nodeStream.on('error', () => { try { res.end(); } catch { /* */ } });
  nodeStream.pipe(res);
});

// ── Pre-flight lead-sheet linter (runs on Start click, before launch) ─────
// In-memory ack registry: token → expiry. Proves the operator saw exactly
// these findings when /api/campaign/start later carries preflightAck.
const _preflightAcks = new Map();
function _registerAck(token) {
  _preflightAcks.set(token, Date.now() + 15 * 60 * 1000); // 15-min validity
  for (const [t, exp] of _preflightAcks) if (exp < Date.now()) _preflightAcks.delete(t);
}

/**
 * Shared interactive pre-flight gate used by /api/campaign/start and
 * /api/campaign/queue-only. Returns false (and has already written the error
 * response) when the request should be rejected; returns true when the caller
 * may proceed. On allow, populates req.body._preflightExcludedUrls with the
 * URLs of blocklist rows that must be excluded from the campaign.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @returns {Promise<boolean>}
 */
async function runPreflightGate(req, res) {
  try {
    const rawSheetUrl = String(req.body?.sheetUrl || '');
    const resolvedGid = req.body?.sheetGid != null
      ? String(req.body.sheetGid).replace(/\D/g, '')
      : '';
    const effectiveUrl = withGid(rawSheetUrl, resolvedGid);
    const gateRows = await fetchSheetWithRows(effectiveUrl);
    const gateGidExplicit = /[#&?]gid=\d+/.test(effectiveUrl) || !!resolvedGid;
    let gateTabs = 1;
    if (!gateGidExplicit) {
      try { gateTabs = (await listSheetTabs(rawSheetUrl)).length || 1; } catch { /* non-fatal */ }
    }
    const gateFindings = lintLeads({
      rows: gateRows,
      linkedinColumn: req.body?.linkedinColumn || '',
      mode: req.body?.mode || 'connect_only',
      templates: req.body?.templates || {},
      blocklist: readBlocklist(),
      tabCount: gateTabs,
      gidExplicit: gateGidExplicit,
    });
    const invalid = launchValidation({
      mode: req.body?.mode,
      profileIds: req.body?.profileIds,
      targetCount: gateFindings.targetCount,
      diagnostics: {
        alreadyProcessed: Number(gateFindings.stagedCount) || 0,
        noUrl: Number(gateFindings.noUrlCount) || 0,
        unmatchedSenders: gateFindings.warnings.filter((f) => f.check === 'sender_mismatch').length,
      },
    });
    if (invalid) {
      res.status(400).json({ error: invalid.message, launchRejected: true, diagnostic: invalid });
      return false;
    }
    const expected = ackFor(gateFindings);
    const provided = String(req.body?.preflightAck || '');
    const ackKnown = _preflightAcks.has(provided) && provided === expected;
    const gate = decidePreflightGate({ findings: gateFindings, ackProvided: ackKnown ? provided : '', ackExpected: expected });
    if (!gate.allow) {
      res.status(409).json({ error: `Pre-flight blockers found (${gateFindings.blockers.length}) — run the pre-flight check`, preflight: true });
      return false;
    }
    // Hard exclusion: blocklisted URLs never reach the campaign, ever.
    if (gate.excludeRows.length) {
      req.body._preflightExcludedUrls = gate.excludeRows.map((f) => f.url).filter(Boolean);
    }
    return true;
  } catch (gateErr) {
    // If the sheet cannot be read the campaign couldn't run anyway — refuse loudly.
    res.status(502).json({ error: `Pre-flight gate could not read the sheet: ${gateErr.message}` });
    return false;
  }
}

app.post('/api/preflight', async (req, res) => {
  try {
    const body = req.body || {};
    const sheetUrl = String(body.sheetUrl || '');
    if (!sheetUrl) return res.status(400).json({ ok: false, error: 'sheetUrl required' });

    const resolvedGid = body.sheetGid != null
      ? String(body.sheetGid).replace(/\D/g, '')
      : '';
    const effectiveUrl = withGid(sheetUrl, resolvedGid);
    const rows = await fetchSheetWithRows(effectiveUrl);

    // Tab ambiguity: explicit gid in the URL or supplied sheetGid? how many tabs?
    const gidExplicit = /[#&?]gid=\d+/.test(effectiveUrl) || !!resolvedGid;
    let tabCount = 1;
    if (!gidExplicit) {
      try { tabCount = (await listSheetTabs(sheetUrl)).length || 1; }
      catch { tabCount = 1; } // tabs unlistable → don't invent a blocker
    }

    const findings = lintLeads({
      rows,
      linkedinColumn: body.linkedinColumn || '',
      mode: body.mode || 'connect_only',
      templates: body.templates || {},
      blocklist: readBlocklist(),
      tabCount,
      gidExplicit,
      dailyLimit: Number(body.dailyLimit) || 0,
      accountCount: Array.isArray(body.profileIds) ? body.profileIds.length : 0,
    });

    const ack = ackFor(findings);
    _registerAck(ack);
    res.json({ ok: true, findings, ack });
  } catch (err) {
    // Sheet unreachable/429 etc. — surfaced now instead of at campaign start.
    res.status(502).json({ ok: false, error: `Pre-flight could not read the sheet: ${err.message}` });
  }
});

// Task 5 (2026-07-07): stamp excluded rows in the sheet after preflight
app.post('/api/preflight/stamp', async (req, res) => {
  const { sheetUrl, linkedinColumn, stamps } = req.body || {};
  if (!sheetUrl || !Array.isArray(stamps)) return res.status(400).json({ ok: false, error: 'sheetUrl and stamps required' });
  let stamped = 0; const failed = [];
  const { updateSheetRow } = await import('./src/sheets-writer.js');
  for (const s of stamps) {
    try {
      const ok = await updateSheetRow(sheetUrl, s.url, { stage: s.stampText }, linkedinColumn || '');
      if (ok) stamped++; else failed.push(s.url);
    } catch { failed.push(s.url); }
  }
  res.json({ ok: failed.length === 0, stamped, failed });
});

app.post('/api/campaign/start', async (req, res) => {
  try {
    // Phase 11.3 (DMS-04): mutex with Check DMs — both need the same browsers.
    if (checkDms.running) return res.status(409).json({ error: 'Check DMs is running — stop it first' });
    if (postAmp.running) return res.status(409).json({ error: 'Post Amplification is running — stop it first' });

    const body = req.body || {};
    const { profileIds, sheetUrl, dailyLimit, mode } = body;

    // Retired modes (2026-08-06) — the picker no longer offers them, but a saved
    // draft, a schedule or an old queued row can still carry one, and those all
    // arrive here. Reject at the door so a retired mode can't run locally either.
    if (isRetiredMode(mode)) {
      return res.status(400).json({ error: `"${mode}" campaigns have been retired and can no longer be launched.` });
    }

    // 2.8.29 / 2.8.31: check_status and message_only auto-derive profiles from
    // the sheet's Account Used column inside campaign.js (only the original
    // sender can check / message a given lead), so empty profileIds is valid.
    if (mode !== 'check_status' && mode !== 'message_only' && mode !== 'introduce_back' && !profileIds?.length) {
      return res.status(400).json({ error: 'profileIds required' });
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
    if (!dailyLimit || dailyLimit < 1) return res.status(400).json({ error: 'dailyLimit must be >= 1' });
    if (rejectIfNoOperatorEmail(res)) return;
    // A foreign-workspace profile — or one whose workspace doesn't run this
    // mode — is rejected at the door, not at launch time.
    if (await rejectIfForeignProfiles(req, res, profileIds, mode)) return;
    if (rejectIfBadPrimaryUrl(body, res)) return;

    // Fix A Task 4 — fast intake check: reject if the frontend signals a
    // multi-tab workbook but no tab was chosen. The deep guard fires again
    // inside campaign.js (Task 5); this keeps the failure fast and surfaced.
    {
      const resolvedGid = body.sheetGid != null
        ? String(body.sheetGid).replace(/\D/g, '')
        : extractSheetGid(sheetUrl || '');
      if (body.multiTab === true && !resolvedGid) {
        return res.status(400).json({ error: 'Pick the lead tab — this workbook has multiple tabs.' });
      }
    }

    // Ortus Basics 1.0: pre-flight gate disabled.
    // if (!await runPreflightGate(req, res)) return;

    const config = buildCampaignConfig(body);
    const owner = req.user;

    // Clear the wizard draft name on launch so the next "+ Start new
    // campaign" click opens an empty wizard rather than re-prompting
    // about a now-stale draft with the same name.
    try { await writeDraftName(''); } catch { /* non-fatal */ }

    // If a campaign is already running, queue this one instead of erroring.
    // The queue chain in launchCampaign's finally{} will pick it up when
    // the current campaign finishes.
    if (campaign.running) {
      const entry = await addToQueue(config, owner);
      const runningName = campaign.name || '(unnamed)';
      return res.json({
        ok: true,
        queued: true,
        queueId: entry.id,
        message: `Added to queue. Will start when "${runningName}" finishes.`,
      });
    }
    // Defensive: if nothing is running but there ARE items already in the
    // queue, drain the queue's first item BEFORE starting this new one so
    // FIFO order is preserved (would otherwise jump the line).
    const existingQueue = await getQueue();
    if (existingQueue.length > 0) {
      const entry = await addToQueue(config, owner);
      // Now drain the head of the queue (which will be the previously-first
      // entry, not this newcomer).
      runNextFromQueue().catch(err => console.error('Drain failed:', err.message));
      return res.json({
        ok: true,
        queued: true,
        queueId: entry.id,
        message: `Added to queue (${existingQueue.length} ahead).`,
      });
    }

    // Fire-and-forget — campaign runs in background; dashboard polls
    // /api/status. launchCampaign handles preventSleep, allowSleep,
    // queue chaining, and finish/failure email notifications.
    launchCampaign(config, owner);

    // v2.59 — start-time same-name dedup. Moved from BEFORE launchCampaign
    // (the original site) to AFTER. Reason: the original placement
    // rewrote history.json before the launch was confirmed. If launchCampaign
    // failed synchronously (e.g., startCampaign threw before campaign.running
    // could be set), the prior history row was already gone. Now we gate
    // on `campaign.running` — startCampaign sets this synchronously at its
    // top before any await, so by the time we're back here we know the
    // launch is accepted. The v2.58 appendHistory dedup is still the
    // ultimate safety net at campaign END.
    if (campaign.running) {
      try {
        const incomingName = String(config.name || '').trim().toLowerCase();
        if (incomingName) {
          let history = [];
          try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf8')); } catch { history = []; }
          if (Array.isArray(history)) {
            const before = history.length;
            history = history.filter((h) => ((h?.name || '').toString().trim().toLowerCase()) !== incomingName);
            if (history.length < before) {
              await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
              console.log(`[history] start-time dedup: removed ${before - history.length} prior entr${before - history.length === 1 ? 'y' : 'ies'} named "${config.name}"`);
            }
          }
        }
      } catch (err) {
        console.warn('[history] start-time dedup failed (non-fatal):', err.message);
      }

      // Also drop any draft with the same name — the operator is launching
      // this one, the draft slot is now obsolete.
      try {
        const incomingName = String(config.name || '').trim().toLowerCase();
        if (incomingName) {
          const allDrafts = await getDrafts();
          for (const d of allDrafts) {
            const dn = String(d?.name || '').trim().toLowerCase();
            if (dn === incomingName) await removeDraft(d.id);
          }
        }
      } catch (err) {
        console.warn('[drafts] start-time dedup failed (non-fatal):', err.message);
      }
    }

    res.json({ ok: true, message: 'Campaign started' });
  } catch (err) {
    console.error('Campaign start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// v2.58.x — IC preflight: validate that the sheet's sender column resolves
// to at least one matched GoLogin profile BEFORE starting. Mirrors the
// matching logic at src/campaign.js:1502-1564 but synchronous, no campaign
// side-effects. Lets the UI show a targeted modal instead of the operator
// finding the failure only in the post-start log rail.
app.post('/api/campaign/preflight-ic-senders', async (req, res) => {
  try {
    const { sheetUrl, senderColumn } = req.body || {};
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    const rows = await fetchSheet(sheetUrl);
    const token = process.env.GOLOGIN_API_TOKEN;
    const profiles = token ? await getProfiles(token) : [];
    const nameToId = {};
    for (const p of profiles) nameToId[p.name] = p.id;
    nameToId['You'] = 'local-browser';
    nameToId['Local Browser'] = 'local-browser';
    nameToId['local-browser'] = 'local-browser';
    nameToId['local-browser - manual'] = 'local-browser';

    const matched = new Map();
    const unmatched = new Map();
    let blanks = 0;
    for (const row of rows) {
      let acct = '';
      if (senderColumn && row && row[senderColumn] != null) {
        acct = row[senderColumn].toString().trim();
      }
      if (!acct) acct = (row?.Sender || row?.sender || '').toString().trim();
      if (!acct) { blanks++; continue; }
      if (nameToId[acct]) matched.set(acct, (matched.get(acct) || 0) + 1);
      else unmatched.set(acct, (unmatched.get(acct) || 0) + 1);
    }

    const totalRows = rows.length;
    if (matched.size > 0) {
      return res.json({ ok: true, totalRows, matchedCount: matched.size });
    }
    const reason = (blanks === totalRows) ? 'no_column' : 'no_match';
    const unmatchedArr = [...unmatched.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
    res.json({ ok: false, reason, totalRows, blanks, unmatched: unmatchedArr });
  } catch (err) {
    console.error('IC preflight error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Picker (#8): stored connection-to-primary status for a given primary URL,
// so the wizard can show "remembered" status before a campaign starts.
app.get('/api/primary-status', async (req, res) => {
  try {
    const primaryUrl = String(req.query.primaryUrl || '');
    const key = primaryKeyFromUrl(primaryUrl);
    if (!key) return res.json({ key: '', statuses: {} });
    const store = await loadPrimaryStatus(dataPath('primary-status.json'));
    const suffix = '|' + key;
    const statuses = {};
    for (const k of Object.keys(store)) {
      if (k.endsWith(suffix)) {
        const pid = k.slice(0, -suffix.length);
        statuses[pid] = { state: store[k].state, verifiedAt: store[k].verifiedAt || null };
      }
    }
    res.json({ key, statuses });
  } catch (e) {
    res.json({ key: '', statuses: {} });
  }
});

// Task 8: wizard primary-session hint — is the primary's captured LinkedIn
// session live on the VM (Task 6 capture → engine registry, Task 5's by-slug
// lookup)? Advisory only, next to the Primary Person URL field. Never 500s/400s
// the wizard: bad/missing/encoded URL → { state: 'none' } (mirrors
// /api/primary-status above), same for an engine hiccup.
app.get('/api/primary-session', async (req, res) => {
  try {
    const primaryUrl = String(req.query.primaryUrl || '');
    const slug = extractPrimarySlug(primaryUrl);
    if (!slug) return res.json({ state: 'none' });
    const r = await getPrimarySession(slug);
    res.json(r);
  } catch (e) {
    res.json({ state: 'none' });
  }
});

// How many personal-primary follow-ups the last poll pulled down late (the app
// had been closed past their due time). Backs the board nudge. Never throws.
app.get('/api/local-followups/pending', (_req, res) => {
  try { res.json({ late: lastLateCount() }); } catch { res.json({ late: 0 }); }
});

// Get a single queued campaign's full config (used by the dashboard Edit
// button — full payload, not the trimmed summary the list returns).
app.get('/api/queue/:id', async (req, res) => {
  try {
    const all = await getQueue();
    const entry = all.find((e) => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List queued campaigns for the dashboard's Queued section.
app.get('/api/queue', async (_req, res) => {
  try {
    const queue = await getQueue();
    // Strip large/sensitive fields the UI doesn't need (templates can be big).
    const summary = queue.map(e => ({
      id: e.id,
      name: getConfigById(e.campaignId || e.config?.campaignId)?.name || e.name,
      queuedAt: e.queuedAt,
      campaignId: e.campaignId || e.config?.campaignId,
      lifecycle: campaignLifecycle({ queued: true, scheduledAt: e.scheduledAt }),
      mode: e.config?.mode || '',
      profileIds: e.config?.profileIds || [],
      sheetUrl: e.config?.sheetUrl || '',
      scheduledAt: e.scheduledAt || null,
      dailyContinuation: !!e.config?._dailyContinuation,
    }));
    res.json({ queue: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a queued campaign before it starts.
app.delete('/api/queue/:id', async (req, res) => {
  try {
    const ok = await removeFromQueue(req.params.id);
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.60.0 — Edit a queued campaign entry. Body: subset of
// { name, scheduledAt, config } — any unknown keys are rejected by the
// helper. Used by the dashboard v0.3 "Edit" / "Reschedule" affordances
// on queue rows. Validation lives in updateQueueEntry; this handler
// just translates throws/null into HTTP status codes.
app.patch('/api/queue/:id', async (req, res) => {
  try {
    const updated = await updateQueueEntry(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, entry: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reorder a queued campaign within the FIFO order. Body: { direction: 'up' | 'down' }
app.post('/api/queue/:id/move', async (req, res) => {
  try {
    const dir = (req.body && req.body.direction) || '';
    if (dir !== 'up' && dir !== 'down') {
      return res.status(400).json({ error: 'direction must be "up" or "down"' });
    }
    const newIndex = await moveInQueue(req.params.id, dir);
    if (newIndex === -1) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, newIndex });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Team Connections (warm-reach) ──────────────────────────────────
// In-app search over colleagues' ingested LinkedIn networks joined to HubSpot
// (DNC-filtered), backed by the local cache (scripts/build-connections-cache.js).
// Read-only; emits a lead-schema CSV ready to launch as an Introduce Back campaign.
function connectionsCriteria(b = {}) {
  return {
    countries: b.countries || [], regions: b.regions || [], cities: b.cities || [],
    jobTitles: b.jobTitles || [], companies: b.companies || [], geo: b.geo || [],
  };
}

app.get('/api/connections/stats', async (_req, res) => {
  try {
    res.json({ ...(await dbCall('getConnectionsStats', [])), sync: getConnectionsSyncState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pull new/changed network CSVs from the Q2 2026 Drive folder (via the central
// Apps Script), then refresh the HubSpot cache for new slugs. Runs in the
// background; the UI polls /api/connections/stats (sync.*) for progress.
app.post('/api/connections/sync', (_req, res) => {
  try {
    res.json(startConnectionsSync({}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Operation Magellan ───────────────────────────────────────────────────────
// Collect the team's LinkedIn connections and push them into HubSpot. The
// collect phase only reads a connections list — it sends no invites and no
// messages, so it deliberately ignores credits, assignment and in-use state.

app.get('/api/magellan/state', (_req, res) => {
  res.json(magellan.getState());
});

// The spreadsheet the central Apps Script is bound to — where Magellan's tabs
// land. Not the FG sheet: that one is locked by the Follower Growth jobs.
app.get('/api/magellan/sheet-url', async (_req, res) => {
  try {
    return res.json({ url: await magellanSheetUrl() });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

// The account picker. Every GoLogin profile, joined to whether we already hold
// its connections. "Collected" is derived from the file on disk rather than a
// separate ledger, so the two can't drift apart.
// The SoO is a slow, heavily-contended read and the picker reloads often, so
// hold the email list for a few minutes. Only the addresses are kept.
let _magellanSoo = { at: 0, emails: [] };
// Last known good roster, on disk. The in-memory cache is empty on every
// restart, which is precisely when a sheet outage hurts: 2026-08-12, with the
// SoO refusing to answer, the picker resolved 5 of 550 labels to an email and
// the other 545 were unimportable. Only email addresses are stored — see the
// magellanSooEmails note.
const MAGELLAN_SOO_FILE = dataPath('magellan-soo-emails.json');
function magellanSooFromDisk() {
  try {
    const j = JSON.parse(readFileSync(MAGELLAN_SOO_FILE, 'utf8'));
    return Array.isArray(j.emails) ? j.emails : [];
  } catch { return []; }
}

// One refresh in flight at a time. Without this, three picker loads in a row
// each start their own 78s SoO read against a sheet that is already the
// bottleneck.
let _magellanSooRefresh = null;
function refreshMagellanSoo() {
  if (_magellanSooRefresh) return _magellanSooRefresh;
  _magellanSooRefresh = fetchSoOData()
    .then((soo) => {
      const emails = (((soo && soo.accounts) || []).map((a) => a && a.email).filter(Boolean));
      if (emails.length) {
        _magellanSoo = { at: Date.now(), emails };
        try {
          writeFileSync(`${MAGELLAN_SOO_FILE}.tmp`, JSON.stringify({ at: new Date().toISOString(), emails }));
          renameSync(`${MAGELLAN_SOO_FILE}.tmp`, MAGELLAN_SOO_FILE);
        } catch (err) { console.warn(`[magellan] could not cache the roster — ${err.message}`); }
      }
      return emails;
    })
    .catch((err) => {
      console.warn(`[magellan] roster refresh failed — ${err.message}`);
      return [];
    })
    .finally(() => { _magellanSooRefresh = null; });
  return _magellanSooRefresh;
}

/**
 * The account roster, never on the critical path.
 *
 * fetchSoOData retries a 25s Apps Script timeout, so a contended sheet takes
 * ~78s to FAIL — measured 2026-08-12, with the picker awaiting it the whole
 * time. The tab drew an empty account list and no error, because the request
 * was simply still open, and nobody waits 78 seconds. Capping it was not
 * enough: a healthy standalone read took 7.2s, but from inside the server —
 * which is hammering the same Apps Script with campaign sheet writes — even 12s
 * timed out, so the cap just traded a hang for a slow tab AND a stale roster.
 *
 * So the read comes off the request path entirely. Any roster we have is served
 * immediately and a refresh runs behind it; only the very first load with no
 * roster at all has to wait. A stale roster resolves labels correctly, and
 * people join the SoO monthly, so stale means one unresolved new hire.
 */
async function magellanSooEmails({ maxAgeMs = 5 * 60 * 1000, timeoutMs = 12000, wait = false } = {}) {
  const fresh = _magellanSoo.emails.length && Date.now() - _magellanSoo.at < maxAgeMs;
  if (fresh) return _magellanSoo.emails;

  const known = _magellanSoo.emails.length ? _magellanSoo.emails : magellanSooFromDisk();
  // `wait` is what the refresh button means: it asked for the authoritative
  // answer, so it gets to wait for one — but still capped, and still falling
  // back to what we have rather than failing the whole picker.
  if (wait) {
    const TIMED_OUT = Symbol('magellan-soo-refresh-timeout');
    const got = await Promise.race([
      refreshMagellanSoo(),
      new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
    ]);
    if (got !== TIMED_OUT && got.length) return got;
    if (known.length) return known;
    throw new Error(`the SoO did not answer within ${Math.round(timeoutMs / 1000)}s`);
  }
  if (known.length) {
    // Stale-while-revalidate. Deliberately not awaited, and deliberately not
    // stamped into _magellanSoo — that would hand a stale read the same
    // five-minute grace as a fresh one and stop us retrying the real sheet.
    refreshMagellanSoo();
    return known;
  }

  // Nothing at all yet. This is the one call that has to wait, and it is capped
  // so a first run during an outage still renders a picker.
  const TIMED_OUT = Symbol('magellan-soo-timeout');
  const emails = await Promise.race([
    refreshMagellanSoo(),
    new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), timeoutMs)),
  ]);
  if (emails === TIMED_OUT) {
    throw new Error(`the SoO did not answer within ${Math.round(timeoutMs / 1000)}s`);
  }
  return emails;
}

// Same reasoning for the HubSpot property. The picker reloads on every tab
// visit and every refresh; the option list changes only when someone edits the
// property by hand — and the refresh button passes maxAgeMs: 0, so adding an
// account to the property and pressing refresh shows it immediately.
let _magellanHsOptions = { at: 0, set: null };
async function magellanHsOptions({ maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (_magellanHsOptions.set && Date.now() - _magellanHsOptions.at < maxAgeMs) return _magellanHsOptions.set;
  const set = await connectionsPropOptions();
  _magellanHsOptions = { at: Date.now(), set };
  return set;
}

// Can this token edit the property's option list at all? Cached like the option
// list itself so the card does not pay a round trip per render. When the answer
// is false the picker hides the "add to the HubSpot list" button entirely — a
// button that always 403s is worse than no button.
let _magellanCanEdit = { at: 0, val: null };
async function magellanCanEditOptions({ maxAgeMs = 5 * 60 * 1000 } = {}) {
  if (_magellanCanEdit.val !== null && Date.now() - _magellanCanEdit.at < maxAgeMs) return _magellanCanEdit.val;
  const val = (await tokenScopes()).includes('crm.schemas.contacts.write');
  _magellanCanEdit = { at: Date.now(), val };
  return val;
}

// Read fresh each time — it is a handful of lines, and someone adding a
// mapping should not have to restart the app to see it take effect.
function magellanLabelOverrides() {
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, 'data/magellan-labels.json'), 'utf8'));
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => !k.startsWith('_') && v));
  } catch { return {}; }
}

app.get('/api/magellan/accounts', async (req, res) => {
  try {
    // The refresh button asks for the slow, authoritative answer. Everything
    // else takes the cached one.
    const fresh = Boolean(req.query.fresh);
    const maxAgeMs = fresh ? 0 : 5 * 60 * 1000;
    const collected = magellanListCollected({ fresh });
    const profiles = await getProfiles();

    // A GoLogin profile is labelled however someone typed it — sometimes the
    // account's email, sometimes just "Nikki". HubSpot's Linkedin 1st
    // Connections field only accepts the EMAIL, so resolve the label to its SoO
    // address with the same exact-first, ambiguity-refusing matcher the SoO
    // write-back uses. Unresolved profiles keep their label and are marked, so
    // they can be seen rather than silently collected under a name nothing can
    // be imported against.
    let sooEmails = [];
    try {
      const soo = await magellanSooEmails({ maxAgeMs, wait: fresh });
      sooEmails = soo;
    } catch (err) {
      console.warn(`[magellan] could not read the SoO — falling back to profile names: ${err.message}`);
    }

    // Labels the matcher will never resolve — "Ines", "Nikki" — because a bare
    // first name is not close enough to any address to be safe to guess at.
    // Refusing is right; leaving them unusable is not, so the answers live in a
    // file rather than in someone's head. Checked first: a confirmed mapping
    // beats a fuzzy match.
    const overrides = magellanLabelOverrides();

    // Which accounts HubSpot's "Linkedin 1st Connections" list will actually
    // accept. Read here so the selection bar can say "12 of 13 can go in"
    // BEFORE Check runs — the same split buildPreview does at run time. A
    // portal that will not answer leaves this null: unknown, and the screen
    // says nothing rather than guessing.
    let hsOptions = null;
    try {
      // This route renders on every visit to the Magellan tab, so a hung
      // HubSpot must not hang the page — that would be strictly worse than
      // the importable split simply being unknown, which the code below
      // already handles gracefully via hsOptions === null.
      const TIMED_OUT = Symbol('magellan-accounts-hubspot-timeout');
      const result = await Promise.race([
        magellanHsOptions({ maxAgeMs }),
        new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 5000)),
      ]);
      if (result === TIMED_OUT) {
        console.warn('[magellan] HubSpot options did not answer within 5s — showing accounts without the importable split');
      } else {
        hsOptions = result;
      }
    } catch (err) {
      console.warn(`[magellan] could not read the HubSpot options — ${err.message}`);
    }

    const accounts = profiles.map((p) => {
      const forced = overrides[p.name] || '';
      const hit = !forced && sooEmails.length ? resolveSoOEmail(p.name, sooEmails) : null;
      const email = forced || (hit && hit.email ? hit.email : '');
      const account = email || p.name;
      // Older files were written under the profile label; keep finding them.
      const c = collected.get(account) || collected.get(p.name) || null;
      return {
        profileId: p.id,
        account,
        profile: p.name,
        resolved: Boolean(email),
        ambiguous: Boolean(hit && hit.ambiguous),
        // Matched exactly as buildPreview does: trimmed and lowercased.
        importable: hsOptions ? hsOptions.has(String(account).trim().toLowerCase()) : null,
        collected: Boolean(c),
        count: c ? c.count : null,
        withMemberId: c ? c.withMemberId : null,
        collectedAt: c ? c.at : null,
      };
    });
    res.json({ accounts, canEditOptions: await magellanCanEditOptions({ maxAgeMs }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/magellan/collect', (req, res) => {
  try {
    res.json(magellan.startCollect((req.body || {}).accounts || []));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add operator addresses to HubSpot's linkedin_1st_connections option list.
// Any operator may call this — the safety is in the writer (append-only merge,
// guarded, then verified by reading the list back), not in who presses it.
app.post('/api/magellan/hubspot-options/add', async (req, res) => {
  try {
    const accounts = ((req.body || {}).accounts || []).filter(Boolean);
    if (!accounts.length) return res.status(400).json({ error: 'no accounts given' });
    const out = await addConnectionsOptions(accounts);
    // The cached option list is stale by definition now.
    _magellanHsOptions = { at: 0, set: null };
    console.log(`[magellan] added ${out.added.length} option(s) to linkedin_1st_connections: ${out.added.join(', ')}`);
    res.json(out);
  } catch (err) {
    console.warn(`[magellan] could not add options — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Works out what the import would do. Writes nothing. The plan itself can be
// hundreds of thousands of rows, so it stays on the server — only totals go out.
// Stop after the current account. The one in flight finishes and closes its
// browser cleanly rather than being killed mid-read.
app.post('/api/magellan/stop', (_req, res) => {
  try {
    res.json(magellan.stopCollect());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/magellan/preview', async (req, res) => {
  try {
    const { totals, blocked, duplicates } = await magellan.buildPreview((req.body || {}).accounts || []);
    res.json({ totals, blocked, duplicates });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Merging cannot be undone in HubSpot, so it needs its own confirmation — the
// import's does not carry over to it.
app.post('/api/magellan/merge-duplicates', async (req, res) => {
  try {
    if (!(req.body || {}).confirm) {
      return res.status(400).json({ error: 'Merging must be confirmed' });
    }
    res.json(await magellan.mergeDuplicates());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The only path that writes to HubSpot, and only from an explicit click.
app.post('/api/magellan/import', async (req, res) => {
  try {
    if (!(req.body || {}).confirm) {
      return res.status(400).json({ error: 'Import must be confirmed' });
    }
    // Starts the run and answers now. The import takes minutes; the card reads
    // its progress and its outcome from /api/magellan/state, which it already
    // polls. Holding this request open for the whole write is what made a
    // successful import report "The app did not answer".
    res.json(magellan.startImport());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/connections/search', async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await dbCall('searchConnections', [connectionsCriteria(b), { limit: b.limit || 1000 }]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/connections/export', async (req, res) => {
  try {
    const b = req.body || {};
    const urls = Array.isArray(b.urls) ? b.urls : undefined;
    res.json(await dbCall('exportConnections', [connectionsCriteria(b), { urls }]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Build a warm-reach lead list and write it to a NEW Google Sheet via the
// central Apps Script (createLeadTab), returning its URL — the campaign
// "Build & attach a warm list" flow then sets it as the campaign source.
// Requires the Apps Script redeployed with the createLeadTab handler.
app.post('/api/connections/to-workbook', async (req, res) => {
  try {
    const b = req.body || {};
    const urls = Array.isArray(b.urls) ? b.urls : undefined;
    const { header, rows, count } = await dbCall('buildLeadRows', [connectionsCriteria(b), { urls }]);
    console.log(`[to-workbook] request: ${urls ? urls.length : 0} urls in, ${count} leads to write`);
    if (!count) return res.status(400).json({ error: 'No leads selected to write.' });
    const name = (b.name && String(b.name).trim()) || `Warm ICB list — ${new Date().toISOString().slice(0, 10)}`;
    const result = await createWorkbookTab({ name, header, rows });
    console.log(`[to-workbook] Apps Script returned: ${JSON.stringify(result).slice(0, 300)}`);
    res.json({ ...result, count });
  } catch (err) {
    console.error(`[to-workbook] FAILED: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Follower Growth campaign ───────────────────────────────────────
// Targets come from the Connections DB scoped to ONE operator's network
// (warmVia), function/title filtered, DNC-safe, deduped vs already-invited,
// capped at the account's remaining monthly budget. Results live in the central
// FG sheet (FG Invites / FG Budgets / FG Funnel) via the FG Apps Script.
const FG_MARKETER_KEYWORDS = ['marketing', 'brand', 'growth', 'content', 'demand', 'comms', 'cmo'];
function fgCriteria(b = {}) {
  // Function/title filter rides the jobTitles chip mechanism. Default toward
  // marketers when the operator hasn't set their own chips.
  const jobTitles = Array.isArray(b.jobTitles) && b.jobTitles.length ? b.jobTitles : FG_MARKETER_KEYWORDS;
  return { jobTitles, companies: b.companies || [], geo: b.geo || [] };
}
const fgMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM

// Remaining budget for an account this month = allowance − sent (from FG Budgets).
// Month is compared via normMonth because the sheet may serialize it as a
// tz-shifted ISO date rather than the plain "YYYY-MM" we query with.
function fgRemaining(budgets, account, month) {
  // Credits refill on accept/withdraw, so a stable "remaining = allowance − sent"
  // is wrong — an account that already sent 30 may have free slots again. We can't
  // know the live balance until the invite modal opens, so build up to a full pool
  // of candidates (30) and let the run cap actual sends to the real modal number.
  return FG_DEFAULT_MONTHLY_ALLOWANCE;
}

// Operator roster for the Follower Growth picker (from colleagues.json).
app.get('/api/fg/operators', (_req, res) => {
  try {
    res.json({ operators: listOperators() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Employee roster for the Team Launch board (colleagues with DB coverage + counts).
// Employee roster for the Team Launch board. With ?roles=a,b,c it also returns
// matched (connections whose job title matches the roles) per colleague; without
// it, matched === total (full roster — backward compatible).
app.get('/api/fg/colleagues', async (req, res) => {
  try {
    const roles = parseRolesParam(req.query.roles);
    let alreadyInvited = [];
    try {
      const { invites } = await getFgState();
      alreadyInvited = invitedKeysFromState(invites);
    } catch (_) { console.warn('[fg/colleagues] FG sheet unreachable — falling back to raw matched counts:', _.message); }
    const colleagues = await dbCall('listFgColleaguesMatched', [roles, { alreadyInvited }]);
    res.json({ colleagues });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// In-app database view: the central FG sheet, rendered in the campaign tab.
app.get('/api/fg/db', async (_req, res) => {
  try {
    res.json(await getFgState());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Build (preview) a queued invite list for an operator/account — does NOT write.
app.post('/api/fg/build', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.operator) return res.status(400).json({ error: 'operator (colleague email) is required' });
    const account = b.account || b.operator;
    const month = b.month || fgMonth();
    const { invites, budgets } = await getFgState();
    const alreadyInvited = invitedKeysFromState(invites);
    const budget = fgRemaining(budgets, account, month);
    const out = buildFgTargets(fgCriteria(b), { operator: b.operator, operatorName: b.operatorName, account, month, alreadyInvited, budget });
    res.json({ ...out, account, month, budget });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Persist a built list to FG Invites as Queued.
app.post('/api/fg/queue', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) return res.status(400).json({ error: 'No rows to queue.' });
    res.json(await queueFgInvites(rows));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Flip Queued → Invited (manual send done) + bump the account budget.
app.post('/api/fg/mark-invited', async (req, res) => {
  try {
    const b = req.body || {};
    const memberIds = Array.isArray(b.memberIds) ? b.memberIds : null;
    if (!memberIds || !memberIds.length) return res.status(400).json({ error: 'memberIds required' });
    res.json(await markFgInvited({ memberIds, account: b.account, operator: b.operator, month: b.month || fgMonth() }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Follower Growth Phase 2 — automated browser-driven invite send.
// Launches a GoLogin profile for the given operator account, runs
// runFollowerInvites against the Ortus Club page invite modal, then marks
// all successfully-invited member IDs as Invited in the FG sheet.
// ---------------------------------------------------------------------------
let _fgSend = { running: false, phase: 'idle', invited: 0, skipped: 0, creditsBefore: null, creditsAfter: null, error: null };
let _fgAbort = false;

app.get('/api/fg/send/status', (_req, res) => res.json(_fgSend));
app.post('/api/fg/send/stop', (_req, res) => { _fgAbort = true; res.json({ ok: true }); });

app.post('/api/fg/send/start', async (req, res) => {
  if (_fgSend.running) return res.status(409).json({ error: 'A send is already running.' });
  const b = req.body || {};
  const profileId = b.profileId;
  const operator = b.operator;
  if (!profileId || !operator) return res.status(400).json({ error: 'profileId and operator are required' });
  const month = b.month || new Date().toISOString().slice(0, 7);
  res.json({ started: true });
  _fgSend = { running: true, phase: 'launching', invited: 0, skipped: 0, creditsBefore: null, creditsAfter: null, error: null };
  _fgAbort = false;
  (async () => {
    let launchedProfile = false;
    const { closeProfile: _closeProfile } = await import('./src/gologin-launcher.js');
    try {
      const { invites } = await getFgState();
      const queued = (invites || [])
        .filter((r) => r['Status'] === 'Queued' && r['Account'] === operator)
        .map((r) => ({ name: r['Target Name'], jobTitle: r['Job Title'], company: r['Company'], memberId: String(r['Member ID'] || '') }));
      if (!queued.length) {
        _fgSend = { running: false, phase: 'done', invited: 0, skipped: 0, creditsBefore: 0, creditsAfter: 0, error: null,
          note: `No queued invites for ${operator}. The send only fires rows already saved to the sheet as “Queued” for this operator — click “Queue these invites” first, and make sure the operator selected matches the one you queued under.` };
        return;
      }
      const token = process.env.GOLOGIN_API_TOKEN;
      const isLocal = profileId === 'local-browser';
      preventSleep('fg-invite');
      campaignLog(`[FG-invite] Launching ${isLocal ? 'local browser' : `profile ${profileId}`} for ${operator} — ${queued.length} queued invite(s)`);
      const launched = isLocal ? await launchLocalBrowser() : await launchProfile(profileId, token);
      launchedProfile = true;
      const page = launched.page;
      _fgSend.phase = 'inviting';
      const out = await runFollowerInvites({
        page,
        inviteUrl: ORTUS_PAGE_INVITE_URL,
        queued,
        log: (m) => { try { campaignLog(`[FG-invite] ${m}`); } catch (_) {} },
        shouldAbort: () => _fgAbort,
      });
      _fgSend = { ..._fgSend, phase: 'marking', invited: out.invited.length, skipped: out.skipped.length, creditsBefore: out.creditsBefore, creditsAfter: out.creditsAfter };
      if (out.invited.length) await markFgInvited({ memberIds: out.invited, account: operator, operator, month });
      const nothing = (out.invited.length + out.skipped.length) === 0;
      _fgSend = { running: false, phase: 'done', invited: out.invited.length, skipped: out.skipped.length, creditsBefore: out.creditsBefore, creditsAfter: out.creditsAfter, error: null,
        note: nothing ? `Opened the browser for ${queued.length} queued invite(s) but matched none — the page "Invite to follow" modal may not have opened. Is this account logged in AND an admin of the Ortus Club page? Check the log for [FG-invite] lines.` : null };
    } catch (err) {
      _fgSend = { ..._fgSend, running: false, phase: 'error', error: err.message };
    } finally {
      try { if (launchedProfile) { await (profileId === 'local-browser' ? closeLocalBrowser() : _closeProfile(profileId)); } } catch (_) {}
      try { allowSleep(); } catch (_) {}
    }
  })();
});

// ── Follower Growth — Team Launch (sequential multi-account batch) ──────────
// Replaces the build→queue→send queue. For each employee→profile pair, build
// targets fresh, launch ONE browser, send, write back (append invited rows then
// flip to Invited — no permanent Queued rows), then the next pair. One browser
// open at a time (multi-browser crash constraint).
let _fgTeam = { running: false, phase: 'idle', totalAccounts: 0, doneAccounts: 0, currentAccount: null, sent: 0, skipped: 0, invitesTotal: 0, perAccount: [], logs: [], error: null };
let _fgTeamAbort = false;
// The browser handle of the account currently running, so Stop can force-close it
// mid-operation (the in-flight page wait throws → the run aborts immediately
// instead of waiting out a 2-min modal timeout).
let _fgActiveHandle = null;

// Durable cloud-FG reconcile records. NEVER git-add data/fg-cloud-runs.json.
// Uses dataPath() (src/paths.js) — the same ORTUS_DATA_DIR-aware root every
// other stateful file (state.json, history.json, campaign.log, …) resolves
// through — NOT process.cwd(), which would diverge from that root whenever
// ORTUS_DATA_DIR is set (e.g. the packaged Electron app / `npm run dev:app`).
const _fgCloudRunStore = makeRunStore(dataPath('fg-cloud-runs.json'));

// FG launches currently between "accepted" and "recorded in the run store".
// Same identity duplicateFgRun matches on, so the in-flight half and the
// already-dispatched half of the duplicate guard agree on what "the same run"
// means. In memory only: a restart mid-dispatch clears it, which is correct —
// after a restart there is no in-flight request left to collide with.
const _fgLaunchesInFlight = new Set();
const fgLaunchKey = ({ pageId = '', sheetUrl = '', tab = '' } = {}) => `${pageId}|${sheetUrl}|${tab}`;

// Sheet-driven (list) run reconcile: stamp Status / Invited At / Note / Member ID
// back into the run's OWN list tab from the engine's per-lead results, so the tab
// you built doubles as the live ledger. Idempotent (re-stamping the same value is
// a no-op) and delta-only (pending leads produce no update). Returns
// { reconciled } true once the campaign is terminal so the record is retired.
async function reconcileListRun(record) {
  const camp = await getCloudCampaign(record.cloudId);
  const status = String((camp && (camp.campaign?.status ?? camp.status)) || '');
  let leads = [];
  try { const res = await getCloudCampaignLeads(record.cloudId); leads = (res && res.leads) || []; }
  catch (e) { throw new Error(`could not read cloud leads: ${e.message}`); }
  const updates = ledgerUpdatesFromLeads(leads);
  // Tracks the sheet write-back outcome so the terminal-retire decision below
  // (listRunShouldRetire) can tell "nothing to stamp" from "stamping failed".
  let sheetStampOk = 0;
  let sheetStampTotal = 0;
  if (updates.length) {
    if (record.sheetUrl) {
      // The operator's own sheet — through the MAIN Apps Script (openById, so
      // it can reach any spreadsheet). The FG script cannot: it is
      // container-bound to the central FG spreadsheet.
      //
      // BATCHED on purpose. ledgerUpdatesFromLeads re-emits every actioned lead
      // on EVERY tick (it is not a delta) and doPost holds a script lock for the
      // whole request, shared with every live connection campaign on the same
      // deployment — so one POST per row meant a 700-row run re-issuing 700
      // locked POSTs every 30 seconds. updateSheetRows chunks internally.
      const { updateSheetRows } = await import('./src/sheets-writer.js');
      // Account id → email. The CAMPAIGN's own config.accountEmails is the
      // authoritative map: the engine re-routes leads across accounts as it
      // runs, so the ids on its leads are not the ids in the plan we stored at
      // dispatch. Measured on a live run: 0 of 50 lead account ids appeared in
      // record.perAccount, all 50 appeared in config.accountEmails. The stored
      // plan stays as the fallback for a campaign fetched without its config.
      const acctEmail = {};
      for (const a of record.perAccount || []) { if (a && a.profileId) acctEmail[String(a.profileId)] = a.account || ''; }
      const cfgEmails = (camp && (camp.campaign?.config ?? camp.config) || {}).accountEmails || {};
      for (const [id, email] of Object.entries(cfgEmails)) { if (email) acctEmail[String(id)] = email; }
      const stamp = await updateSheetRows(record.sheetUrl, updates.map((u) => ({
        linkedinUrl: u.url,
        ...fgLedgerTracking({ ...u, invitedBy: acctEmail[u.account] || '' }),
      })), '');
      sheetStampOk = stamp.ok;
      sheetStampTotal = stamp.total;
      try { campaignLog(`[FG-cloud] list ledger → operator sheet: stamped ${sheetStampOk}/${sheetStampTotal} row(s)`); } catch (_) {}
      // Per-row visibility is the point: the operator needs to know WHICH rows
      // did not stamp, not just how many. Capped so a whole-batch failure
      // cannot flood the log every 30s.
      for (const f of stamp.failures.slice(0, 20)) {
        try { campaignLog(`[FG-cloud] ledger row not stamped (${f.linkedinUrl}): ${f.error}`); } catch (_) {}
      }
      if (stamp.failures.length > 20) {
        try { campaignLog(`[FG-cloud] …and ${stamp.failures.length - 20} more unstamped row(s)`); } catch (_) {}
      }
    } else {
      const r = await updateFgListLedger(record.tab, updates);
      try { campaignLog(`[FG-cloud] list ledger "${record.tab}": stamped ${r.updated} row(s)`); } catch (_) {}
    }
  }

  // Gap 1 + Gap 4 fix: write invited AND already-follows members to the central
  // FG Invites tab so they appear in invitedKeysFromState (the cross-run de-dupe
  // source). Already-follows cost no credit and must never re-fill a slot — the
  // local path persists both identically (server.js record callback). Uses
  // invitedWritebackFromLeads for invited leads, then extends with already-follows
  // from the same engine leads. Requires perAccount + month stored at dispatch
  // time. Older records without perAccount are harmless (skipped). Best-effort:
  // a sheet hiccup must not fail reconcile.
  if (record.perAccount) {
    const groups = invitedWritebackFromLeads(leads, record);
    // Gap 4: also include already-follows leads (status='skipped', error matches
    // 'already follows'). Group their member IDs by account, same as invited.
    const byUrl = {};
    for (const a of record.perAccount) Object.assign(byUrl, a.rowsByUrl || {});
    const byProfileMeta = new Map(record.perAccount.map((a) => [String(a.profileId), a]));
    const alreadyFollowsById = new Map(); // profileId → Set(memberId)
    for (const l of leads) {
      if (l.status !== 'skipped' || !/already follow/i.test(l.error || '')) continue;
      const memberId = byUrl[String(l.leadUrl || '').trim()];
      if (!memberId) continue;
      const profileId = String(l.account || '');
      if (!profileId || !byProfileMeta.has(profileId)) continue;
      if (!alreadyFollowsById.has(profileId)) alreadyFollowsById.set(profileId, new Set());
      alreadyFollowsById.get(profileId).add(String(memberId));
    }
    // Merge already-follows into existing groups or create new ones
    for (const [profileId, ids] of alreadyFollowsById) {
      const existing = groups.find((g) => byProfileMeta.get(profileId)?.account === g.account);
      if (existing) {
        for (const id of ids) if (!existing.memberIds.includes(id)) existing.memberIds.push(id);
      } else {
        const meta = byProfileMeta.get(profileId);
        groups.push({ account: meta.account, operator: meta.operator, month: meta.month, memberIds: [...ids] });
      }
    }
    for (const g of groups) {
      try {
        await markFgInvited({ memberIds: g.memberIds, invited: g.invited, account: g.account, operator: g.operator, month: g.month });
        try { campaignLog(`[FG-cloud] list run ${record.cloudId}: marked ${g.memberIds.length} invite(s)/follow(s) for ${g.account} in FG Invites`); } catch (_) {}
      } catch (e) {
        try { campaignLog(`[FG-cloud] ⚠ list run ${record.cloudId}: FG Invites writeback failed for ${g.account} (${e.message}) — will retry next reconcile`); } catch (_) {}
      }
    }
  }

  const terminal = ['done', 'cancelled', 'error', 'stopped'].includes(status);

  // Gap 3 fix: write the engine's per-account credit snapshot to FG Budgets so
  // the sheet stays current. The engine reads the exact same live modal numbers
  // the local path does (available / allowance / refill) and persists them via
  // store.setCredits — the /accounts endpoint surfaces them. Only at terminal
  // (final snapshot), and only when we have perAccount metadata for the lookup.
  if (terminal && record.perAccount) {
    try {
      const acctResp = await getCloudCampaignAccounts(record.cloudId);
      const cloudAccounts = (acctResp && acctResp.accounts) || [];
      for (const ca of cloudAccounts) {
        if (!ca.credits || ca.credits.available == null) continue;
        const meta = record.perAccount.find((a) => a.profileId === ca.profileId);
        if (!meta) continue;
        try {
          await observeFgCredits({
            account: meta.account, operator: meta.operator, month: meta.month,
            available: ca.credits.available, allowance: ca.credits.allowance,
            refill: ca.credits.refill || '',
          });
          try { campaignLog(`[FG-cloud] list run ${record.cloudId}: observed credits for ${meta.account} — ${ca.credits.available}/${ca.credits.allowance}`); } catch (_) {}
        } catch (e) {
          try { campaignLog(`[FG-cloud] ⚠ list run ${record.cloudId}: credit observation failed for ${meta.account} (${e.message})`); } catch (_) {}
        }
      }
    } catch (e) {
      try { campaignLog(`[FG-cloud] ⚠ list run ${record.cloudId}: could not read accounts for credit observation (${e.message})`); } catch (_) {}
    }
  }

  // Do NOT retire a sheet-sourced run whose stamping did not fully land —
  // see listRunShouldRetire's doc comment for why (updateSheetRow never
  // throws, so `terminal` alone is not a safe retire signal for it). The
  // legacy tab path is untouched: updateFgListLedger throws on failure, so
  // this function never even reaches this line on that path — it propagates
  // out to the caller, which leaves the record un-reconciled the same way.
  const canRetire = listRunShouldRetire({
    terminal, sheetSourced: !!record.sheetUrl, stampedOk: sheetStampOk, stampedTotal: sheetStampTotal,
  });
  if (terminal && !canRetire) {
    try {
      campaignLog(`[FG-cloud] list run ${record.cloudId}: keeping open — ${sheetStampTotal - sheetStampOk}/${sheetStampTotal} ledger row(s) did not stamp to the operator sheet; will retry next reconcile`);
    } catch (_) {}
  }
  return { reconciled: canRetire, updated: updates.length };
}

// Reconcile every dispatched cloud-FG run: pull engine results and write invited
// members back to the FG sheet. Runs on a timer while the app is open AND once at
// startup (so a run that finished while the laptop was closed is written back).
// Guarded against overlapping callers (startup + 30s timer + post-dispatch kick)
// so concurrent invocations never double-process the same record.
let _fgCloudReconciling = false;
async function reconcileFgCloudRuns() {
  if (_fgCloudReconciling) return;
  _fgCloudReconciling = true;
  try {
    const deps = {
      getCampaign: (id) => getCloudCampaign(id),
      getLeads: (id) => getCloudCampaignLeads(id),
      markInvited: (args) => markFgInvited(args),
      markFailed: (args) => markFgFailed(args),
      log: (m) => { try { campaignLog(`[FG-cloud] ${m}`); } catch (_) {} },
    };
    for (const record of _fgCloudRunStore.load()) {
      if (record.status === 'reconciled') continue;
      try {
        // Sheet-driven (list) runs write the ledger back into their OWN tab; the
        // legacy per-account runs write the shared FG-Invites tab. Branch on kind.
        const out = record.kind === 'list'
          ? await reconcileListRun(record)
          : await reconcileCloudRun(record, deps);
        if (out.reconciled) _fgCloudRunStore.update(record.cloudId, { status: 'reconciled' });
      } catch (e) {
        try { campaignLog(`[FG-cloud] reconcile ${record.cloudId} failed: ${e.message}`); } catch (_) {}
      }
    }

    // Also reconcile Auto-Pilot runs dispatched cloud-side while the app was closed.
    try {
      const resp = await fetch(`${FG_ROSTER_URL}/admin/autopilot`, {
        headers: { authorization: `Bearer ${FG_ROSTER_TOKEN}` },
      });
      if (resp.ok) {
        const { runs } = await resp.json();
        const localIds = new Set((_fgCloudRunStore.load() || []).map((r) => r.cloudId));
        for (const rec of pickUnreconciled(runs, localIds)) {
          _fgCloudRunStore.add({ ...rec, status: rec.status || 'dispatched' }); // adopt into the local reconcile pipeline
        }
      }
    } catch (_) { /* offline / service down — retried next tick */ }
  } finally {
    _fgCloudReconciling = false;
  }
}

app.get('/api/fg/team-launch/status', (_req, res) => res.json(_fgTeam));
app.post('/api/fg/team-launch/stop', async (_req, res) => {
  _fgTeamAbort = true;
  // Force-close the running account's browser so any in-flight page wait (e.g. the
  // up-to-2-min modal wait) rejects right away — a true stop, not stop-after-account.
  const h = _fgActiveHandle; _fgActiveHandle = null;
  try { if (h) await h.close(); } catch (_) {}
  res.json({ ok: true });
});

// The tab an FG run reads/writes: "FG <next run day>" so a list generated ahead
// of time is picked up by the scheduled fire on that day. Same key for generate
// and a shortly-after manual launch (nextRun is deterministic within a day).
function fgNextRunCycleKey(days = [1, 15]) {
  const d = nextRun(new Date(), { days, enabled: true });
  return cycleKey(d || new Date());
}

// Which accounts may invite people to follow the chosen page, from the SoO
// `Company` column. Only an account belonging to the page's org can send its
// invites, so this decides who a run is allowed to route through.
//
// Two constraints shape this. The SoO read sits on a LAUNCH request, and
// fetchSoOData retries a 25s Apps Script timeout — ~78s to fail on a contended
// sheet (see magellanSooEmails). So it is capped hard and cached. And it FAILS
// OPEN: an empty set means "no restriction" downstream, because an SoO outage
// silently reducing a run to zero invites is worse than the wrong-org sends the
// gate exists to prevent — those are visible, a zero-invite run is not.
const FG_SOO_TTL_MS = 5 * 60 * 1000;
const FG_SOO_TIMEOUT_MS = 12_000;
let _fgSooRows = { rows: [], at: 0 };

async function fgAllowedSenders(page) {
  if (!page?.sooCompany) return null;   // page declares no org — no restriction
  const fresh = _fgSooRows.rows.length && Date.now() - _fgSooRows.at < FG_SOO_TTL_MS;
  if (!fresh) {
    const TIMED_OUT = Symbol('fg-soo-timeout');
    const got = await Promise.race([
      fetchSoOData().catch(() => TIMED_OUT),
      new Promise((r) => setTimeout(() => r(TIMED_OUT), FG_SOO_TIMEOUT_MS)),
    ]);
    if (got !== TIMED_OUT) {
      const rows = Array.isArray(got) ? got : (got?.rows || got?.accounts || []);
      if (rows.length) _fgSooRows = { rows, at: Date.now() };
    }
  }
  const senders = sendersForPage(_fgSooRows.rows, page);
  if (!senders.size) {
    campaignLog(`[FG-cloud] ⚠ could not read the SoO roster for ${page.label} — sending WITHOUT the page/org sender check`);
  }
  return senders;
}

// Every GoLogin login on this machine, keyed by the account email. GoLogin
// profiles are NAMED after the email they log in as (the client pairs the same
// way in fgtlAutoPairName), so this is the whole account map — not just the
// accounts a roles search happened to surface. A sheet names its own senders;
// they must resolve even when the launch cart is empty.
const FG_PROFILES_TTL_MS = 5 * 60 * 1000;
let _fgProfileMap = { map: null, at: 0 };
async function fgProfileIdsByEmail() {
  if (_fgProfileMap.map && Date.now() - _fgProfileMap.at < FG_PROFILES_TTL_MS) return _fgProfileMap.map;
  const map = {};
  const profiles = await getProfiles(process.env.GOLOGIN_API_TOKEN);
  for (const p of profiles || []) {
    const name = String(p?.name || '').trim().toLowerCase();
    if (name.includes('@')) map[name] = p.id;
  }
  _fgProfileMap = { map, at: Date.now() };
  return map;
}

// Every email a sheet names as a sender — the Account Email column and the
// Connected Accounts cells both count.
function fgEmailsNamedByRows(rows) {
  const out = new Set();
  for (const row of Array.isArray(rows) ? rows.slice(1) : []) {
    for (const cell of row || []) for (const e of emailsInCell(cell)) out.add(e);
  }
  return out;
}

// What this sheet + page would actually do, before anything is dispatched. The
// answer comes from the SAME parse the launch runs (parseListRows), so §3 can
// never promise a number the run won't deliver.
app.get('/api/fg/sheet-preview', async (req, res) => {
  const sheetUrl = String(req.query.sheetUrl || '').trim();
  if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl is required' });
  const page = pageById(req.query.pageId);
  let rows;
  try { rows = gridFromSheetRows(await fetchSheet(sheetUrl)); }
  catch (e) { return res.status(502).json({ error: `Could not read that sheet: ${e.message}` }); }
  if (!rows || rows.length < 2) return res.status(400).json({ error: 'That tab has no rows under its header — check the link’s #gid.' });

  const [emailToProfileId, allowedSenders] = await Promise.all([
    fgProfileIdsByEmail().catch(() => ({})),
    fgAllowedSenders(page),
  ]);
  const { leads, skipped } = parseListRows(rows, { emailToProfileId, allowedSenders });

  const named = fgEmailsNamedByRows(rows);
  const mayInvite = (e) => !allowedSenders?.size || allowedSenders.has(e);
  const willSend = [...named].filter((e) => emailToProfileId[e] && mayInvite(e));
  const wrongCompany = [...named].filter((e) => !mayInvite(e));
  const noProfile = [...named].filter((e) => mayInvite(e) && !emailToProfileId[e]);

  res.json({
    page: { id: page.id, label: page.label, company: page.sooCompany || '' },
    // Proof of WHAT was read, for the "Read this sheet" button: the spreadsheet
    // id and gid actually fetched (not the ones the operator believes they
    // pasted), plus the header it found.
    read: {
      sheetId: (String(sheetUrl).match(/\/d\/([A-Za-z0-9_-]+)/) || [])[1] || '',
      gid: (String(sheetUrl).match(/[?#&]gid=(\d+)/) || [])[1] || '0',
      header: (rows[0] || []).map((c) => String(c == null ? '' : c).trim()).filter(Boolean),
      dataRows: rows.length - 1,
      at: new Date().toISOString(),
    },
    rowsTotal: leads.length + skipped.length,
    rowsCovered: leads.length,
    accountsNamed: named.size,
    willSend: willSend.length,
    wrongCompany: wrongCompany.length,
    noProfile: noProfile.length,
    senders: willSend.sort(),
    uncovered: skipped.slice(0, 50).map((s) => ({ row: s.rowNumber, url: s.url, reason: s.reason })),
  });
});

// The FG Google Sheet's own URL — so the wizard can deep-link "Open the FG Sheet".
// Asks the Apps Script (getSheetUrl); falls back to a local FG_SHEET_URL env var
// when the deployed script predates that action.
app.get('/api/fg/sheet-url', async (_req, res) => {
  try {
    // Retry (postFg default 3× w/ backoff): the Apps Script 302→echo dance
    // intermittently 404s on a cold call, especially right after launch while the
    // app is busy loading profiles. A single attempt would spuriously fail.
    const r = await postFg({ action: 'getSheetUrl' }, { timeoutMs: 30000 });
    if (r && r.url) return res.json({ url: r.url });
  } catch (_) { /* fall through to env */ }
  if (process.env.FG_SHEET_URL) return res.json({ url: process.env.FG_SHEET_URL });
  return res.status(404).json({ error: 'FG sheet URL not available — redeploy the FG Apps Script (getSheetUrl) or set FG_SHEET_URL.' });
});

// FG Master build progress — polled by the UI, same shape as _fgSend.
let _fgMaster = { running: false, phase: 'idle', done: 0, total: 0, written: 0, droppedNoUrl: 0, backfilled: 0, fromFunnelSheet: 0, alreadyThere: 0, full: false, error: null, finishedAt: null };

app.get('/api/fg/master/status', (_req, res) => res.json(_fgMaster));

// Rebuild the FG Master tab: every warm contact, with the FG Invites ledger
// folded in so a rebuild never loses invite history. Fire-and-forget — the build
// is ~56 chunked POSTs and far outlives an HTTP request.
// Incremental by default: only people not already in the tab are appended, so
// existing rows (and any invite stamps typed in by hand) are never touched.
// POST { full: true } clears the tab and rewrites every row from scratch.
app.post('/api/fg/master/build', async (req, res) => {
  if (_fgMaster.running) return res.status(409).json({ error: 'A master build is already running.' });
  const full = !!(req.body && req.body.full);
  res.json({ started: true, full });
  _fgMaster = { running: true, phase: 'reading', done: 0, total: 0, written: 0, droppedNoUrl: 0, backfilled: 0, fromFunnelSheet: 0, alreadyThere: 0, full, error: null, finishedAt: null };
  (async () => {
    try {
      let invitedIndex = new Map();
      try {
        const { invites } = await getFgState();
        invitedIndex = invitedIndexFromFgInvites(invites);
        // invitedIndex is dual-keyed (Member ID AND URL per invited row), so its
        // .size roughly doubles the true count — report the actual Invited rows.
        _fgMaster.backfilled = (invites || []).filter((r) => r && r.Status === 'Invited').length;
      } catch (e) {
        campaignLog(`[FG-master] could not read FG Invites for backfill (${e.message}) — building without it`);
      }
      _fgMaster.phase = 'building';
      const records = listMasterRecords({});
      const { rows, droppedNoUrl } = buildMasterRows(records, invitedIndex);
      // Fold in the team's manual funnel sheet (FUNNEL_I) exports, if this
      // machine has them: ~27k people the Connections DB has never seen, plus
      // the invites they recorded by hand. Best-effort — a bad export must not
      // cost us the whole build.
      let seedStats = { added: 0, enriched: 0, stamped: 0 };
      try {
        const seeds = readSeedDir(dataPath('funnel-i'));
        if (seeds.length) {
          seedStats = mergeFunnelSeeds(rows, seeds);
          campaignLog(`[FG-master] manual funnel sheet: +${seedStats.added} new people, ${seedStats.enriched} enriched, ${seedStats.stamped} invites stamped`);
        }
      } catch (e) {
        campaignLog(`[FG-master] could not read the manual funnel export (${e.message}) — building without it`);
      }
      _fgMaster = { ..._fgMaster, droppedNoUrl, fromFunnelSheet: seedStats.added, backfilled: _fgMaster.backfilled + seedStats.stamped };
      // Incremental: ask the sheet who is already in the tab and append only the
      // rest. A missing tab (exists:false) falls back to a full build on its own.
      let toWrite = rows;
      let appendAt = 0;
      if (!full) {
        _fgMaster.phase = 'comparing';
        const existing = await readFgMasterKeys({ onProgress: ({ done, total }) => { _fgMaster.done = done; _fgMaster.total = total; } });
        if (existing.exists) {
          const fresh = newRowsOnly(rows, existing.keys);
          toWrite = fresh.rows;
          appendAt = existing.rows + 2; // row 1 is the header
          _fgMaster.alreadyThere = fresh.skipped;
          campaignLog(`[FG-master] incremental — ${existing.rows} already in the tab, ${toWrite.length} new`);
        } else {
          campaignLog('[FG-master] no FG Master tab yet — building it in full');
        }
      }
      const count = toWrite.length;
      _fgMaster = { ..._fgMaster, phase: 'writing', done: 0, total: count };
      campaignLog(`[FG-master] writing ${count} row(s) (${droppedNoUrl} dropped for no LinkedIn URL)`);
      const out = await writeFgMaster(toWrite, { appendAt, onProgress: ({ done, total }) => { _fgMaster.done = done; _fgMaster.total = total; } });
      _fgMaster = { ..._fgMaster, running: false, phase: 'done', written: out.written, finishedAt: new Date().toISOString() };
      campaignLog(`[FG-master] done — ${out.written} row(s) written to "${out.tab}"`);
    } catch (err) {
      _fgMaster = { ..._fgMaster, running: false, phase: 'error', error: err.message, finishedAt: new Date().toISOString() };
      campaignLog(`[FG-master] failed: ${err.message}`);
    }
  })();
});

// The company pages FG can grow. Static, but served so the dropdown and the
// launch path can never disagree about the ids.
app.get('/api/fg/pages', (_req, res) => {
  // sooCompany goes with it: the board filters the account roster by the SAME
  // SoO Company the server gates senders on, so the accounts an operator can
  // see and pick are exactly the ones the launch will accept. Without it the
  // browser fell back to a hardcoded "the ortus club" and every Apex run
  // dispatched an all-Ortus roster into an Apex-only gate — zero leads, always.
  res.json({ pages: FG_PAGE_LIST.map((p) => ({ id: p.id, label: p.label, sooCompany: p.sooCompany || '' })) });
});

// All tab names in the FG sheet — populates the "bring your own" dropdown.
app.get('/api/fg/tabs', async (_req, res) => {
  try {
    // Retry (postFg default 3× w/ backoff) — the listTabs call can transiently
    // fail on a cold Apps Script; one attempt left the dropdown silently empty.
    const r = await postFg({ action: 'listTabs' }, { timeoutMs: 30000 });
    if (r && Array.isArray(r.tabs)) return res.json({ tabs: r.tabs });
    return res.status(502).json({ error: (r && r.error) || 'Could not list tabs', tabs: [] });
  } catch (e) { return res.status(502).json({ error: e.message, tabs: [] }); }
});

// Manually stamp the ledger (Status / Invited At / Note / Member ID) back into a
// list tab from a cloud run's current results. The 30s reconcile does this
// automatically; this endpoint is for firing it on demand (e.g. an in-flight run
// registered before auto-reconcile, or a one-off catch-up).
app.post('/api/fg/list/writeback', async (req, res) => {
  const b = req.body || {};
  const cloudId = String(b.cloudId || '').trim();
  const tab = String(b.tab || '').trim();
  if (!cloudId || !tab) return res.status(400).json({ error: 'cloudId and tab are required.' });
  try {
    const out = await reconcileListRun({ cloudId, tab, kind: 'list' });
    return res.json({ ok: true, updated: out.updated, reconciled: out.reconciled });
  } catch (e) { return res.status(502).json({ error: e.message }); }
});

// Unreconciled cloud runs — powers the FG board "awaiting reconcile" indicator.
app.get('/api/fg/cloud-runs/pending', (_req, res) => {
  const runs = _fgCloudRunStore.load() || [];
  const pending = runs.filter((r) => r.status !== 'reconciled');
  return res.json({ pending: pending.length, runs: pending.map((r) => ({ cloudId: r.cloudId, kind: r.kind, tab: r.tab, status: r.status, dispatchedAt: r.dispatchedAt })) });
});

// Manual "Sync now" — reconcile all unreconciled cloud runs on demand.
app.post('/api/fg/cloud-runs/reconcile', async (_req, res) => {
  try {
    await reconcileFgCloudRuns();
    const runs = _fgCloudRunStore.load() || [];
    const pending = runs.filter((r) => r.status !== 'reconciled').length;
    return res.json({ ok: true, pending });
  } catch (e) { return res.status(502).json({ error: e.message }); }
});

// GENERATE (auto option): build the invite list from the role keywords and write
// it to the per-run tab. No hard monthly cap — list all eligible; LinkedIn's own
// invite credits are the ceiling. The tab is then reviewable/editable before the
// fire reads it.
app.post('/api/fg/list/generate', async (req, res) => {
  const b = req.body || {};
  const pairs = Array.isArray(b.pairs) ? b.pairs.filter((p) => p && p.operator && p.account && p.profileId) : [];
  if (!pairs.length) return res.status(400).json({ error: 'At least one paired account is required.' });
  const month = b.month || fgMonth();
  const keywords = Array.isArray(b.keywords) ? b.keywords : [];
  let snap;
  try { snap = await getFgState(); } catch (e) { return res.status(502).json({ error: `Could not read FG sheet: ${e.message}` }); }
  const alreadyInvited = invitedKeysFromState(snap.invites);
  const criteria = fgCriteria({ jobTitles: keywords });

  // Pre-compute each account's FG targets through the roster bridge (dbCall). The
  // connections DB (~152MB) is NOT on operator machines, so a direct
  // buildFgTargets() ENOENTs — dbCall runs the read locally when the DB is present
  // and otherwise delegates to the central fg-roster /rpc (same match code).
  // buildListRows() is synchronous, so we resolve every pair's targets up front and
  // hand it a plain sync lookup.
  //
  // The budget is passed as a NUMBER on purpose. It used to be omitted, which
  // defaults to Infinity in buildFgTargets (Infinity serialises to null over
  // JSON/RPC, so it could not be sent literally) — and that wrote the entire
  // matching pool to the tab: 25,882 rows for a run that can send ~1,000. The
  // step-1 headline promised the capped number, and a 25k-row tab is not
  // something a human reviews. fgRemaining() is the same per-account allowance
  // the headline counts.
  let built;
  try {
    built = await generateListRows(pairs, {
      criteria, month, alreadyInvited,
      budget: fgRemaining(snap.budgets, '', month),
    }, { buildTargets: (c, o) => dbCall('buildFgTargets', [c, o]) });
  } catch (e) {
    // Never let a build failure (e.g. roster service not deployed) become an
    // unhandled rejection — that would take the whole app down.
    return res.status(502).json({ error: `Could not build the list: ${e.message}` });
  }
  const { header, rows, perAccount, skipped } = built;
  const tab = fgListTabName(b.cycleKey || fgNextRunCycleKey(b.days));
  try { await writeFgList(tab, rows, { header }); }
  catch (e) { return res.status(502).json({ error: `Could not write the list tab "${tab}": ${e.message}` }); }
  return res.json({ tab, count: rows.length, perAccount, skipped });
});

app.post('/api/fg/team-launch/start', async (req, res) => {
  if (_fgTeam.running) return res.status(409).json({ error: 'A team launch is already running.' });
  const b = req.body || {};
  const pairs = Array.isArray(b.pairs) ? b.pairs.filter((p) => p && p.operator && p.account && p.profileId) : [];
  // A sheet run names its own senders row by row, so an empty cart is fine
  // there — the account map is resolved from GoLogin below. Every other path
  // builds its list per account and still needs at least one.
  if (!pairs.length && b.source !== 'list') return res.status(400).json({ error: 'At least one paired account is required.' });

  // A list source is required on EVERY path, cloud or local. This refusal sits
  // ABOVE the target branch on purpose: the local branch below still contains
  // the old build-a-list-from-the-connections-DB code, so without this a launch
  // with no source (or with a pasted sheet it ignores) would quietly generate a
  // list nobody asked for — the deleted silent fallback, one display:none away.
  const src = resolveListSource(b);
  if (!src.ok) return res.status(400).json({ error: src.error });

  if ((b.target || 'local') === 'cloud') {
    const month = b.month || fgMonth();

    // Sheet-driven flow (new two-option FG): read the pre-generated invite-list
    // tab and work down it. Each lead is pinned to its account (Account Email →
    // profileId). No tab yet → tell the operator to generate it first.
    if (b.source === 'list') {
      const owner = getOperatorEmail() || req.user || '';
      const runKey = b.cycleKey || fgNextRunCycleKey(b.days);
      const page = pageById(b.pageId);

      // Duplicate guard, in two halves. Both sit above every read and every
      // write on purpose: a second press must cost nothing and change nothing.
      // `force` is the operator saying they meant it, and only ever arrives
      // from the confirm dialog these 409s drive — it bypasses both.
      const launchKey = fgLaunchKey({
        pageId: page.id, sheetUrl: src.kind === 'sheet' ? src.sheetUrl : '', tab: src.tab || '',
      });
      if (!b.force) {
        // Half one: a launch still IN FLIGHT. The run store is only written
        // after dispatchFromRows returns, and everything between here and
        // there — prepareSheet, the sheet read, the SoO read, the dispatch —
        // takes up to a minute. Without this, two presses inside that minute
        // both read an empty store and both dispatch, which is precisely the
        // double-click this guard exists to stop.
        if (_fgLaunchesInFlight.has(launchKey)) {
          campaignLog('[FG-cloud] refused a duplicate launch — one for the same page and list is still being dispatched');
          return res.status(409).json({
            duplicate: true, inFlight: true,
            error: `A Follower Growth run for ${page.label} on this same list is being dispatched right now. `
              + 'Give it a moment — it can take a minute to build the list and hand it to the VM.',
          });
        }
        // Half two: a launch already DISPATCHED minutes ago.
        const dupe = duplicateFgRun(_fgCloudRunStore.load(), {
          pageId: page.id, sheetUrl: src.kind === 'sheet' ? src.sheetUrl : '', tab: src.tab || '',
        });
        if (dupe) {
          const mins = Math.max(1, Math.round((Date.now() - Date.parse(dupe.dispatchedAt)) / 60000));
          campaignLog(`[FG-cloud] refused a duplicate launch — ${dupe.cloudId} started ${mins} min ago for the same page and list`);
          return res.status(409).json({
            duplicate: true, cloudId: dupe.cloudId,
            error: `A Follower Growth run for ${page.label} on this same list started ${mins} minute${mins === 1 ? '' : 's'} ago. `
              + 'Running it again splits the same monthly invite credits across two campaigns, so both send less than one would.',
          });
        }
      }
      // Held for the rest of this request, released however it ends — a thrown
      // error or a dropped connection must not leave FG wedged. 'close' fires
      // on every outcome, and the release is idempotent.
      _fgLaunchesInFlight.add(launchKey);
      res.on('close', () => { _fgLaunchesInFlight.delete(launchKey); });

      // The operator's OWN sheet (src.kind === 'sheet') is read straight over
      // the public CSV endpoint — no Apps Script involved, so it works on any
      // spreadsheet. The legacy tab path still goes through the container-bound
      // FG script, which can only ever see the central FG spreadsheet.
      let rows;
      const label = src.kind === 'sheet' ? src.sheetUrl : `tab "${src.tab}"`;
      try {
        rows = src.kind === 'sheet'
          ? gridFromSheetRows(await fetchSheet(src.sheetUrl))
          : await readFgList(src.tab);
      } catch (e) {
        return res.status(502).json({ error: `Could not read ${label}: ${e.message}` });
      }
      // An empty read is ambiguous: the source may genuinely be empty, or the
      // read may have handed back nothing on a slow call. Say which, so a
      // transient hiccup doesn't read as "you forgot to generate the list".
      if (!rows || rows.length < 2) {
        const n = Array.isArray(rows) ? rows.length : 0;
        return res.status(400).json({
          error: n === 0
            ? `Nothing came back from ${label}. Three things do this: the tab is empty, the link's #gid points at a different (empty) tab, or the sheet is not shared "anyone with the link can view".`
            : `${label} has a header but no people under it — check the link's #gid is on the tab that holds the rows.`,
        });
      }

      // A BYO sheet only ever has the columns the operator typed — no ledger
      // columns. Without provisioning them here, the reconcile writeback
      // (Task 5) will find no "FG Status" etc. column, skip every write, and
      // report success anyway: the exact silent failure this plan exists to
      // remove. The legacy tab path is exempt: it writes through the
      // container-bound FG Apps Script against the central spreadsheet, which
      // already has these columns and isn't touched by prepareSheet.
      // …but only when they are actually missing. prepareSheet is an Apps
      // Script POST, and every such POST queues in ONE global lane shared with
      // every running campaign's row writes (src/webapp-lane.js). Measured
      // 2026-08-14 with 29 campaigns live: a launch sat in that queue for 11+
      // minutes with the operator's Run button frozen on "Dispatching…", to add
      // four columns the sheet already had. The header is already in `rows` from
      // the read above, so this check costs nothing and skips the lane entirely
      // on every run after the first.
      const FG_LEDGER_COLUMNS = ['FG Status', 'FG Invited At', 'FG Note', 'FG Member ID', 'FG Invited By'];
      const header = (rows[0] || []).map((c) => String(c == null ? '' : c).trim());
      const missing = FG_LEDGER_COLUMNS.filter((c) => !header.includes(c));

      if (src.kind === 'sheet' && !missing.length) {
        campaignLog(`[FG-cloud] ✓ ledger columns already present on ${src.sheetUrl} — skipping prepareSheet`);
      } else if (src.kind === 'sheet') {
        campaignLog(`[FG-cloud] preparing ${src.sheetUrl} — missing: ${missing.join(', ')}`);
        const { prepareSheet } = await import('./src/sheets-writer.js');
        // Bounded: the lane can be minutes deep, and this sits on a request the
        // operator is watching. Timing out here reports a stuck bridge instead
        // of hanging the button forever.
        const PREPARE_TIMEOUT_MS = 90_000;
        const TIMED_OUT = Symbol('prepare-timeout');
        const prep = await Promise.race([
          prepareSheet(src.sheetUrl, 'follower_growth').catch((e) => {
            campaignLog(`[FG-cloud] ⚠ prepareSheet failed for ${src.sheetUrl}: ${e.message}`);
            return { ok: false };
          }),
          new Promise((r) => setTimeout(() => r(TIMED_OUT), PREPARE_TIMEOUT_MS)),
        ]).then((v) => (v === TIMED_OUT
          ? (campaignLog(`[FG-cloud] ⚠ prepareSheet timed out after ${PREPARE_TIMEOUT_MS / 1000}s — the Apps Script lane is congested`), { ok: false, timedOut: true })
          : v));
        if (prep.timedOut) {
          return res.status(504).json({
            error: `Timed out adding the tracking columns to "${src.sheetUrl}" — the Google Apps Script bridge is busy (it is shared with every running campaign). Add these columns to the tab by hand and run again: ${missing.join(', ')}. Nothing was launched.`,
          });
        }
        if (!prep.ok) {
          // Unlike a connection campaign (run locally, watched, with SoO as a
          // fallback record), an FG sheet run is fired at a remote VM and this
          // sheet is the operator's ONLY record of who got invited. A run that
          // cannot be recorded is worse than a run that never started, so this
          // aborts rather than warning-and-continuing the way campaign.js does.
          //
          // prepareSheet() returns ok:false both when SHEETS_WEBAPP_URL is
          // unset (silent, by design — sheets-writer.js) and when the bridge
          // call genuinely failed. Treating both as abort-worthy is only safe
          // because SHEETS_WEBAPP_URL (sheets-webapp-url.js) is a hardcoded
          // constant, never unset. If it's ever made env-gated like this
          // file's FG_WEBAPP_URL, this needs to distinguish "unconfigured" from
          // "failed" instead of refusing on both.
          campaignLog(`[FG-cloud] ✗ prepareSheet did not confirm for ${src.sheetUrl} — refusing to launch`);
          return res.status(502).json({
            error: `Could not prepare "${src.sheetUrl}" for tracking (FG Status / Invited At / Note / Member ID columns). Fix sheet access and try again — nothing was launched.`,
          });
        }
        campaignLog(`[FG-cloud] ✓ prepareSheet ready on ${src.sheetUrl}${prep.added?.length ? ` — added: ${prep.added.join(', ')}` : ''}`);
      }

      // The SHEET names the senders, so the account map comes from GoLogin —
      // every login on this machine — not from the client's roster search. The
      // cart's pairs are folded in on top (they carry the operator label) but
      // are no longer the gate: a sheet naming an account nobody searched for
      // used to route to nothing, which is a run that dispatches zero leads.
      const accountEmails = Object.fromEntries(pairs.map((p) => [p.profileId, p.account]));
      try {
        for (const [email, pid] of Object.entries(await fgProfileIdsByEmail())) {
          if (!accountEmails[pid]) accountEmails[pid] = email;
        }
      } catch (e) {
        campaignLog(`[FG-cloud] ⚠ could not list GoLogin profiles (${e.message}) — routing from the launch cart only`);
      }
      const allowedSenders = await fgAllowedSenders(page);
      if (allowedSenders?.size) {
        campaignLog(`[FG-cloud] ${allowedSenders.size} account(s) may invite to ${page.label} (SoO Company "${page.sooCompany}")`);
      }
      const out = await dispatchFromRows(rows, {
        accountEmails,
        allowedSenders,
        // Name it for the RUN DAY, not the month: two fires in one month were
        // both called "· 2026-08" and were indistinguishable on the board.
        // The page is in the name because the board carries Ortus and Apex runs
        // side by side and they were indistinguishable — same title, same day.
        campaign: { name: `${page.label} · Follower Growth · ${runKey}`, owner,
                    config: { inviteUrl: page.inviteUrl, pageId: page.id, pageLabel: page.label,
                              monthlyBudget: FG_DEFAULT_MONTHLY_ALLOWANCE } },
      }, { startCloud: (payload) => startCloudCampaign(payload) });
      if (out.error) return res.status(502).json({ error: out.error, skipped: out.skipped });
      // Which page this run invites to, stated plainly in the log: a wrong
      // dropdown pick is invisible until the invites land otherwise.
      try { campaignLog(`[FG-cloud] inviting ${out.leadCount} people to follow ${page.label} (${page.inviteUrl})`); } catch (_) {}
      // Register this run so the reconcile loop stamps the ledger (Status /
      // Invited At / Note / Member ID) back into ITS tab/sheet as invites go
      // out. perAccount + month are stored so the reconcile can also call
      // markFgInvited to feed the central FG Invites de-dupe tab (Gap 1).
      const pairsLookup = Object.fromEntries(pairs.map((p) => [p.profileId, p]));
      try { _fgCloudRunStore.add({
        cloudId: out.cloudId, kind: 'list', tab: src.tab || '', owner, month,
        sheetUrl: src.kind === 'sheet' ? src.sheetUrl : '',
        pageId: page.id, pageLabel: page.label,
        status: 'dispatched', dispatchedAt: new Date().toISOString(),
        perAccount: (out.perAccount || []).map((a) => ({
          profileId: a.profileId, account: a.account,
          operator: (pairsLookup[a.profileId] || {}).operator || owner,
          month, rowsByUrl: a.rowsByUrl || {},
        })),
      }); } catch (_) {}
      reconcileFgCloudRuns().catch(() => {}); // kick a first poll shortly (non-blocking)
      // Slim per-account plan (profileId → queued count) so the Live-status board
      // can show how many invites each account has lined up. The engine's /leads
      // reports pending leads as unrouted (account:null), so this fire-time plan is
      // the only source of the per-account queued totals.
      const plan = (out.perAccount || []).map((a) => ({ profileId: a.profileId, account: a.account, count: a.count }));
      return res.json({ started: true, cloudId: out.cloudId, leadCount: out.leadCount, skipped: out.skipped, tab: src.tab || '', sheetUrl: src.kind === 'sheet' ? src.sheetUrl : '', perAccount: plan });
    }

    // The build-from-the-connections-DB path (auto-pilot and the manual Team
    // Launch) gets the same guard as the sheet path. It fires on a schedule
    // rather than a button, so a collision is far less likely — but "less
    // likely" is not a reason for one of two launch paths to be unprotected.
    const monthlyPage = FG_PAGES.ortus;               // this path hardcodes the Ortus invite URL
    const monthlyKey = fgLaunchKey({ pageId: monthlyPage.id });
    if (!b.force) {
      if (_fgLaunchesInFlight.has(monthlyKey)) {
        return res.status(409).json({
          duplicate: true, inFlight: true,
          error: `A Follower Growth run for ${monthlyPage.label} is being dispatched right now. Give it a moment.`,
        });
      }
      const dupe = duplicateFgRun(_fgCloudRunStore.load(), { pageId: monthlyPage.id, sheetUrl: '', tab: '' });
      if (dupe) {
        const mins = Math.max(1, Math.round((Date.now() - Date.parse(dupe.dispatchedAt)) / 60000));
        campaignLog(`[FG-cloud] refused a duplicate team launch — ${dupe.cloudId} started ${mins} min ago`);
        return res.status(409).json({
          duplicate: true, cloudId: dupe.cloudId,
          error: `A Follower Growth run for ${monthlyPage.label} started ${mins} minute${mins === 1 ? '' : 's'} ago. `
            + 'Running it again splits the same monthly invite credits across two campaigns, so both send less than one would.',
        });
      }
    }
    _fgLaunchesInFlight.add(monthlyKey);
    res.on('close', () => { _fgLaunchesInFlight.delete(monthlyKey); });

    const keywords = Array.isArray(b.keywords) ? b.keywords : [];
    let snap;
    try { snap = await getFgState(); } catch (e) { return res.status(502).json({ error: `Could not read FG sheet: ${e.message}` }); }
    const buildTargets = (pair) => {
      const alreadyInvited = invitedKeysFromState(snap.invites);
      const budget = fgRemaining(snap.budgets, pair.account, month);
      const out = buildFgTargets(fgCriteria({ jobTitles: keywords }), { operator: pair.operator, operatorName: pair.operatorName, account: pair.account, month, alreadyInvited, budget });
      let reason = '';
      if (!out.count) {
        if (out.matched === 0) reason = 'no connections match these roles';
        else if (out.eligible === 0) reason = 'all matching connections already invited';
        else reason = 'monthly budget used up — no invites remaining this month';
      }
      return { rows: out.rows, count: out.count, reason };
    };
    const result = await startTeamLaunchCloud(pairs, {
      buildTargets,
      startCloud: (payload) => startCloudCampaign(payload),
      queueInvites: (rows, opts) => queueFgInvites(rows, opts),
      runStore: _fgCloudRunStore,
      now: () => new Date().toISOString(),
      log: (m) => { try { campaignLog(`[FG-cloud] ${m}`); } catch (_) {} },
      month, owner: getOperatorEmail() || req.user || '',
      // This path is Ortus-only (it hardcodes ORTUS_PAGE_INVITE_URL below), so
      // the page name is fixed rather than read off a dropdown. pageId goes
      // into the run store as this run's identity for the duplicate guard.
      name: `${monthlyPage.label} · Follower Growth · ${month}`,
      pageId: monthlyPage.id,
      inviteUrl: ORTUS_PAGE_INVITE_URL, monthlyBudget: FG_DEFAULT_MONTHLY_ALLOWANCE,
    });
    if (result.error) return res.status(502).json({ error: result.error });
    reconcileFgCloudRuns().catch(() => {}); // kick a first poll shortly (non-blocking)
    return res.json({ started: true, cloudId: result.cloudId });
  }

  // Local target. This branch still builds its own list from the connections DB
  // and hardcodes ORTUS_PAGE_INVITE_URL — it cannot honour a pasted sheet or the
  // chosen page. Refuse rather than silently invite a different list to a
  // different page.
  if (src.kind === 'sheet') {
    return res.status(400).json({ error: 'A pasted Google Sheet list can only run on the cloud VM. Switch the run target to the cloud, or build the list from the team\'s connections.' });
  }

  const month = b.month || fgMonth();
  const keywords = Array.isArray(b.keywords) ? b.keywords : [];
  res.json({ started: true });

  _fgTeam = makeInitialStatus(pairs);
  _fgTeam.phase = 'launching';
  _fgTeamAbort = false;
  const token = process.env.GOLOGIN_API_TOKEN;

  (async () => {
    try {
      const { closeProfile } = await import('./src/gologin-launcher.js');
      preventSleep('fg-team-launch');

      let _fgTeamSnap = { invites: [], budgets: [] };
      const localRunAt = new Date().toISOString();
      const localRunId = 'local-' + localRunAt;
      const deps = {
        // Build this account's targets fresh (DNC-safe, keyword-filtered, deduped vs
        // already-invited, budget-capped) immediately before its send.
        buildTargets: (pair) => {
          // NOTE: getFgState is async; we snapshot it once per account via the closure below.
          const snap = _fgTeamSnap;
          const alreadyInvited = invitedKeysFromState(snap.invites);
          const budget = fgRemaining(snap.budgets, pair.account, month);
          const out = buildFgTargets(fgCriteria({ jobTitles: keywords }), { operator: pair.operator, operatorName: pair.operatorName, account: pair.account, month, alreadyInvited, budget });
          // Specific skip reason so the live log isn't a vague catch-all.
          let reason = '';
          if (!out.count) {
            if (out.matched === 0) reason = 'no connections match these roles';
            else if (out.eligible === 0) reason = 'all matching connections already invited';
            else reason = 'monthly budget used up — no invites remaining this month';
          }
          return { rows: out.rows, count: out.count, reason };
        },
        launch: async (pair) => {
          const isLocal = pair.profileId === 'local-browser';
          campaignLog(`[FG-team] Launching ${isLocal ? 'local browser' : `profile ${pair.profileId}`} for ${pair.account}`);
          const launched = isLocal ? await launchLocalBrowser() : await launchProfile(pair.profileId, token);
          return { page: launched.page, close: async () => { await (isLocal ? closeLocalBrowser() : closeProfile(pair.profileId)); } };
        },
        send: ({ page, queued, log, shouldAbort }) => runFollowerInvites({ page, inviteUrl: ORTUS_PAGE_INVITE_URL, queued, log, shouldAbort }),
        // Write-back: append the invited rows then flip them to Invited (+bump budget).
        // End state has NO Queued rows; reuses existing Apps Script actions.
        record: async ({ rows, invitedIds, alreadyFollowingIds = [], account, operator }) => {
          // Already-follows go into the SAME store as invited so the next build's
          // alreadyInvited dedupe removes them; the observeCredits write-back keeps
          // the real budget correct (these consumed no credit).
          const persistIds = [...new Set([...(invitedIds || []), ...alreadyFollowingIds].map(String))];
          const set = new Set(persistIds);
          const persistRows = rows.filter((r) => set.has(String(r[2])));
          if (persistRows.length) {
            // BEST-EFFORT: the invites were already sent on LinkedIn. If the sheet
            // write-back fails (postFg already retries transient Google hiccups),
            // do NOT abort the account — that would hide real sent invites as a ✗
            // Error and leave them mislabeled. Log a loud STRANDED warning instead;
            // the run still reports "N sent" and writes the real credit snapshot.
            try {
              await queueFgInvites(persistRows, { runId: localRunId, runAt: localRunAt });
              await markFgInvited({ memberIds: persistIds, account, operator, month });
            } catch (e) {
              const warn = `[${new Date().toISOString()}] ⚠ STRANDED: ${persistIds.length} invite(s)/follow(s) WERE sent for ${account} but the sheet write-back failed — they will be re-checked next run; flip them to Invited manually if needed (${e.message})`;
              try { _fgTeam.logs.push(warn); if (_fgTeam.logs.length > 200) _fgTeam.logs.shift(); } catch (_) {}
              try { campaignLog(`[FG-team] ${warn}`); } catch (_) {}
            }
          }
          try { _fgTeamSnap = await getFgState(); } catch (_) { /* keep prior snapshot */ } // refresh so the next account dedups against these
        },
        // Authoritative credit write-back: store the modal's real available number
        // so the shared budget self-corrects for accept/withdraw refills.
        observeCredits: async ({ account, operator, month: m, available, allowance, refill }) => {
          await observeFgCredits({ account, operator, month: m || month, available, allowance, refill });
          _fgTeamSnap = await getFgState();
        },
        log: (m) => { try { campaignLog(`[FG-team] ${m}`); } catch (_) {} },
        now: () => new Date().toISOString(),
      };

      _fgTeamSnap = await getFgState();
      await runTeamLaunch(pairs, {
        keywords, month,
        getAbort: () => _fgTeamAbort,
        setActiveHandle: (h) => { _fgActiveHandle = h; },
        clearActiveHandle: () => { _fgActiveHandle = null; },
      }, deps, _fgTeam);
    } catch (err) {
      _fgTeam.running = false; _fgTeam.phase = 'error'; _fgTeam.error = err.message;
    } finally {
      _fgTeam.running = false;
      try { allowSleep(); } catch (_) {}
    }
  })();
});

// ── Manual bulk reply sweep ──────────────────────────────────────────────────
// One-button, observable inbox sweep. Mirrors the FG team-launch streaming
// pattern: sequential per-profile scan, isolated per-profile errors, force-close
// on stop. Preview-only unless the operator turns dry-run OFF.
let _replySweep = makeInitialSweepStatus([], true);
_replySweep.running = false; _replySweep.phase = 'idle';
let _replySweepAbort = false;
let _replySweepHandle = null;

// Reply-sweep eligibility is BROADER than the DM-only CHECK_DMS_STAGE_FILTER:
// anyone we've actually engaged can reply, including connection campaigns (Stage
// "Connected", "Introduction Made", …). Exclude only leads that can't have replied
// — still-pending connects, skipped rows, and blanks. Shared by /start + /accounts.
function replyEligibleRows(rows) {
  const hasStageSchema = rows.length > 0 && ('Stage' in rows[0]);
  return rows.filter((row) => {
    if (hasStageSchema) {
      const stage = String(row.Stage || '').trim();
      if (!stage) return false;
      if (/^Skipped/i.test(stage)) return false;
      if (/^Connect Pending$/i.test(stage)) return false;
      return true;
    }
    return String(row.Message || '').trim().toLowerCase() === 'sent';
  });
}

// Publish the current FG team config to the cloud so Auto-Pilot can fire it.
app.post('/api/fg/autopilot/publish', async (req, res) => {
  const b = req.body || {};
  const config = buildAutopilotConfig({
    pairs: Array.isArray(b.pairs) ? b.pairs : [],
    keywords: Array.isArray(b.keywords) ? b.keywords : [],
    enabled: b.enabled !== false,
    days: Array.isArray(b.days) && b.days.length ? b.days : [1, 15],
    marketerDefaults: FG_MARKETER_KEYWORDS,
    publishedBy: getOperatorEmail() || req.user || '',
    publishedAt: new Date().toISOString(),
  });
  const r = await publishAutopilotConfig(config);
  if (r.error) return res.status(502).json(r);
  res.json({ ok: true, config });
});

// Read-through proxy for the panel's collapsed strip — keeps FG_ROSTER_TOKEN
// server-side (browser only ever calls same-origin /api/fg/*).
app.get('/api/fg/autopilot', async (_req, res) => {
  // Resilient: if the roster service is unreachable (e.g. not yet deployed), still
  // return a computed next-run from the default schedule so the strip shows a date
  // instead of a blank "—". `degraded:true` tells the client NOT to publish (the
  // real persisted enabled/days is unknown — never clobber it with a guess).
  let j = null;
  try {
    const r = await fetch(`${FG_ROSTER_URL}/admin/autopilot`, {
      headers: { authorization: `Bearer ${FG_ROSTER_TOKEN}` },
      signal: AbortSignal.timeout(4000), // never hang the panel on a slow/undeployed service
    });
    if (r.ok) j = await r.json();
  } catch (_) { /* service down/slow — fall through to degraded so the strip still renders */ }
  const degraded = !j;
  const cfg = (j && j.config) || { enabled: true, days: [1, 15] };
  const instant = cfg.enabled ? nextRun(new Date(), cfg) : null;
  res.json({ config: (j && j.config) || null, runs: (j && j.runs) || [], degraded, nextRunLabel: instant ? instant.toISOString() : null });
});
app.post('/api/fg/autopilot/run', async (_req, res) => {
  try {
    const r = await fetch(`${FG_ROSTER_URL}/admin/autopilot`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${FG_ROSTER_TOKEN}` },
      // Building targets for the whole team (~24 accounts) + inserting thousands of
      // leads is slow — give it real headroom so a working dispatch isn't aborted.
      body: JSON.stringify({ force: true }), signal: AbortSignal.timeout(120000),
    });
    // The old (not-yet-updated) service answers this path with an HTML 404, which
    // isn't JSON — surface a human message instead of a raw parse error.
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    if (!r.ok || !body) return res.status(503).json({ error: 'the cloud Auto-Pilot service isn’t deployed yet — deploy it, then Run it now will work' });
    res.status(r.status).json(body);
  } catch (e) {
    // A timeout does NOT mean "unreachable" — the dispatch may still be completing
    // in the cloud. Never tell the operator it failed when it might not have.
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return res.status(202).json({ pending: true });
    }
    res.status(503).json({ error: `the cloud Auto-Pilot service isn’t reachable — ${e.message}` });
  }
});

app.get('/api/reply-sweep/status', (_req, res) => res.json(_replySweep));

// The accounts that actually have reply-eligible leads in a given sheet — so the UI
// can offer a SHORT, sheet-scoped account picker instead of all GoLogin profiles.
app.get('/api/reply-sweep/accounts', async (req, res) => {
  const sheetUrl = req.query.sheetUrl;
  if (!sheetUrl) return res.json({ accounts: [] });
  let rows;
  try { rows = await fetchSheet(sheetUrl); }
  catch (err) { return res.status(400).json({ error: `Could not load sheet: ${err.message}`, accounts: [] }); }
  let nameToId = {}; const nameById = new Map();
  try {
    const allProfiles = await getProfiles(process.env.GOLOGIN_API_TOKEN);
    for (const p of allProfiles) { nameToId[(p.name || '').toLowerCase()] = p.id; nameById.set(p.id, p.name || p.id); }
  } catch { /* fall back to sender string as id */ }
  const byAcct = new Map();
  for (const row of replyEligibleRows(rows)) {
    const acct = String(row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').trim();
    if (!acct) continue;
    const pid = nameToId[acct.toLowerCase()] || acct;
    byAcct.set(pid, (byAcct.get(pid) || 0) + 1);
  }
  const accounts = [...byAcct.entries()]
    .map(([id, leadCount]) => ({ id, name: nameById.get(id) || id, leadCount }))
    .sort((a, b) => b.leadCount - a.leadCount);
  res.json({ accounts });
});

app.post('/api/reply-sweep/stop', async (_req, res) => {
  _replySweepAbort = true;
  const h = _replySweepHandle; _replySweepHandle = null;
  try { if (h && typeof h.close === 'function') await h.close(); } catch (_) {}
  res.json({ ok: true });
});

// Open a reply's thread in the SENDER's own GoLogin browser (not the system
// browser) so the operator reads/replies as the right account. Launches the
// profile if needed and navigates it to the conversation; leaves it open for
// the operator to act in. Refuses while a sweep is mid-run (it owns the browsers).
app.post('/api/reply-sweep/open-thread', async (req, res) => {
  if (_replySweep.running) return res.status(409).json({ error: 'Reply sweep is running — wait for it to finish.' });
  const b = req.body || {};
  const profileId = b.profileId;
  const threadId = b.threadId;
  const fallbackUrl = b.profileUrl || '';
  if (!profileId) return res.status(400).json({ error: 'profileId required' });
  const url = threadId
    ? `https://www.linkedin.com/messaging/thread/${encodeURIComponent(threadId)}/`
    : fallbackUrl;
  if (!url) return res.status(400).json({ error: 'threadId or profileUrl required' });
  try {
    const token = process.env.GOLOGIN_API_TOKEN;
    const isLocal = profileId === 'local-browser';
    const existingPid = getProfilePid(profileId);
    if (existingPid) {
      // Already open (operator-opened or focus-existing) — bring it onscreen.
      // We don't hold its page handle, so we can't navigate it programmatically.
      if (process.platform === 'darwin') { try { await unhideByPids([existingPid]); } catch (_) {} }
      return res.json({ ok: true, action: 'focused-existing', pid: existingPid, url });
    }
    const launched = isLocal ? await launchLocalBrowser() : await launchProfile(profileId, token);
    try { await launched.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (_) {}
    const newPid = getProfilePid(profileId);
    if (process.platform === 'darwin' && newPid) { try { await unhideByPids([newPid]); } catch (_) {} }
    res.json({ ok: true, action: 'launched', pid: newPid, url });
  } catch (err) {
    console.error(`[reply-sweep open-thread] ${profileId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reply-sweep/start', async (req, res) => {
  if (_replySweep.running) return res.status(409).json({ error: 'A reply sweep is already running.' });
  const b = req.body || {};
  let { sheetUrl, linkedinColumn, profileIds } = b;
  const dryRun = b.dryRun !== false; // default ON (preview-only) unless explicitly false
  if (!sheetUrl && campaign.running && campaign.sheetUrl) {
    sheetUrl = campaign.sheetUrl;
    linkedinColumn = linkedinColumn || campaign.linkedinColumn || '';
  }
  if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
  linkedinColumn = linkedinColumn || 'Linkedin URL';

  // Load + group sent rows by sender (same grouping as /api/reply-check-now).
  const token = process.env.GOLOGIN_API_TOKEN;
  let rows;
  try { rows = await fetchSheet(sheetUrl); }
  catch (err) { return res.status(400).json({ error: `Could not load sheet: ${err.message}` }); }

  let nameByProfileId = new Map();
  let nameToId = {};
  try {
    const allProfiles = await getProfiles(token);
    nameByProfileId = new Map(allProfiles.map((p) => [p.id, p.name || p.id]));
    for (const p of allProfiles) nameToId[(p.name || '').toLowerCase()] = p.id;
  } catch { /* fall back to id-as-name */ }

  const candidateRows = replyEligibleRows(rows);

  const wanted = Array.isArray(profileIds) && profileIds.length ? profileIds.slice() : null;
  const leadsByProfile = new Map();
  for (const row of candidateRows) {
    const acct = String(row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').trim();
    if (!acct) continue;
    const pid = nameToId[acct.toLowerCase()] || acct;
    if (wanted && !wanted.includes(pid)) continue;
    if (!leadsByProfile.has(pid)) leadsByProfile.set(pid, []);
    leadsByProfile.get(pid).push(row);
  }

  const pids = [...leadsByProfile.keys()];
  const names = pids.map((pid) => nameByProfileId.get(pid) || pid);
  res.json({ started: true, profiles: names.length });

  _replySweep = makeInitialSweepStatus(names, dryRun);
  _replySweepAbort = false;

  // Scan window: campaign first send-out − 12h, else 14 days back.
  const startMs = campaign.startedAt ? Date.parse(campaign.startedAt) : NaN;
  const watermark = (Number.isFinite(startMs) ? startMs : (Date.now() - 14 * 86400000)) - 12 * 60 * 60 * 1000;
  const stamp = (m) => { _replySweep.logs.push(`[${new Date().toISOString()}] ${m}`); if (_replySweep.logs.length > 200) _replySweep.logs.shift(); try { campaignLog(`[reply-sweep] ${m}`); } catch (_) {} };

  (async () => {
    setBulkCheckInProgress(true);
    preventSleep('reply-sweep');
    try {
      stamp(`▶ Reply sweep started · ${pids.length} account(s) · ${dryRun ? 'preview only' : 'WRITE-BACK ON'}`);
      const launchedPids = new Set();   // profiles WE opened this sweep (for the close safety net)
      for (let i = 0; i < pids.length; i++) {
        const pid = pids[i];
        const slot = _replySweep.perProfile[i];
        const pName = names[i];
        if (_replySweepAbort) { slot.status = 'skipped'; slot.error = 'stopped'; stamp(`⊘ [${pName}] Stopped`); continue; }
        _replySweep.currentProfile = pName;
        slot.status = 'running';
        const wasRunning = !!getProfilePid(pid);
        const isLocal = pid === 'local-browser';
        let launched = null, handle = null;
        try {
          stamp(`📬 [${pName}] Scanning inbox…`);
          launched = isLocal ? await launchLocalBrowser() : await launchProfile(pid, token);
          if (!isLocal) launchedPids.add(pid);
          handle = { close: async () => { try { await (isLocal ? closeLocalBrowser() : closeProfile(pid)); } catch (_) {} } };
          _replySweepHandle = handle;

          const out = await sweepProfileInbox({
            page: launched.page, sheetUrl, linkedinColumn,
            candidateRows: leadsByProfile.get(pid), watermark, log: stamp,
          });
          if (out.error) { slot.status = 'error'; slot.error = out.error; stamp(`⚠ [${pName}] ${out.error}`); }
          else {
            slot.replies = out.campaignReplies.length;
            slot.unmatched = out.unmatched.length;
            slot.status = 'done';
            for (const r of out.campaignReplies) _replySweep.campaignReplies.push({ ...r, account: pName, accountPid: pid });
            for (const u of out.unmatched) _replySweep.unmatched.push({ ...u, account: pName, accountPid: pid });
            stamp(`📬 [${pName}] ${out.campaignReplies.length} reply(ies), ${out.unmatched.length} unmatched · ${out.conversationsScanned} scanned`);

            if (!dryRun && out.campaignReplies.length) {
              const wb = await applyReplyWriteBack({ sheetUrl, linkedinColumn, campaignReplies: out.campaignReplies });
              _replySweep.wrote += wb.wrote;
              stamp(`✍ [${pName}] wrote ${wb.wrote}, skipped ${wb.skipped}${wb.errors.length ? `, ${wb.errors.length} error(s)` : ''}`);
            }
          }
        } catch (err) {
          if (_replySweepAbort) { slot.status = 'skipped'; slot.error = 'stopped'; stamp(`⊘ [${pName}] Stopped`); }
          else { slot.status = 'error'; slot.error = err.message; stamp(`✗ [${pName}] ${err.message}`); }
        } finally {
          _replySweepHandle = null;
          // Always close what WE opened (sweep only runs when no campaign is active,
          // so wasRunning should be false; we still respect an operator-opened browser).
          if (!wasRunning && handle) {
            stamp(`⏏ [${pName}] Closing browser…`);
            try { await handle.close(); } catch (_) {}
            if (!isLocal) {
              await new Promise((r) => setTimeout(r, 1500));   // let kill/SIGKILL settle
              if (getProfilePid(pid)) { try { await closeProfile(pid); } catch (_) {} }
              if (!getProfilePid(pid)) launchedPids.delete(pid);
            }
            slot.closed = true;
            stamp(`✓ [${pName}] Closed`);
          }
          _replySweep.doneProfiles++;
        }
      }
      // Safety net: force-close any profile we opened that somehow survived its finally.
      for (const pid of launchedPids) {
        if (getProfilePid(pid)) { stamp(`⏏ Safety close — ${nameByProfileId.get(pid) || pid}`); try { await closeProfile(pid); } catch (_) {} }
      }
      _replySweep.phase = 'done';
      stamp(`■ Reply sweep complete — ${_replySweep.campaignReplies.length} reply(ies), ${_replySweep.unmatched.length} unmatched${dryRun ? '' : `, ${_replySweep.wrote} written`}`);
    } catch (err) {
      _replySweep.phase = 'error'; _replySweep.error = err.message; stamp(`✗ Fatal — ${err.message}`);
    } finally {
      _replySweep.running = false; _replySweep.currentProfile = null;
      setBulkCheckInProgress(false);
      try { allowSleep(); } catch (_) {}
    }
  })();
});

// v2.59.x — Atomic full-order reorder for drag-and-drop in the dashboard.
// Body: { ids: ["q_xxx", "q_yyy", ...] } in the desired new order. Validates
// the ids match the current queue exactly so a concurrent pop/cancel can't
// silently corrupt the order — client refreshes and retries on mismatch.
app.post('/api/queue/reorder', async (req, res) => {
  try {
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const result = await reorderQueue(ids);
    if (!result.ok) {
      if (result.reason === 'mismatch') {
        return res.status(409).json({ error: 'Queue changed — refresh and retry', reason: 'mismatch' });
      }
      return res.status(400).json({ error: 'Invalid input', reason: result.reason || 'unknown' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.59.x — Add a campaign to the queue WITHOUT auto-draining. Mirrors the
// validation of /api/campaign/start but skips the running-or-empty branches
// — the operator clicks "Add to Queue" intentionally, even when idle, to
// stage runs without firing one immediately. Drain via /api/queue/run-next
// or wait for the next launchCampaign() chain.
app.post('/api/campaign/queue-only', async (req, res) => {
  try {
    if (checkDms.running) return res.status(409).json({ error: 'Check DMs is running — stop it first' });
    if (postAmp.running) return res.status(409).json({ error: 'Post Amplification is running — stop it first' });

    const body = req.body || {};
    const { profileIds, sheetUrl, dailyLimit, mode } = body;

    // Retired modes — same gate as /api/campaign/start. Queueing one would just
    // defer the rejection to drain time, where nobody is watching for the error.
    if (isRetiredMode(mode)) {
      return res.status(400).json({ error: `"${mode}" campaigns have been retired and can no longer be queued.` });
    }
    if (mode !== 'check_status' && mode !== 'message_only' && mode !== 'introduce_back' && !profileIds?.length) {
      return res.status(400).json({ error: 'profileIds required' });
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
    if (!dailyLimit || dailyLimit < 1) return res.status(400).json({ error: 'dailyLimit must be >= 1' });
    if (rejectIfNoOperatorEmail(res)) return;
    // A foreign-workspace profile — or one whose workspace doesn't run this
    // mode — is rejected at the door, not at launch time.
    if (await rejectIfForeignProfiles(req, res, profileIds, mode)) return;
    if (rejectIfBadPrimaryUrl(body, res)) return;

    // Fix A Task 4 — intake guard (mirrors /api/campaign/start).
    {
      const resolvedGid = body.sheetGid != null
        ? String(body.sheetGid).replace(/\D/g, '')
        : extractSheetGid(sheetUrl || '');
      if (body.multiTab === true && !resolvedGid) {
        return res.status(400).json({ error: 'Pick the lead tab — this workbook has multiple tabs.' });
      }
    }

    // Ortus Basics 1.0: pre-flight gate disabled.
    // if (!await runPreflightGate(req, res)) return;

    const config = buildCampaignConfig(body);
    const owner = req.user;

    try { await writeDraftName(''); } catch { /* non-fatal */ }

    const entry = await addToQueue(config, owner);
    const position = (await getQueue()).length;
    res.json({
      ok: true,
      queued: true,
      queueId: entry.id,
      message: position === 1
        ? 'Added to queue. Press "Run next" or start another campaign to drain it.'
        : `Added to queue (position ${position}).`,
    });
  } catch (err) {
    console.error('Queue-only error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// v2.59.x — Explicitly drain the head of the queue when no campaign is
// running. Used by the dashboard's "Run next" pill, which is visible only
// when idle + non-empty queue. No-op (with a friendly response) if a
// campaign is already running — the queue will chain when it finishes.
app.post('/api/queue/run-next', async (_req, res) => {
  try {
    if (campaign.running) {
      return res.json({ ok: false, reason: 'running', message: 'A campaign is already running.' });
    }
    const queue = await getQueue();
    if (queue.length === 0) {
      return res.json({ ok: false, reason: 'empty', message: 'Queue is empty.' });
    }
    runNextFromQueue().catch(err => console.error('Run-next drain failed:', err.message));
    res.json({ ok: true, message: 'Draining next queued campaign…' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Monitoring routes (Task 8a) — Check now, Stop monitoring, State
// ---------------------------------------------------------------------------

app.post('/api/monitoring/check-now', async (req, res) => {
  try {
    const { runMonitoringCheckAll, getCampaignState, setBulkCheckInProgress } = await import('./src/campaign.js');
    // Ortus Basics 1.0: check-now is the ONLY way a check runs, so it must not
    // require the campaign to be sitting in monitoring — the operator may want a
    // check after a run has finished and settled.
    const state = getCampaignState();
    const _checkable = (state?.participatingProfileIds || state?.profileIds || []).length;
    if (!_checkable) {
      return res.status(400).json({ error: 'No campaign accounts to check yet — run a campaign first.' });
    }
    // Fire and forget — the operator wants the button to feel responsive,
    // but the actual bulk-check pass takes 30-120s.
    //
    // The flag is what MAKES the sweep visible. Without it
    // getCampaignStatus().monitoringCheckInProgress stayed false for the whole
    // manual sweep, so the card had nothing to render "checking" from: the
    // operator pressed Run check now, browsers opened, and the card went on
    // reading a countdown to the next check. It also gates Stop, which could
    // only ever no-op on a sweep it did not know was running. The scheduled
    // tick has always set it; this route never did.
    setBulkCheckInProgress(true);
    runMonitoringCheckAll()
      .then((outcome) => {
        const finished = getCampaignState();
        finished.logs = finished.logs || [];
        const stamp = () => `[${new Date().toISOString()}]`;
        const successful = !!(outcome && outcome.ok);
        finished.logs.push(`${stamp()} ${successful ? '✓' : '⚠'} Check complete${successful ? '' : ' — some accounts need attention'}.`);
        // A terminal schedule event is part of the sweep contract. Without it,
        // the final account line (often Identity Restricted) permanently owns
        // the banner even though the check has already ended.
        if (finished.state === 'monitoring' && finished.nextCheckAt) {
          finished.logs.push(`${stamp()} ${nextCheckLogLine(finished.nextCheckAt)}`);
        }
      })
      .catch((err) => {
        console.warn('[check-now] threw:', err.message);
        const failed = getCampaignState();
        failed.logs = failed.logs || [];
        failed.logs.push(`[${new Date().toISOString()}] ⚠ Check ended unexpectedly — retry the check. Monitoring remains active.`);
      })
      .finally(() => setBulkCheckInProgress(false));
    res.json({ ok: true, started: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop the acceptance check that is running right now, WITHOUT ending the
// campaign. Monitoring, the cadence and the next check time are untouched.
app.post('/api/campaign/check/stop', async (req, res) => {
  try {
    const { stopMonitoringCheck } = await import('./src/campaign.js');
    res.json(stopMonitoringCheck());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitoring/auto-checks', async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) required' });
    }
    const { getCampaignState, setMonitoringAutoChecks } = await import('./src/campaign.js');
    // Ortus Basics 1.0: check-now is the ONLY way a check runs, so it must not
    // require the campaign to be sitting in monitoring — the operator may want a
    // check after a run has finished and settled.
    const state = getCampaignState();
    const _checkable = (state?.participatingProfileIds || state?.profileIds || []).length;
    if (!_checkable) {
      return res.status(400).json({ error: 'No campaign accounts to check yet — run a campaign first.' });
    }
    const value = await setMonitoringAutoChecks(enabled);
    res.json({ ok: true, autoChecksEnabled: value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitoring/stop', async (_req, res) => {
  try {
    const { stopMonitoring: _stopMonitoring } = await import('./src/campaign.js');
    const result = await _stopMonitoring({ reason: 'operator-stopped' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/monitoring/state', (_req, res) => {
  import('./src/campaign.js').then((mod) => {
    const c = mod.getCampaignState();
    // Return only the monitoring-relevant slice
    res.json({
      state: c.state || 'idle',
      mode: c.mode,
      sendingEndedAt: c.sendingEndedAt,
      monitoringUntil: c.monitoringUntil,
      nextCheckAt: c.nextCheckAt,
      participatingProfileIds: c.participatingProfileIds || [],
      profileIds: c.profileIds || [],
      profileNames: c.profileNames || [],
      logs: c.logs || [],
      sheetUrl: c.sheetUrl,
      name: c.name,
      autoChecksEnabled: c.autoChecksEnabled !== false,
    });
  }).catch((err) => res.status(500).json({ error: err.message }));
});

// v2.14.x: macOS sleep-resume hook. Called by electron/main.js when the
// system wakes — kicks an immediate tick so an overdue auto-check fires
// without waiting up to 60s for the next setInterval boundary.
app.post('/api/monitoring/wake', async (_req, res) => {
  try {
    const { tickMonitoringNow } = await import('./src/campaign.js');
    tickMonitoringNow().catch((err) => console.warn('[wake] tick threw:', err.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Electron writes a durable reason before this Mac sleeps or the app quits.
// On the next launch the canonical card can explain why local work stopped,
// instead of reconstructing a misleading generic running/waiting state.
app.post('/api/runtime/interruption', async (req, res) => {
  try {
    const { recordRuntimeInterruption } = await import('./src/campaign.js');
    res.json(recordRuntimeInterruption(req.body?.reason || 'unexpected-exit'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/runtime/resumed', async (_req, res) => {
  try {
    const { acknowledgeRuntimeResume } = await import('./src/campaign.js');
    res.json(acknowledgeRuntimeResume());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.78: guards for the manual /api/bulk-check-now sweep. _manualSweepRunning
// blocks overlapping sweeps; _manualSweepAbort lets Stop halt one in flight.
let _manualSweepRunning = false;
let _manualSweepAbort = false;

// Put an account BACK into the live sending rotation. Body: { profileId }.
//
// This used to bench too (skip=true). Benching an account mid-run is no longer
// a thing the app can do: a campaign's accounts are decided before it starts,
// and to take one out you stop the campaign, remove it, and start again
// (operator, 2026-09-04). The UI no longer offers it, and the endpoint refuses
// it — so the rule holds even if some caller asks.
//
// The other direction stays: it retries an auto-parked account (weekly cap,
// signed out, skipped), which is recovery, not benching.
app.post('/api/campaign/profile-skip', (req, res) => {
  const { profileId, skip } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId required' });
  // Benching mid-run is back (operator, 2026-09-19): the account finishes the
  // lead it is on, then sits out until un-benched.
  const result = setProfileSkip(profileId, !!skip);
  res.json(result);
});

// Take an account out of the running campaign for good. Body: { profileId }.
app.post('/api/campaign/profile-remove', (req, res) => {
  const { profileId } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId required' });
  const result = removeProfileFromCampaign(profileId);
  if (!result.ok) return res.status(409).json({ error: result.reason });
  res.json(result);
});

// v2.86.15: edit-while-paused. Three live setters apply new values to the
// running campaign object while it's paused; the send loop picks them up on
// Resume. Each is gated inside the setter on campaign.running && _paused.
app.post('/api/campaign/live/templates', (req, res) => {
  const templates = req.body?.templates || req.body || {};
  if (!templates || typeof templates !== 'object') {
    return res.status(400).json({ error: 'templates required' });
  }
  const result = setLiveTemplates(templates);
  res.json(result);
});

app.post('/api/campaign/live/daily-limit', (req, res) => {
  const dailyLimit = req.body?.dailyLimit;
  if (dailyLimit === undefined || dailyLimit === null) {
    return res.status(400).json({ error: 'dailyLimit required' });
  }
  const result = setLiveDailyLimit(dailyLimit);
  res.json(result);
});

app.post('/api/campaign/live/cadence', (req, res) => {
  const checkIntervalMinutes = req.body?.checkIntervalMinutes;
  if (checkIntervalMinutes === undefined || checkIntervalMinutes === null) {
    return res.status(400).json({ error: 'checkIntervalMinutes required' });
  }
  const result = setLiveCadence(checkIntervalMinutes);
  res.json(result);
});

let _recoveryExitRequested = false;
async function closeCurrentCampaignBrowsers() {
  const ids = [...new Set((campaign.profileIds || []).filter((id) => id && id !== 'local-browser'))];
  await Promise.allSettled(ids.map((id) => closeProfile(id)));
  if ((campaign.profileIds || []).includes('local-browser')) {
    try { await closeLocalBrowser(); } catch (err) { console.warn('[stop] closeLocalBrowser:', err.message); }
  }
}
const _campaignStopWatchdog = createStopWatchdog({
  isRunning: ({ generation }) => campaign.running && campaign._abort && campaign._generation === generation,
  onStuck: async ({ graceMs }) => {
    const status = getCampaignStatus();
    const pending = Math.max(0, Number(status.totalTargets || 0) - Number(status.totalProcessed || 0));
    try {
      const { recordRuntimeInterruption } = await import('./src/campaign.js');
      recordRuntimeInterruption('campaign-stop-timeout', { pending });
    } catch (err) { console.error('[stop-watchdog] recovery journal failed:', err.message); }
    console.error(`[stop-watchdog] Stop exceeded ${Math.round(graceMs / 1000)}s; requesting supervised restart.`);
    _recoveryExitRequested = true;
    await Promise.race([
      closeCurrentCampaignBrowsers(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    process.exit(75);
  },
});

app.post('/api/campaign/stop', async (req, res) => {
  // v2.14.x: optional `{ full: true }` body opts out of the
  // connect_and_introduce post-campaign sweep + auto-intros. Default
  // behaviour is unchanged (Stop sending, keep monitoring) — relevant only
  // when the running campaign is mode=connect_and_introduce.
  const fullHalt = req.body?.full !== false;
  const immediate = !!req.body?.immediate;
  const result = stopCampaign({ full: fullHalt });
  const stopState = campaign.running ? _campaignStopWatchdog.arm({ generation: campaign._generation }) : _campaignStopWatchdog.status();
  let tracking = { ok: true };
  if (fullHalt) {
    if (immediate) {
      // The state/timer flags above are already off. Removing persisted future
      // schedules is cleanup and must never hold the Stop response hostage.
      tracking = { ok: true, cleanupPending: true };
      stopCampaignBackgroundTracking().catch((err) => console.warn('[stop] background tracking cleanup:', err.message));
    } else {
      tracking = await Promise.race([
        stopCampaignBackgroundTracking(),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'Background checks did not confirm stop within 10 seconds.' }), 10000)),
      ]);
    }
  }
  // v2.14.x: ALSO flip the abort flags for Check DMs and Post Amplification.
  // The bottom-bar Stop button posts to /api/campaign/stop regardless of
  // which subsystem is currently running (the cockpit overlay sets
  // checkDms.running and postAmp.running to make the UI feel like a unified
  // campaign). Without these flips, the closeAllProfiles() below kills
  // their browsers but their loops keep iterating — post-amp launches a
  // FRESH browser for the next account and the operator sees a "stopped"
  // campaign mysteriously start sending again. checkDms has the same
  // shape. Flipping both flags here makes Stop actually mean Stop.
  checkDms._abort = true;
  postAmp._abort = true;
  // v2.78: also halt a manual /api/bulk-check-now sweep in flight — its
  // per-account loop checks this flag and breaks. stopCampaign() already
  // force-closes the in-flight check browser via activeBulkChecks.
  _manualSweepAbort = true;
  // v2.14.x: respond to the UI immediately so the dashboard flips to
  // 'stopping' without waiting for the browser-close round-trip. The actual
  // browser kill runs after a short drain window — see comment block below.
  res.status(tracking.ok ? 200 : 502).json({ ...result, tracking, stopping: campaign.running, stopRequestedAt: stopState.requestedAt, stopDeadlineAt: stopState.deadlineAt });

  // v2.14.x: drain-then-kill instead of kill-then-loop-discovers-it.
  //
  // The previous order (closeAllProfiles -> respond) force-closed every
  // browser BEFORE any in-flight worker had a chance to see _abort=true.
  // When that worker was inside runAutoIntros, the next iteration hit a
  // dead page and stamped 7-10 leads as 'Failed (MESSAGE_SEND_FAILED:
  // compose textbox did not appear)' — a cascade of phantom failures
  // (repro: franco.espino 2026-05-17T16:26:53).
  //
  // New order:
  //   1. stopCampaign() flips campaign._abort = true
  //   2. respond to UI
  //   3. wait 15s — the exact grace period promised by the stop dialog
  //      to see _abort at their next iteration boundary, stamp remaining
  //      leads as 'Skipped — Stop pressed', and exit their finally blocks
  //      (which close their own browser cleanly)
  //   4. closeAllProfiles() as a safety net for anything that didn't
  //      drain (e.g. hung navigations) — by now it's usually a no-op.
  //
  // Pattern matches Crawlee (apify/crawlee#1102) and the broader Puppeteer
  // graceful-abort guidance (puppeteer/puppeteer#4671). Worker-side
  // cleanup is already idempotent so the safety-net close is harmless.
  setTimeout(async () => {
    try { await closeCurrentCampaignBrowsers(); } catch (err) { console.warn('[stop] closeCurrentCampaignBrowsers:', err.message); }
  }, immediate ? 0 : 15000);
});

// Permanently remove the local crash/stop recovery copy. This deliberately
// cannot touch a running local campaign, monitoring watcher, or any Cloud VM
// campaign; it only deletes the inactive runtime-interruption journal that
// creates the stale "This Mac unavailable" board card.
app.delete('/api/campaign/interrupted', (_req, res) => {
  const interruption = readRuntimeInterruption();
  if (!interruption) return res.json({ ok: true, deleted: false });
  if (campaign.running || campaign.state === 'monitoring') {
    return res.status(409).json({ error: 'The local campaign is active and cannot be deleted as a recovery copy.' });
  }
  clearRuntimeInterruption();
  res.json({ ok: true, deleted: true });
});

// Phase 2.8.9: pause/resume control. Pause is non-destructive — browsers stay
// open, the loop sleeps at the next lead boundary. Resume picks up where it
// left off.
app.post('/api/campaign/pause', (_req, res) => {
  res.json(pauseCampaign());
});

app.post('/api/campaign/resume', (_req, res) => {
  res.json(resumeCampaign());
});

// ── v2.112: resume-with-live-state (paused only) ────────────────────────────
function _resumeGuard(res) {
  if (!campaign.running) { res.status(409).json({ error: 'not-running' }); return false; }
  if (!campaign._paused) { res.status(409).json({ error: 'not-paused' }); return false; }
  return true;
}

function _buildResumeChanges() {
  const urlOf = campaign._urlOf || ((r) => r && (r.url || ''));
  const prev = campaign._currentTargets ? campaign._currentTargets() : [];
  const staged = campaign._pendingResume || {};
  const sheetDiff = staged.reloadSheet && staged.newRows
    ? computeSheetDiff(prev, staged.newRows.filter(campaign._isTarget || (() => true)), urlOf)
    : computeSheetDiff(prev, prev, urlOf);
  // Slice modes (check_status/message_only/introduce_back) drain pre-built per-profile
  // slices, so _reloadTargets will NOT add brand-new leads (only update existing rows).
  // Mirror that here so the preview is honest: relabel `added` as `skippedNew` (a "needs
  // restart to include" notice), never show it as an applied add.
  const SLICE_MODES = ['check_status', 'message_only', 'introduce_back'];
  if (SLICE_MODES.includes(campaign.mode) && sheetDiff.addedCount) {
    sheetDiff.skippedNew = sheetDiff.addedCount;
    sheetDiff.added = [];
    sheetDiff.addedCount = 0;
  } else {
    sheetDiff.skippedNew = 0;
  }
  const ids = (campaign.profileIds || []).slice();
  const names = {};
  (campaign.profileIds || []).forEach((id, i) => { names[id] = (campaign.profileNames || [])[i] || id; });
  const nextIds = ids.concat((staged.addProfiles || []).map(a => a.id));
  (staged.addProfiles || []).forEach(a => { names[a.id] = a.name || a.id; });
  const prevBench = [...(campaign._skippedProfiles || [])];
  const nextBench = prevBench.slice();
  for (const [id, skip] of Object.entries(staged.benchToggles || {})) {
    if (skip && !nextBench.includes(id)) nextBench.push(id);
    if (!skip) { const i = nextBench.indexOf(id); if (i >= 0) nextBench.splice(i, 1); }
  }
  const accountDiff = computeAccountDiff(
    { ids, benched: prevBench, names },
    { ids: nextIds, benched: nextBench, names },
  );
  const snap = campaign._pauseSnapshot || { dailyLimit: campaign.dailyLimit, checkIntervalMinutes: campaign.checkIntervalMinutes, templates: campaign.templates };
  const settingsDiff = computeSettingsDiff(snap, {
    dailyLimit: campaign.dailyLimit, checkIntervalMinutes: campaign.checkIntervalMinutes, templates: campaign.templates,
  });
  const rc = summarizeResumeChanges({ sheetDiff, accountDiff, settingsDiff });
  // skippedNew is informational (slice modes) — surface the notice even if nothing else changed.
  if (rc.sheet.skippedNew) rc.isEmpty = false;
  return rc;
}

app.post('/api/campaign/resume/reload-sheet', async (req, res) => {
  if (!_resumeGuard(res)) return;
  try {
    const rows = await campaign._refetchRows();
    campaign._pendingResume.reloadSheet = true;
    campaign._pendingResume.newRows = rows;
    res.json({ ok: true, resumeChanges: _buildResumeChanges() });
  } catch (err) {
    // Intentional HTTP 200 with { ok:false }: a failed reload must NOT block resume — the
    // frontend keeps the current targets and shows the error inline. Do not change to a
    // non-200 status (it would break that error-handling contract).
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/campaign/resume/accounts', async (req, res) => {
  if (!_resumeGuard(res)) return;
  const { bench, add } = req.body || {};
  // Validate everything BEFORE mutating staging, so a 400 leaves nothing partially staged.
  const benchEntries = (bench && typeof bench === 'object') ? Object.entries(bench) : [];
  for (const [id] of benchEntries) {
    if (!(campaign.profileIds || []).includes(id)) {
      return res.status(400).json({ error: `unknown profile ${id}` });
    }
  }
  let addById = null;
  if (Array.isArray(add) && add.length) {
    // getProfiles already imported from ./src/gologin-launcher.js (same source
    // the /api/profiles route uses). Returns [{ id, name, ... }].
    const available = await getProfiles(process.env.GOLOGIN_API_TOKEN);
    addById = new Map(available.map(p => [p.id, p.name]));
    for (const a of add) {
      if (!addById.has(a.id)) return res.status(400).json({ error: `unknown profile ${a.id}` });
      if ((campaign.profileIds || []).includes(a.id)) return res.status(400).json({ error: `already in run ${a.id}` });
    }
  }
  // All valid — apply.
  for (const [id, skip] of benchEntries) {
    campaign._pendingResume.benchToggles[id] = !!skip;
  }
  if (addById) {
    for (const a of add) {
      if (!campaign._pendingResume.addProfiles.some(x => x.id === a.id)) {
        campaign._pendingResume.addProfiles.push({ id: a.id, name: addById.get(a.id) });
      }
    }
  }
  res.json({ ok: true, resumeChanges: _buildResumeChanges() });
});

app.get('/api/campaign/resume/preview', (req, res) => {
  if (!_resumeGuard(res)) return;
  res.json({ ok: true, resumeChanges: _buildResumeChanges() });
});

app.post('/api/campaign/resume/confirm', (req, res) => {
  if (!_resumeGuard(res)) return;
  const applied = _buildResumeChanges();
  const result = resumeCampaign({ applyPending: true });
  res.json({ ok: result.ok !== false, applied });
});

// Local-browser re-login recovery (2026-06-15): operator clicked "Done" in the
// "log into LinkedIn" popup. Flips campaign._loginDone so awaitLocalLogin's
// poll loop re-verifies health and resumes the run.
app.post('/api/campaign/login-done', (_req, res) => {
  res.json(confirmLogin());
});

// ---------------------------------------------------------------------------
// Sales Nav Scrape — control-panel proxy to the GKE scraper engine.
//
// These routes do NOT run a campaign or launch a local browser. They forward
// to the engine (src/scraper-client.js) and relay its JSON. The engine runs
// the GoLogin profile + scraping on GKE and writes results to the sheet. When
// SCRAPER_ENGINE_URL is unset every call returns { error } (never throws), so
// the UI can show "engine not configured" instead of failing.
// ---------------------------------------------------------------------------
// Who is doing this, for the audit line. `admin` mirrors the board's own
// admin set so a line reads the same way the board labels the actor.
function scrapeActor(req) {
  const actor = getOperatorEmail() || (req && req.user) || 'unknown';
  return { actor, admin: String(actor).toLowerCase() === 'antonio@ortusclub.com' };
}

/** Best-effort audit line. A logging failure must never fail the operation. */
async function logScrape(campaignId, message, { level, actor } = {}) {
  if (!campaignId) return;
  try { await appendScrapeLog(campaignId, { message, level, actor }); }
  catch (e) { console.error('scrape log write failed:', campaignId, e.message); }
}

/**
 * The board id a launch WILL land on, computed from the same triple the board
 * groups by. Lets the dispatch path log against the strip before the strip (and
 * its engine jobs) exist.
 */
function boardIdForLaunch({ sheetUrl, tabName, campaignName }) {
  return scrapeCampaignId({
    userId: getOperatorId(),
    sheetUrl: sheetUrl || '',
    base: (campaignName || baseTabName(tabName) || '').trim(),
  });
}

app.post('/api/scrape/start', async (req, res) => {
  const { searchUrls, sheetUrl, tabName, profileId, slowMode, campaignName, accountName } = req.body || {};
  // Blocklisted people the engine must skip mid-scrape. Only URN-form entries
  // can be matched against a search result (which carries a memberUrn, not a
  // vanity slug); vanity-only entries still block at send-out via pre-flight.
  const _bl = readBlocklist();
  const excludeUrns = _bl
    .filter((e) => e.kind === 'person' && e.urn)
    .map((e) => e.urn);
  // Blocklisted COMPANIES the engine must skip mid-scrape. A search result
  // carries a company name, so this is matchable the same way pre-flight
  // already matches the sheet's Company column. Operator, 2026-09-01: "PNC" was
  // on the blocklist and its people were still being collected, because only
  // person entries were ever sent. Domains stay behind: a scrape result has no
  // email address to match one against.
  const excludeCompanies = _bl
    .filter((e) => (e.kind || 'company') === 'company' && String(e.value || '').trim())
    .map((e) => String(e.value).trim());
  // Stamp the owner server-side (the authoritative "Operating as" email) so the
  // shared board can show WHO launched each scrape across machines.
  const result = await startScrape({
    searchUrls, sheetUrl, tabName, profileId, slowMode,
    ownerEmail: getOperatorEmail() || '', campaignName: campaignName || '',
    excludeUrns, excludeCompanies,
    accountName: accountName || '',
  });
  // Dispatch was the single biggest blind spot: WHAT was asked for (search URL,
  // GoLogin profile, destination sheet + tab) was never written down anywhere,
  // so results landing in the wrong tab left no record of the request.
  const { actor } = scrapeActor(req);
  const cid = boardIdForLaunch({ sheetUrl, tabName, campaignName });
  const urls = (Array.isArray(searchUrls) ? searchUrls : [searchUrls]).filter(Boolean);
  if (result && result.error) {
    await logScrape(cid, `✗  Dispatch failed — ${urls.length} search(es) on ${profileId || 'no profile'}: ${result.error}`, { level: 'err', actor });
  } else {
    await logScrape(
      cid,
      `▶  Dispatched ${urls.length} search(es) · account ${profileId || '?'} · → tab "${tabName || 'Results'}"${slowMode ? ' · slow mode' : ''} by ${actor}`,
      { actor },
    );
    for (const u of urls) await logScrape(cid, `  → ${u}`, { actor });
    if (sheetUrl) await logScrape(cid, `  → sheet ${sheetUrl}`, { actor });
  }
  res.status(result && result.error ? 400 : 200).json(result);
});

// Read input Sales Nav search URLs from a pasted Google Sheet (app-side only —
// the extracted URLs are dispatched as the same `searchUrls`, so the engine is
// unchanged). Never throws; returns { urls, count } or { error }.
app.get('/api/scrape/extract-urls', async (req, res) => {
  const sheetUrl = (req.query.sheetUrl || '').toString().trim();
  if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
  try {
    // Row-aware read so the UI can offer a "scrape rows 2–10" picker. `items`
    // carries the 1-based sheet row number per URL; `urls` is the flat list
    // (back-compat / convenience).
    const rowsWithNumbers = await fetchSheetWithRows(sheetUrl);
    const items = extractSalesNavUrlsWithRows(rowsWithNumbers);
    res.json({ items, urls: items.map((i) => i.url), count: items.length });
  } catch (err) {
    res.status(400).json({ error: err && err.message ? err.message : 'could not read sheet' });
  }
});

// Pause/Resume/Stop are keyed by profileId on the engine, but the board's own
// toggle route was the only control path that logged anything — and the strip's
// buttons call THESE routes directly, so a stop (the most audit-worthy action on
// a shared board) left no trace at all. The client passes the strip's id so the
// line lands on the right campaign; without it the control still works, unlogged.
function scrapeControlRoute(path, run, verb, level) {
  app.post(path, async (req, res) => {
    const { profileId, campaignId } = req.body || {};
    const result = await run(profileId);
    const { actor, admin } = scrapeActor(req);
    const failed = result && result.error;
    await logScrape(
      campaignId,
      failed
        ? `✗  ${verb} failed on account ${profileId || '?'}: ${result.error}`
        : `${verb} — account ${profileId || '?'} by ${admin ? `${actor} (admin)` : actor}`,
      { level: failed ? 'err' : level, actor },
    );
    res.json(result);
  });
}
scrapeControlRoute('/api/scrape/pause', pauseScrape, '⏸  Paused', 'warn');
scrapeControlRoute('/api/scrape/resume', resumeScrape, '▶  Resumed', 'info');
scrapeControlRoute('/api/scrape/stop', stopScrape, '⏹  STOPPED', 'warn');

app.get('/api/scrape/jobs', async (_req, res) => {
  res.json(await getScrapeJobs());
});

app.get('/api/scrape/logs', async (req, res) => {
  res.json(await getScrapeLogs(req.query.since));
});

app.post('/api/scrape/campaigns', async (req, res) => {
  try {
    const { name, sheetUrl, tabName, profileIds, searchUrls } = req.body || {};
    const rec = await addScrapeCampaign({
      name: name || tabName || 'Sales Nav scrape',
      owner: req.user || null,
      sheetUrl, tabName,
      profileIds: Array.isArray(profileIds) ? profileIds : [],
      searchUrls: Array.isArray(searchUrls) ? searchUrls : [],
    });
    const { actor } = scrapeActor(req);
    await logScrape(rec.id, `✎  Scrape created — "${rec.name}" · ${(rec.searchUrls || []).length} search(es) · → tab "${rec.tabName || ''}" by ${actor}`, { actor });
    res.json({ ok: true, campaign: rec });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sales Nav board cache.
//
// Measured 2026-08-07, per request: the engine's GET /api/jobs takes 7.7-10s
// and returns 14.7MB (2,807 jobs). Grouping is 9ms and the override loop is
// 1ms — the engine round trip IS the latency, and it sat directly on the
// request path. Three separate client paths pay it: the 2.5s board poll,
// openScrapeSetupFor(), and rerunScrape(), the last two only to .find() a
// single record by id.
//
// So the board never painted on open, while the campaigns dashboard (which
// renders local files) is instant. Serve from memory and refresh behind the
// request instead: a stale board is enormously better than no board, and the
// 2.5s poll replaces it within one tick anyway.
const SCRAPE_BOARD_TTL = 15000; // refresh in the background past this age
let _scrapeBoard = null;        // { at, campaigns, me }
let _scrapeBoardInflight = null; // dedupes concurrent refreshes into one fetch

async function refreshScrapeBoard() {
  // SHARED board: group EVERY operator's engine jobs into strips (not just
  // this install's). Each job is tagged with its own userId + owner email,
  // so the board shows the whole team's scrapes.
  const jobsRes = await getAllScrapeJobsFast();
  if (jobsRes && jobsRes.error) throw new Error(jobsRes.error);
  const jobs = Array.isArray(jobsRes) ? jobsRes : (jobsRes && jobsRes.jobs) || [];
  const me = getOperatorEmail() || '';
  const campaigns = groupJobsIntoCampaigns(jobs, { currentEmail: me, currentOperatorId: getOperatorId() });
  // Apply any saved config overrides (operator edited + Saved a scrape's config)
  // so the board strip AND openScrapeSetupFor reflect the saved edits on re-open.
  for (const c of campaigns) {
    const ov = await getScrapeOverride(c.id);
    if (ov) {
      if (ov.searchUrls && ov.searchUrls.length) c.searchUrls = ov.searchUrls;
      if (ov.sheetUrl) c.sheetUrl = ov.sheetUrl;
      if (ov.tabName) c.tabName = ov.tabName;
      if (ov.name) c.name = ov.name;
      if (ov.profileIds && ov.profileIds.length) c.profileIds = ov.profileIds;
      c._edited = true;
    }
  }
  // Turn this poll into the log stream the scrape never had. Per-job state
  // transitions, lead progress and final totals are observable ONLY here, and
  // were being rendered and discarded. Best-effort: a log write must never take
  // down the board.
  try {
    const events = diffBoardEvents((_scrapeBoard && _scrapeBoard.campaigns) || [], campaigns);
    for (const ev of events) await logScrape(ev.campaignId, ev.message, { level: ev.level });
  } catch (e) { console.error('scrape board log diff failed:', e.message); }

  _scrapeBoard = { at: Date.now(), campaigns, me };
  return _scrapeBoard;
}

/** Refresh at most once at a time; callers share the in-flight promise. */
function refreshScrapeBoardOnce() {
  if (!_scrapeBoardInflight) {
    _scrapeBoardInflight = refreshScrapeBoard().finally(() => { _scrapeBoardInflight = null; });
  }
  return _scrapeBoardInflight;
}

/**
 * The board, served from memory. Only the very first call after boot can block;
 * everything after it returns immediately and refreshes behind the response.
 */
async function getScrapeBoard() {
  if (!_scrapeBoard) return refreshScrapeBoardOnce();
  if (Date.now() - _scrapeBoard.at > SCRAPE_BOARD_TTL) {
    // Stale — kick a refresh but DON'T await it. A failed background refresh
    // must not reject into a caller that already has good data to return.
    refreshScrapeBoardOnce().catch(() => { /* keep serving the last good board */ });
  }
  return _scrapeBoard;
}

app.get('/api/scrape/campaigns', async (_req, res) => {
  try {
    const board = await getScrapeBoard();
    // Slimmed: the full board is 20.4MB and this is polled every 2.5s. The
    // strips need a label and a count, not 2,247 full Sales Nav search URLs.
    // /api/scrape/campaigns/:id below still serves the complete record.
    res.json({ campaigns: slimBoard(board.campaigns), me: board.me, cachedAt: board.at });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// One scrape by board id. openScrapeSetupFor() and rerunScrape() used to pull
// the whole 22MB list and .find() in it; this hands them the single record.
app.get('/api/scrape/campaigns/:id', async (req, res) => {
  try {
    const board = await getScrapeBoard();
    const rec = (board.campaigns || []).find((c) => c.id === req.params.id) || null;
    res.json({ campaign: rec, me: board.me });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Save an edited config for a scrape strip (keyed by its board id) so the edits
// persist and win on re-open. Local-only; used by the wizard's Save button.
app.post('/api/scrape/campaigns/:id/config', async (req, res) => {
  try {
    const { searchUrls, sheetUrl, tabName, name, profileIds } = req.body || {};
    const before = (await getScrapeOverride(req.params.id)) || {};
    const saved = await saveScrapeOverride(req.params.id, { searchUrls, sheetUrl, tabName, name, profileIds });
    // A saved override silently changes what a RE-RUN will do. The campaign side
    // logs every live config edit; this one logged nothing, so a strip could
    // quietly start pointing at a different sheet or tab with no record of when.
    const { actor } = scrapeActor(req);
    const changed = [];
    const fmt = (v) => (Array.isArray(v) ? `${v.length} item(s)` : String(v ?? ''));
    for (const k of ['name', 'sheetUrl', 'tabName', 'searchUrls', 'profileIds']) {
      const a = before[k]; const b = saved && saved[k];
      if (b === undefined) continue;
      if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(`${k}: ${fmt(a) || '—'} → ${fmt(b)}`);
    }
    if (changed.length) {
      await logScrape(req.params.id, `✎  Config edited by ${actor} — ${changed.join(' · ')}`, { level: 'warn', actor });
    }
    res.json({ ok: true, config: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/scrape/campaigns/:id/config', async (req, res) => {
  res.json({ config: await getScrapeOverride(req.params.id) });
});

app.post('/api/scrape/campaigns/:id/toggle', async (req, res) => {
  try {
    const on = !!(req.body && req.body.on);
    // The board's strips are engine-derived (synthetic `eng_` ids), so the
    // profiles to drive come from the client (it has them from the live jobs).
    // Fall back to a local record if one exists (legacy / same-machine).
    let profileIds = Array.isArray(req.body && req.body.profileIds) ? req.body.profileIds.filter(Boolean) : null;
    if (!profileIds) {
      const rec = await getScrapeCampaign(req.params.id);
      profileIds = (rec && rec.profileIds) || [];
      if (rec) await updateScrapeCampaign(rec.id, { enabled: on });
    }
    if (!profileIds.length) return res.status(400).json({ error: 'no profiles to toggle' });
    const { actor, admin } = scrapeActor(req);
    for (const pid of profileIds) {
      try { on ? await resumeScrape(pid) : await pauseScrape(pid); }
      catch (e) {
        // Was console-only: a toggle could half-apply and the operator would see
        // a success response with no record of which account didn't move.
        console.error('toggle scrape profile failed:', pid, e.message);
        await logScrape(req.params.id, `✗  Toggle ${on ? 'ON' : 'OFF'} failed on account ${pid}: ${e.message}`, { level: 'err', actor });
      }
    }
    try { await appendAction(req.params.id, { actor, admin, action: `toggled ${on ? 'ON' : 'OFF'}` }); } catch { /* audit best-effort */ }
    res.json({ ok: true, enabled: on });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Engine run-history is fetched per runId, and an OPEN log pane re-polls every
// 2.5s — cache it so the pane doesn't hammer the engine with the same request.
const SCRAPE_HISTORY_TTL = 30000;
const _scrapeHistory = new Map(); // campaignId → { at, lines }

app.get('/api/scrape/campaigns/:id/logs', async (req, res) => {
  const rec = await getScrapeCampaign(req.params.id);
  // Read by the REQUESTED id as well as the local record's. Every app-written
  // line is keyed on the board id (an `eng_...` for engine-derived strips), but
  // this only ever read `rec.id` — which exists solely for local `sc_...`
  // records. Result: every audit line written so far was unreachable by the UI.
  const ids = [...new Set([req.params.id, rec && rec.id].filter(Boolean))];
  const persistedSets = await Promise.all(ids.map((id) => readScrapeLog(id, { limit: 300 })));
  const persisted = persistedSets.flat();

  // Which engine job ids belong to THIS scrape. The engine stamps every live log
  // line with its jobId, and a campaign's own jobs carry that same id (jobs[].id
  // === jobs[].runId), so this is the only identity that actually scopes a line
  // to a campaign.
  //
  // It replaces `String(ln.tabName || '').startsWith(tabName)`, which was wrong
  // twice over. `tabName` here is the campaign's BASE tab, and 83 live campaigns
  // share the tab "Results" — so every "Results *" scrape rendered every other
  // one's events, including 18 failed "Results 1111 N" runs whose "account is
  // logged out" lines then appeared under scrapes that were collecting fine.
  // "A" likewise swallowed "A.". And when tabName came back empty — which it
  // does for every engine-derived strip, since those have no local record —
  // `!tabName` short-circuited the filter into a no-op and returned the ENTIRE
  // global engine buffer.
  const _board = await getScrapeBoard().catch(() => null);
  const _rec = _board && (_board.campaigns || []).find((c) => c.id === req.params.id);
  const jobIds = jobIdsForCampaign(_rec);

  let live = [];
  let engineDown = '';
  try {
    const l = await getScrapeLogs(req.query.since);
    if (l && l.error) throw new Error(l.error);
    const lines = Array.isArray(l) ? l : (l && l.logs) || [];
    live = scopeLiveLines(lines, jobIds);
  } catch (e) {
    // Was swallowed: an unreachable engine rendered as an empty log box, which
    // reads identically to "this scrape did nothing".
    engineDown = e && e.message ? e.message : 'engine unreachable';
  }
  // The two sources above only cover a scrape that is still running on this
  // machine: `persisted` needs a LOCAL record (engine-derived strips have none),
  // and `live` is the engine's global LIVE buffer, which drops a scrape's lines
  // once it finishes — which is why a done strip's log went blank.
  //
  // The engine does persist per-run history; nothing was ever asking for it.
  // Fall back to it when the live sources came up empty.
  //
  // Fetch history whenever the LIVE buffer is empty — not, as before, only when
  // persisted was empty too. Now that the app writes its own lines, keying off
  // `persisted` would have permanently suppressed the engine's side of the story
  // for every scrape that has an audit line.
  let history = [];
  if (!live.length) {
    const cached = _scrapeHistory.get(req.params.id);
    if (cached && Date.now() - cached.at < SCRAPE_HISTORY_TTL) {
      history = cached.lines;
    } else {
      try {
        const runIds = [...new Set((_rec && _rec.jobs || []).map((j) => j && j.runId).filter(Boolean))];
        const sets = await Promise.all(runIds.map((rid) => getScrapeRunLogs(rid).catch(() => null)));
        history = sets.flatMap((s) => (s && Array.isArray(s.logs) ? s.logs : []))
          .map((ln) => ({ ts: ln.ts, message: ln.message, jobId: ln.jobId, tabName: ln.tabName }));
        _scrapeHistory.set(req.params.id, { at: Date.now(), lines: history });
      } catch { /* no history — the empty-state message below still shows */ }
    }
  }
  const merged = [...persisted, ...live, ...history].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (engineDown) {
    merged.push({ ts: Date.now(), level: 'err', message: `⚠️  Can't reach the scraper engine (${engineDown}) — this log may be incomplete. A running scrape is not affected.` });
  }
  res.json({ lines: merged });
});

// Per-job live View — proxies the engine's MJPEG screencast stream
// (multipart/x-mixed-replace) straight through to the dashboard's <img>, which
// renders it as live video. Long-lived stream: we pipe frames as they arrive
// and abort the upstream when the viewer disconnects. 404 when not running.
app.get('/api/scrape/view/:jobId', async (req, res) => {
  const stream = await openScrapeJobViewStream(req.params.jobId);
  if (!stream.ok) return res.status(stream.status || 502).json({ error: stream.error });

  res.writeHead(200, {
    'Content-Type': stream.contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'X-Accel-Buffering': 'no',
  });

  const nodeStream = Readable.fromWeb(stream.body);
  const cleanup = () => {
    try { stream.abort(); } catch { /* */ }
    try { nodeStream.destroy(); } catch { /* */ }
  };
  req.on('close', cleanup);
  nodeStream.on('error', () => { try { res.end(); } catch { /* */ } });
  nodeStream.pipe(res);
});

// v2.14.x: Restore — "panic button" recovery endpoint. Force-kills
// browsers, force-resets in-memory campaign state (even if the in-flight
// loop is hung), and re-launches with the most recent settings. Settings
// source priority: live snapshot (_lastRunSettings) → last history.json
// entry → none (idle no-op with cleanup only). Always returns 200 with
// { ok, restartedFrom, reason? } — the loop runs async after the response.
app.post('/api/campaign/restore', async (_req, res) => {
  try {
    // Restore re-launches with the last settings — gate it like a fresh start.
    if (rejectIfNoOperatorEmail(res)) return;
    const result = await restoreCampaign();
    res.json(result);
  } catch (err) {
    console.error('[restore] failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// v2.111: follow-up batch summary for the live-campaign countdown. Reads the
// queue at most once per 5s so the 2s status poll stays off the synchronous
// hot path (see campaign.js getCampaignStatus perf note).
let _fuCache = { at: 0, tasks: [] };
async function _activeFollowUpSummary(base) {
  const ids = (base.profileIds && base.profileIds.length) ? base.profileIds : (base.participatingProfileIds || []);
  if (!ids.length) return null;
  const now = Date.now();
  if (now - _fuCache.at > 5000) _fuCache = { at: now, tasks: await loadPrimaryTasks() };
  return summarizeFollowUps(_fuCache.tasks, ids);
}

app.get('/api/campaign/status', async (_req, res) => {
  const base = getCampaignStatus();
  // v2.12.x: when Post Amplification is running, surface its state through
  // the same payload the Live Status panel already polls. Logs are already
  // mirrored into campaign.logs by pushPostAmpLog, so the log rail shows
  // them either way; this overlay just makes the headline tiles render.
  if (postAmp.running) {
    return res.json({
      ...base,
      running: true,
      mode: 'post_amplification',
      name: 'Post Amplification',
      currentProfile: postAmp.currentProfile || '',
      currentAction: {
        label: postAmp.currentProfile
          ? `Engaging ${postAmp.currentIndex}/${postAmp.total} · ${postAmp.currentProfile}`
          : 'Starting…',
        account: postAmp.currentProfile || '—',
        lead: postAmp.postUrl ? '(amplifying post)' : '—',
        mode: 'post_amplification',
        startedAt: postAmp.startedAt || Date.now(),
      },
      processedToday: postAmp.engaged,
      totalProcessed: postAmp.completed,
      totalTargets: postAmp.total,
      profileNames: [],
      errors: postAmp.errors.slice(-20).map(e => ({ message: e })),
      skippedCount: getSkips().length,
    });
  }
  let followUp = null;
  try { followUp = await _activeFollowUpSummary(base); } catch { /* non-fatal — countdown just hides */ }
  const stopState = _campaignStopWatchdog.status();
  res.json({ ...base, followUp, skippedCount: getSkips().length,
    stopRequestedAt: campaign.running && campaign._abort ? stopState.requestedAt : null,
    stopDeadlineAt: campaign.running && campaign._abort ? stopState.deadlineAt : null });
});

app.get('/api/campaign/skips', (_req, res) => {
  res.json({ skips: getSkips() });
});

// v2.83: live settings snapshot for the dashboard "Open" button. Returns the
// running/last campaign's full config (templates incl. primary contact,
// concurrency, delays, linkedinColumn, senderFirstNames) so the wizard can be
// pre-filled exactly like the past "Edit & resume" flow. { ok:false } when no
// campaign has run this process lifetime (nothing to open).
app.get('/api/campaign/active-settings', (_req, res) => {
  try {
    const settings = getLastRunSettings();
    if (!settings) return res.json({ ok: false, settings: null });
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Sheet-write failure ledger ────────────────────────────────────────────────

app.get('/api/campaign/sheet-write-failures', (_req, res) => {
  res.json({ failures: getFailures() });
});

app.post('/api/campaign/sheet-write-failures/retry', async (_req, res) => {
  try {
    const { updateSheetRow } = await import('./src/sheets-writer.js');
    const result = await retryFailures(async (failure) => {
      let payload;
      try {
        payload = JSON.parse(failure.payload);
      } catch {
        return { error: 'payload unrecoverable — cannot retry' };
      }
      const ok = await updateSheetRow(campaign.sheetUrl, failure.url, payload, failure.column || undefined);
      if (!ok) return { error: 'sheet write failed' };
      return {};
    });
    campaign.sheetWriteFailures = getFailures().length;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename the active campaign. No-op if nothing is running — front-end disables
// the editable affordance in that case. Empty string clears the name.
app.post('/api/campaign/name', (req, res) => {
  try {
    const { name } = req.body || {};
    const updated = setCampaignName(typeof name === 'string' ? name : '');
    res.json({ ok: true, name: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Draft campaign name — persisted between sessions so the operator can stage a
// name from the wizard without launching a campaign. Dashboard surfaces it as
// a "Draft" row when nothing is running.
const DRAFT_NAME_FILE = dataPath('draft-name.json');

async function readDraftName() {
  try {
    const raw = await readFile(DRAFT_NAME_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.name === 'string' ? parsed.name : '';
  } catch { return ''; }
}

async function writeDraftName(name) {
  await mkdir(dirname(DRAFT_NAME_FILE), { recursive: true });
  const tmp = `${DRAFT_NAME_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ name, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, DRAFT_NAME_FILE);
}

app.get('/api/draft-name', async (_req, res) => {
  res.json({ name: await readDraftName() });
});

app.post('/api/draft-name', async (req, res) => {
  try {
    const name = (typeof req.body?.name === 'string' ? req.body.name : '').trim();
    // v2.59 name uniqueness: collision with running campaign is blocked
    // here too so the legacy single-draft path can't sneak around the
    // /api/drafts guard.
    const collision = _draftNameCollision(name);
    if (collision) return res.status(collision.status).json(collision.body);
    await writeDraftName(name);
    res.json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active post-campaign acceptance-tracking windows. Used by the dashboard
// (future) to show the operator which sheets are still being swept and when
// they expire.
app.get('/api/post-campaign-tracking', async (_req, res) => {
  try {
    const list = await listPostCampaignSchedule();
    res.json({ windows: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.72: Replies panel — inbound replies found by the hourly reply-check (and
// the manual Check DMs flow), newest first, plus the active reply-tracking
// windows. The dashboard polls this to show who replied + the message text.
app.get('/api/replies', async (req, res) => {
  try {
    const [replies, unseen, windows] = await Promise.all([
      listReplies({ limit: 100 }),
      unseenReplyCount(),
      listReplyCheckSchedule(),
    ]);
    // Replies inbox: attach the heuristic auto-label (pure, offline) to every
    // reply at read time. A manual correction (r.label) always wins and is
    // reported at high confidence.
    const { classifyReply } = await import('./src/reply-classify.js');
    const { replyKey } = await import('./src/replies-log.js');
    const decorated = replies.map((r) => {
      const auto = classifyReply(r.text);
      return {
        ...r,
        key: replyKey(r),
        label: r.label || auto.label,
        labelConfidence: r.label ? 'high' : auto.confidence,
        labelSource: r.label ? 'manual' : 'auto',
      };
    });
    // Tell the UI whether the "Suggest reply" action can work right now.
    const prefs = await getNotificationPrefs(req.user);
    const aiOptIn = !!prefs.aiReplySuggestions;
    const aiKeyPresent = !!process.env.ANTHROPIC_API_KEY;
    res.json({ replies: decorated, unseen, windows, ai: { optIn: aiOptIn, keyPresent: aiKeyPresent } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Replies inbox: manual label correction. Body: { key, label }.
app.post('/api/replies/label', async (req, res) => {
  try {
    const { key, label } = req.body || {};
    const { isValidLabel } = await import('./src/reply-classify.js');
    if (!key) return res.status(400).json({ error: 'key required' });
    if (!isValidLabel(label)) return res.status(400).json({ error: `Invalid label: ${label}` });
    const { setReplyLabel } = await import('./src/replies-log.js');
    const ok = await setReplyLabel(String(key), label);
    if (!ok) return res.status(404).json({ error: 'Reply not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Replies inbox: AI-suggested reply draft (opt-in, OFF by default). The draft
// is returned to the UI for the operator to COPY manually — there is no code
// path from here to any LinkedIn send function, by design. Gated on the
// per-operator aiReplySuggestions pref AND ANTHROPIC_API_KEY being set.
app.post('/api/replies/suggest', async (req, res) => {
  try {
    const prefs = await getNotificationPrefs(req.user);
    if (!prefs.aiReplySuggestions) {
      return res.status(400).json({ error: 'AI reply suggestions are off. Turn on the toggle in the Replies inbox header first.' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set in your .env — add it and restart the app to use AI suggestions.' });
    }
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    const { readRepliesLog } = await import('./src/replies-log.js');
    const { replyKey } = await import('./src/replies-log.js');
    const log = await readRepliesLog();
    const reply = log.find((r) => replyKey(r) === String(key));
    if (!reply) return res.status(404).json({ error: 'Reply not found' });
    const { suggestReply } = await import('./src/reply-suggest.js');
    const suggestion = await suggestReply(reply, { apiKey: process.env.ANTHROPIC_API_KEY });
    res.json({ ok: true, suggestion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark all recorded replies as acknowledged (clears the panel's unseen badge).
app.post('/api/replies/seen', async (_req, res) => {
  try {
    await markRepliesSeen();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.98 — resolve the swept-account NAMES (lowercased, for matching the sheet's
// Sender column) for a solo-check request. Returns null for "all senders".
// Mirrors the account resolution inside /api/bulk-check-now.
async function _resolveSweptAccountNames({ profileId, profileIds, allSenders }, token) {
  if (allSenders) return null;
  let ids = [];
  if (Array.isArray(profileIds) && profileIds.length) {
    ids = profileIds.filter((p) => typeof p === 'string' && p.length);
  } else if (profileId) {
    ids = [profileId];
  }
  if (!ids.length) return null;
  let nameById = new Map();
  try {
    const all = await getProfiles(token);
    nameById = new Map(all.map((p) => [p.id, String(p.name || '').toLowerCase()]));
  } catch { /* fall back to no names → treat as all */ }
  const names = new Set();
  for (const id of ids) { const n = nameById.get(id); if (n) names.add(n); }
  return names.size ? names : null;
}

// v2.98 — find rows stamped with the terminal "Failed — Primary not in your
// connections" intro failure, scoped to a set of sender names (null = all
// senders). Returns [{ linkedinUrl, sender }].
async function _findReconnectableIntroFailures(sheetUrl, linkedinColumn, accountNamesLower) {
  const rows = await fetchSheet(sheetUrl);
  const out = [];
  for (const row of rows) {
    const intro = (row['Introduction Status'] || row['introduction status'] || '').toString().trim();
    if (intro !== INTRO_FAILED_PRIMARY_NOT_CONNECTED) continue;
    const sender = (row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').toString().trim();
    if (accountNamesLower && !accountNamesLower.has(sender.toLowerCase())) continue;
    const url = extractLinkedInUrl(row, linkedinColumn);
    if (!url) continue;
    out.push({ linkedinUrl: url, sender });
  }
  return out;
}

// v2.98 — pre-scan for the "reconnect & retry" confirm. The solo-check UI calls
// this before sweeping; if count > 0 it shows a confirm naming the primary, then
// re-POSTs /api/bulk-check-now with reviveFailedIntros:true.
app.post('/api/intro-failures/preview', async (req, res) => {
  try {
    let { sheetUrl, linkedinColumn, profileId, profileIds, allSenders,
          primaryName, primarySource, autoAcceptPrimary } = req.body || {};
    if (!sheetUrl && campaign.running && campaign.sheetUrl) {
      sheetUrl = campaign.sheetUrl;
      linkedinColumn = linkedinColumn || campaign.linkedinColumn || '';
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });
    const token = process.env.GOLOGIN_API_TOKEN;
    const names = await _resolveSweptAccountNames({ profileId, profileIds, allSenders }, token);
    const failures = await _findReconnectableIntroFailures(sheetUrl, linkedinColumn || '', names);
    const accounts = [...new Set(failures.map((f) => f.sender).filter(Boolean))];
    const effPrimary = (primaryName && String(primaryName).trim())
      || (campaign.templates && campaign.templates.primaryName) || '';

    // v2.98.1: resolve HOW the auto-accept will run so the confirm can spell it
    // out. Effective values fall back to the live campaign's templates when the
    // request didn't carry them (active-campaign solo check).
    const effSource = (primarySource !== undefined && primarySource !== null && primarySource !== '')
      ? primarySource
      : ((campaign.templates && campaign.templates.primarySource) || '');
    const effAutoAccept = (autoAcceptPrimary !== undefined)
      ? !!autoAcceptPrimary
      : !!(campaign.templates && campaign.templates.autoAcceptPrimary);
    let acceptVia = 'local';     // 'gologin' | 'local'
    let acceptViaName = '';
    if (effSource && effSource !== 'local-browser') {
      acceptVia = 'gologin';
      try {
        const all = await getProfiles(token);
        const p = all.find((x) => x.id === effSource);
        acceptViaName = (p && p.name) || effSource;
      } catch { acceptViaName = effSource; }
    }
    res.json({
      ok: true, count: failures.length, accounts, primaryName: effPrimary,
      autoAccept: effAutoAccept, acceptVia, acceptViaName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual bulk-check trigger. Bypasses the per-account cadence cooldown so the
// operator can on-demand sweep their sheet for newly-accepted invites.
//
// v2.71: works mid-campaign. If a campaign is running and not already
// paused, this endpoint pauses it, waits for the worker(s) to reach a
// lead boundary (so browsers go idle), runs the sweep + auto-intros, then
// resumes the campaign. Pause already triggered by the operator is left
// in place after the sweep (we only auto-resume what we auto-paused).
app.post('/api/bulk-check-now', async (req, res) => {
  // v2.78: refuse overlapping sweeps. A second click used to launch a parallel
  // 53-account sweep that fought the first for GoLogin browsers (see the
  // duplicate "sweeping 53 account(s)" lines in the field log).
  if (_manualSweepRunning) {
    return res.status(409).json({ error: 'A bulk check is already running. Wait for it to finish, or press Stop.' });
  }
  _manualSweepRunning = true;
  _manualSweepAbort = false;
  // A Stop pressed while nothing was running leaves campaign._abort armed
  // (stopCampaign flips it unconditionally and only a campaign start clears
  // it). The sweep loop below reads that flag, so the next manual check used to
  // log "Stop detected" and finish with 0 accounts swept before opening a
  // single browser (Sam, 2026-09-23 20:32). A stale abort with no campaign or
  // monitoring to abort belongs to nobody: clear it here so the check can run.
  if (!campaign.running && campaign.state !== 'monitoring') campaign._abort = false;
  // Say "checking" the INSTANT the click is accepted, not 180 lines later.
  // The flag used to be set down at the sweep loop, after account resolution and
  // a sheet read over the network, so the operator pressed the button and the
  // card sat on "Waiting for next check" for seconds while browsers were already
  // being opened. The sweep genuinely starts here: this is the truthful moment.
  // Cleared in the outer finally below, so a throw during setup cannot leak it.
  setBulkCheckInProgress(true);
  // v2.71: pause-if-running coordination. Captured before mutating campaign
  // state so the finally block knows whether to resume.
  const _weShouldAutoResume = campaign.running && !campaign._paused && !campaign._pauseRequested;
  try {
    let { sheetUrl, linkedinColumn, profileId, profileIds,
          primaryName, primaryIntroBody, primaryUrl, introTitle,
          autoAcceptPrimary, primarySource, allSenders, reviveFailedIntros,
          // Cloud-campaign local check (v2.160.87): the request carries the CLOUD
          // campaign's mode/templates, since the local `campaign` singleton may
          // hold a stale/unrelated local config. Fall back to current behaviour.
          mode: reqMode, ccDmBody: reqCcDmBody, senderFirstNames: reqSenderFirstNames,
          skipIntroductions: reqSkipIntros } = req.body || {};
    // "Connections only": the wizard says so explicitly; a check that carries no
    // answer (older clients, the running campaign's own card) follows the campaign.
    const skipIntros = reqSkipIntros === true || (reqSkipIntros == null && !!campaign.skipIntroductions);
    // v2.78: "all senders in the sheet" — ignore any campaign/explicit accounts
    // and derive every account from the sheet's Sender column (below), even
    // while a campaign is running.
    if (allSenders) {
      profileIds = undefined;
      profileId = undefined;
    } else if (campaign.running && !(Array.isArray(profileIds) && profileIds.length > 0) && !profileId) {
      // v2.71: if running, default to the campaign's own selected profiles so
      // the sweep covers every account, not just the one the operator was
      // looking at. Operator-provided profileIds in req.body still wins.
      profileIds = Array.isArray(campaign.profileIds) ? campaign.profileIds.slice() : [];
    }
    // v2.71: fall back to the campaign's sheetUrl too — the live "Run check
    // now" button doesn't always re-post the sheet URL with the click.
    if (!sheetUrl && campaign.running && campaign.sheetUrl) {
      sheetUrl = campaign.sheetUrl;
      linkedinColumn = linkedinColumn || campaign.linkedinColumn || '';
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    // A check stamps "Still Pending (…)" and "Connected" into Connection
    // Accepted Status. That column is provisioned when a campaign STARTS, so a
    // check on a tab whose campaign was never started had nowhere to write, and
    // the Apps Script reports success for a field whose column is missing
    // (Sam, 2026-09-23 21:46, "Test" tab: 3 rows "refreshed", nothing on the
    // sheet). Provision it here the same non-lossy way Start does. Sheets that
    // already have the column are left alone.
    try {
      const probe = await fetchSheet(sheetUrl).catch(() => []);
      const headers = probe.length ? Object.keys(probe[0]) : [];
      const hasAccepted = headers.some((h) => /^(connection accepted status|connected status)$/i.test(String(h || '').trim()));
      if (!hasAccepted) {
        const { prepareSheet } = await import('./src/sheets-writer.js');
        // connect_only's column set has no accepted-status column, so a check on
        // that mode borrows the check_status set, which is exactly that column.
        const prepMode = ['connect_and_introduce', 'connect_and_message'].includes(reqMode) ? reqMode : 'check_status';
        const prep = await prepareSheet(sheetUrl, prepMode);
        campaignLog(prep.ok
          ? `🧱 This tab had no tracking columns yet — added ${(prep.added || []).join(', ') || 'them'} so the check has somewhere to write.`
          : '⚠ Could not add tracking columns to this tab — the check will run, but its results may not reach the sheet.');
      }
    } catch (e) {
      campaignLog(`⚠ Tracking-column check failed: ${e.message}`);
    }

    // v2.97: take precedence over a running campaign. Instead of waiting up to
    // 90s for a cooperative pause boundary (and failing if a slow lead — e.g. a
    // ~50s intro attempt — blew past it), we PREEMPT the in-flight lead so the
    // pause lands within ~1s. The preempted lead is left unstamped and is
    // re-attempted when the campaign resumes after the sweep.
    if (_weShouldAutoResume) {
      campaignLog('⏸ Manual bulk check — pausing campaign (taking precedence over the current lead)…');
      pauseCampaign();
      const preempted = preemptCurrentLead();
      campaignLog(preempted
        ? '⏭ Current lead preempted — it will be retried on resume.'
        : 'ℹ No lead in flight — pausing at the next boundary.');
      // Short wait for the pause to acknowledge. With preempt this is ~1s; allow
      // generous margin for a lead mid-cleanup, but never the old 90s hang.
      const deadline = Date.now() + 30_000;
      while (!campaign._paused && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!campaign._paused) {
        campaignLog('⚠ Manual bulk check — pause did not acknowledge in 30s; sweeping anyway (browsers may contend briefly).');
      } else {
        campaignLog('✓ Campaign paused — starting sweep.');
      }
    }

    const token = process.env.GOLOGIN_API_TOKEN;
    const { bulkCheckConnections } = await import('./src/linkedin/bulk-check-connections.js');
    const { runAutoIntros } = await import('./src/linkedin/auto-intro.js');
    const { runAutoDms } = await import('./src/linkedin/auto-dm.js');
    const { closeProfile: _closeProfile } = await import('./src/gologin-launcher.js');

    // Build the list of profiles to sweep. Explicit selection wins (in
    // priority order: profileIds array > legacy profileId scalar). Fallback
    // is to derive unique account emails from the sheet's Account Used
    // column, then map to profile IDs via the GoLogin profile cache.
    let profileIdsToSweep = [];
    let derivedFromSheet = false;
    if (Array.isArray(profileIds) && profileIds.length > 0) {
      profileIdsToSweep = profileIds.filter((p) => typeof p === 'string' && p.length);
    } else if (profileId) {
      profileIdsToSweep = [profileId];
    } else {
      try {
        const rows = await fetchSheet(sheetUrl);
        const accountEmails = new Set();
        for (const row of rows) {
          // v2.78: prefer the canonical Sender column (the "all senders in the
          // sheet" solo check), falling back to Account Used for older sheets.
          const v = (row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').toString().trim();
          if (v && v.includes('@')) accountEmails.add(v.toLowerCase());
        }
        if (accountEmails.size === 0) {
          return res.status(400).json({ error: 'No accounts selected and no Account Used values found on the sheet to derive from.' });
        }
        const allProfiles = await getProfiles(token);
        const byName = new Map(allProfiles.map((p) => [String(p.name || '').toLowerCase(), p.id]));
        for (const email of accountEmails) {
          const pid = byName.get(email);
          if (pid) profileIdsToSweep.push(pid);
        }
        derivedFromSheet = true;
        if (profileIdsToSweep.length === 0) {
          return res.status(400).json({ error: `Found ${accountEmails.size} account email(s) on the sheet but none matched a GoLogin profile.` });
        }
      } catch (err) {
        return res.status(500).json({ error: `Could not derive accounts from sheet: ${err.message}` });
      }
    }

    // Resolve profile IDs → human names (the email, for Ortus accounts) so
    // the sidecar tab's Account column reads "rashank.khrera@ortus.solutions"
    // instead of an opaque GoLogin profile id. The campaign loop already
    // passes pName; the manual button used to skip this lookup.
    let nameByProfileId = new Map();
    try {
      const allProfiles = await getProfiles(token);
      nameByProfileId = new Map(allProfiles.map((p) => [p.id, p.name || p.id]));
    } catch { /* fall back to id-as-name if cache fetch fails */ }

    // Filter out accounts the most-recent campaign parked — but ONLY the ones
    // that genuinely cannot be driven. parkedProfiles is in-memory (not
    // persisted across restarts) so this catches the current/last-run
    // accounts, which is the case this guard was written for: ran a campaign,
    // an account got parked for session-expired, then Bulk Check tried that
    // dead account anyway.
    //
    // A park is not one thing, though, and this used to treat it as one. A
    // weekly invitation cap says nothing about whether the browser works: the
    // session is fine, the account can still read its connections and still
    // send messages — it just cannot send more INVITES. Skipping it here cost
    // the operator both halves of this endpoint, because it does the
    // acceptance sweep AND fires runAutoIntros. Five capped accounts sat out
    // their own introductions for a limit that has nothing to do with either
    // (operator, 2026-09-04). Same for a throttle or a skip streak: they are
    // sending problems, and a sweep is not sending.
    //
    // So the test is "can this browser be driven at all", not "was it parked".
    const CANNOT_BE_DRIVEN = /session.?expired|challenge|checkpoint|proxy|407|cannot.?open|identity.?restricted/i;
    const parkedSet = new Set((campaign.parkedProfiles || [])
      .filter((p) => CANNOT_BE_DRIVEN.test(String(p.reason || '')))
      .map((p) => p.profileId));
    const skippedParked = [];
    profileIdsToSweep = profileIdsToSweep.filter((pid) => {
      if (parkedSet.has(pid)) {
        const reason = (campaign.parkedProfiles.find((p) => p.profileId === pid) || {}).reason || 'parked';
        const pName = nameByProfileId.get(pid) || pid;
        skippedParked.push({ profileId: pid, profileName: pName, reason });
        campaignLog(`⏭ Skipping ${pName} — parked from last campaign (${reason}).`);
        return false;
      }
      return true;
    });
    if (profileIdsToSweep.length === 0) {
      return res.json({
        ok: true,
        derivedFromSheet,
        profilesSweep: 0,
        skippedParked,
        result: { matched: 0, stamped: 0, fetched: 0 },
        perProfile: [],
      });
    }

    // v2.98 — "reconnect & retry" revive (operator confirmed in the UI). For
    // each swept account, overwrite its terminal "Failed — Primary not in your
    // connections" rows with the non-terminal retry sentinel and remember their
    // URLs. Folding those URLs into connectedUrls below makes runAutoIntros'
    // connect-to-primary gate fire this run (send the connect + queue the
    // auto-accept); the sentinel makes future checks keep retrying until the
    // intro lands. We can't clear the cell to blank — the shared Apps Script
    // skips empty-string writes — so the sentinel doubles as the visible status.
    const reviveByAccount = new Map(); // pName.toLowerCase() -> Set(urls)
    if (reviveFailedIntros) {
      try {
        const sweptNames = new Set(
          profileIdsToSweep.map((pid) => (nameByProfileId.get(pid) || '').toLowerCase()).filter(Boolean)
        );
        const failures = await _findReconnectableIntroFailures(
          sheetUrl, linkedinColumn || '', sweptNames.size ? sweptNames : null
        );
        const { updateSheetRow } = await import('./src/sheets-writer.js');
        for (const f of failures) {
          const key = (f.sender || '').toLowerCase();
          if (!reviveByAccount.has(key)) reviveByAccount.set(key, new Set());
          reviveByAccount.get(key).add(f.linkedinUrl);
          try {
            await updateSheetRow(sheetUrl, f.linkedinUrl, { introductionStatus: INTRO_RETRY_RECONNECT }, linkedinColumn || '');
          } catch (e) {
            campaignLog(`⚠ Reconnect & retry — could not mark ${f.linkedinUrl}: ${e.message}`);
          }
        }
        if (failures.length) {
          campaignLog(`↻ Reconnect & retry — re-queued ${failures.length} failed intro(s) across ${reviveByAccount.size} account(s); they will reconnect to the primary and retry.`);
        }
      } catch (e) {
        campaignLog(`⚠ Reconnect & retry preflight failed: ${e.message}`);
      }
    }

    // Sweep each profile sequentially. Sequential because GoLogin browsers
    // are RAM-heavy and parallel launches can OOM the laptop on weak hosts.
    const perProfile = [];
    let totalMatched = 0;
    let totalStamped = 0;
    let totalFetched = 0;
    campaignLog(`📡 Manual bulk Connection Status check — sweeping ${profileIdsToSweep.length} account(s)…`);
    // v2.59.15: report "a check is running" so the monitoring dashboard hero
    // flips to the gold pulsing "CHECKING / now" during a manual sweep (it
    // previously only fired for the scheduled auto-check). try/finally so the
    // flag always clears — a stuck flag would block scheduled ticks forever.
    setBulkCheckInProgress(true);
    try {
    for (const pid of profileIdsToSweep) {
      // v2.78: stop the sweep the instant the operator hits Stop, instead of
      // grinding through every remaining account.
      if (_manualSweepAbort || campaign._abort || campaign._abortCheck) {
        campaignLog('■ Stop detected — halting bulk check sweep.');
        break;
      }
      const pName = nameByProfileId.get(pid) || pid;
      const wasAlreadyRunning = !!getProfilePid(pid);
      campaignLog(`📡 [${pName}] Launching browser…`);
      let launched;
      try {
        launched = await launchProfile(pid, token);
      } catch (err) {
        const msg = `Launch failed: ${err.message}`;
        campaignLog(`⚠ [${pName}] ${msg}`);
        perProfile.push({ profileId: pid, profileName: pName, error: msg });
        continue;
      }
      // v2.78: register the in-flight check so Stop (stopCampaign /
      // _forceCloseActiveBulkChecks) force-closes this browser and interrupts
      // a sweep already mid-flight.
      addActiveBulkCheck(pid);
      let r;
      try {
        campaignLog(`📡 [${pName}] Sweeping recent connections…`);
        r = await bulkCheckConnections(launched.page, sheetUrl, linkedinColumn || '', pName);
        // v2.14.x: Match the cockpit's "Check now" button — after bulk-check,
        // also fire auto-intros for any newly-accepted leads. Build the
        // templates object from req.body fields first (wizard direct call),
        // then fall back to campaign.templates (live-panel "Bulk Check" button
        // which has no DOM fields for primary person). Without this fallback,
        // the button only stamped Connection Accepted but never sent the intro
        // DM, leaving operators wondering why Bulk Check produced no IC messages.
        // Note: runAutoIntros reads templates.primaryName / templates.primaryIntroBody
        // (not top-level params), so we must pass a templates object.
        const _reqTemplates = {
          primaryName:      String(primaryName      || '').trim(),
          primaryIntroBody: String(primaryIntroBody || '').trim(),
          primaryUrl:       String(primaryUrl       || '').trim(),
          introTitle:       introTitle || '',
          // v2.97: carry the auto-accept config so the v2.96 connect-to-primary
          // self-heal can fire from the solo check too (fall back to the live
          // campaign's templates when the request didn't include them).
          autoAcceptPrimary: (autoAcceptPrimary !== undefined)
            ? autoAcceptPrimary
            : (campaign.templates && campaign.templates.autoAcceptPrimary),
          primarySource: (primarySource !== undefined)
            ? primarySource
            : (campaign.templates && campaign.templates.primarySource),
        };
        const _effectiveTemplates = (_reqTemplates.primaryName && _reqTemplates.primaryIntroBody)
          ? _reqTemplates
          : (campaign.templates || {});
        // v2.59.2: phase-2 routing MUST respect the campaign mode. Previously
        // this block fired runAutoIntros for ANY campaign whose templates
        // happened to carry primaryName + primaryIntroBody — so a CC+DM run
        // whose campaign.templates still held leftover primary fields (from a
        // prior CC+IC config) sent a 3-way INTRO instead of a plain DM. Repro
        // in dev-app.log 2026-05-29T12:47:19 ("Auto-introducing … to Antonio
        // Varlese" during a connect_and_message campaign). Gate by mode:
        // CC+DM → runAutoDms (plain DM only, never an IC), everything else →
        // the existing intro path.
        // v2.98: fold this account's revived failed-intro URLs into the set so
        // the connect-to-primary gate runs even when nobody newly accepted.
        // CSV-export lag means bulkCheckConnections may not have re-picked the
        // just-written sentinel rows yet; this guarantees they're processed now.
        const _revive = reviveByAccount.get((pName || '').toLowerCase());
        if (_revive && _revive.size) {
          if (!Array.isArray(r.connectedUrls)) r.connectedUrls = [];
          const _seen = new Set(r.connectedUrls);
          for (const u of _revive) if (!_seen.has(u)) r.connectedUrls.push(u);
        }
        const _phaseMode = reqMode || campaign.mode || '';
        if (!r.error && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
          if (_phaseMode === 'connect_and_message') {
            const _ccDmBody = ((reqCcDmBody !== undefined ? reqCcDmBody : (campaign.templates && campaign.templates.ccDmBody)) || '').trim();
            if (_ccDmBody) {
              try {
                await runAutoDms({
                  page: launched.page,
                  profileId: pid,
                  profileName: pName,
                  sheetUrl,
                  linkedinColumn: linkedinColumn || '',
                  connectedUrls: r.connectedUrls,
                  templates: campaign.templates || {},
                  senderFirstNames: reqSenderFirstNames || campaign.senderFirstNames || {},
                  log: campaignLog,
                });
              } catch (dmErr) {
                campaignLog(`⚠ [${pName}] Auto-DM pass threw: ${dmErr.message}`);
              }
            } else {
              campaignLog(`⚠ [${pName}] CC+DM bulk-check: post-acceptance DM body missing — no DM sent.`);
            }
          } else if (skipIntros && Array.isArray(r.connectedUrls) && r.connectedUrls.length > 0) {
            campaignLog(`ℹ [${pName}] Connections only — ${r.connectedUrls.length} accepted connection(s) stamped, no introduction sent.`);
          } else if (_effectiveTemplates.primaryName && _effectiveTemplates.primaryIntroBody) {
            try {
              await runAutoIntros({
                page: launched.page,
                profileId: pid,
                profileName: pName,
                sheetUrl,
                linkedinColumn: linkedinColumn || '',
                connectedUrls: r.connectedUrls,
                templates: _effectiveTemplates,
                senderFirstNames: reqSenderFirstNames || campaign.senderFirstNames || {},
                log: campaignLog,
              });
            } catch (introErr) {
              campaignLog(`⚠ [${pName}] Auto-intro pass threw: ${introErr.message}`);
            }
          }
        }
      } catch (err) {
        r = { error: `Sweep threw: ${err.message}` };
      } finally {
        removeActiveBulkCheck(pid);
        if (!wasAlreadyRunning) {
          try { await _closeProfile(pid); } catch { /* */ }
        }
      }
      if (r.error) {
        campaignLog(`⚠ [${pName}] Bulk check: ${r.error}`);
      } else if (r.plain) {
        // The sweep's own sentence. The forensic field dump it used to print
        // here still goes to stdout from bulk-check-connections.js.
        campaignLog(r.plain);
      } else {
        const stamped = r.stamped || 0;
        campaignLog(`📡 [${pName}] Bulk check: ${r.matched || 0} marked Connected, ${stamped} marked Still Pending (of ${r.fetched || 0} recent connections fetched)`);
      }
      perProfile.push({ profileId: pid, profileName: pName, ...r });
      if (!r.error) {
        totalMatched += r.matched || 0;
        totalStamped += r.stamped || 0;
        totalFetched += r.fetched || 0;
      }
    }
    campaignLog(`📡 Manual bulk check complete — ${totalMatched} Connected, ${totalStamped} Still Pending across ${profileIdsToSweep.length} account(s).`);
    // A terminal schedule event is part of the sweep contract — the same line
    // the Check now route writes at server.js:4986, for the same reason. This
    // route never wrote it, so after a manual sweep the newest line in the log
    // was "check complete", the banner kept that finished event forever, and
    // the card sat on FINISHED CHECKING ALL AVAILABLE ACCOUNTS with the
    // next-check countdown replaced by a check-progress panel. Measured
    // 2026-08-28 on COLL_CHI_ANTONIO2: state monitoring, no check running,
    // next check 17:08, and nothing on the card or in the log said so.
    try {
      if (campaign && campaign.state === 'monitoring' && campaign.nextCheckAt) {
        campaignLog(nextCheckLogLine(campaign.nextCheckAt));
      }
    } catch (_) { /* the sweep itself already succeeded */ }
    } finally {
      setBulkCheckInProgress(false);
    }

    res.json({
      ok: true,
      derivedFromSheet,
      profilesSweep: profileIdsToSweep.length,
      skippedParked,
      result: {
        matched: totalMatched,
        stamped: totalStamped,
        fetched: totalFetched,
      },
      perProfile,
      autoPaused: _weShouldAutoResume,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    _manualSweepRunning = false;
    // A Stop pressed during a solo sweep (no campaign running) also arms
    // campaign._abort so the auto-intros inside the sweep halt. That job is
    // done once the sweep unwinds; leaving it armed would stop the NEXT check
    // on sight. Same guard as the start of the route: never touch a live
    // campaign's flag.
    if (!campaign.running && campaign.state !== 'monitoring') campaign._abort = false;
    // Pairs with the early set at the top of this route. A throw during setup
    // would otherwise leave the card claiming a check is running forever, and a
    // stuck flag also blocks every scheduled tick.
    setBulkCheckInProgress(false);
    // v2.71: ALWAYS resume if we were the ones who paused, even on error.
    // Operator-initiated pauses are left in place — we only undo our own.
    if (_weShouldAutoResume && campaign.running) {
      try {
        resumeCampaign();
        campaignLog('▶ Manual bulk check done — campaign resumed.');
      } catch (resumeErr) {
        campaignLog(`⚠ Manual bulk check — resume failed: ${resumeErr.message}`);
      }
    }
  }
});

// v2.78: stop a running manual/solo bulk-check sweep (the "Stop solo check"
// button). Sets the abort flag and force-closes the in-flight check browser so
// the sweep breaks within ~1-2s, then unwinds and resolves the original
// /api/bulk-check-now request.
app.post('/api/bulk-check/stop', (_req, res) => {
  const wasRunning = _manualSweepRunning;
  _manualSweepAbort = true;
  forceCloseActiveBulkChecks();
  // v3.1.33: release the lock here too, instead of trusting the sweep's own
  // `finally` to do it. That finally is unreachable when the loop is parked
  // inside a hung await (a GoLogin launch that never settles), and the abort
  // flag above cannot help either: it is only read between accounts, and
  // forceCloseActiveBulkChecks has nothing to close because addActiveBulkCheck
  // runs only AFTER launchProfile returns. The result was a permanently stuck
  // flag — every later check answered "a bulk check is already running" with
  // both Wait and Stop dead ends, until the app was restarted.
  //
  // Safe to clear eagerly: this is an explicit operator Stop, not the
  // accidental double-click v2.78 added the guard for. If the old sweep is
  // still alive it breaks at its next account boundary, and its finally
  // setting the flag false again is a no-op.
  _manualSweepRunning = false;
  if (wasRunning) campaignLog('■ Stop solo check requested — halting sweep.');
  res.json({ ok: true, wasRunning });
});

// v2.72: Manual "Run reply check now" — the messaging-campaign counterpart of
// /api/bulk-check-now. Instead of sweeping connection acceptances, it scrapes
// each sent lead's thread for inbound replies (writes Reply/ReplyAt/Stage to
// the sheet + Replies tab via checkProfileDmsPerLead, and records them to the
// in-app replies panel). Works mid-campaign with the same pause/resume +
// idempotent-launch pattern as bulk-check-now, so the paused campaign's own
// browser is reused and never closed out from under it.
app.post('/api/reply-check-now', async (req, res) => {
  const _weShouldAutoResume = campaign.running && !campaign._paused && !campaign._pauseRequested;
  try {
    let { sheetUrl, linkedinColumn, profileIds } = req.body || {};
    if (campaign.running && !(Array.isArray(profileIds) && profileIds.length > 0)) {
      profileIds = Array.isArray(campaign.profileIds) ? campaign.profileIds.slice() : [];
    }
    if (!sheetUrl && campaign.running && campaign.sheetUrl) {
      sheetUrl = campaign.sheetUrl;
      linkedinColumn = linkedinColumn || campaign.linkedinColumn || '';
    }
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    if (_weShouldAutoResume) {
      campaignLog('⏸ Manual reply check — pausing campaign so the browser can scan threads…');
      pauseCampaign();
      const deadline = Date.now() + 90_000;
      while (!campaign._paused && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!campaign._paused) {
        campaignLog('⚠ Manual reply check — pause did not acknowledge in 90s; aborted.');
        return res.status(503).json({ error: 'Pause did not take effect within 90s. Wait for the current lead to finish, then retry.' });
      }
      campaignLog('✓ Campaign paused — starting reply check.');
    }

    const token = process.env.GOLOGIN_API_TOKEN;
    const { checkProfileDms } = await import('./src/linkedin/check-dms.js');
    const { appendReplies } = await import('./src/replies-log.js');
    const { scanRepliesForProfile } = await import('./src/post-campaign-reply-check.js');
    const { writeRecentMessagesTab } = await import('./src/sheets-writer.js');
    const { closeProfile: _closeProfile } = await import('./src/gologin-launcher.js');

    // Scan window: back to the campaign's first send-out minus a 12h buffer.
    const _startMs = campaign.startedAt ? Date.parse(campaign.startedAt) : NaN;
    const _replyWatermark = (Number.isFinite(_startMs) ? _startMs : (Date.now() - 14 * 86400000)) - 12 * 60 * 60 * 1000;

    // Load the sheet once, resolve profile names, group sent rows by sender.
    let rows;
    try { rows = await fetchSheet(sheetUrl); }
    catch (err) { return res.status(400).json({ error: `Could not load sheet: ${err.message}` }); }

    let nameByProfileId = new Map();
    let nameToId = {};
    try {
      const allProfiles = await getProfiles(token);
      nameByProfileId = new Map(allProfiles.map((p) => [p.id, p.name || p.id]));
      for (const p of allProfiles) nameToId[(p.name || '').toLowerCase()] = p.id;
    } catch { /* fall back to id-as-name */ }

    const hasStageSchema = rows.length > 0 && ('Stage' in rows[0]);
    const candidateRows = rows.filter((row) => {
      if (hasStageSchema) return CHECK_DMS_STAGE_FILTER.has(String(row.Stage || '').trim());
      return String(row.Message || '').trim().toLowerCase() === 'sent';
    });

    // Which profiles to check: explicit > campaign's > everyone with sent rows.
    let targetProfileIds = Array.isArray(profileIds) && profileIds.length
      ? profileIds.slice()
      : null;

    const leadsByProfile = new Map();
    for (const row of candidateRows) {
      const acct = String(row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || '').trim();
      if (!acct) continue;
      const pid = nameToId[acct.toLowerCase()] || acct;
      if (targetProfileIds && !targetProfileIds.includes(pid)) continue;
      if (!leadsByProfile.has(pid)) leadsByProfile.set(pid, []);
      leadsByProfile.get(pid).push(row);
    }

    if (leadsByProfile.size === 0) {
      return res.json({ ok: true, profilesChecked: 0, repliesFound: 0, perProfile: [], autoPaused: _weShouldAutoResume });
    }

    const perProfile = [];
    const replyItems = [];   // unified found replies for the card strip
    let totalReplies = 0;
    // Scan the Sales Nav inbox too when this is a MESSAGING campaign (OP / InMail /
    // message-only) whose Sending Method used Sales Nav (opChannel ≠ ln_only).
    // CC+IC / ICB / CC+DM are LinkedIn-connection flows → regular inbox only.
    const _MESSAGING_MODES = new Set(['open_profile_only', 'inmail_only', 'message_only']);
    const _opChannel = String(campaign.templates?.opChannel || 'sn_first');
    const wantSalesNav = _MESSAGING_MODES.has(String(campaign.mode || '')) && _opChannel !== 'ln_only';
    setBulkCheckInProgress(true);
    campaignLog(`📬 Manual reply check — scanning ${leadsByProfile.size} account(s) for replies${wantSalesNav ? ' (incl. Sales Navigator)' : ''}…`);
    try {
      for (const [pid, leads] of leadsByProfile.entries()) {
        const pName = nameByProfileId.get(pid) || pid;
        const wasAlreadyRunning = !!getProfilePid(pid);
        let launched;
        try {
          launched = await launchProfile(pid, token);
        } catch (err) {
          campaignLog(`⚠ [${pName}] Launch failed: ${err.message}`);
          perProfile.push({ profileId: pid, profileName: pName, error: `Launch failed: ${err.message}` });
          continue;
        }
        try {
          campaignLog(`📬 [${pName}] Scanning inbox for replies…`);
          // v2.72: bulk inbox fetch first (fast), reusing this (paused) profile's
          // own browser; falls back to per-lead thread scrape if the inbox API
          // can't be read. Back to the campaign's first send-out − 12h.
          const result = await scanRepliesForProfile({
            profileId: pid,
            profileName: pName,
            leads,
            sheetUrl,
            linkedinColumn: linkedinColumn || 'Linkedin URL',
            watermark: _replyWatermark,
            page: launched.page, // reuse this session; do NOT let it self-close
          });
          if (Array.isArray(result.errors) && result.errors.length) {
            campaignLog(`⚠ [${pName}] reply scan: ${result.errors.join('; ')}`);
          }
          totalReplies += result.inboundCount;
          // Replies inbox: stamp the campaign name onto each captured reply so
          // the inbox subline can show "via <account> · <campaign>".
          await appendReplies((result.logEntries || []).map((e) => ({ ...e, campaign: campaign.name || '' })));
          // v2.72: dump inbound 1:1 replies to the shared "Recent Messages" tab.
          try { await writeRecentMessagesTab(sheetUrl, pName, result.recentMessages || [], []); }
          catch (e) { campaignLog(`⚠ [${pName}] Recent Messages write failed: ${e.message}`); }
          campaignLog(`📬 [${pName}] ${result.inboundCount} reply(ies)${result.suspectedCount ? `, ${result.suspectedCount} suspected (ambiguous name)` : ''} found [${result.method}].`);
          for (const m of (result.recentMessages || [])) {
            if (m.matched === false) continue;
            replyItems.push({ leadName: m.name || '', account: pName, accountPid: pid, snippet: String(m.lastMessage || '').slice(0, 160), fullText: String(m.lastMessage || ''), threadId: '', profileUrl: '', channel: 'dm' });
          }
          let snReplies = 0;
          // Sales Nav pass — OPs/InMails reply here, not in the regular inbox.
          // Reuse this profile's already-open page; failures are non-fatal.
          if (wantSalesNav) {
            try {
              campaignLog(`🧭 [${pName}] Scanning Sales Navigator inbox (OP / InMail)…`);
              const sn = await loadSalesNavConversations(launched.page, { watermark: _replyWatermark });
              if (sn.error) {
                campaignLog(`⚠ [${pName}] Sales Nav skipped — ${sn.error}`);
              } else {
                const { campaignReplies } = classifyConversations(sn.convs, leads, linkedinColumn || 'Linkedin URL');
                snReplies = campaignReplies.length;
                for (const r of campaignReplies) {
                  replyItems.push({ leadName: r.leadName || '', account: pName, accountPid: pid, snippet: r.snippet || '', fullText: r.fullText || r.snippet || '', threadId: r.threadId || '', profileUrl: r.profileUrl || '', channel: 'salesnav' });
                }
                if (snReplies) {
                  try {
                    const wb = await applyReplyWriteBack({ sheetUrl, linkedinColumn: linkedinColumn || 'Linkedin URL', campaignReplies });
                    campaignLog(`✍ [${pName}] Sales Nav wrote ${wb.wrote}, skipped ${wb.skipped}`);
                  } catch (wbErr) { campaignLog(`⚠ [${pName}] Sales Nav write-back failed: ${wbErr.message}`); }
                }
                campaignLog(`🧭 [${pName}] ${snReplies} OP/InMail reply(ies) found [salesnav · ${sn.convs.length} scanned].`);
              }
            } catch (snErr) { campaignLog(`⚠ [${pName}] Sales Nav reply check threw: ${snErr.message}`); }
          }
          totalReplies += snReplies;
          perProfile.push({ profileId: pid, profileName: pName, replies: result.inboundCount + snReplies, suspected: result.suspectedCount });
        } catch (err) {
          campaignLog(`⚠ [${pName}] Reply check threw: ${err.message}`);
          perProfile.push({ profileId: pid, profileName: pName, error: err.message });
        } finally {
          if (!wasAlreadyRunning) { try { await _closeProfile(pid); } catch { /* */ } }
        }
      }
      campaignLog(`📬 Manual reply check complete — ${totalReplies} new reply(ies) across ${leadsByProfile.size} account(s).`);
    } finally {
      setBulkCheckInProgress(false);
    }

    res.json({ ok: true, profilesChecked: leadsByProfile.size, repliesFound: totalReplies, perProfile, replies: replyItems, autoPaused: _weShouldAutoResume });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (_weShouldAutoResume && campaign.running) {
      try { resumeCampaign(); campaignLog('▶ Manual reply check done — campaign resumed.'); }
      catch (resumeErr) { campaignLog(`⚠ Manual reply check — resume failed: ${resumeErr.message}`); }
    }
  }
});

app.delete('/api/draft-name', async (_req, res) => {
  try {
    await writeDraftName('');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-draft endpoints ──
// The single-draft /api/draft-name above is kept for back-compat (the
// wizard's saveDraftName still hits it). These power the new dashboard
// Drafts section and let the operator stage multiple campaigns in
// parallel without losing any.
app.get('/api/drafts', async (_req, res) => {
  try { res.json({ drafts: await getDrafts() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/drafts/:id', async (req, res) => {
  try {
    const d = await getDraft(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json(d);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// v2.59: name uniqueness check shared by POST + PATCH. Blocks saving a
// draft whose name collides with the currently-running campaign.
// Returns null when the name is OK, or an error payload when blocked.
function _draftNameCollision(name) {
  const norm = String(name || '').trim().toLowerCase();
  if (!norm) return null;
  const runningName = String(campaign.name || '').trim().toLowerCase();
  if (runningName && runningName === norm) {
    return {
      status: 409,
      body: {
        error: 'name_collides_with_running',
        message: `A campaign called "${campaign.name}" is currently running. Choose a different name, or stop the running campaign first.`,
      },
    };
  }
  return null;
}

const _draftNamesBeingCreated = new Set();

app.post('/api/drafts', async (req, res) => {
  const { name, config, uniqueName } = req.body || {};
  const key = String(name || '').trim().toLowerCase();
  let reserved = false;
  try {
    if (uniqueName || key) {
      if (!key) return res.status(400).json({ message: 'Enter a campaign name.' });
      const conflict = () => res.status(409).json({ error: 'name_exists', message: `A campaign named "${String(name).trim()}" already exists. Please choose a different name.` });
      if (_draftNamesBeingCreated.has(key)) return conflict();
      _draftNamesBeingCreated.add(key);
      reserved = true;
      const { listConfigs } = await import('./src/campaign-configs.js');
      const [drafts, history, queue, schedules] = await Promise.all([getDrafts(), listHistory({ includeArchived: true }), getQueue(), loadSchedules()]);
      const existing = [...drafts, ...history, ...queue, ...schedules, ...listConfigs(), campaign];
      if (existing.some(item => String(item?.name || '').trim().toLowerCase() === key)) return conflict();
    }
    const collision = _draftNameCollision(name);
    if (collision) return res.status(collision.status).json(collision.body);
    const entry = await addDraft({ name, config });
    res.json({ ok: true, draft: entry });
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { if (reserved) _draftNamesBeingCreated.delete(key); }
});

app.patch('/api/drafts/:id', async (req, res) => {
  try {
    const collision = _draftNameCollision(req.body?.name);
    if (collision) return res.status(collision.status).json(collision.body);
    const updated = await updateDraft(req.params.id, req.body || {});
    // The write named one campaign; this draft belongs to another. Refuse it —
    // the client detaches on 409 rather than continuing to write across.
    if (updated === DRAFT_IDENTITY_MISMATCH) {
      return res.status(409).json({ error: 'This draft belongs to a different campaign' });
    }
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, draft: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk "Delete all drafts" — one request, one disk write (vs 227 DELETEs).
app.post('/api/drafts/trash-all', async (_req, res) => {
  try { res.json({ ok: true, trashed: await trashAllDrafts() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/drafts/:id', async (req, res) => {
  try {
    // Bulk "Delete all drafts" sends {soft:true} → hide now, keep 1 week, then
    // purgeTrashedDrafts removes it. A per-draft delete (no flag) is immediate.
    const ok = (req.body && req.body.soft)
      ? await trashDraft(req.params.id)
      : await removeDraft(req.params.id);
    res.json({ ok });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Phase 11.2: Show Browsers — un-hide every active Chromium process (D-18).
// Called by the dashboard "Show Browsers" button and the tray menu item.
// ---------------------------------------------------------------------------
app.post('/api/browsers/show', async (_req, res) => {
  try {
    if (process.platform !== 'darwin') {
      return res.json({ ok: true, shown: 0, skipped: 0, platform: 'other' });
    }
    const pids = getActiveBrowserPids();
    const { shown, skipped } = await unhideByPids(pids);
    res.json({ ok: true, shown, skipped, platform: 'darwin' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open the GoLogin browser for a specific profile. If the profile is already
// running (in activeProfiles), unhide its window and bring it onscreen.
// If not, launch it. Used by the Account Queue's Open Browser + Try Again
// buttons so the operator can manually intervene mid-run (e.g. log back in
// after a session-expired park).
app.post('/api/profile/:id/open-browser', async (req, res) => {
  const profileRef = req.params.id;
  if (!profileRef) return res.status(400).json({ error: 'profileId required' });
  try {
    const profileId = resolveProfileId(await getProfiles(), profileRef);
    if (!profileId) {
      return res.status(404).json({ error: `No exact GoLogin profile matches ${profileRef}` });
    }
    const existingPid = getProfilePid(profileId);
    if (existingPid) {
      if (process.platform === 'darwin') {
        await unhideByPids([existingPid]);
      }
      return res.json({ ok: true, action: 'focused-existing', pid: existingPid });
    }
    const token = process.env.GOLOGIN_API_TOKEN;
    await launchProfile(profileId, token);
    const newPid = getProfilePid(profileId);
    if (process.platform === 'darwin' && newPid) {
      await unhideByPids([newPid]);
    }
    res.json({ ok: true, action: 'launched', pid: newPid });
  } catch (err) {
    console.error(`[open-browser] ${profileId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Retry a parked profile mid-run: clears the campaign-side park state
// (weeklyLimited, parkedProfiles, profileEndReasons, consecutive counters)
// AND opens the GoLogin browser so the operator can re-authenticate. The
// next campaign rotation picks the profile up again.
app.post('/api/campaign/profile/:id/retry', async (req, res) => {
  const profileId = req.params.id;
  if (!profileId) return res.status(400).json({ error: 'profileId required' });
  try {
    const result = retryParkedProfile(profileId);
    if (!result.ok) return res.status(409).json({ error: result.reason || 'retry-failed' });
    // "I've logged back in" sends open:false — the operator has already got the
    // browser open, that is where they signed in. Launching it again would fight
    // them for the window.
    if (req.body && req.body.open === false) {
      return res.json({ ok: true, profileName: result.profileName, browser: { action: 'skipped' } });
    }
    // Same launch + unhide flow as /api/profile/:id/open-browser. We don't
    // delegate so the response can carry both the unpark + launch outcome.
    let launchInfo;
    const existingPid = getProfilePid(profileId);
    if (existingPid) {
      if (process.platform === 'darwin') await unhideByPids([existingPid]);
      launchInfo = { action: 'focused-existing', pid: existingPid };
    } else {
      const token = process.env.GOLOGIN_API_TOKEN;
      try {
        await launchProfile(profileId, token);
        const newPid = getProfilePid(profileId);
        if (process.platform === 'darwin' && newPid) await unhideByPids([newPid]);
        launchInfo = { action: 'launched', pid: newPid };
      } catch (launchErr) {
        // Unpark already happened — campaign loop will try the launch itself
        // on next rotation. Surface the failure but don't fail the whole call.
        launchInfo = { action: 'launch-failed', error: launchErr.message };
      }
    }
    res.json({ ok: true, profileName: result.profileName, browser: launchInfo });
  } catch (err) {
    console.error(`[retry] ${profileId}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 11.3: Check DMs
// Scans LinkedIn inboxes for replies to previously messaged prospects and
// writes results to the sheet + in-memory cache for the UI to fetch.
// ---------------------------------------------------------------------------
const checkDms = {
  running: false,
  _abort: false,
  currentProfile: null,
  repliesFound: 0,
  errors: [],
  startedAt: null,
  _lastResults: null, // { byProfile: { name: [replies] }, ambiguous, completedAt }
};

const CHECK_DMS_STATE_FILE = dataPath('check-dms-state.json');

async function loadCheckDmsWatermarks() {
  try {
    const raw = await readFile(CHECK_DMS_STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return {}; }
}

async function saveCheckDmsWatermarks(state) {
  try {
    await mkdir(dirname(CHECK_DMS_STATE_FILE), { recursive: true });
    await writeFile(CHECK_DMS_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[check-dms] failed to save watermarks: ${err.message}`);
  }
}

// 2.9.7: Stages that mean "we've sent at least one outbound message and are
// now waiting for / tracking a reply." Check DMs only scrapes these rows.
const CHECK_DMS_STAGE_FILTER = new Set([
  'DM Sent', 'IC Sent', 'OP Sent', 'InM Sent', 'Replied',
]);

app.post('/api/check-dms/start', async (req, res) => {
  try {
    if (campaign.running) return res.status(409).json({ error: 'Campaign is running — stop it first' });
    if (checkDms.running) return res.status(409).json({ error: 'Check DMs is already running' });
    if (postAmp.running) return res.status(409).json({ error: 'Post Amplification is running — stop it first' });

    const { sheetUrl, linkedinColumn } = req.body;
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    // 2.9.7: Auto-route from the sheet's Account Used column. Same logic as
    // check_status / message_only — operator no longer picks profiles.
    let rows;
    try { rows = await fetchSheet(sheetUrl); }
    catch (err) { return res.status(400).json({ error: `Could not load sheet: ${err.message}` }); }

    let profiles = [];
    try {
      const token = process.env.GOLOGIN_API_TOKEN;
      if (token) profiles = await getProfiles(token);
    } catch (err) {
      console.warn(`[check-dms] getProfiles failed: ${err.message}`);
    }

    const nameToId = {};
    for (const p of profiles) nameToId[p.name] = p.id;
    // Local browser pseudo-profile aliases (mirror campaign.js).
    nameToId['You']                    = 'local-browser';
    nameToId['Local Browser']          = 'local-browser';
    nameToId['local-browser']          = 'local-browser';
    nameToId['local-browser - manual'] = 'local-browser';

    // Filter rows to Sent-stage rows. Fall back to legacy Message='sent' if
    // the sheet doesn't have a Stage column yet.
    const hasStageSchema = rows.length > 0 && ('Stage' in rows[0]);
    const candidateRows = rows.filter(row => {
      if (hasStageSchema) {
        const stage = String(row.Stage || '').trim();
        return CHECK_DMS_STAGE_FILTER.has(stage);
      }
      return String(row.Message || '').trim().toLowerCase() === 'sent';
    });

    // Group rows by Sender → profileId. New schema (2.9.x) writes the
    // canonical name to the 'Sender' column; legacy sheets use 'Account Used'.
    // Read both — prefer Sender, fall back to Account Used.
    const leadsByProfile = new Map();
    const unmatched = new Map();
    for (const row of candidateRows) {
      const acct = String(
        row['Sender'] || row['sender'] ||
        row['Account Used'] || row['account used'] || ''
      ).trim();
      if (!acct) {
        unmatched.set('(blank)', (unmatched.get('(blank)') || 0) + 1);
        continue;
      }
      const pid = nameToId[acct];
      if (!pid) {
        unmatched.set(acct, (unmatched.get(acct) || 0) + 1);
        continue;
      }
      if (!leadsByProfile.has(pid)) leadsByProfile.set(pid, []);
      leadsByProfile.get(pid).push(row);
    }

    if (leadsByProfile.size === 0) {
      let msg;
      if (candidateRows.length === 0) {
        msg = 'No rows in Sent stage found — nothing to check.';
      } else {
        const names = [...unmatched.entries()]
          .map(([n, c]) => `${n} (${c})`)
          .slice(0, 5)
          .join(', ');
        msg = `Found ${candidateRows.length} row(s) in Sent stage, but no GoLogin profile in this workspace matches the sender(s): ${names}.`;
      }
      return res.status(400).json({
        error: msg,
        unmatched: Object.fromEntries(unmatched),
      });
    }

    checkDms.running = true;
    checkDms._abort = false;
    checkDms.startedAt = Date.now();
    checkDms.repliesFound = 0;
    checkDms.errors = [];
    checkDms.currentProfile = null;
    checkDms._lastResults = null;

    const owner = req.user;

    preventSleep('check-dms');
    // Fire and forget
    (async () => {
      const byProfile = {};
      const ambiguous = [];
      try {
        for (const [profileId, leads] of leadsByProfile.entries()) {
          if (checkDms._abort) break;
          checkDms.currentProfile = profileId;
          const result = await checkProfileDmsPerLead(profileId, leads, {
            sheetUrl,
            linkedinColumn: linkedinColumn || 'Linkedin URL',
            shouldAbort: () => checkDms._abort,
            // 2.9.7: surface diagnostic lines to the Live Status log panel
            // (which polls campaign.logs on /api/campaign/status). The
            // check-dms vs campaign mutex makes mixing safe.
            log: (line) => {
              const stamped = `[${new Date().toISOString()}] ${line}`;
              campaign.logs.push(stamped);
              if (campaign.logs.length > 500) campaign.logs.shift();
            },
          });
          byProfile[profileId] = result.replies || [];
          // Inbound count drives the headline metric the operator sees.
          checkDms.repliesFound += (result.replies || []).filter(r => r.inbound).length;
          // Replies inbox: persist inbound replies to the local replies log so
          // they show in the Replies view (capture at the CALL SITE — the
          // scraper itself stays untouched). Best-effort; the sheet write-back
          // inside checkProfileDmsPerLead remains the source of truth.
          try {
            const { appendReplies } = await import('./src/replies-log.js');
            const profileName = Object.keys(nameToId).find((n) => nameToId[n] === profileId && n !== 'local-browser') || profileId;
            const entries = (result.replies || []).filter((r) => r.inbound).map((r) => {
              const row = r.match || {};
              const lastMsg = Array.isArray(r.messages) && r.messages.length ? r.messages[r.messages.length - 1] : null;
              return {
                profileId, profileName,
                linkedinUrl: r.leadUrl || row['Linkedin URL'] || '',
                leadName: r.name || `${row['First Name'] || row.firstName || ''} ${row['Last Name'] || row.lastName || ''}`.trim(),
                text: r.snippet || (lastMsg && lastMsg.body) || '',
                campaign: '',
                repliedAt: r.timestamp || (lastMsg && lastMsg.time) || null,
                suspected: false,
              };
            });
            if (entries.length) await appendReplies(entries);
          } catch (logErr) {
            console.warn(`[check-dms] replies-log append failed: ${logErr.message}`);
          }
          if (Array.isArray(result.ambiguous)) ambiguous.push(...result.ambiguous.map(a => ({ ...a, profileId })));
          if (Array.isArray(result.errors) && result.errors.length) {
            checkDms.errors.push(...result.errors.map(e => `[${profileId}] ${e}`));
          }
        }
        checkDms._lastResults = { byProfile, ambiguous, completedAt: Date.now() };
        notifyEmail(owner, {
          title: 'Check DMs finished',
          body: `Check DMs finished: ${checkDms.repliesFound} new reply(ies), ${checkDms.errors.length} error(s).`,
          link: '/',
        }).catch(() => {});
      } catch (err) {
        console.error('Check DMs error:', err.message);
        checkDms.errors.push(err.message);
      } finally {
        checkDms.running = false;
        checkDms.currentProfile = null;
        allowSleep();
      }
    })();

    res.json({
      ok: true,
      message: 'Check DMs started',
      profiles: leadsByProfile.size,
      threads: candidateRows.length,
      unmatched: Object.fromEntries(unmatched),
    });
  } catch (err) {
    console.error('Check DMs start error:', err.message);
    checkDms.running = false;
    res.status(500).json({ error: err.message });
  }
});

// 2.9.7: Preview endpoint — same shape as /api/check-status/preview so the
// dashboard can render coverage bars before the operator clicks Start.
app.get('/api/check-dms/preview', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });

    const [rows, profiles] = await Promise.all([
      fetchSheet(url),
      (async () => {
        try {
          const token = process.env.GOLOGIN_API_TOKEN;
          if (!token) return [];
          return await getProfiles(token);
        } catch { return []; }
      })(),
    ]);

    const knownNames = new Set(profiles.map(p => p.name));
    const LOCAL_BROWSER_NAMES = new Set(['You', 'Local Browser', 'local-browser', 'local-browser - manual']);
    const hasStageSchema = rows.length > 0 && ('Stage' in rows[0]);

    const byAccount = {};
    const unmatched = {};
    let totalThreads = 0;
    for (const row of rows) {
      // Same filter as the start route — only rows we have a thread for.
      if (hasStageSchema) {
        const stage = String(row.Stage || '').trim();
        if (!CHECK_DMS_STAGE_FILTER.has(stage)) continue;
      } else {
        if (String(row.Message || '').trim().toLowerCase() !== 'sent') continue;
      }
      const acct = String(
        row['Sender'] || row['sender'] ||
        row['Account Used'] || row['account used'] || ''
      ).trim();
      if (!acct) continue;
      totalThreads++;
      if (LOCAL_BROWSER_NAMES.has(acct)) {
        byAccount['You'] = (byAccount['You'] || 0) + 1;
      } else if (knownNames.has(acct)) {
        byAccount[acct] = (byAccount[acct] || 0) + 1;
      } else {
        unmatched[acct] = (unmatched[acct] || 0) + 1;
      }
    }

    // Rough estimate: ~12s per thread (nav + settle + scrape).
    const runtimeSeconds = totalThreads * 12;

    res.json({
      totalPending: totalThreads,
      byAccount: Object.entries(byAccount).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      unmatched: Object.entries(unmatched).map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      accountsCount: Object.keys(byAccount).length,
      runtimeSeconds,
    });
  } catch (err) {
    console.error('Check DMs preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/check-dms/stop', (_req, res) => {
  checkDms._abort = true;
  res.json({ ok: true, message: 'Abort requested' });
});

app.get('/api/check-dms/status', (_req, res) => {
  res.json({
    running: checkDms.running,
    currentProfile: checkDms.currentProfile,
    repliesFound: checkDms.repliesFound,
    errors: checkDms.errors,
    startedAt: checkDms.startedAt,
  });
});

app.get('/api/check-dms/replies', (_req, res) => {
  res.json(checkDms._lastResults || { byProfile: {}, ambiguous: [], completedAt: null });
});

// ---------------------------------------------------------------------------
// Post Amplification (v2.12.x — Phase 2). Sequential per-account engagement
// on a single LinkedIn post URL. Mutually exclusive with campaign + check-dms
// (same Orbita process pool). Own dedup state at data/post-amplification-state.json.
// ---------------------------------------------------------------------------
const postAmp = {
  running: false,
  _abort: false,
  startedAt: null,
  completedAt: null,
  postUrl: null,
  total: 0,
  completed: 0,
  engaged: 0,
  skippedDedup: 0,
  errors: [],
  currentIndex: 0,
  currentProfile: null,
  // Tail of log lines surfaced through the same /api/campaign/status payload
  // the Live Status panel polls — so the operator sees progress without
  // adding a second polling loop.
  logs: [],
};

function pushPostAmpLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  postAmp.logs.push(stamped);
  if (postAmp.logs.length > 300) postAmp.logs.shift();
  // Mirror to campaign.logs so the existing Live Status panel renders it
  // without extra UI plumbing — the campaign vs post-amp mutex makes this
  // unambiguous (only one of them is running at a time).
  campaign.logs.push(stamped);
  if (campaign.logs.length > 500) campaign.logs.shift();
}

app.post('/api/post-amplification/start', async (req, res) => {
  try {
    if (campaign.running) return res.status(409).json({ error: 'Campaign is running — stop it first' });
    if (checkDms.running) return res.status(409).json({ error: 'Check DMs is running — stop it first' });
    if (postAmp.running) return res.status(409).json({ error: 'Post Amplification is already running' });

    const { postUrl, accountConfigs, name } = req.body || {};
    if (!postUrl || !/linkedin\.com\/posts\/[^/]+/.test(postUrl)) {
      return res.status(400).json({ error: 'postUrl required (linkedin.com/posts/<slug>-<id>)' });
    }
    if (!Array.isArray(accountConfigs) || accountConfigs.length === 0) {
      return res.status(400).json({ error: 'accountConfigs required' });
    }
    // Filter to actionable configs server-side so the engine doesn't waste
    // browser launches on accounts the operator left fully unchecked.
    const actionable = accountConfigs.filter(c => {
      if (!c || !c.profileId) return false;
      const hasComment = !!c.comment && (c.commentText || '').trim().length > 0;
      return c.like || hasComment;
    });
    if (actionable.length === 0) {
      return res.status(400).json({ error: 'No accounts have Like or a non-empty Comment configured.' });
    }
    // Same workspace + mode gate the campaign endpoints use. Post Amplification
    // is one of the two modes the marketing workspace exists for, so this pass
    // is what LETS marketing accounts through here while still refusing another
    // team's accounts.
    if (await rejectIfForeignProfiles(req, res, actionable.map((c) => c.profileId), POST_AMPLIFICATION_MODE)) return;

    // Reset state for this run.
    postAmp.running = true;
    postAmp._abort = false;
    postAmp.startedAt = Date.now();
    postAmp.completedAt = null;
    postAmp.postUrl = postUrl;
    postAmp.total = actionable.length;
    postAmp.completed = 0;
    postAmp.engaged = 0;
    postAmp.skippedDedup = 0;
    postAmp.errors = [];
    postAmp.currentIndex = 0;
    postAmp.currentProfile = null;
    postAmp.logs = [];

    const owner = req.user;
    const startedAt = postAmp.startedAt;
    const campaignName = (name || '').trim() || 'Post Amplification';

    preventSleep('post-amplification');
    pushPostAmpLog(`=== Post Amplification starting · ${actionable.length} account(s) · ${postUrl} ===`);

    // Fire-and-forget so the HTTP request returns immediately.
    (async () => {
      let endReason = 'completed';
      try {
        await runPostAmplification({
          postUrl,
          accountConfigs: actionable,
          status: postAmp,
          shouldAbort: () => postAmp._abort,
          log: pushPostAmpLog,
        });
        if (postAmp._abort) endReason = 'stopped';
        else if (postAmp.errors.length > 0 && postAmp.engaged === 0) endReason = 'errored';
      } catch (err) {
        console.error('[post-amp] orchestrator threw:', err.message);
        postAmp.errors.push(err.message);
        endReason = 'errored';
      } finally {
        postAmp.completedAt = Date.now();
        postAmp.running = false;
        allowSleep();

        // Append to history so it shows in the past-campaigns dashboard.
        try {
          let history = [];
          try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf8')); } catch { /* */ }
          history.push({
            date: new Date(startedAt).toISOString(),
            name: campaignName,
            mode: 'post_amplification',
            profiles: actionable.map(c => c.profileName || c.profileId),
            dailyLimit: actionable.length,
            totalProcessed: postAmp.completed,
            successCount: postAmp.engaged,
            errorCount: postAmp.errors.length,
            duration: Math.round((postAmp.completedAt - startedAt) / 1000),
            templateNames: [],
            endReason,
            settings: {
              profileIds: actionable.map(c => c.profileId),
              postAmplification: {
                postUrl,
                accountConfigs: actionable.map(c => ({
                  profileId: c.profileId,
                  profileName: c.profileName,
                  like: !!c.like,
                  comment: !!c.comment,
                  commentText: c.commentText || '',
                })),
              },
            },
          });
          await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
        } catch (err) {
          console.warn(`[post-amp] history append failed: ${err.message}`);
        }

        notifyEmail(owner, {
          title: `Post Amplification ${endReason}`,
          body: `Engaged ${postAmp.engaged}/${postAmp.total} · skipped ${postAmp.skippedDedup} · errors ${postAmp.errors.length}`,
          link: '/',
        }).catch(() => {});
        pushPostAmpLog(`=== Post Amplification ${endReason} · engaged ${postAmp.engaged}/${postAmp.total} · skipped-dedup ${postAmp.skippedDedup} · errors ${postAmp.errors.length} ===`);
      }
    })();

    res.json({
      ok: true,
      message: 'Post Amplification started',
      total: actionable.length,
    });
  } catch (err) {
    console.error('[post-amp] start error:', err.message);
    postAmp.running = false;
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/post-amplification/stop', (_req, res) => {
  postAmp._abort = true;
  res.json({ ok: true, message: 'Abort requested' });
});

app.get('/api/post-amplification/status', (_req, res) => {
  res.json({
    running: postAmp.running,
    postUrl: postAmp.postUrl,
    total: postAmp.total,
    completed: postAmp.completed,
    engaged: postAmp.engaged,
    skippedDedup: postAmp.skippedDedup,
    errors: postAmp.errors,
    currentIndex: postAmp.currentIndex,
    currentProfile: postAmp.currentProfile,
    startedAt: postAmp.startedAt,
    completedAt: postAmp.completedAt,
  });
});

// ---------------------------------------------------------------------------
// Campaign presets — whole-campaign snapshots (mode, sheet, accounts, templates,
// rate, limits, etc.) so operators can reload a full setup with one click.
// Stored globally (team-shared); "last used" is per-user.
// Shape of data/presets.json: { presets: { name: { config, meta } }, last_used: { email: { config, meta } } }
// Store logic lives in src/presets.js (pure module, atomic .tmp+rename writes).
// ---------------------------------------------------------------------------

app.get('/api/presets', (_req, res) => {
  // Return just the presets map with a small summary per entry.
  res.json(listPresets());
});

app.get('/api/presets/:name', (req, res) => {
  const name = req.params.name;
  if (name === '_last_used') {
    const last = getLastUsedPreset(req.user);
    if (!last) return res.status(404).json({ error: 'No last-used preset for this operator' });
    return res.json(last);
  }
  const entry = getPreset(name);
  if (!entry) return res.status(404).json({ error: 'Preset not found' });
  res.json(entry);
});

app.post('/api/presets', (req, res) => {
  try {
    const { name, config } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config required' });
    res.json(savePreset({ name, config, user: req.user }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/presets/:name', (req, res) => {
  try {
    deletePreset(req.params.name);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save current campaign config as "last used" for the current operator.
// Called automatically by the client right before starting a campaign.
app.post('/api/presets/_last_used', (req, res) => {
  try {
    const { config } = req.body || {};
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config required' });
    res.json(saveLastUsedPreset(req.user, config));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Templates (save/load named template sets)
// ---------------------------------------------------------------------------
const TEMPLATES_PATH = dataPath('templates.json');

async function loadTemplates() {
  try {
    const raw = await readFile(TEMPLATES_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveTemplates(data) {
  await mkdir(dirname(TEMPLATES_PATH), { recursive: true });
  await writeFile(TEMPLATES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

app.get('/api/templates', async (_req, res) => {
  const templates = await loadTemplates();
  res.json(templates);
});

app.post('/api/templates', async (req, res) => {
  try {
    const { name, templates: tpl } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const all = await loadTemplates();
    all[name] = tpl;
    await saveTemplates(all);
    res.json({ saved: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:name', async (req, res) => {
  try {
    const all = await loadTemplates();
    delete all[req.params.name];
    await saveTemplates(all);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Schedules (node-cron persistence + CRUD)
// ---------------------------------------------------------------------------
const SCHEDULES_PATH = dataPath('schedules.json');
const activeJobs = new Map(); // id -> cron job instance

async function loadSchedules() {
  try {
    const raw = await readFile(SCHEDULES_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveSchedules(data) {
  await mkdir(dirname(SCHEDULES_PATH), { recursive: true });
  await writeFile(SCHEDULES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function shiftCronMinutes(cronExpr, deltaMinutes) {
  const parts = cronExpr.split(' ');
  if (parts.length !== 5) return null;
  const [mnStr, hrStr, dom, mon, dow] = parts;
  let minute = parseInt(mnStr, 10);
  let hour = parseInt(hrStr, 10);
  if (isNaN(minute) || isNaN(hour)) return null;
  minute += deltaMinutes;
  while (minute < 0) { minute += 60; hour -= 1; }
  while (minute >= 60) { minute -= 60; hour += 1; }
  while (hour < 0) hour += 24;
  while (hour >= 24) hour -= 24;
  return `${minute} ${hour} ${dom} ${mon} ${dow}`;
}

function registerSchedule(schedule) {
  // Stop existing jobs for this schedule (main + pre-fire)
  if (activeJobs.has(schedule.id)) {
    const { main, prefire } = activeJobs.get(schedule.id);
    main?.stop();
    prefire?.stop();
  }
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cron)) {
    console.error(`[scheduler] Invalid cron for schedule "${schedule.name}": ${schedule.cron}`);
    return;
  }

  // Pre-fire heads-up (5 minutes before) — sent to the creator of the schedule
  const preExpr = shiftCronMinutes(schedule.cron, -5);
  let prefire = null;
  if (preExpr && cron.validate(preExpr)) {
    prefire = cron.schedule(preExpr, () => {
      const [mn, hr] = schedule.cron.split(' ');
      const timeStr = `${String(hr).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
      const target = schedule.createdBy;
      (target ? notifyEmail(target, {
        title: 'Scheduled campaign starting soon',
        body: `${schedule.name} will start at ${timeStr} (in ~5 min).`,
        link: '/',
      }) : notifyAll({
        title: 'Scheduled campaign starting soon',
        body: `${schedule.name} will start at ${timeStr} (in ~5 min).`,
        link: '/',
      })).catch(() => {});
    });
  }

  // Main fire
  const main = cron.schedule(schedule.cron, async () => {
    console.log(`[scheduler] Firing schedule "${schedule.name}" (owner: ${schedule.createdBy || 'none'})`);
    // Unattended cron fire bypasses the HTTP start gate — enforce identity here
    // too, else a scheduled acceptance-check flips accounts "In Use" anonymously.
    if (blockIfNoOperatorEmail(`schedule "${schedule.name}"`, schedule.createdBy)) return;
    const notify = (payload) => schedule.createdBy
      ? notifyEmail(schedule.createdBy, payload)
      : notifyAll(payload);

    // Not when it is about to be queued behind a running campaign — that path
    // sends its own "queued" notice instead of a false "running now".
    if (!campaign.running) notify({
      title: 'Campaign started',
      body: `${schedule.name} is running now on ${schedule.profileIds.length} account(s).`,
      link: '/',
    }).catch(() => {});
    preventSleep(`schedule:${schedule.name}`);
    try {
      // A schedule made from the wizard carries the whole launch — run exactly
      // that, under the campaign's own permanent id, so nothing is cloned and no
      // setting (primary person, intro message, stop options…) is dropped.
      // Something is already running → join the queue instead of failing with
      // "Campaign already running" (operator, 2026-09-21). Same rule as pressing
      // Start while busy; the queue starts it when the current campaign finishes.
      if (campaign.running) {
        const queuedConfig = schedule.launchBody
          ? buildCampaignConfig({ ...schedule.launchBody, campaignId: schedule.campaignId, name: schedule.name })
          : buildCampaignConfig({ campaignId: schedule.campaignId, name: schedule.name, profileIds: schedule.profileIds,
              sheetUrl: schedule.sheetUrl, templates: schedule.templates || {}, dailyLimit: schedule.dailyLimit || 50,
              mode: schedule.mode || 'connect_only', delayMin: schedule.delayMin, delayMax: schedule.delayMax,
              pauseOnThrottle: schedule.pauseOnThrottle });
        await addToQueue(queuedConfig, schedule.createdBy || null);
        const busyWith = campaign.name || 'another campaign';
        campaignLog(`🗓 Scheduled campaign "${schedule.name}" is due, but "${busyWith}" is running — added to the queue. It starts when that one finishes.`);
        const allS = await loadSchedules();
        const sq = allS.find(x => x.id === schedule.id);
        if (sq) { sq.lastRun = new Date().toISOString(); await saveSchedules(allS); }
        notify({ title: 'Scheduled campaign queued', body: `${schedule.name} was due while "${busyWith}" is running — it is queued and starts next.`, link: '/' }).catch(() => {});
        return;
      }
      if (schedule.launchBody) {
        const fullConfig = buildCampaignConfig({ ...schedule.launchBody, campaignId: schedule.campaignId, name: schedule.name });
        fullConfig.createdBy = schedule.createdBy || null;
        await startCampaign(fullConfig);
      } else await startCampaign({
        campaignId: schedule.campaignId, name: schedule.name,
        profileIds: schedule.profileIds,
        sheetUrl: schedule.sheetUrl,
        templates: schedule.templates || {},
        dailyLimit: schedule.dailyLimit || 50,
        mode: schedule.mode || 'connect_only',
        delayMin: schedule.delayMin,
        delayMax: schedule.delayMax,
        createdBy: schedule.createdBy || null,
        // Fix B Task 3: schedules default to pausing on throttle.
        pauseOnThrottle: schedule.pauseOnThrottle === false ? false : true,
        // Blocklist hard-exclusion: no interactive gate here (unattended).
        // startCampaign's central guard (blocklistExcludedUrls) covers this path.
      });
      const all = await loadSchedules();
      const s = all.find(x => x.id === schedule.id);
      if (s) { s.lastRun = new Date().toISOString(); await saveSchedules(all); }

      const status = getCampaignStatus();
      const terminal = terminalPresentation(status);
      notify({
        title: `Campaign ${terminal.label.toLowerCase()}`,
        body: `${schedule.name}: ${terminal.explanation} ${status.processedToday || 0} actions, ${terminal.pending} pending.`,
        link: '/',
      }).catch(() => {});
    } catch (err) {
      console.error(`[scheduler] Schedule "${schedule.name}" failed:`, err.message);
      notify({
        title: 'Campaign failed',
        body: `${schedule.name} failed: ${err.message}`,
        link: '/',
      }).catch(() => {});
    } finally {
      allowSleep();
    }
  });
  activeJobs.set(schedule.id, { main, prefire });
}

// Schedule CRUD (D-03)
app.get('/api/schedules', async (_req, res) => {
  const schedules = await loadSchedules();
  res.json(schedules);
});

app.post('/api/schedules', async (req, res) => {
  try {
    const { name, cron: cronExpr, profileIds, sheetUrl, mode, templates, dailyLimit, delayMin, delayMax, enabled } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!cronExpr || !cron.validate(cronExpr)) return res.status(400).json({ error: 'valid cron expression required' });
    if (!profileIds?.length) return res.status(400).json({ error: 'profileIds required' });
    if (!sheetUrl) return res.status(400).json({ error: 'sheetUrl required' });

    const all = await loadSchedules();
    // P-06 fix (2.8.18): validate any client-supplied id against the expected
    // shape (sched_<digits>). Without this, the client can inject arbitrary
    // strings — including ones that break out of the single-quote-delimited
    // onclick attribute in app.js:2409 and produce stored XSS in the schedules
    // panel. Reject anything not matching the canonical shape.
    let id;
    if (req.body.id) {
      if (!/^sched_\d+$/.test(req.body.id)) {
        return res.status(400).json({ error: 'invalid schedule id' });
      }
      id = req.body.id;
    } else {
      id = `sched_${Date.now()}`;
    }
    // One schedule per campaign: scheduling a campaign that already has one
    // REPLACES it (operator, 2026-09-21) — it used to pile up a new run per press.
    let replaced = false;
    if (!req.body.id && req.body.campaignId) {
      const mine = all.filter(s => s.campaignId === req.body.campaignId);
      if (mine.length) {
        replaced = true;
        id = mine[0].id;                                   // keep the first, overwrite it below
        for (const extra of mine.slice(1)) {
          const job = activeJobs.get(extra.id);
          if (job) { job.main?.stop(); job.prefire?.stop(); activeJobs.delete(extra.id); }
        }
        for (let i = all.length - 1; i >= 0; i--) if (all[i].campaignId === req.body.campaignId && all[i].id !== id) all.splice(i, 1);
      }
    }
    const existing = all.findIndex(s => s.id === id);
    const identity = ensureCampaignIdentity({ campaignId: existing >= 0 ? all[existing].campaignId : req.body.campaignId, name, config: req.body });
    const schedule = {
      campaignId: identity.campaignId, id, name: identity.name, cron: cronExpr, profileIds, sheetUrl,
      mode: mode || 'connect_only', templates: templates || {},
      dailyLimit: dailyLimit || 50,
      delayMin, delayMax,
      enabled: enabled !== false, lastRun: null,
      // The FULL launch the wizard would have sent to /api/campaign/start (primary
      // person, intro message, sender names, sheet tab, stop options…). The thin
      // fields above are kept for the schedules panel and as a fallback.
      launchBody: (req.body.launchBody && typeof req.body.launchBody === 'object') ? req.body.launchBody : (existing >= 0 ? all[existing].launchBody : undefined),
      // P-06 fix (2.8.18): never trust req.body.createdBy — that lets a
      // logged-in user spoof schedule ownership and redirect notification
      // emails to other operators. createdBy is always derived from req.user
      // (set by the auth middleware from the session cookie). For updates,
      // preserve the existing owner.
      createdBy: existing >= 0 ? (all[existing].createdBy || req.user) : req.user,
    };
    if (existing >= 0) { all[existing] = { ...all[existing], ...schedule }; }
    else { all.push(schedule); }
    await saveSchedules(all);
    registerSchedule(schedule);
    res.json({ saved: true, replaced, schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/schedules/:id', async (req, res) => {
  try {
    const all = await loadSchedules();
    const filtered = all.filter(s => s.id !== req.params.id);
    if (activeJobs.has(req.params.id)) {
      const { main, prefire } = activeJobs.get(req.params.id);
      main?.stop();
      prefire?.stop();
      activeJobs.delete(req.params.id);
    }
    await saveSchedules(filtered);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Company/domain blocklist (pre-flight linter) ─────────────────────────
app.get('/api/blocklist', (req, res) => {
  res.json({ entries: readBlocklist() });
});

app.post('/api/blocklist', (req, res) => {
  try {
    const entry = addBlocklistEntry({
      value: req.body?.value,
      reason: req.body?.reason || '',
      addedBy: req.body?.addedBy || '',
    });
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/blocklist', (req, res) => {
  res.json({ ok: removeBlocklistEntry(req.body?.value) });
});

// ---------------------------------------------------------------------------
// Campaign history (D-11)
// ---------------------------------------------------------------------------
const HISTORY_PATH = dataPath('history.json');

// v2.60.0 — Added optional ?includeArchived=false to hide soft-archived
// entries. Default behaviour (no query param) is unchanged: returns ALL
// entries, including archived, so existing callers keep working.
// v2.76: extract a Google Sheet id from its URL (…/spreadsheets/d/<id>/…).
function _sheetIdFromUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

// v2.76: collect every still-active background schedule (reply + bulk) and
// attach a `monitoring` summary to each history entry so the Past view can show
// "still monitoring · Nd left" and offer an on/off toggle.
async function _activeScheduleEntries() {
  const now = Date.now();
  let reply = [], bulk = [];
  try { reply = await listReplyCheckSchedule(); } catch { /* */ }
  try { bulk = await listPostCampaignSchedule(); } catch { /* */ }
  return [...reply, ...bulk].filter((e) => e && (!e.expiresAt || now < e.expiresAt));
}

function _monitoringForEntry(entry, active) {
  const sid = _sheetIdFromUrl(entry?.settings?.sheetUrl);
  const pids = entry?.settings?.profileIds || [];
  if (!sid || pids.length === 0) return { active: false, count: 0, expiresAt: null };
  const pidSet = new Set(pids);
  const matches = active.filter((e) => e.sheetId === sid && pidSet.has(e.profileId));
  const maxExp = matches.reduce((m, e) => Math.max(m, e.expiresAt || 0), 0);
  return { active: matches.length > 0, count: matches.length, expiresAt: maxExp || null };
}

app.get('/api/history', async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived !== 'false';
    const list = await listHistory({ includeArchived });
    const active = await _activeScheduleEntries();
    for (const entry of list) {
      try { entry.monitoring = _monitoringForEntry(entry, active); }
      catch { entry.monitoring = { active: false, count: 0, expiresAt: null }; }
    }
    res.json(list);
  } catch {
    res.json([]);
  }
});

// v2.76: turn a Past campaign's background tracking (reply + accept checks)
// on or off from the Past view. off → remove the schedule entries (browsers
// stop reopening). on → re-register reply tracking for its accounts.
app.post('/api/history/:idx/monitoring', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const on = !!(req.body && req.body.on);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid idx' });
    const list = await listHistory({ includeArchived: true });
    const entry = list[idx];
    if (!entry) return res.status(404).json({ error: 'No such history entry' });
    const sheetUrl = entry?.settings?.sheetUrl || '';
    const sheetId = _sheetIdFromUrl(sheetUrl);
    const profileIds = entry?.settings?.profileIds || [];
    if (!sheetId || profileIds.length === 0) {
      return res.status(400).json({ error: 'Campaign has no sheet/accounts to track' });
    }

    if (!on) {
      const removed = (await removeReplySchedules(sheetId, profileIds))
                    + (await removeBulkSchedules(sheetId, profileIds));
      return res.json({ ok: true, on: false, removed });
    }

    // Re-enable: register reply tracking for each account. Resolve names so the
    // scheduler's name→id step works; best-effort if GoLogin is unreachable.
    let idToName = {};
    try {
      const profiles = await getProfiles(process.env.GOLOGIN_API_TOKEN);
      for (const p of profiles) idToName[p.id] = p.name;
    } catch { /* names optional */ }
    const linkedinColumn = entry?.settings?.linkedinColumn || '';
    const days = entry?.settings?.acceptanceTrackingDays || 7;
    const operatorEmail = (await readSessionFromRequest(req)) || null;
    let added = 0;
    for (const pid of profileIds) {
      await registerReplySchedule({
        sheetId, sheetUrl, profileId: pid,
        profileName: idToName[pid] || pid,
        linkedinColumn, days, operatorEmail,
      });
      added++;
    }
    return res.json({ ok: true, on: true, added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/history', async (_req, res) => {
  try {
    await writeFile(HISTORY_PATH, '[]', 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.11.8: delete a single past-campaign entry by index. :idx is the on-disk
// index in history.json (the dashboard preserves it across the newest-first
// sort), matching the convention the rename endpoint already uses.
app.delete('/api/history/:idx', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid idx' });
    let history = [];
    try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf-8')); } catch { /* empty */ }
    if (!Array.isArray(history) || idx >= history.length) {
      return res.status(404).json({ error: 'No such history entry' });
    }
    history.splice(idx, 1);
    await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
    res.json({ ok: true, remaining: history.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.11.8: batch delete. Accepts { indexes: [int, ...] }. Sorts descending
// before splicing so removing earlier indexes doesn't shift later ones.
// Single-shot replacement of history.json — no partial-state risk.
app.post('/api/history/delete-batch', async (req, res) => {
  try {
    const { indexes } = req.body || {};
    if (!Array.isArray(indexes) || indexes.some(n => !Number.isInteger(n) || n < 0)) {
      return res.status(400).json({ error: 'indexes must be an array of non-negative integers' });
    }
    let history = [];
    try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf-8')); } catch { /* empty */ }
    if (!Array.isArray(history)) history = [];
    // Dedupe + sort descending so each splice doesn't invalidate later targets.
    const sorted = [...new Set(indexes)].sort((a, b) => b - a);
    let deleted = 0;
    for (const i of sorted) {
      if (i < history.length) {
        history.splice(i, 1);
        deleted++;
      }
    }
    await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
    res.json({ ok: true, deleted, remaining: history.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a past-campaign entry by its index in history.json. Index, not id,
// because legacy entries don't have ids. Sort order on the dashboard matches
// the on-disk array so :idx maps cleanly to what the operator clicked.
app.patch('/api/history/:idx/name', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Invalid idx' });
    const { name } = req.body || {};
    if (typeof name !== 'string') return res.status(400).json({ error: 'name must be a string' });

    let history = [];
    try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf-8')); } catch { /* empty */ }
    if (!Array.isArray(history) || idx >= history.length) {
      return res.status(404).json({ error: 'No such history entry' });
    }
    history[idx].name = name.trim();
    await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
    res.json({ ok: true, name: history[idx].name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.60.0 — Rerun a finished campaign by enqueuing a copy of its stored
// settings. The on-disk index :idx maps 1:1 to history.json (oldest-first).
// Logic lives in src/history-helpers.js#relaunchHistoryEntry — this route
// is a pure HTTP translator (result code → status code). Returns 422 when
// the history entry pre-dates the settings-capture change and has no
// rerunnable config.
// Blocklist hard-exclusion: no interactive gate here (unattended queue path).
// startCampaign's central guard (blocklistExcludedUrls) covers this path.
app.post('/api/history/:idx/relaunch', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const result = await relaunchHistoryEntry(idx);
    if (!result.ok) {
      if (result.code === 'invalid_idx') return res.status(400).json({ error: 'Invalid idx' });
      if (result.code === 'out_of_range') return res.status(404).json({ error: 'No such history entry' });
      if (result.code === 'missing_settings') return res.status(422).json({ error: 'history_entry_missing_settings' });
      return res.status(500).json({ error: 'unknown_error' });
    }
    // Operator expectation: rerun behaves like /api/campaign/start —
    // start immediately when idle, queue when a campaign is already
    // running. relaunchHistoryEntry always queues (FIFO-safe); we drain
    // the head here so an idle app fires the rerun right away instead of
    // leaving it parked in the queue.
    let started = false;
    if (!campaign.running) {
      try {
        await runNextFromQueue();
        started = true;
      } catch (err) {
        console.error('[history] Rerun drain failed:', err.message);
      }
    }
    res.json({
      ok: true,
      queueId: result.entry.id,
      started,
      queued: !started,
      message: started
        ? `Starting "${result.entry.name}" now`
        : `Queued "${result.entry.name}" — will start when current campaign finishes`,
      entry: result.entry,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.60.0 — Soft-archive a past campaign so it disappears from the
// dashboard's "Past" section without losing the underlying history record.
// Pair with GET /api/history?includeArchived=false to hide it from the UI.
app.patch('/api/history/:idx/archive', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const result = await archiveHistoryEntry(idx);
    if (!result.ok) {
      if (result.code === 'invalid_idx') return res.status(400).json({ error: 'Invalid idx' });
      if (result.code === 'out_of_range') return res.status(404).json({ error: 'No such history entry' });
      return res.status(500).json({ error: 'unknown_error' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.60.0 — Per-campaign filtered slice of data/campaign.log. The dashboard
// v0.3 Past dock "Open log" action calls this to show what a finished run
// actually did without dumping the entire shared log. Capped at last 500
// matching lines for UI responsiveness; { lines, name, total } in body.
app.get('/api/history/:idx/log', async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const result = await readCampaignLog(idx);
    if (!result.ok) {
      if (result.code === 'invalid_idx') return res.status(400).json({ error: 'Invalid idx' });
      if (result.code === 'out_of_range') return res.status(404).json({ error: 'No such history entry' });
      return res.status(500).json({ error: 'unknown_error' });
    }
    res.json({ lines: result.lines, name: result.name, total: result.total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CSV export (D-13, D-14, D-15)
// ---------------------------------------------------------------------------
const STATE_PATH = dataPath('state.json');

app.get('/api/export/csv', async (_req, res) => {
  try {
    let state;
    try {
      state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    } catch {
      return res.status(404).json({ error: 'No campaign data found' });
    }

    const processed = state.processed || {};
    const entries = Object.entries(processed);
    if (!entries.length) {
      return res.status(404).json({ error: 'No processed leads to export' });
    }

    // CSV header
    const columns = ['LinkedIn URL', 'Profile Used', 'Action', 'Date'];
    const rows = [columns.join(',')];

    for (const [url, data] of entries) {
      const row = [
        `"${url}"`,
        `"${(data.profileName || data.profileId || '').replace(/"/g, '""')}"`,
        `"${(data.action || '').replace(/"/g, '""')}"`,
        `"${data.date || ''}"`,
      ];
      rows.push(row.join(','));
    }

    const csv = rows.join('\n');
    const filename = `campaign-export-${new Date().toISOString().slice(0, 10)}.csv`;

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Campaign settings, kept by name (Ortus Basics 1.0) ─────────────────────
// Saved on Save and on Start; restored when a campaign of that name is opened.
// Keyed by name because an engine campaign id never survived a restart, which
// is why reopening a campaign kept coming back empty.
app.get('/api/campaign-configs', async (_req, res) => {
  try {
    const { listConfigs } = await import('./src/campaign-configs.js');
    res.json({ ok: true, configs: listConfigs() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/campaign-configs/:name', async (req, res) => {
  try {
    const { deleteConfig, normaliseName } = await import('./src/campaign-configs.js');
    const entry = req.query.campaignId ? getConfigById(String(req.query.campaignId)) : null;
    if (req.query.campaignId && !entry) return res.status(404).json({ error: 'Campaign not found.' });
    const key = normaliseName(entry?.name || req.params.name);
    const matches = row => entry ? row.campaignId === entry.campaignId : normaliseName(row.name) === key;
    const queue = await getQueue();
    if (((campaign.running || campaign.state === 'monitoring') && matches(campaign))
        || queue.some(matches)) {
      return res.status(409).json({ ok: false, error: 'Stop or remove this campaign from the queue before deleting its saved settings.' });
    }
    if (!deleteConfig(req.params.name, entry?.campaignId)) return res.status(404).json({ ok: false, error: 'Saved campaign not found.' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/campaign-configs/by-id/:campaignId', (req, res) => {
  const entry = getConfigById(req.params.campaignId);
  if (!entry) return res.status(404).json({ ok: false, error: 'Campaign not found.' });
  res.json({ ok: true, ...entry });
});

app.get('/api/campaign-configs/:name', async (req, res) => {
  try {
    const { getConfig } = await import('./src/campaign-configs.js');
    const entry = getConfig(req.params.name);
    if (!entry) return res.status(404).json({ ok: false, error: 'No saved settings for that campaign name.' });
    res.json({ ok: true, ...entry });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Rename a campaign everywhere it is named, in one call.
//
// A campaign's name is its identity: settings are keyed by it, and the board
// reads it from the run history. Renaming used to touch neither — Save wrote a
// SECOND settings record under the new name and the board kept showing the old
// one (operator, 2026-09-04). All three stores move together here, or the
// campaign ends up existing twice.
app.post('/api/campaign-configs/rename', async (req, res) => {
  try {
    const from = String(req.body?.from || '').trim();
    const to = String(req.body?.to || '').trim();
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    const { renameConfig } = await import('./src/campaign-configs.js');
    const moved = renameConfig(from, to, req.body?.campaignId);
    // 'missing' just means this campaign had no saved settings yet — the board
    // rename below is still worth doing. A clash is fatal: two campaigns must
    // not collapse into one record.
    if (!moved.ok && moved.reason === 'clash') {
      return res.status(409).json({ error: `A campaign named "${to}" already exists` });
    }
    if (!moved.ok && moved.reason === 'invalid') {
      return res.status(400).json({ error: 'Invalid name' });
    }

    // The dashboard's local campaigns read their name from the run history.
    let historyRenamed = 0;
    try {
      let history = [];
      try { history = JSON.parse(await readFile(HISTORY_PATH, 'utf-8')); } catch { /* none yet */ }
      if (Array.isArray(history)) {
        const key = (v) => String(v || '').trim().toLowerCase();
        for (const entry of history) {
          if (entry && (entry.campaignId ? entry.campaignId === moved.campaignId : key(entry.name) === key(from))) { entry.name = to; historyRenamed += 1; }
        }
        if (historyRenamed) await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
      }
    } catch (err) {
      console.warn('[rename] history rename failed:', err.message);
    }

    // Drafts. The dashboard lists these by name, so a draft left on the old
    // name is a renamed campaign that reappears under its old one.
    let draftsRenamed = 0;
    try {
      const { renameDrafts } = await import('./src/drafts.js');
      draftsRenamed = await renameDrafts(from, to, moved.campaignId);
    } catch (err) {
      console.warn('[rename] draft rename failed:', err.message);
    }

    // And the per-run snapshots, which the wizard falls back to.
    let snapshotsRenamed = 0;
    try {
      const { renameCloudLaunchConfigs } = await import('./src/cloud-launch-configs.js');
      snapshotsRenamed = await renameCloudLaunchConfigs(from, to);
    } catch (err) {
      console.warn('[rename] launch-config rename failed:', err.message);
    }

    // A campaign running right now carries its name in memory too.
    try {
      if (campaign && (campaign.campaignId ? campaign.campaignId === moved.campaignId : String(campaign.name || '').trim().toLowerCase() === from.toLowerCase())) {
        setCampaignName(to);
      }
    } catch (_) { /* nothing running */ }

    res.json({ ok: true, campaignId: moved.campaignId, name: to, settingsMoved: !!moved.ok, historyRenamed, draftsRenamed, snapshotsRenamed });
  } catch (err) {
    console.error('[campaign-configs] rename failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaign-configs', async (req, res) => {
  try {
    const { saveConfig } = await import('./src/campaign-configs.js');
    const { name, config } = req.body || {};
    if (!String(name || '').trim()) {
      return res.status(400).json({ ok: false, error: 'A campaign needs a name before its settings can be saved.' });
    }
    res.json({ ok: true, saved: saveConfig(name, config, { campaignId: req.body?.campaignId || config?.campaignId, listed: true }) });
  } catch (err) {
    console.error('[campaign-configs] save failed:', err);
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ── GoLogin workspace tokens (Ortus Basics 1.0) ────────────────────────────
// The app ships with no secrets. These two routes are the Settings stage: the
// operator pastes the tokens they hold, and the workspaces those tokens unlock
// become selectable. Nothing here ever echoes a token back.
app.get('/api/credentials', async (_req, res) => {
  try {
    const { credentialStatus, readOthers } = await import('./src/gologin-credentials.js');
    res.json({ ok: true, credentials: credentialStatus(), others: readOthers() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/credentials', async (req, res) => {
  try {
    const { saveCredentials, credentialStatus } = await import('./src/gologin-credentials.js');
    const body = req.body || {};
    // Only the known token names are accepted — an arbitrary key would end up
    // in process.env, which is not somewhere untrusted input belongs.
    const { credentialFields } = await import('./src/gologin-credentials.js');
    const allowed = new Set(credentialFields().map((f) => f.env));
    const input = {};
    for (const [k, v] of Object.entries(body)) if (allowed.has(k)) input[k] = v;
    // `others` is the operator's own workspace list — replaced wholesale.
    if (Array.isArray(body.others)) {
      const { saveOthers } = await import('./src/gologin-credentials.js');
      saveOthers(body.others);
    }
    if (!Object.keys(input).length && !Array.isArray(body.others)) {
      return res.status(400).json({ ok: false, error: 'No known token fields in the request.' });
    }
    if (!Object.keys(input).length) {
      const { readOthers } = await import('./src/gologin-credentials.js');
      return res.json({ ok: true, credentials: credentialStatus(), others: readOthers() });
    }
    saveCredentials(input);
    res.json({ ok: true, credentials: credentialStatus() });
  } catch (err) {
    console.error('[credentials] save failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
migrateCampaignIdentities();

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`\n  ✦ Ortus Basics — Version ${APP_VERSION}`);
  console.log(`  ✦ build: v${APP_VERSION}`);
  console.log(`  ✦ Dashboard: http://localhost:${PORT}`);
  startAmbientSampling(getActiveBrowserPids);
  console.log(`  ✦ GoLogin token: ${process.env.GOLOGIN_API_TOKEN ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`  ✦ Sheet tracking: ✓ centralized (Antonio's Apps Script)`);

  await initNotifier();
  console.log(`  ✦ Notifications: ${process.env.SMTP_HOST ? 'email enabled' : 'email DISABLED — set SMTP_HOST/PORT/USER/PASS + NOTIFY_EMAILS'}\n`);

  // Warm the Sales Nav board so the FIRST open is instant too, not just later
  // ones. Deliberately not awaited — the engine fetch takes ~8s and must not
  // hold up boot. Failure is silent: the route falls back to fetching on demand.
  refreshScrapeBoardOnce()
    .then((b) => console.log(`  ✦ Sales Nav board: warmed (${(b.campaigns || []).length} scrapes)`))
    .catch((e) => console.log(`  ✦ Sales Nav board: warm-up failed (${e.message}) — will load on demand`));

  // Same for the central FG sheet: fgState is a 78s read (15k+ invite rows) and
  // every FG surface needs it — the db view, the colleague roster, the budgets.
  // Reading it once here means the first FG open is served from cache like the
  // rest. Not awaited; getFgState coalesces, so a visit during the warm-up joins
  // this read instead of starting a second one.
  getFgState()
    .then((s) => console.log(`  ✦ FG sheet: warmed (${s.invites.length} invite rows)`))
    .catch((e) => console.log(`  ✦ FG sheet: warm-up failed (${e.message}) — will load on demand`));

  // Collected connections used to live in the repo's own data/connections, so
  // running the app from a worktree hid all 455 of them. They belong in
  // ORTUS_DATA_DIR; this copies them across once and never deletes the original.
  try {
    const mig = magellanMigrateLegacy();
    if (mig.moved) console.log(`  ✦ Magellan: copied ${mig.moved} collected account file(s) into ${mig.to}`);
  } catch (e) { console.log(`  ✦ Magellan: could not copy the old connections folder (${e.message})`); }

  // Same reasoning for Magellan's account roster: read it once at boot so the
  // first visit to the tab is served from cache like every later one, instead of
  // being the single request that has to wait out a contended Apps Script.
  refreshMagellanSoo()
    .then((e) => console.log(`  ✦ Magellan roster: ${e.length ? `warmed (${e.length} accounts)` : 'warm-up returned nothing — will retry on demand'}`));

  // Bulk "Delete all drafts" soft-deletes (trashedAt); hard-purge anything past
  // the 1-week grace on boot, then daily.
  const _purgeDrafts = () => purgeTrashedDrafts().then((n) => { if (n) console.log(`  ✦ Purged ${n} draft(s) past the 1-week trash window.`); }).catch(() => {});
  _purgeDrafts();
  setInterval(_purgeDrafts, 24 * 60 * 60 * 1000);

  // Post-campaign sweeps power the CC+IC auto-intro DM (and bulk-check
  // refresh for any other registered entry). Each tick respects per-entry
  // cooldown + 7-day expiry; runAutoIntros only fires for entries that
  // carry primaryName/primaryIntroBody, so Check Status-only entries are
  // bulk-checked but never DM'd.
  // Ortus Basics 1.0: no automatic acceptance sweeps. This 30-min scheduler was
  // the last automatic checker left — the monitoring watcher is already a no-op
  // and shouldAutoFireCheck() returns false. Every check is now operator-driven
  // via ⚡ Check now. (was: startPostCampaignScheduler();)
  // v2.72: hourly reply tracking for message-sending campaigns (never in the
  // first hour, ≤1×/hour per account). Writes replies to the sheet + the
  // in-app replies panel; desktop/email alerts are opt-in.
  startReplyCheckScheduler();

  // Load and register saved schedules (D-05)
  loadSchedules().then(async (schedules) => {
    // One schedule per campaign. Older builds added a run per press, so collapse
    // any leftovers to the MOST RECENTLY CREATED one (ids are sched_<timestamp>).
    const newest = new Map();
    for (const sch of schedules) {
      if (!sch.campaignId) continue;
      const stamp = Number(String(sch.id || '').replace(/\D/g, '')) || 0;
      const cur = newest.get(sch.campaignId);
      if (!cur || stamp > cur.stamp) newest.set(sch.campaignId, { id: sch.id, stamp });
    }
    const kept = schedules.filter((sch) => !sch.campaignId || newest.get(sch.campaignId).id === sch.id);
    if (kept.length !== schedules.length) {
      console.log(`[scheduler] Removed ${schedules.length - kept.length} duplicate schedule(s) — one schedule per campaign.`);
      try { await saveSchedules(kept); } catch (err) { console.warn('[scheduler] could not save de-duplicated schedules:', err.message); }
      schedules = kept;
    }
    for (const s of schedules) registerSchedule(s);
    if (schedules.length) console.log(`  ✦ Schedules: ${schedules.filter(s => s.enabled).length} active of ${schedules.length} total`);
  }).catch(err => console.error('Failed to load schedules:', err.message));

  // v2.14 — resume any in-flight monitoring state from disk before the watcher
  // starts, so the campaign global is populated on the first watcher tick.
  // Gated on operator identity — a resumed monitoring loop runs acceptance
  // checks that flip accounts "In Use", so it must not run anonymously. Skip
  // quietly (no boot-time notify spam); the load-time modal prompts the human.
  if (UI_PREVIEW) {
    console.log('[boot] UI preview — monitoring resume, task runner, follow-up poller and queue drain are OFF');
  } else if (getOperatorEmail()) {
    resumeMonitoringFromDisk()
      .then((r) => {
        if (r.action !== 'noop') console.log('[boot] monitoring:', r.action);
      })
      .catch((err) => console.warn('[boot] monitoring resume failed:', err.message));
  } else {
    console.error('[boot] monitoring resume skipped — no operator email set on this machine');
  }

  // v2.14 — start the T+7d monitoring auto-end watcher
  if (!UI_PREVIEW) startMonitoringWatcher();

  // Cloud-FG write-back: reconcile on boot, then every 30s while the app is open.
  reconcileFgCloudRuns().catch(() => {});
  setInterval(() => { reconcileFgCloudRuns().catch(() => {}); }, 30_000);

  // v2.91 — drain primary-side automation tasks (auto-accept + first follow-up)
  // in idle gaps, one browser at a time, gated on the global browser semaphore.
  if (!UI_PREVIEW) startPrimaryTaskRunner();

  // Pull a cloud campaign's PERSONAL-primary follow-ups down to this machine and
  // enqueue them into the same local runner (the VM can't safely send as a
  // personal account). GoLogin primaries send on the VM, untouched.
  // Ortus Basics 1.0: cloud campaigns are discontinued — no follow-up poller.
  // (was: if (!UI_PREVIEW) startCloudFollowupPoller();)

  // Drain the campaign queue at startup. If the server crashed/restarted
  // while items were queued, this auto-promotes the next one to active so
  // the operator doesn't have to re-trigger anything.
  if (!UI_PREVIEW) setTimeout(() => {
    runNextFromQueue().catch(err => console.error('Startup queue drain failed:', err.message));
  }, 1000);
});

// ---------------------------------------------------------------------------
// Disk-status endpoint (Phase 2.8.20 / W3-C2) — read-only free-bytes check.
// ---------------------------------------------------------------------------
app.get('/api/disk-status', async (_req, res) => {
  const status = await checkDiskFree();
  res.json(status);
});

// ---------------------------------------------------------------------------
// Persisted errors endpoint (Phase 2.8.20 / W1-B2) — read-only.
// Returns the contents of data/errors.log.json (empty array if missing).
// ---------------------------------------------------------------------------
app.get('/api/errors', async (_req, res) => {
  try {
    const raw = await readFile(dataPath('errors.log.json'), 'utf8');
    const arr = JSON.parse(raw);
    res.json(Array.isArray(arr) ? arr : []);
  } catch (_) {
    res.json([]);
  }
});

app.get('/api/warnings', async (_req, res) => {
  try {
    const buf = await readFile(dataPath('warnings-log.ndjson'), 'utf-8').catch(() => '');
    const lines = buf.split('\n').filter(Boolean);
    const warnings = lines
      .slice(-200)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    res.json({ warnings });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// Notification status endpoint (Phase 2.8.19 / C4) — read-only check of SMTP
// configuration so the sidebar Notifications panel can show "wired" /
// "not configured" without dialing out.
// ---------------------------------------------------------------------------
app.get('/api/notify/status', (_req, res) => {
  res.json({ smtpConfigured: !!process.env.SMTP_HOST });
});

// Per-operator notification preferences (sidebar toggles).
app.get('/api/notification-prefs', async (req, res) => {
  try {
    const prefs = await getNotificationPrefs(req.user);
    res.json({ ok: true, prefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notification-prefs', async (req, res) => {
  try {
    const patch = req.body || {};
    const next = await setNotificationPrefs(req.user, patch);
    res.json({ ok: true, prefs: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v2.58.x — per-operator preferences (timezone today). Stored locally,
// keyed by the signed-in email. Campaign launcher's tz becomes the
// stamping authority for sheet timestamps (Apps Script honours it when
// present, falls back to project timezone otherwise).
app.get('/api/operator-prefs', async (req, res) => {
  try {
    const prefs = await getOperatorPrefs(req.user);
    res.json({ ok: true, prefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/operator-prefs', async (req, res) => {
  try {
    const patch = req.body || {};
    // tz is the only field for now; pass-through validation lives here so
    // garbage strings can't reach the bot. Empty string is allowed and means
    // "no preference" (skip the modal next time, fall back to GAS default).
    if (patch.tz !== undefined && typeof patch.tz !== 'string') {
      return res.status(400).json({ error: 'tz must be a string' });
    }
    // v2.113: pre-send identity safeguard toggle (boolean, sticky per-operator).
    if (patch.identityGate !== undefined && typeof patch.identityGate !== 'boolean') {
      return res.status(400).json({ error: 'identityGate must be a boolean' });
    }
    const next = await setOperatorPrefs(req.user, patch);
    res.json({ ok: true, prefs: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-machine operator identity — the email stamped as the reserver in the SoO
// 'CC User App' column. Mandatory: campaign start is gated on it (see below),
// because the shared dashboard login can't identify who's actually operating.
app.get('/api/operator-identity', (req, res) => {
  const email = getOperatorEmail();
  res.json({ ok: true, email, set: !!email });
});

app.post('/api/operator-identity', (req, res) => {
  try {
    const email = (req.body && req.body.email != null) ? String(req.body.email).trim() : '';
    if (!email || !isPlausibleEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    const saved = setOperatorEmail(email);
    res.json({ ok: true, email: saved, set: !!saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Renderer poll: pull recent desktop notifications since the last poll.
// Filters by the signed-in operator so other operators' personal reminders
// don't appear in this user's tab. Items with audience=null are broadcast.
app.get('/api/notifications/recent', (req, res) => {
  const since = Number.parseInt(req.query.since, 10) || 0;
  const items = getRecentNotifications({ sinceTs: since, audience: req.user });
  res.json({ items, now: Date.now() });
});

// ---------------------------------------------------------------------------
// Debrief email endpoint — MANUAL operator click ("Email to me" in the
// debrief overlay). No automatic/background sending — the operator must
// explicitly click the button each time. Complies with the auto-send-OFF rule.
// ---------------------------------------------------------------------------
app.post('/api/debrief/email', async (req, res) => {
  try {
    const { subject, body } = req.body || {};
    if (!subject || !body) return res.status(400).json({ ok: false, error: 'subject and body required' });
    // "Email to me" — send only to the operator who clicked, not the whole
    // NOTIFY_EMAILS list (mirror POST /api/notify/test, which uses req.user).
    const result = await notifyEmail(req.user, { title: String(subject), body: String(body) });
    res.json({ ok: true, recipient: req.user, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Notification test endpoint — sends a test email to configured recipients
// ---------------------------------------------------------------------------
app.post('/api/notify/test', async (req, res) => {
  try {
    const result = await notifyEmail(req.user, {
      title: 'Ortus test notification',
      body: 'If you see this, email notifications are wired up correctly.',
      link: '/',
    });
    res.json({ ok: true, recipient: req.user, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Dev tools — Preview intro DM (pure text, no LinkedIn interaction)
// Fetches the first row from the configured sheet, runs personalizeTemplate
// with the same data dict that auto-intro uses, and returns the resolved body
// + title so the operator can catch stale placeholders before a campaign run.
// ---------------------------------------------------------------------------
app.post('/api/preview-intro-dm', async (req, res) => {
  try {
    const { sheetUrl, introBody, primaryName, primaryUrl, introTitle } = req.body || {};
    if (!sheetUrl)    return res.status(400).json({ error: 'sheetUrl required' });
    if (!introBody)   return res.status(400).json({ error: 'introBody required' });
    if (!primaryName) return res.status(400).json({ error: 'primaryName required' });

    const { personalizeTemplate } = await import('./src/linkedin/helpers.js');
    const { fetchSheet }          = await import('./src/sheets.js');

    let rows = [];
    try {
      rows = await fetchSheet(sheetUrl);
    } catch (e) {
      return res.status(400).json({ error: `Sheet fetch failed: ${e.message}` });
    }

    if (!rows.length) {
      return res.status(400).json({ error: 'Sheet has no rows' });
    }

    // Use the first row as the sample lead.
    const row = rows[0];

    // Mirror the introData dict built in outreach.js (case 'message', introMode).
    // The row is spread verbatim so raw column names (e.g. "First Name") resolve
    // directly; we also add normalised lowercase-spaced aliases that operators
    // typically write in their body copy.
    const introTokens = String(primaryName).trim().split(/\s+/);
    const introFirst  = introTokens[0] || '';
    const introLast   = introTokens.slice(1).join(' ');

    const data = {
      // Raw row — resolves whatever casing the operator actually used as a header
      ...row,
      // Normalised aliases for the most common lead name placeholders
      'first name': (row['First Name'] || row['first name'] || row['firstName'] || row['first_name'] || '').trim(),
      'last name':  (row['Last Name']  || row['last name']  || row['lastName']  || row['last_name']  || '').trim(),
      'name':       (row['Name']       || row['name']       || '').trim() ||
                    `${(row['First Name'] || row['first name'] || '').trim()} ${(row['Last Name'] || row['last name'] || '').trim()}`.trim(),
      'company':    (row['Company']    || row['company']    || '').trim(),
      // Primary / intro person tokens — all naming variants accepted by outreach.js
      'primary name': primaryName,
      'primary url':  primaryUrl || '',
      'intro name':       primaryName,
      'introName':        primaryName,
      'intro_name':       primaryName,
      'intro first name': introFirst,
      'introFirstName':   introFirst,
      'intro_first_name': introFirst,
      'intro last name':  introLast,
      'introLastName':    introLast,
      'intro_last_name':  introLast,
    };

    const resolvedBody  = personalizeTemplate(introBody, data);
    const resolvedTitle = personalizeTemplate(
      introTitle || 'Introduction: {firstName} <> {primaryFirstName}',
      data
    );

    // Surface any remaining unresolved placeholders as a warning.
    const bodyLeftovers  = resolvedBody.match(/\{[^}]+\}/g)  || [];
    const titleLeftovers = resolvedTitle.match(/\{[^}]+\}/g) || [];
    const unresolvedPlaceholders = [...new Set([...bodyLeftovers, ...titleLeftovers])];

    res.json({
      ok: true,
      sampleLead: {
        firstName: data['first name'],
        lastName:  data['last name'],
        company:   data['company'],
      },
      resolvedTitle,
      resolvedBody,
      primaryName,
      primaryUrl: primaryUrl || '',
      unresolvedPlaceholders,
    });
  } catch (err) {
    console.error('[preview-intro-dm] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// v2.14.x — Diagnostic: navigate a URL inside a specific GoLogin profile and
// report what URL the page ACTUALLY ends up on (after redirects + JS-driven
// nav). Built to investigate the Sales-Nav redirect issue: paste the
// /messaging/compose/?recipient=… URL, see if LinkedIn server-side reroutes
// to /sales/lead/…, capture a screenshot of where we landed.
//
// Usage from terminal (port shows on dev:app boot — currently 61044):
//   curl -X POST http://localhost:<PORT>/api/diagnostic/navigate \
//     -H 'Content-Type: application/json' \
//     -d '{"profileEmail":"marife.espeleta@ortus.solutions","url":"https://www.linkedin.com/messaging/compose/?recipient=hannah-gywneth-samson-085a83378"}'
//
// Response includes the inputUrl we asked for, finalUrl after redirects,
// the full transition list (every URL the main frame visited), title,
// whether Sales Nav was detected, and a screenshot path. Refuses to run if
// a campaign is currently active so it doesn't fight for the semaphore.
// ---------------------------------------------------------------------------
app.post('/api/diagnostic/navigate', async (req, res) => {
  if (campaign.running) {
    return res.status(409).json({ error: 'A campaign is currently running. Stop it first to use the diagnostic.' });
  }
  const { profileEmail, profileId: profileIdRaw, url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!profileEmail && !profileIdRaw) {
    return res.status(400).json({ error: 'profileEmail or profileId required' });
  }
  const token = process.env.GOLOGIN_API_TOKEN;
  let profileId = profileIdRaw;
  let resolvedFromEmail = null;
  if (!profileId && profileEmail) {
    try {
      const allProfiles = await getProfiles(token);
      const match = allProfiles.find((p) => String(p.name || '').toLowerCase() === String(profileEmail).toLowerCase());
      if (!match) {
        return res.status(404).json({ error: `Profile not found for email: ${profileEmail}` });
      }
      profileId = match.id;
      resolvedFromEmail = match.name;
    } catch (err) {
      return res.status(500).json({ error: `Profile resolution failed: ${err.message}` });
    }
  }

  const { closeProfile: _closeProfile } = await import('./src/gologin-launcher.js');

  let launched;
  try {
    launched = await launchProfile(profileId, token);
  } catch (err) {
    return res.status(500).json({ error: `Launch failed: ${err.message}` });
  }
  const page = launched.page;

  const transitions = [];
  const navListener = (frame) => {
    try {
      if (frame === page.mainFrame()) {
        transitions.push({ at: new Date().toISOString(), url: frame.url() });
      }
    } catch { /* */ }
  };
  page.on('framenavigated', navListener);

  let navError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    navError = err.message;
  }
  // Let any client-side / meta-refresh redirects play out.
  await new Promise(r => setTimeout(r, 5000));

  let finalUrl = '';
  let title = '';
  try { finalUrl = page.url(); } catch { /* */ }
  try { title = await page.title(); } catch { /* */ }

  // Screenshot for visual confirmation of where we landed.
  const ts = Date.now();
  const screenshotPath = `/tmp/ortus-diagnose-${ts}.png`;
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch (e) {
    console.warn(`[diagnostic] screenshot failed: ${e.message}`);
  }

  // Capture the visible DOM landmarks — different LinkedIn surfaces have
  // distinct top-bar markers. Helps identify Sales Nav vs regular UI.
  let landmarks = {};
  try {
    landmarks = await page.evaluate(() => {
      const out = {};
      out.hasSalesNavBar  = !!document.querySelector('#sales-nav-app-banner, .global-nav__nav, [data-control-name*="sales"]');
      out.hasMessagingForm = !!document.querySelector('.msg-form__contenteditable, div[role="textbox"][aria-label*="Write a message" i]');
      out.hasSalesCompose = !!document.querySelector('.lead-message-form, .ml-message-form, .msg-overlay-list-bubble');
      out.bodyTextSample  = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return out;
    });
  } catch { /* */ }

  page.off('framenavigated', navListener);
  try { await _closeProfile(profileId); } catch { /* */ }

  res.json({
    profileEmail: profileEmail || resolvedFromEmail,
    profileId,
    inputUrl: url,
    finalUrl,
    redirected: !!finalUrl && finalUrl !== url,
    salesNavDetected: !!finalUrl && finalUrl.includes('/sales/'),
    transitionCount: transitions.length,
    transitions,
    title,
    landmarks,
    navError,
    screenshotPath,
  });
});

// ---------------------------------------------------------------------------
// Phase 2.8.20 (W1-C1) — fatal-error sink. Sync write because the process is
// already dying — async writes risk being dropped before the event loop ends.
// Line-delimited JSON (NDJSON) keeps appends cheap and partial-write-safe.
// ---------------------------------------------------------------------------
function appendFatalErrorSync(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(dataPath('fatal-errors.log'), line);
  } catch (_) { /* truly nothing left to do */ }
}

// ---------------------------------------------------------------------------
// Graceful shutdown — close GoLogin profiles on SIGINT/SIGTERM (REL-03)
// ---------------------------------------------------------------------------
async function gracefulShutdown(signal) {
  console.log(`\n[shutdown] ${signal} received. Shutting down... waiting for current lead`);
  // Say it is a quit, not a Stop press. stopReason stays 'operator-stopped' on
  // purpose — the dashboard keys off that value.
  stopCampaign({ quitting: true });

  // Wait for current lead to finish (campaign loop checks _abort between leads)
  const deadline = Date.now() + 30000;
  while (campaign.running && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }

  const count = await closeAllProfiles();
  await closeLocalBrowser();
  console.log(`[shutdown] Closing ${count} profiles...`);
  // Drain the central Operations Log buffer before exit — otherwise the last
  // 0–30s of buffered events (the ones not yet auto-flushed) are lost on every
  // quit/relaunch. Timeout-guarded so a dead network can't hang shutdown.
  try {
    await Promise.race([flushOpsLog(), new Promise((r) => setTimeout(r, 4000))]);
  } catch (_) { /* fire-and-forget */ }
  console.log('[shutdown] Done.');
  process.exit(_recoveryExitRequested ? 75 : 0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Phase 2.8.20 (W1-C1) — catch crashes that would otherwise leave orphan
// browsers and skip the cloud-commit phase. Writes a fatal-error line
// synchronously, then runs the same graceful shutdown path.
process.on('uncaughtException', (err) => {
  appendFatalErrorSync({
    at: new Date().toISOString(),
    kind: 'uncaughtException',
    message: err && err.message ? err.message : String(err),
    stack:   err && err.stack   ? err.stack   : '',
  });
  console.error(`[fatal] uncaughtException: ${err && err.message}`);
  gracefulShutdown('FATAL').catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack   = reason instanceof Error ? reason.stack   : '';
  appendFatalErrorSync({
    at: new Date().toISOString(),
    kind: 'unhandledRejection',
    message,
    stack,
  });
  console.error(`[fatal] unhandledRejection: ${message}`);
  gracefulShutdown('FATAL').catch(() => process.exit(1));
});
