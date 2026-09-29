/**
 * Automatic reply tracking.
 *
 * Companion to post-campaign-bulk-check.js. After a message-sending campaign
 * (Message Campaign / Introduction / Connect+DM / Connect+Introduce) ends,
 * each (sheet, profile) that sent at least one message is registered for a
 * window (default 7 days). A background scheduler ticks and, once per hour per
 * account, scrapes each sent lead's thread for inbound replies via the shared
 * checkProfileDmsPerLead routine. New replies are:
 *   • written to the Google Sheet (Reply / ReplyAt / ReplyPreview + Replies tab,
 *     Stage → "Replied") — handled inside checkProfileDmsPerLead.
 *   • recorded to the in-app replies log (replies-log.js) for the dashboard panel.
 *   • surfaced via desktop popup + email when the operator opts in (off by default).
 *
 * "Never in the first hour": registerReplySchedule stamps lastCheckedAt = now,
 * and the per-account cooldown is 1 hour, so the first sweep can only fire ~1h
 * after registration. "At most once per hour": the same 1h cooldown.
 *
 * The bot must be running for sweeps to fire. Sweeps are skipped while a
 * foreground campaign is actively sending (GoLogin allows one session per
 * profile) and resume as soon as it finishes — so replies are caught hourly
 * throughout the whole tracking window.
 *
 * Persistent state: data/post-campaign-reply-check.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dataPath } from './paths.js';
import { getProfiles } from './gologin-launcher.js';
import * as browserSemaphore from './browser-semaphore.js';
import { fetchSheet } from './sheets.js';
import { checkProfileDms, checkProfileDmsPerLead } from './linkedin/check-dms.js';
import { writeRecentMessagesTab } from './sheets-writer.js';
import { appendReplies } from './replies-log.js';
import { notifyEmail, enqueueDesktopNotification } from './notifier.js';
import { getPrefs } from './notification-prefs.js';
import { appendCampaignLog } from './campaign-log-bus.js';

const SCHEDULE_FILE = dataPath('post-campaign-reply-check.json');
const TICK_INTERVAL_MS = 30 * 60 * 1000;        // ticks every 30 min…
const REPLY_COOLDOWN_MS = 60 * 60 * 1000;       // …but each account is swept at most 1×/hour

// v2.103.2: HARD-DISABLED. On a rate-limited / degraded session every inbox
// scan fails (checkProfileDms → "Voyager returned null", "detached Frame",
// or ENOENT on the profile's Default/Preferences). The scheduler still opens a
// browser per (sheet, profile) for each failed scan, producing a continuous
// open/fail/close browser storm that the operator could only stop by
// force-quitting the app — and it caught zero replies anyway. Disabled until
// the scan path is made degradation-safe (fail → skip with backoff, never
// re-open a dead session). Flip back to true to re-enable.
const REPLY_CHECK_ENABLED = false;

// Stages meaning "we sent an outbound message and are tracking a reply."
// Mirrors CHECK_DMS_STAGE_FILTER in server.js.
const REPLY_STAGE_FILTER = new Set(['DM Sent', 'IC Sent', 'OP Sent', 'InM Sent', 'Replied']);

let _tickTimer = null;

async function readSchedule() {
  try { return JSON.parse(await readFile(SCHEDULE_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeSchedule(s) {
  try { await writeFile(SCHEDULE_FILE, JSON.stringify(s, null, 2)); }
  catch (err) { console.warn(`[reply-check] write failed: ${err.message}`); }
}

function key(sheetId, profileId) { return `${sheetId}|${profileId}`; }

// Lazy import to avoid a load-time circular dep with campaign.js.
async function isCampaignRunning() {
  try {
    const m = await import('./campaign.js');
    return !!(m.campaign && m.campaign.running);
  } catch { return false; }
}

/**
 * Pure helper (unit-tested): from sheet rows, return the ones this profile
 * sent that are eligible for a reply scrape (Sent-stage + matching sender).
 * Falls back to the legacy Message='sent' flag when there's no Stage column.
 */
export function leadsForProfile(rows, profileName) {
  if (!Array.isArray(rows) || !profileName) return [];
  const hasStage = rows.length > 0 && ('Stage' in rows[0]);
  const target = String(profileName).trim().toLowerCase();
  return rows.filter((row) => {
    const sentStage = hasStage
      ? REPLY_STAGE_FILTER.has(String(row.Stage || '').trim())
      : String(row.Message || '').trim().toLowerCase() === 'sent';
    if (!sentStage) return false;
    const acct = String(
      row['Sender'] || row['sender'] || row['Account Used'] || row['account used'] || ''
    ).trim().toLowerCase();
    return acct === target;
  });
}

/**
 * Pure helper (unit-tested): map a checkProfileDms() result into replies-log
 * entries. Keeps only inbound replies, plus ambiguous (same-name) inbound
 * conversations flagged as `suspected` for manual review.
 */
export function repliesToLogEntries(result, profileId, profileName) {
  const out = [];
  for (const r of (result?.replies || [])) {
    if (!r.inbound) continue;
    const row = r.match || {};
    const leadName = r.name || `${row['First Name'] || row.firstName || ''} ${row['Last Name'] || row.lastName || ''}`.trim();
    out.push({
      profileId, profileName,
      linkedinUrl: r.leadUrl || row['Linkedin URL'] || '',
      leadName,
      text: r.snippet || '',
      repliedAt: r.timestamp || null,
      suspected: false,
    });
  }
  for (const a of (result?.ambiguous || [])) {
    if (!a.inbound) continue;
    out.push({
      profileId, profileName,
      linkedinUrl: '',
      leadName: a.name || '(unknown)',
      text: a.snippet || '',
      repliedAt: a.timestamp || null,
      suspected: true,
    });
  }
  return out;
}

/**
 * Map a checkProfileDmsPerLead() result → recentMessages + log entries.
 * Per-lead threads are inherently 1:1, so each inbound reply qualifies.
 */
function perLeadToOutputs(result, profileId, profileName) {
  const recentMessages = [];
  const logEntries = [];
  for (const r of (result?.replies || [])) {
    if (!r.inbound) continue;
    const row = r.match || {};
    const leadName = `${row['First Name'] || row.firstName || ''} ${row['Last Name'] || row.lastName || ''}`.trim();
    const lastMsg = Array.isArray(r.messages) && r.messages.length ? r.messages[r.messages.length - 1] : null;
    const text = r.snippet || (lastMsg && lastMsg.body) || '';
    const receivedAt = (lastMsg && lastMsg.time) || '';
    recentMessages.push({ account: profileName, name: leadName, lastMessage: text, receivedAt, matched: true });
    logEntries.push({ profileId, profileName, linkedinUrl: r.leadUrl || '', leadName, text, repliedAt: receivedAt || null, suspected: false });
  }
  return { recentMessages, logEntries };
}

/**
 * v2.72: bulk inbox reply scan (one fetch per account — fast, like the
 * connection checker). No per-lead fallback (operator requirement: per-lead is
 * too slow). Returns a unified shape for both callers.
 */
export async function scanRepliesForProfile({ profileId, profileName, leads, sheetUrl, linkedinColumn, watermark, page = null }) {
  const bulk = await checkProfileDms(profileId, { watermark, sheetUrl, linkedinColumn, page, pName: profileName });
  return {
    method: 'bulk',
    recentMessages: bulk.recentMessages || [],
    logEntries: repliesToLogEntries(bulk, profileId, profileName),
    inboundCount: (bulk.replies || []).filter((r) => r.inbound).length,
    suspectedCount: (bulk.ambiguous || []).filter((a) => a.inbound).length,
    errors: bulk.errors || [],
  };
}

/**
 * Register (or refresh) a reply-tracking window for one (sheet, profile).
 * Called from campaign.js's finally block per profile that sent ≥1 message.
 * lastCheckedAt = now enforces the "never in the first hour" rule.
 */
export async function registerReplySchedule({ sheetId, sheetUrl, profileId, profileName,
                                              linkedinColumn, days, operatorEmail, scanSinceMs }) {
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
    // v2.72: scan window cutoff — first send-out minus a 12h safety buffer.
    // Every sweep looks back to here (not incremental) so a reply that lands
    // hours after sending is always caught. Preserved across re-registration.
    scanSinceMs: Number.isFinite(scanSinceMs) ? scanSinceMs : (sched[k]?.scanSinceMs || (now - 12 * 60 * 60 * 1000)),
    registeredAt: sched[k]?.registeredAt || now,
    expiresAt: now + days * 86400000,
    // First-hour blackout: the first sweep can't fire until now + cooldown.
    lastCheckedAt: now,
  };
  await writeSchedule(sched);
  console.log(`[reply-check] Registered ${profileName || profileId} on sheet ${sheetId} for ${days}d (first check after ${new Date(now + REPLY_COOLDOWN_MS).toISOString()})`);
}

/** Desktop + email alert for a batch of new replies — opt-in, off by default. */
async function notifyNewReplies(entry, freshReplies) {
  if (!freshReplies || freshReplies.length === 0) return;
  const audience = entry.operatorEmail;
  if (!audience) return; // can't honor a per-operator pref without an owner
  const prefs = await getPrefs(audience);
  if (!prefs.replyAlerts) return;

  const n = freshReplies.length;
  const first = freshReplies[0];
  const preview = String(first.text || '').slice(0, 140);
  const title = n === 1 ? `New reply on ${entry.profileName}` : `${n} new replies on ${entry.profileName}`;
  const body = n === 1
    ? `${first.leadName || first.linkedinUrl}: "${preview}" — log into ${entry.profileName} to reply.`
    : `${n} leads replied to ${entry.profileName}. Log into that account to reply. Latest: "${preview}"`;

  enqueueDesktopNotification({ title, body, audience });
  try { await notifyEmail(audience, { title, body, link: '/' }); }
  catch (err) { console.warn(`[reply-check] notifyEmail failed for ${audience}: ${err.message}`); }
}

/**
 * One scheduler pass. Skips entirely while a foreground campaign is sending.
 * Sweeps each due account sequentially to keep GoLogin resource use predictable.
 */
async function tick() {
  if (!REPLY_CHECK_ENABLED) return; // v2.103.2: hard-disabled — see flag note above
  if (await isCampaignRunning()) {
    console.log('[reply-check] Tick skipped — campaign is running');
    return;
  }
  const sched = await readSchedule();
  if (Object.keys(sched).length === 0) return;

  const now = Date.now();
  let changed = false;

  // Resolve profile name → id once (checkProfileDms takes a profileId).
  let nameToId = {};
  try {
    const token = process.env.GOLOGIN_API_TOKEN;
    const profiles = await getProfiles(token);
    for (const p of profiles) nameToId[p.name] = p.id;
  } catch (err) {
    console.warn(`[reply-check] getProfiles failed: ${err.message}`);
  }
  nameToId['You'] = nameToId['Local Browser'] = nameToId['local-browser'] = 'local-browser';

  const dueKeys = [];
  for (const k of Object.keys(sched)) {
    const entry = sched[k];
    if (now >= entry.expiresAt) {
      delete sched[k];
      changed = true;
      console.log(`[reply-check] Window expired for ${entry.profileName} on sheet ${entry.sheetId}`);
      continue;
    }
    if (now < (entry.lastCheckedAt || 0) + REPLY_COOLDOWN_MS) continue;
    dueKeys.push(k);
  }

  for (const k of dueKeys) {
    const entry = sched[k];
    if (!entry) continue;

    const profileId = nameToId[entry.profileName] || entry.profileId;
    const watermark = Number.isFinite(entry.scanSinceMs) ? entry.scanSinceMs : (now - 12 * 60 * 60 * 1000);
    const _msg = `📬 ${entry.profileName}: scanning inbox for replies…`;
    console.log(`[reply-check] ${_msg}`);
    appendCampaignLog(entry.sheetId, entry.profileId, _msg);

    // v2.91: the inbox scan opens a browser internally (checkProfileDms →
    // launchProfile when no page is passed). Route it through the global
    // browser-semaphore so the runner's "no browser open" gate stays accurate.
    await browserSemaphore.acquire();
    try {
      // v2.72: build this profile's sent-lead list for the per-lead fallback.
      let leads = [];
      try { leads = leadsForProfile(await fetchSheet(entry.sheetUrl), entry.profileName); }
      catch (e) { console.warn(`[reply-check] sheet load failed: ${e.message}`); }

      // Bulk inbox scan first (fast); falls back to per-lead thread scrape if
      // the inbox API can't be read.
      const result = await scanRepliesForProfile({
        profileId,
        profileName: entry.profileName,
        leads,
        sheetUrl: entry.sheetUrl,
        linkedinColumn: entry.linkedinColumn || 'Linkedin URL',
        watermark,
      });

      // Dump inbound 1:1 replies to the shared "Recent Messages" tab.
      try { await writeRecentMessagesTab(entry.sheetUrl, entry.profileName, result.recentMessages || [], []); }
      catch (e) { console.warn(`[reply-check] recent-messages write failed: ${e.message}`); }

      const fresh = await appendReplies(result.logEntries || []);
      const _r = `📬 ${entry.profileName}: ${result.inboundCount} reply(ies)${result.suspectedCount ? `, ${result.suspectedCount} suspected (ambiguous name)` : ''} — ${fresh.length} new [${result.method}]`;
      console.log(`[reply-check] ${_r}`);
      appendCampaignLog(entry.sheetId, entry.profileId, _r);
      if (fresh.length) await notifyNewReplies(entry, fresh);
      if (result.errors && result.errors.length) {
        console.warn(`[reply-check] ${entry.profileName}: ${result.errors.join('; ')}`);
      }
    } catch (err) {
      console.warn(`[reply-check] ${entry.profileName} sweep threw: ${err.message}`);
    } finally {
      browserSemaphore.release();
    }

    entry.lastCheckedAt = now;
    changed = true;

    if (await isCampaignRunning()) {
      console.log('[reply-check] Mid-tick: campaign started — pausing remaining sweeps');
      break;
    }
  }

  if (changed) await writeSchedule(sched);
}

export function startScheduler() {
  if (!REPLY_CHECK_ENABLED) {
    console.log('[reply-check] Scheduler DISABLED (v2.103.2) — not starting. Inbox reply tracking is off until the scan path is degradation-safe.');
    return;
  }
  if (_tickTimer) return;
  _tickTimer = setInterval(() => { tick().catch((err) => console.warn(`[reply-check] Tick threw: ${err.message}`)); }, TICK_INTERVAL_MS);
  setTimeout(() => { tick().catch((err) => console.warn(`[reply-check] First-tick threw: ${err.message}`)); }, 45_000);
  console.log('[reply-check] Scheduler started (30-min ticks, 1h per-account cooldown)');
}

export function stopScheduler() {
  if (_tickTimer) clearInterval(_tickTimer);
  _tickTimer = null;
}

export async function listSchedule() {
  const sched = await readSchedule();
  return Object.values(sched);
}

/**
 * v2.76: remove reply-tracking entries for a sheet (optionally limited to a
 * set of profileIds). Used by "Stop everything" and the Past-view monitoring
 * toggle to actually halt the background browser checks. Returns the count
 * removed.
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

/** v2.76: wipe ALL reply-tracking entries (operator "clear backlog"). */
export async function clearAllSchedules() {
  await writeSchedule({});
}
