/**
 * Post-campaign acceptance tracking.
 *
 * After a campaign ends, each (sheet, profile) used during the run is
 * registered for a configurable window (default 7 days). A background
 * scheduler ticks every 30 min and runs a bulk Connection Status sweep on
 * any entry whose 6h cooldown has elapsed and whose window hasn't expired.
 *
 * The bot must be running for sweeps to fire. If the operator closes the
 * Electron window, sweeps pause; they resume on the next boot's first tick.
 *
 * Persistent state lives in `data/post-campaign-bulk-check.json` so the
 * scheduler can recover from crashes and restarts.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dataPath } from './paths.js';
import { launchProfile, closeProfile } from './gologin-launcher.js';
import { flushSheetWrites } from './sheets-writer.js';
import * as browserSemaphore from './browser-semaphore.js';
import { bulkCheckConnections } from './linkedin/bulk-check-connections.js';
import { runAutoIntros } from './linkedin/auto-intro.js';
import { runAutoDms } from './linkedin/auto-dm.js';
import { notifyEmail, enqueueDesktopNotification } from './notifier.js';
import { getPrefs } from './notification-prefs.js';
import { appendCampaignLog } from './campaign-log-bus.js';

const SCHEDULE_FILE = dataPath('post-campaign-bulk-check.json');
const TICK_INTERVAL_MS = 30 * 60 * 1000;
const SWEEP_COOLDOWN_MS = 6 * 60 * 60 * 1000; // per (sheet, profile)

let _tickTimer = null;

async function readSchedule() {
  try { return JSON.parse(await readFile(SCHEDULE_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeSchedule(s) {
  try { await writeFile(SCHEDULE_FILE, JSON.stringify(s, null, 2)); }
  catch (err) { console.warn(`[post-campaign] write failed: ${err.message}`); }
}

function key(sheetId, profileId) { return `${sheetId}|${profileId}`; }

/**
 * Decide whether a post-campaign sweep entry should fire a group intro.
 *
 * Only CC+IC (connect_and_introduce) ever sends a post-acceptance group
 * intro. The mode gate is load-bearing: a CC+DM campaign launched after a
 * CC+IC config was filled in carries leftover primaryName/primaryIntroBody
 * on its schedule entry, and without this check the sweep would send a real
 * group intro on a plain DM campaign. The in-campaign path is already
 * mode-gated (campaign.js willAutoIntro); this mirrors that guard for the
 * background sweep so neither path can fire an intro for the wrong mode.
 */
export function shouldFirePostCampaignIntro(entry, connectedUrls) {
  if (!entry) return false;
  if (!Array.isArray(connectedUrls) || connectedUrls.length === 0) return false;
  if (entry.mode !== 'connect_and_introduce') return false;
  if (entry.skipIntroductions === true) return false;
  return !!(entry.primaryName && entry.primaryIntroBody);
}

/**
 * Decide whether a post-campaign sweep entry should fire a 1:1 auto-DM.
 *
 * The CC+DM counterpart of shouldFirePostCampaignIntro. Only CC+DM
 * (connect_and_message) entries with a persisted DM body fire here. Without
 * this the post-campaign sweep stamped acceptances as Connected but never sent
 * the post-acceptance DM — the auto-DM dispatch + the persisted ccDmBody were
 * both missing on this path (the in-campaign and in-app monitoring paths
 * already handle CC+DM via willAutoDm). Mode-gated so it's mutually exclusive
 * with the intro gate.
 */
export function shouldFirePostCampaignDm(entry, connectedUrls) {
  if (!entry) return false;
  if (!Array.isArray(connectedUrls) || connectedUrls.length === 0) return false;
  if (entry.mode !== 'connect_and_message') return false;
  return !!entry.ccDmBody;
}

/**
 * Rebuild the `{ profileId: firstName }` map runAutoIntros/runAutoDms read from
 * a schedule entry's single persisted name. Entries written before this shipped
 * have no senderFirstName — those return {} and the send path keeps its old
 * email-split fallback, so an old entry degrades exactly as it does today
 * instead of throwing.
 */
export function senderFirstNamesFor(entry) {
  const name = (entry && entry.senderFirstName || '').trim();
  if (!name || !entry.profileId) return {};
  return { [entry.profileId]: name };
}

// Lazy import to avoid a load-time circular dep with campaign.js (which
// also imports from this file). Resolved at call time, never at module init.
async function isCampaignRunning() {
  try {
    const m = await import('./campaign.js');
    return !!(m.campaign && m.campaign.running);
  } catch { return false; }
}

/**
 * Register (or refresh) a post-campaign acceptance window.
 *
 * Called by campaign.js's finally block once per (sheet, profile) that
 * actually sent at least one invite. Re-registration extends the window
 * — the new expiry is `now + days`.
 */
export async function registerSchedule({ sheetId, sheetUrl, profileId, profileName, linkedinColumn, days,
                                          operatorEmail,
                                          mode = '', primaryName = '', primaryIntroBody = '',
                                          primaryUrl = '', introTitle = '', ccDmBody = '',
                                          autoAcceptPrimary = false, followUpEnabled = false,
                                          followUpBody = '', followUpDelayMinutes = 10,
                                          primarySource = 'local-browser',
                                          senderFirstName = '',
                                          skipIntroductions = false,
                                          sweepIntervalMs = null }) {
  if (!sheetId || !profileId || !Number.isFinite(days) || days <= 0) return;
  const sched = await readSchedule();
  const k = key(sheetId, profileId);
  const now = Date.now();
  sched[k] = {
    sheetId,
    sheetUrl,
    profileId,
    profileName: profileName || profileId,
    linkedinColumn: linkedinColumn || '',
    operatorEmail: operatorEmail || sched[k]?.operatorEmail || null,
    // "Connections only": this campaign never introduces, not even post-campaign.
    skipIntroductions: skipIntroductions === true,
    // Connect + Introduce Back: persist the primary fields so each
    // post-campaign sweep can fire the auto-intro DM after the
    // bulk-check stamps Connected.
    mode: mode || '',
    primaryName: primaryName || '',
    primaryIntroBody: primaryIntroBody || '',
    primaryUrl: primaryUrl || '',
    introTitle: introTitle || '',
    // v2.59.x: CC+DM post-acceptance body — persisted so the sweep can fire the
    // 1:1 auto-DM (runAutoDms reads templates.ccDmBody). Was previously dropped,
    // so even with a DM dispatch the body wouldn't have survived to send time.
    ccDmBody: ccDmBody || '',
    // v2.91: primary-side automation config carried into the post-campaign sweep
    autoAcceptPrimary: !!autoAcceptPrimary,
    followUpEnabled: !!followUpEnabled,
    followUpBody: followUpBody || '',
    followUpDelayMinutes: Number(followUpDelayMinutes) > 0 ? Number(followUpDelayMinutes) : 10,
    primarySource: (primarySource && primarySource !== 'local-browser') ? primarySource : 'local-browser',
    // The operator-configured nice name for THIS account, so a sweep days later
    // signs the intro/DM the same way the campaign itself did. The entry is
    // per-(sheet, profile), so one string is the whole map: senderFirstNamesFor
    // rebuilds the {profileId: name} shape runAutoIntros/runAutoDms expect.
    // Without it those two paths fell through to `profileName.split(' ')[0]` —
    // and profileName is the GoLogin label, i.e. the account's EMAIL. Every
    // post-campaign intro carrying {sender first name} went out signed
    // "nabungaires@gmail.com". The in-campaign and in-app monitoring paths both
    // carried the name already (monitoring-persistence.js persists it); this
    // background sweep was the one path that didn't.
    senderFirstName: senderFirstName || '',
    // v2.148: per-entry sweep interval derived from the campaign's operator
    // cadence (checkIntervalMinutes). null → scheduler's 6h SWEEP_COOLDOWN_MS.
    sweepIntervalMs: Number(sweepIntervalMs) > 0 ? Number(sweepIntervalMs) : null,
    registeredAt: (sched[k]?.registeredAt) || now,
    expiresAt: now + days * 86400000,
    // The campaign's own bulk-check just ran, so no need to immediately
    // sweep again — set lastCheckedAt to "now" so the cooldown applies.
    lastCheckedAt: now,
  };
  await writeSchedule(sched);
  console.log(`[post-campaign] Registered ${profileName || profileId} on sheet ${sheetId} for ${days}d (expires ${new Date(sched[k].expiresAt).toISOString()}, owner: ${sched[k].operatorEmail || 'none'})`);
}

/**
 * Reminder for the operator: "we're about to launch a connection check for
 * accounts A, B, C." Fires both an email and a desktop popup. Groups by
 * operatorEmail — each operator gets one bundled notification per tick
 * listing only their own accounts. Entries with no operator (registered
 * before the field existed) are bundled under a null key and broadcast.
 */
async function notifyDueSweeps(dueEntries) {
  const byOwner = new Map();
  for (const e of dueEntries) {
    const key = e.operatorEmail || '__broadcast__';
    if (!byOwner.has(key)) byOwner.set(key, []);
    byOwner.get(key).push(e);
  }

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  for (const [key, entries] of byOwner.entries()) {
    const audience = key === '__broadcast__' ? null : key;

    // Per-operator opt-in. Broadcast entries (no owner) skip the notification
    // entirely — there's no way to honor a per-user pref without an owner.
    if (!audience) continue;
    const prefs = await getPrefs(audience);
    if (!prefs.connectionCheckReminders) continue;

    const names = entries.map((e) => e.profileName).join(', ');
    const title = `Launching connection check at ${time}`;
    const body = entries.length === 1
      ? `About to check connections for ${names}.`
      : `About to check connections for ${entries.length} accounts: ${names}.`;

    enqueueDesktopNotification({ title, body, audience });
    try {
      await notifyEmail(audience, { title, body });
    } catch (err) {
      console.warn(`[post-campaign] notifyEmail failed for ${audience}: ${err.message}`);
    }
  }
}

/**
 * One scheduler pass. Skips entirely if a foreground campaign is running.
 * Sweeps each due entry sequentially (not in parallel — keeps GoLogin
 * resource use predictable on weak laptops).
 */
async function tick() {
  if (await isCampaignRunning()) {
    console.log('[post-campaign] Tick skipped — campaign is running');
    return;
  }
  const sched = await readSchedule();
  if (Object.keys(sched).length === 0) return;

  const now = Date.now();
  let changed = false;
  const token = process.env.GOLOGIN_API_TOKEN;

  // First pass: expire-purge + identify due entries so we can fire a single
  // bundled "about to launch checks" notification per operator before any
  // sweep starts. Two-pass keeps the existing per-entry sweep semantics
  // (sequential, foreground-yielding) intact below.
  const dueKeys = [];
  for (const k of Object.keys(sched)) {
    const entry = sched[k];
    if (now >= entry.expiresAt) {
      delete sched[k];
      changed = true;
      console.log(`[post-campaign] Schedule expired for ${entry.profileName} on sheet ${entry.sheetId}`);
      continue;
    }
    // v2.148: honor the campaign's operator cadence when it was registered
    // with one; entries without it (unset cadence / pre-2.148 builds) keep the
    // 6h fallback. Effective floor is TICK_INTERVAL_MS (the 30-min tick).
    const cooldownMs = Number(entry.sweepIntervalMs) > 0 ? Number(entry.sweepIntervalMs) : SWEEP_COOLDOWN_MS;
    if (now < (entry.lastCheckedAt || 0) + cooldownMs) continue;
    dueKeys.push(k);
  }

  if (dueKeys.length > 0) {
    await notifyDueSweeps(dueKeys.map((k) => sched[k]));
  }

  for (const k of dueKeys) {
    const entry = sched[k];
    // Entry may have been deleted above (expired) — guard.
    if (!entry) continue;

    const _sweepMsg = `📡 ${entry.profileName}: bulk check pass starting…`;
    console.log(`[post-campaign] ${_sweepMsg}`);
    appendCampaignLog(entry.sheetId, entry.profileId, _sweepMsg);
    let launched;
    await browserSemaphore.acquire();
    try {
      launched = await launchProfile(entry.profileId, token);
    } catch (err) {
      console.warn(`[post-campaign] Launch failed for ${entry.profileName}: ${err.message}`);
      browserSemaphore.release();
      // Don't update lastCheckedAt — try again on next tick.
      continue;
    }

    try {
      const r = await bulkCheckConnections(launched.page, entry.sheetUrl, entry.linkedinColumn, entry.profileName);
      if (r.error) {
        console.warn(`[post-campaign] ${entry.profileName} sweep error: ${r.error}`);
      } else {
        const _resultMsg = r.plain
          || `📡 ${entry.profileName}: bulk check, ${r.matched} new accepted · ${r.stamped || 0} still pending`;
        console.log(`[post-campaign] ${entry.profileName}: ${r.matched} Connected, ${r.stamped || 0} Still Pending`);
        appendCampaignLog(entry.sheetId, entry.profileId, _resultMsg);
        // Auto-intro pass for connect_and_introduce campaigns whose
        // primary fields were stored at registration time. Mode-gated so a
        // leftover CC+IC config on a CC+DM (or other) campaign can never
        // fire a stray group intro during the acceptance window.
        if (shouldFirePostCampaignIntro(entry, r.connectedUrls)) {
          try {
            // v2.14.x: runAutoIntros reads primary fields from `templates.*`
            // (auto-intro.js:63-65), NOT from top-level kwargs. The previous
            // top-level shape silently triggered the "Primary Person missing"
            // early-return (auto-intro.js:67-71) for every post-campaign
            // sweep — every CC+IC intro that should have fired in the 7-day
            // post-campaign window was silently skipped. Wrap in templates
            // here. (Same convention used by the 3 in-campaign call sites
            // in campaign.js and the manual /api/bulk-check-now button.)
            await runAutoIntros({
              page: launched.page,
              profileId: entry.profileId,
              profileName: entry.profileName,
              sheetUrl: entry.sheetUrl,
              linkedinColumn: entry.linkedinColumn,
              connectedUrls: r.connectedUrls,
              senderFirstNames: senderFirstNamesFor(entry),
              templates: {
                primaryName: entry.primaryName,
                primaryIntroBody: entry.primaryIntroBody,
                primaryUrl: entry.primaryUrl || '',
                introTitle: entry.introTitle || 'Introduction: {firstName} <> {primaryFirstName}',
                autoAcceptPrimary: entry.autoAcceptPrimary,
                followUpEnabled: entry.followUpEnabled,
                followUpBody: entry.followUpBody,
                followUpDelayMinutes: entry.followUpDelayMinutes,
                primarySource: entry.primarySource,
              },
              log: (line) => {
                console.log(`[post-campaign] ${line}`);
                appendCampaignLog(entry.sheetId, entry.profileId, line);
              },
            });
          } catch (introErr) {
            console.warn(`[post-campaign] ${entry.profileName} auto-intro threw: ${introErr.message}`);
          }
        }
        // Auto-DM pass for connect_and_message campaigns — the CC+DM mirror of
        // the auto-intro above. Mode-gated + body-gated by shouldFirePostCampaignDm
        // so it's mutually exclusive with the intro branch. Fixes the gap where
        // CC+DM acceptances in the 6h/7-day window were stamped Connected but
        // never DM'd (the in-campaign + in-app monitoring paths already DM via
        // willAutoDm; this background sweep was the one path that didn't).
        else if (shouldFirePostCampaignDm(entry, r.connectedUrls)) {
          try {
            await runAutoDms({
              page: launched.page,
              profileId: entry.profileId,
              profileName: entry.profileName,
              sheetUrl: entry.sheetUrl,
              linkedinColumn: entry.linkedinColumn,
              connectedUrls: r.connectedUrls,
              // runAutoDms reads the body from templates.ccDmBody and the nice
              // name from the top-level senderFirstNames kwarg — two different
              // places, mirroring the intro path above.
              templates: { ccDmBody: entry.ccDmBody },
              senderFirstNames: senderFirstNamesFor(entry),
              log: (line) => {
                console.log(`[post-campaign] ${line}`);
                appendCampaignLog(entry.sheetId, entry.profileId, line);
              },
            });
          } catch (dmErr) {
            console.warn(`[post-campaign] ${entry.profileName} auto-DM threw: ${dmErr.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[post-campaign] ${entry.profileName} sweep threw: ${err.message}`);
    } finally {
      // Sheet writes are coalesced in sheets-writer; land this account's
      // buffered rows before the sweep moves on, so nothing is left sitting in
      // the buffer if the tick ends or the app is closed.
      try { await flushSheetWrites(); } catch { /* best-effort */ }
      try { await closeProfile(entry.profileId); } catch { /* */ }
      browserSemaphore.release();
    }

    entry.lastCheckedAt = now;
    changed = true;

    const _nextCheckAt = new Date(now + SWEEP_COOLDOWN_MS);
    const _nextHHMM = _nextCheckAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const _idleMsg = `🛏 Monitoring idle · next check at ${_nextHHMM}`;
    appendCampaignLog(entry.sheetId, entry.profileId, _idleMsg);

    // Bail if a campaign started mid-tick (foreground takes priority).
    if (await isCampaignRunning()) {
      console.log('[post-campaign] Mid-tick: campaign started — pausing remaining sweeps');
      break;
    }
  }

  if (changed) await writeSchedule(sched);
}

export function startScheduler() {
  if (_tickTimer) return;
  _tickTimer = setInterval(() => { tick().catch((err) => console.warn(`[post-campaign] Tick threw: ${err.message}`)); }, TICK_INTERVAL_MS);
  // First pass shortly after boot so overdue checks don't wait the full interval.
  setTimeout(() => { tick().catch((err) => console.warn(`[post-campaign] First-tick threw: ${err.message}`)); }, 30_000);
  console.log(`[post-campaign] Scheduler started (30-min ticks, 6h per-account cooldown)`);
}

export function stopScheduler() {
  if (_tickTimer) clearInterval(_tickTimer);
  _tickTimer = null;
}

/**
 * For dashboard visibility — return active schedule entries.
 */
export async function listSchedule() {
  const sched = await readSchedule();
  return Object.values(sched);
}

/**
 * v2.76: remove post-campaign bulk-check entries for a sheet (optionally
 * limited to profileIds). Mirrors the reply-check scheduler so "Stop
 * everything" / the Past-view toggle can halt background browser sweeps.
 */
export async function removeSchedulesForSheet(sheetId, profileIds = null) {
  if (!sheetId) return 0;
  const sched = await readSchedule();
  const pidSet = Array.isArray(profileIds) && profileIds.length ? new Set(profileIds) : null;
  let removed = 0;
  for (const k of Object.keys(sched)) {
    const e = sched[k];
    if (e.sheetId !== sheetId) continue;
    if (pidSet && !pidSet.has(e.profileId)) continue;
    delete sched[k];
    removed++;
  }
  if (removed) await writeSchedule(sched);
  return removed;
}

/** v2.76: wipe ALL post-campaign bulk-check entries. */
export async function clearAllSchedules() {
  await writeSchedule({});
}
