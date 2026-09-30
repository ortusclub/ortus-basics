/**
 * Auto-introduction pass — shared by the in-campaign loop, the manual
 * Bulk Check button, and the post-campaign scheduler.
 *
 * Given a list of leads that just flipped to Connected (returned by
 * bulkCheckConnections.connectedUrls), navigate to each profile and send
 * a 3-way intro DM that includes the configured primary person. Stamps
 * `Introduction Status` on each row.
 *
 * v2.13.14: Construct templates + data exactly the way campaign.js builds
 * them for the Introduce Back batch loop — same `tpl` shape, same `data`
 * enrichment, same call signature into performOutreach. The only overlay
 * is `introMode: true`, `introName: primaryName`, `followUpMessage:
 * primaryIntroBody`, and `introUrl: primaryUrl` (which triggers URL
 * routing for the second pill in sendIntroMessage, sidestepping the
 * unreliable typeahead). senderFirstNames is honoured so
 * `{sender first name}` resolves to the operator-configured nice name
 * rather than the GoLogin email.
 */

import { sendIntroMessage, sendIntroViaCleanCompose } from './actions.js';
import { personalizeTemplate, getConnectionStatus } from './helpers.js';
import { checkAndConnectPrimary, primaryConnState } from './primary-connection.js';
import { readSelfIdentity } from './accept-invitation.js';
import { INTRO_FAILED_PRIMARY_NOT_CONNECTED, INTRO_HELD_PRIMARY_NOT_CONNECTED, INTRO_ASSUMED_PRIMARY_NOT_CONNECTED } from './intro-constants.js';
import { extractSheetId } from '../utils.js';
import { buildFollowUpTask, buildAcceptTask, enqueuePrimaryTask, enqueueFollowUpBatched } from '../primary-tasks.js';
import { fetchSheet } from '../sheets.js';
import { updateSheetRow, batchUpdateSheet } from '../sheets-writer.js';
import { extractLinkedInUrl, campaign, _ops } from '../campaign.js';
import { leadIdentityKeys } from './bulk-check-connections.js';

// Note-aware intro routing (spec 2026-06-10-ccic-note-group-intro). Clean-compose
// (typeahead BOTH pills into a blank /messaging/compose → real group) is used when
// the lead already has a prior 1:1 thread with this account AND we have the lead's
// full name to typeahead. A prior thread comes from EITHER a connection note OR any
// earlier message (v2.92) — both collapse a URL-routed intro into the 1:1 and drop
// the primary pill, so both take the same clean-compose group path. Otherwise the
// unchanged URL-routing path (sendIntroMessage). Pure for unit testing.
export function _decideIntroPath({ hasConnectionNote, hasPriorThread, leadFullName }) {
  if ((hasConnectionNote || hasPriorThread) && (leadFullName || '').toString().trim()) return 'clean-compose';
  return 'url-routing';
}

// Dedupe probe decision: any rendered message event in the group compose means a
// thread for this lead+primary already exists → already introduced.
export function _groupHasHistory(eventCount) {
  return Number(eventCount) > 0;
}

// Defense-in-depth duplicate-profile guard (boss report 2026-06-16). bulk-check
// already dedups the connectedUrls it produces, but collapse the work-list here
// too so NO caller — present or future — can introduce the same person twice in
// one pass. Same strong-identity keys bulk-check matches on (slug + ACwAA token
// + numeric Membership ID), resolved per URL from the sheet row map. A URL with
// no resolvable identity falls back to its raw string, so an exact repeat is
// still collapsed and a real lead is never silently dropped. Pure for testing.
// Returns { urls, duplicates } — duplicates is the count removed (for logging).
export function _dedupeIntroUrls(urls, rowByUrl) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const u of (urls || [])) {
    const keys = leadIdentityKeys(u, (rowByUrl && rowByUrl.get(u)) || {});
    const effectiveKeys = keys.length ? keys : ['url:' + String(u)];
    if (effectiveKeys.some((k) => seen.has(k))) { duplicates++; continue; }
    for (const k of effectiveKeys) seen.add(k);
    out.push(u);
  }
  return { urls: out, duplicates };
}

// v2.96 — connect-to-primary self-heal (spec: every intro to JULIA failed with
// INTRO_RECIPIENT_NOT_FOUND because the sending account wasn't a 1st-degree
// connection of the primary). Pure decision helpers for the gate below.
//
// Should this account's intros be HELD this sweep? True when the primary-
// connection check came back not-connected — we leave Introduction Status blank
// so the next bulk-check re-detects the leads and retries once the primary has
// accepted (bulk-check treats ANY non-blank Introduction Status as terminal, so
// held leads must not be stamped).
export function _shouldHoldIntros(primaryConnResult) {
  return !!primaryConnResult && primaryConnResult.connected === false;
}

// v2.104 — a made (or already-made) 3-way intro is positive proof the lead is a
// 1st-degree connection of THIS account (you can't open the group otherwise), so
// the intro stamp also stamps the connection columns. Without this, a successful
// intro on the reconnect-&-retry or aged-off path (which fire without a fresh
// bulk-check Connected stamp) leaves the row reading "Introduction Made" but
// "Connect Pending". Values mirror bulk-check's Connected stamp so they route to
// the same columns (cc/checkStatus → Connection Accepted Status, stage → Stage,
// connectedAlready → Connected). Returns {} for any non-confirmed outcome — we
// never claim Connected on a failed or interrupted intro.
export function introConnectionStamp(introConfirmed) {
  return introConfirmed
    ? { cc: 'Connected', stage: 'Connected', checkStatus: 'Connected', connectedAlready: 'Yes' }
    : {};
}

// v2.103 — is this an actual LinkedIn member profile URL (/in/<slug>)? The
// connect-to-primary gate only makes sense for one; operators sometimes paste a
// Google Sheet link or a header label in the Primary URL field, and loading that
// just wastes a navigation. Company pages (/company/) aren't member profiles.
export function isLinkedInProfileUrl(url) {
  return /linkedin\.com\/in\/[^/?#\s]+/i.test((url || '').toString());
}

// Should we queue the auto-accept task (the primary's own account accepts the
// account's invite)? When auto-accept is enabled AND we ATTEMPTED a connect —
// regardless of how it ended. Rationale (2026-06-16, the "Micha" case): the
// sender side is fragile — an encoded /in/ACwAA… primary URL that doesn't render,
// a rate-limited page, or a 3rd-degree layout can make sendConnectionRequest
// throw "Connect button not found" even when an invite to the primary is ALREADY
// outstanding (sent in a prior run). connectResult ('sent'/'already_pending'/
// 'failed') is therefore NOT a reliable "is there an invite" signal. The
// authoritative source is the primary's own received-invitations list, and
// acceptInvitationFrom matches it PRECISELY (profile-URL or exact name) — so
// queuing on every attempt is safe: a genuine no-invite simply matches nothing
// and the runner marks it 'skipped'. We only skip queuing when no connect was
// attempted at all (nothing could be pending from this account this run).
export function _shouldQueueAutoAccept({ autoAcceptPrimary, connectAttempted } = {}) {
  return !!autoAcceptPrimary && !!connectAttempted;
}

// The EXACT message-history selector the connection-note dedupe probe uses
// (actions.js:2509), so "does a thread exist" is detected identically on both
// paths. Kept in sync by hand — it is a copy, not an import (actions.js is off-
// limits to modify, and the constant is not exported there).
const _INTRO_THREAD_HISTORY_SELECTOR =
  '.msg-s-event-listitem, [class*="msg-s-event"], [class*="msg-event-listitem"], .msg-s-message-list-content li';

// Probe: does the lead already have a 1:1 thread with this account? Opens the same
// /messaging/compose/?recipient=<lead> URL the URL-routing path uses; when a prior
// 1:1 exists LinkedIn collapses it inline and renders its message history, which we
// count with the shared selector. Any history ⇒ prior thread ⇒ route via clean-
// compose (same as the note path). A probe failure returns false so the route
// falls back to the unchanged URL-routing path — no behaviour change on error.
// DOM-dependent; verified manually against LinkedIn.
async function _leadHasPriorThread(page, leadUrl) {
  try {
    const m = String(leadUrl || '').match(/\/in\/([^/?#]+)/);
    if (!m) return false;
    const composeUrl = `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(m[1])}`;
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // Mirror the note dedupe-probe settle (1500 + 800) so a slow renderer surfaces
    // its history before we count it.
    await new Promise((r) => setTimeout(r, 1500));
    await new Promise((r) => setTimeout(r, 800));
    const eventCount = await page.evaluate(
      (sel) => document.querySelectorAll(sel).length,
      _INTRO_THREAD_HISTORY_SELECTOR,
    );
    return _groupHasHistory(eventCount);
  } catch {
    return false;
  }
}

// Capture a person's REAL profile-photo token from their /in/ page, used to
// disambiguate same-name people in the clean-compose typeahead. The token (the
// licdn media-id) is identical between the profile photo and the dropdown
// avatar (verified live 2026-06-16). Matches the img whose alt is the person's
// name (or the top-card photo) — NOT just the first displayphoto on the page,
// which can be someone else's (e.g. a "people also viewed" face). Navigates the
// page; the caller re-opens compose on retry. Returns '' on any failure → the
// caller then skips rather than guess. Called only on a same-name ambiguity.
async function _captureProfileAvatarToken(page, profileUrl, fullName) {
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    return await page.evaluate((wantName) => {
      const tok = (s) => (String(s || '').match(/image\/v2\/([^\/]+)\//) || [])[1] || '';
      const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const want = norm(wantName);
      const parts = want.split(' ').filter(Boolean);
      const first = parts[0] || '', last = parts[parts.length - 1] || '';
      const imgs = Array.from(document.querySelectorAll('img')).filter((im) => /displayphoto/i.test(im.getAttribute('src') || ''));
      // Prefer the img whose alt is the person's name (the main profile photo).
      const named = imgs.find((im) => {
        const alt = norm(im.getAttribute('alt') || '');
        return alt && (alt === want || (first && last && alt.includes(first) && alt.includes(last)));
      });
      if (named) return tok(named.getAttribute('src'));
      const tc = document.querySelector(
        'img.pv-top-card-profile-picture__image, .pv-top-card__photo img, button[aria-label*="profile photo" i] img'
      );
      return tc ? tok(tc.getAttribute('src')) : '';
    }, fullName);
  } catch {
    return '';
  }
}

/**
 * v2.91: build the follow-up task for one freshly-sent intro, or null when the
 * follow-up is disabled / has no body. Pure — the enqueue side-effect happens
 * at the call site. The follow-up is posted AS the primary, so sender is
 * tpl.primarySource ('local-browser' or the primary's GoLogin profileId) — the
 * runner opens that browser. The body is already personalized above, so the
 * posting identity does not affect {sender first name} / {primary name}.
 */
export function maybeBuildFollowUp({ tpl, introData, profileId, profileName, sheetUrl, leadName, url, threadUrl, now, campaignId = '', campaignName = '' }) {
  if (!tpl || !tpl.followUpEnabled) return null;
  const rawBody = (tpl.followUpBody || '').trim();
  if (!rawBody) return null;
  const body = personalizeTemplate(rawBody, introData);
  // Posting identity = the primary (a participant in every intro thread). The
  // message body above is already personalized from introData, so token
  // resolution ({sender first name} = campaign account) is unaffected.
  const sender = tpl.primarySource || 'local-browser';
  return buildFollowUpTask({
    // Stamped so the dashboard can attribute this follow-up to its campaign
    // rather than pooling it with every other campaign's — see followup-groups.js.
    campaignId, campaignName,
    campaignProfileId: profileId,
    campaignProfileName: profileName,
    sheetId: extractSheetId(sheetUrl) || '',
    sheetUrl,
    sender,
    threadUrl,
    introTitle: tpl.introTitle || '',
    leadName,
    leadUrl: url,
    primaryName: tpl.primaryName || '',
    primaryUrl: tpl.primaryUrl || '',
    body,
    delayMinutes: tpl.followUpDelayMinutes,
    now: Number.isFinite(now) ? now : Date.now(),
  });
}

function _formatLocalDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = d.getDate();
  const ord = (n) => (n % 10 === 1 && n % 100 !== 11) ? 'st'
    : (n % 10 === 2 && n % 100 !== 12) ? 'nd'
    : (n % 10 === 3 && n % 100 !== 13) ? 'rd' : 'th';
  return `${months[d.getMonth()]} ${day}${ord}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// v2.61.0: pure decision helper for reverify-and-downgrade (spec
// 2026-05-27-cc-ic-stamp-resilience). Given the result of
// getConnectionStatus(page) and the row's current `Connection Accepted Status`
// value, decide whether to downgrade the row. Strict mode: only clear-negative
// signals ('connect', 'pending') downgrade; 'message' / 'follow' / 'unknown' /
// 'error' all return noop so a flaky DOM read never clobbers a real connection.
export function _decideReverifyAction(connectionStatus, currentCc) {
  if (currentCc !== 'Connected') {
    return { action: 'noop', reason: 'cc-not-connected' };
  }
  if (connectionStatus === 'connect' || connectionStatus === 'pending') {
    return { action: 'downgrade' };
  }
  if (connectionStatus === 'message') {
    return { action: 'noop', reason: 'genuine-1st-degree' };
  }
  if (connectionStatus === 'follow') {
    return { action: 'noop', reason: 'follow-only-restricted' };
  }
  return { action: 'noop', reason: 'ambiguous' };
}

// v2.61.0: navigate to the lead profile and call getConnectionStatus to
// confirm whether the row's `Connection Accepted Status = Connected` stamp
// is genuine. Used when sendIntroMessage throws compose-textbox-did-not-appear
// on a row stamped Connected — that combination is impossible for a real
// 1st-degree connection (LinkedIn loads compose for them).
//
// On clear-negative ('connect' or 'pending'), writes back
// `Connection Accepted Status = 'Unverified — manual review (<date>)'` so
// the next bulk-check pass leaves the row alone (bulk-check has a sticky
// short-circuit for that exact prefix).
async function _reverifyAndDowngrade({
  page, url, profileName, sheetUrl, linkedinColumn, currentCc, log,
}) {
  if (currentCc !== 'Connected') return { reverified: false };

  let connectionStatus;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    connectionStatus = await getConnectionStatus(page);
  } catch (err) {
    log(`  ⚠ [${profileName}] ${url}: reverify navigation failed (${err.message}) — keeping stamp`);
    return { reverified: false, status: 'error' };
  }

  const decision = _decideReverifyAction(connectionStatus, currentCc);
  if (decision.action !== 'downgrade') {
    log(`  ↻ [${profileName}] ${url}: reverify='${connectionStatus}' — keeping stamp (${decision.reason})`);
    return { reverified: true, status: connectionStatus, downgraded: false };
  }

  const stamp = `Unverified — manual review (${_formatLocalDate(new Date())})`;
  try {
    await updateSheetRow(sheetUrl, url, {
      cc: stamp,
      checkStatus: stamp,
      auditAction: `Reverify after compose-textbox failure: not connected (getConnectionStatus='${connectionStatus}')`,
    }, linkedinColumn);
    log(`  ⤓ [${profileName}] ${url}: downgraded — getConnectionStatus='${connectionStatus}'`);
    return { reverified: true, status: connectionStatus, downgraded: true };
  } catch (err) {
    log(`  ⚠ [${profileName}] ${url}: downgrade write failed (${err.message})`);
    return { reverified: true, status: connectionStatus, downgraded: false };
  }
}

// v2.57.x — Translate raw sendIntroMessage error strings into operator-friendly
// "Failed — <reason>" labels for the Introduction Status sheet column. Mirrors
// the "Skipped — <reason>" pattern used for CC interrupts so the leads sheet
// is scannable without diving into the Audit tab. The raw error stays in
// auditAction (Audit tab) for debugging — that's where engineers paste into
// GitHub issues. Order matters: more-specific patterns first.
function _friendlyIntroFailure(errMsg) {
  const m = errMsg || '';
  if (m.includes('MESSAGE_SEND_FAILED: compose textbox did not appear')) {
    return "Failed — Compose page didn't load";
  }
  if (m.includes('INTRO_RECIPIENT_NOT_FOUND: recipient-not-in-results')) {
    if (/\d+ suggestions but no match/.test(m)) {
      return "Failed — Primary name didn't match suggestions";
    }
    return INTRO_FAILED_PRIMARY_NOT_CONNECTED;
  }
  if (m.includes('INTRO_RECIPIENT_NOT_FOUND: recipient-input-not-found')) {
    return 'Failed — Compose page missing recipient field';
  }
  if (m.includes('INTRO_RECIPIENT_NOT_FOUND: recipient-pill-not-confirmed')) {
    return 'Failed — Primary clicked but not added';
  }
  if (m.includes('INTRO_DROPDOWN_HANG')) {
    return 'Failed — Compose page froze';
  }
  if (m.includes('MESSAGE_SEND_FAILED: not on a profile page')) {
    return 'Failed — Invalid lead URL';
  }
  if (m.includes('MESSAGE_SEND_FAILED: could not type')) {
    return "Failed — Couldn't type message";
  }
  if (m.includes('MESSAGE_SEND_FAILED: composer not focusable')) {
    return 'Failed — Message body not focusable';
  }
  if (m.includes('MESSAGE_SEND_FAILED: send not confirmed')) {
    return 'Failed — Send not confirmed';
  }
  if (m.includes('MESSAGE_SEND_FAILED: introName required')) {
    return 'Failed — Primary name missing in template';
  }
  // Same-name guard (2026-06-16): 2+ people share the name and no profile photo
  // confidently matched the intended person — skipped rather than message a
  // stranger. Terminal (operator clears the cell to retry after disambiguating).
  if (m.includes('IC_INTRO_AMBIGUOUS_RECIPIENT')) {
    return 'Skipped — multiple same-name matches, verify manually';
  }
  // Clean-compose (CC+IC note-branch) failures — IC_ prefixed.
  if (m.includes('IC_INTRO_RECIPIENT_NOT_FOUND')) {
    return 'Failed — Lead or primary not in your connections';
  }
  if (m.includes('IC_INTRO_FAILED')) {
    return "Failed — Group compose didn't load";
  }
  // Unknown error — preserve a truncated raw so info isn't lost on new variants.
  const trunc = m.length > 60 ? m.slice(0, 57) + '…' : m;
  return `Failed — ${trunc || 'unknown'}`;
}

/**
 * @param {object} args
 * @param {puppeteer.Page} args.page          - active page on a logged-in LinkedIn session
 * @param {string} args.profileId             - sender's GoLogin profile id
 * @param {string} args.profileName           - sender's display label (email)
 * @param {string} args.sheetUrl              - target sheet URL (used to look up row data)
 * @param {string} args.linkedinColumn        - operator-specified URL column name
 * @param {string[]} args.connectedUrls       - leads that just flipped to Connected
 * @param {object} args.templates             - wizard templates (full object — primaryName, primaryUrl, primaryIntroBody, introTitle, etc.)
 * @param {Record<string,string>} [args.senderFirstNames] - operator-configured nice names per profileId
 * @param {Function} [args.log]               - log function (defaults to console.log)
 * @returns {Promise<{sent: number, failed: number, skipped: number}>}
 */
export async function runAutoIntros({
  page,
  profileId,
  profileName,
  sheetUrl,
  linkedinColumn,
  connectedUrls,
  templates = {},
  senderFirstNames = {},
  log = console.log,
  onProgress = null,
}) {
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (!Array.isArray(connectedUrls) || connectedUrls.length === 0) return result;

  const primaryName      = (templates.primaryName      || '').trim();
  const primaryIntroBody = (templates.primaryIntroBody || '').trim();
  const primaryUrl       = (templates.primaryUrl       || '').trim();

  if (!primaryName || !primaryIntroBody) {
    log(`  ⚠ [${profileName}] ${connectedUrls.length} acceptance(s) found but Primary Person name/body missing — skipping auto-intro.`);
    result.skipped = connectedUrls.length;
    _ops('WARN', 'Auto-intro skipped (primary missing)', {
      account: profileName,
      details: `${connectedUrls.length} lead(s) — primaryName="${primaryName}" primaryIntroBody set=${!!primaryIntroBody}`,
    });
    return result;
  }

  // One progress contract for local and VM runs. Keep the local campaign state
  // updated directly so every caller (scheduled sweep, Check now and campaign
  // loop) gets the same live stage even when it did not provide a callback.
  const progress = (patch = {}) => {
    const p = { ...patch, stepAt: Date.now() };
    try { if (typeof onProgress === 'function') onProgress(p); } catch { /* cosmetic */ }
    campaign.currentAction = {
      ...(campaign.currentAction || {}),
      phase: 'introducing',
      account: profileName || profileId || null,
      lead: p.name || campaign._checkingLead || null,
      label: p.name ? `Introducing ${p.name}` : (p.stepLabel || 'Preparing introductions'),
      step: p.step || null,
      stepLabel: p.stepLabel || null,
      stepDetail: p.stepDetail || null,
      done: p.index || 0,
      total: p.total || connectedUrls.length,
      startedAt: p.stepAt,
    };
  };

  // v2.96 — connect-to-primary gate for the bulk-check / monitoring intro path.
  //
  // A 3-way intro can only add a 1st-degree connection of THIS account to the
  // group, so if the sending account isn't connected to the primary every intro
  // fails with INTRO_RECIPIENT_NOT_FOUND ("dropdown never opened"). The live
  // campaign loop already has this gate (campaign.js v2.78/v2.91), but the
  // bulk-check / post-campaign sweep — which calls runAutoIntros directly — did
  // not, so once sending ended any account not yet connected to the primary
  // failed its intros permanently (the failure stamp is terminal, never retried).
  //
  // Here we run the SAME machinery: read the degree to the primary, send ONE
  // connect request if not connected, queue the auto-accept so the primary's own
  // account accepts it in the next idle window, and HOLD this account's intros
  // for the sweep — leaving Introduction Status BLANK so the next bulk-check
  // re-detects the leads and re-fires the intro once the primary has accepted.
  // Dedupe across sweeps via the shared campaign._primaryConn map (same one the
  // v2.78 gate uses), so the connect request is only sent once per account.
  // All four runAutoIntros callers gate on mode === 'connect_and_introduce', and
  // we additionally require a primaryUrl + a real GoLogin profile, so this can
  // never fire on plain Introduce-Back or the local browser.
  if (primaryUrl && isLinkedInProfileUrl(primaryUrl) && profileId && profileId !== 'local-browser') {
    progress({ step: 'verifying_primary', stepLabel: 'Verifying the primary connection', stepDetail: 'Checking that this account can create the group introduction' });
    if (!campaign._primaryConn) campaign._primaryConn = new Map();
    const _prevConn = campaign._primaryConn.get(profileId);
    if (_prevConn !== 'connected') {
      try {
        const _res = await checkAndConnectPrimary(page, primaryUrl, {
          log,
          pName: profileName,
          attemptConnect: (_prevConn === undefined || _prevConn === 'no_url' || _prevConn === 'unverified'),
        });
        // v2.102: tri-state — a degree we couldn't read becomes 'unverified'
        // (no connect, intros proceed), never coerced to 'pending'/"No primary".
        campaign._primaryConn.set(profileId, primaryConnState(_res.connected));

        if (_shouldQueueAutoAccept({
          autoAcceptPrimary: templates.autoAcceptPrimary,
          connectAttempted: _res.connectAttempted,
          connectResult: _res.connectResult,
        })) {
          try {
            const _self = await readSelfIdentity(page);
            if (_self.name || _self.profileUrl) {
              const _stored = await enqueuePrimaryTask(buildAcceptTask({
                campaignProfileId: profileId,
                campaignProfileName: profileName,
                sheetId: extractSheetId(sheetUrl) || '',
                sheetUrl,
                account: _self,
                primaryUrl,
                sender: templates.primarySource,
              }));
              if (_stored) {
                const _where = (templates.primarySource && templates.primarySource !== 'local-browser')
                  ? "the primary's GoLogin profile"
                  : 'your local browser';
                log(`  ⏳ [${profileName}] Auto-accept queued — ${_where} will accept this account's invite at the next idle moment.`);
              }
            } else {
              log(`  ⚠ [${profileName}] Could not read this account's identity (nav not ready) — skipping auto-accept queue; the connect was still sent.`);
            }
          } catch (e) {
            log(`  ⚠ [${profileName}] Auto-accept queue warning: ${e.message}`);
          }
        }

        if (_shouldHoldIntros(_res)) {
          log(`  ⏸ [${profileName}] Not connected to ${primaryName} — ${connectedUrls.length} accepted lead(s) not introduced. Noted on the sheet; clear the note and run a check once they are connected.`);
          try {
            await batchUpdateSheet(sheetUrl, connectedUrls.map((u) => ({ linkedinUrl: u, introductionStatus: INTRO_HELD_PRIMARY_NOT_CONNECTED })));
          } catch (e) {
            log(`  ⚠ [${profileName}] Could not note the held intros on the sheet: ${e.message}`);
          }
          result.skipped = connectedUrls.length;
          return result;
        }
      } catch (e) {
        // Gate failure must never block intros — if the degree read throws,
        // fall through and attempt the intros as before.
        log(`  ⚠ [${profileName}] Primary-connection gate error: ${e.message} — proceeding with intros.`);
      }
    }
  }

  // Build the templates object the way campaign.js does for Introduce Back —
  // same shape, full wizard inheritance — with the CC+IC-specific overlay.
  // `introUrl` is what makes sendIntroMessage use URL-routing for the
  // second pill (see actions.js:1284 and outreach.js:488). Without it the
  // call would fall back to the typeahead-typing path, which is what was
  // failing in the field with "dropdown never opened".
  const tpl = {
    ...templates,
    introMode: true,
    introName: primaryName,
    followUpMessage: primaryIntroBody,
    introUrl: primaryUrl,
    introTitle: templates.introTitle || 'Introduction: {firstName} <> {primaryFirstName}',
  };

  // Campaign-level: did this campaign send a connection note? If so the lead has a
  // prior 1:1 thread and URL-routing would collapse the intro into it (spec
  // 2026-06-10). Note campaigns route through clean-compose (group) instead.
  const hasConnectionNote = (templates.connectionNote || templates.note || '').toString().trim() !== '';

  // Re-fetch sheet to map URLs → row data for placeholder substitution.
  // Cheap (single CSV read) and necessary because outreach.js merges the
  // row data into templates so {first name}, {primary name}, etc. resolve.
  let rows = [];
  try { rows = await fetchSheet(sheetUrl); } catch { /* best-effort — empty data is fine */ }
  const rowByUrl = new Map();
  for (const r of rows) {
    const u = extractLinkedInUrl(r, linkedinColumn);
    if (u) rowByUrl.set(u, r);
  }

  // Defense-in-depth duplicate-profile guard (2026-06-16): collapse the
  // work-list by strong identity so the send loop below physically cannot fire
  // the intro twice for the same person, even if a caller hands us a list with
  // duplicates. bulk-check dedups upstream; this is the belt-and-suspenders.
  {
    const _dd = _dedupeIntroUrls(connectedUrls, rowByUrl);
    if (_dd.duplicates > 0) {
      log(`  ⚠ [${profileName}] Collapsed ${_dd.duplicates} duplicate profile(s) in this batch — introducing each person once.`);
      connectedUrls = _dd.urls;
    }
  }

  // v2.14.x: split primaryName on whitespace so operators can write
  // "Hey {firstName}, let me introduce you {primary first name}" instead
  // of always rendering the full name. Mirrors the intro-name split in
  // outreach.js:469-484 for the IB path.
  const primaryTokens    = primaryName.split(/\s+/);
  const primaryFirstName = primaryTokens[0] || '';
  const primaryLastName  = primaryTokens.slice(1).join(' ');

  // v2.14.x: split introName (=primaryName) the same way outreach.js:469-484
  // does for IB, so {intro first name} / {intro last name} resolve in both
  // the body and the group title.
  const introTokens = primaryName.split(/\s+/);
  const introFirst  = introTokens[0] || '';
  const introLast   = introTokens.slice(1).join(' ');

  // v2.14.x: bail-out helper. When stop is pressed mid-batch or the browser
  // dies under us, the remaining intros never get a fair attempt — stamp
  // them with a 'Skipped — <reason>' status so the operator does NOT see a
  // cascade of bogus 'Failed' marks. Reason ∈ {'Stop pressed','browser closed'}.
  // The next campaign run / bulk-check sweep will re-detect these leads as
  // Connected with no Introduction Status and fire the intro fresh.
  async function _stampSkipped(skippedUrls, reason) {
    for (const skippedUrl of skippedUrls) {
      await updateSheetRow(sheetUrl, skippedUrl, {
        introductionStatus: `Skipped — ${reason}`,
        sender: profileName,
        accountUsed: profileName,
        dateLastAction: _formatLocalDate(new Date()),
        auditAction: `Intro skipped: ${reason} (lead never attempted)`,
      }, linkedinColumn).catch(() => {});
      result.skipped++;
    }
  }
  // v2.14.x: returns true when the puppeteer page is dead — browser was
  // killed (closeAllProfiles), the websocket dropped, or the tab was closed.
  // page.isClosed() is documented but flaky in edge cases (puppeteer#6695);
  // pairing it with browser.connected catches every real scenario.
  function _browserAlive() {
    try {
      const b = page.browser?.();
      if (!b || b.connected === false) return false;
      if (page.isClosed?.()) return false;
      return true;
    } catch { return false; }
  }

  log(`  🤝 [${profileName}] Auto-introducing ${connectedUrls.length} new connection(s) to ${primaryName}…`);
  // Three-strikes rule: consecutive failures for THIS sender in THIS pass.
  const INTRO_STRIKES = 3;
  let _consecutiveFailures = 0;
  for (let i = 0; i < connectedUrls.length; i++) {
    const url = connectedUrls[i];

    // Stop lands within one person, not at the end of the account. The leads
    // left over are abandoned WITHOUT a stamp, so the next check reads them
    // again. This is why nothing is written here, unlike the Stop branch
    // below, which marks the rest as Skipped because the whole run is over.
    if (campaign._abortCheck) {
      log(`  ■ [${profileName}] Check stopped by you. ${connectedUrls.length - i} person(s) were left untouched, so the next check reads them again.`);
      break;
    }

    // v2.14.x: graceful-abort checkpoint. Without this guard, runAutoIntros
    // keeps iterating against a dead page after the operator presses Stop
    // (which force-closes browsers from server.js:/api/campaign/stop) or
    // after any silent browser death — every subsequent sendIntroMessage
    // fails fast at 'compose textbox did not appear' and stamps the lead
    // as 'Failed', producing the 7-bogus-Failed cascade seen 2026-05-17.
    // Industry pattern (Crawlee #1102, Puppeteer #4671): check abort flag
    // + browser-alive between iterations and bail out cleanly. Remaining
    // leads are stamped as 'Skipped — <reason>' so the operator can tell
    // them apart from real LinkedIn-side failures.
    if (campaign._abort) {
      log(`  ■ [${profileName}] Stop detected — marking remaining ${connectedUrls.length - i} intro(s) as Skipped.`);
      await _stampSkipped(connectedUrls.slice(i), 'Stop pressed');
      break;
    }
    if (!_browserAlive()) {
      log(`  ■ [${profileName}] Browser closed — marking remaining ${connectedUrls.length - i} intro(s) as Skipped.`);
      await _stampSkipped(connectedUrls.slice(i), 'browser closed');
      break;
    }

    // Build `data` the EXACT same way campaign.js builds it for the IB
    // batch loop (see src/campaign.js around the `Build template data`
    // comment). senderFirstName resolves from the operator-configured
    // map first, falling back to splitting the profile display name —
    // matching IB byte-for-byte.
    const row = rowByUrl.get(url) || {};
    const resolvedFirst = senderFirstNames[profileId];
    // v2.14.x: tolerate every reasonable casing of the name columns —
    // "First Name" / "first name" / "FIRST NAME" / "First name" /
    // "firstName" / "first_name". Without this, a column header like
    // "first name" (lowercase) silently produces an empty firstName and
    // the intro DM goes out as "Hey , let me introduce you…" with the
    // lead's name missing. See live-test screenshot 2026-05-15.
    const leadFirstName = row['First Name'] || row['First name'] || row['first name']
      || row['FIRST NAME'] || row['firstName'] || row['FirstName'] || row['first_name'] || '';
    const leadLastName = row['Last Name'] || row['Last name'] || row['last name']
      || row['LAST NAME'] || row['lastName'] || row['LastName'] || row['last_name'] || '';
    // Name the person the check is on, so a stop can say who it interrupted.
    campaign._checkingLead = `${leadFirstName} ${leadLastName}`.trim() || null;
    const data = {
      ...row,
      firstName: leadFirstName,
      lastName: leadLastName,
      // v2.14.x: the default introTitle is `'Introduction: {first name}
      // <> {intro name}'` (with a space). Without these aliases the
      // {first name} token never resolves and the thread title renders
      // as "Introduction:  <> Antonio Varlese" with the lead's name
      // missing. Mirror the camelCase + with-space dual-flavour pattern
      // outreach.js uses for intro name.
      'first name': leadFirstName,
      'last name': leadLastName,
      company: row['Company'] || row['company'] || '',
      title: row['Title'] || row['title'] || row['Job Title'] || '',
      senderName: profileName || '',
      senderFirstName: (resolvedFirst && resolvedFirst.trim())
        || (profileName || '').split(/\s+/)[0]
        || '',
      // Surface the primary person under every naming flavour the
      // operator might have typed: legacy "primary name", new
      // "primary full name" (v2.14.x rename), and the camelCase form.
      // All three resolve to the same full name so old templates keep
      // working after the wizard chip rename.
      primaryName,
      'primary name': primaryName,
      'primary full name': primaryName,
      'primaryFullName': primaryName,
      'primary_full_name': primaryName,
      primaryUrl: primaryUrl || '',
      'primary url': primaryUrl || '',
      // v2.14.x: primary-name split — operators can now write just
      // {primary first name} instead of always {primary name}. All
      // three naming flavours accepted (with-space label, camelCase,
      // snake_case) for parity with how outreach.js handles intro name.
      'primary first name': primaryFirstName,
      'primaryFirstName':   primaryFirstName,
      'primary_first_name': primaryFirstName,
      'primary last name': primaryLastName,
      'primaryLastName':   primaryLastName,
      'primary_last_name': primaryLastName,
    };
    // v2.14.x: diagnostic log — surfaces whether rowByUrl found the lead
    // and what firstName/lastName resolved to. If the field still comes
    // up empty after the casing tolerance above, this line tells the
    // operator exactly which column header to fix in their sheet.
    log(`     · row matched=${!!rowByUrl.get(url)} firstName="${leadFirstName}" lastName="${leadLastName}"`);
    log(`  ✓ [${profileName}] ${url}: Connection Accepted (stamped at detection)`);

    // v2.14.x: IC DM fast-path — bypass performOutreach entirely.
    //
    // The old path called performOutreach(..., 'force_message') which did:
    //   1. page.goto(leadProfile, { waitUntil: 'networkidle0', timeout: 30s })
    //   2. waitForDomSettle (1.5s settle + 2s buffer)
    //   3. zoom=75%
    //   4. Voyager degree check + getConnectionStatus DOM check
    //   5. → eventually called sendIntroMessage, which navigates to compose anyway
    //
    // For IC DM none of (1)-(4) is necessary: bulk-check just confirmed
    // degree=1 within the last ~60s, and sendIntroMessage navigates to its
    // own compose URL. The profile-visit detour wasted 5-30s per lead in
    // background-throttled mode and was the underlying reason the 180s
    // watchdog kept firing. Now we build the body/title from templates and
    // call sendIntroMessage directly with the lead URL as the 6th arg.
    //
    // INTRO_RECIPIENT_NOT_FOUND retry-once is preserved.
    const introData = {
      ...data,
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
    const body  = personalizeTemplate(tpl.followUpMessage, introData);
    const title = personalizeTemplate(tpl.introTitle, introData);

    let ok = false;
    let alreadyMade = false;
    let errMsg = '';
    let attempt = 0;

    // v2.110 (Antonio + boss, 2026-06-16): CC+IC now ALWAYS builds the 3-way
    // GROUP via clean-compose — the exact path Introduce Back uses. A blank
    // /messaging/compose/ with both pills typed by name never collapses into an
    // existing 1:1 thread, so the old v2.92 _leadHasPriorThread DOM probe (which
    // missed in the field — Pinky Salaria) is gone: there's nothing to detect.
    // URL-routing survives ONLY as the fallback for rows with no name to typeahead.
    const leadFullName = `${leadFirstName} ${leadLastName}`.trim();
    const baseProgress = { name: leadFullName, index: i + 1, total: connectedUrls.length };
    progress({ ...baseProgress, step: 'opening_compose', stepLabel: 'Opening the introduction message', stepDetail: 'Preparing a new three-person conversation' });

    // Same-name disambiguation needs the intended person's real profile photo.
    // Resolved LAZILY (only on a typeahead ambiguity) so the common single-match
    // case keeps the fast-path's zero-profile-visit speed. The primary's photo is
    // cached across leads/sweeps — it's one person per campaign.
    let leadAvatarToken = '';
    let primaryAvatarToken = (campaign._primaryAvatarToken && campaign._primaryAvatarToken.url === primaryUrl)
      ? campaign._primaryAvatarToken.token
      : '';

    while (attempt < 2) {
      attempt++;
      try {
        progress({ ...baseProgress, step: 'selecting_recipients', stepLabel: 'Selecting both recipients', stepDetail: attempt > 1 ? `Retry ${attempt} · resolving the correct people` : 'Adding the accepted lead and primary person' });
        progress({ ...baseProgress, step: 'sending_message', stepLabel: 'Writing and sending the introduction', stepDetail: 'Waiting for LinkedIn to confirm the message' });
        if (leadFullName) {
          await sendIntroViaCleanCompose(page, body, leadFullName, primaryName, title, {
            dedupeProbe: true,
            leadAvatarToken,
            primaryAvatarToken,
          });
        } else {
          // No First/Last Name on the row → can't typeahead the lead into a group.
          // Fall back to URL-routing (Antonio's choice 2026-06-16); it can collapse
          // into a 1:1, but it's the only option without a name.
          log(`  ⚠ [${profileName}] ${url}: no First/Last Name on the row — URL-routing fallback (add a name to force the 3-way group).`);
          await sendIntroMessage(page, body, primaryName, title, '', url);
        }
        ok = true;
        break;
      } catch (err) {
        errMsg = err.message || String(err);
        // Existing-thread redirect (URL-routing fallback path) → already introduced.
        if (errMsg.includes('INTRO_ALREADY_EXISTS')) {
          alreadyMade = true;
          break;
        }
        // Same-name ambiguity: resolve the intended person's REAL profile photo(s)
        // and retry once so the typeahead picks by picture. If no reference photo
        // can be captured, fall through → skip (never message the wrong person).
        if (attempt < 2 && errMsg.includes('IC_INTRO_AMBIGUOUS_RECIPIENT')) {
          if (!leadAvatarToken && leadFullName) {
            leadAvatarToken = await _captureProfileAvatarToken(page, url, leadFullName).catch(() => '');
          }
          if (!primaryAvatarToken && primaryUrl) {
            primaryAvatarToken = await _captureProfileAvatarToken(page, primaryUrl, primaryName).catch(() => '');
            if (primaryAvatarToken) campaign._primaryAvatarToken = { url: primaryUrl, token: primaryAvatarToken };
          }
          if (leadAvatarToken || primaryAvatarToken) {
            log(`  ↻ [${profileName}] ${url}: same-name match — resolved profile photo(s), retrying with photo disambiguation…`);
            continue;
          }
          break; // no reference photo available → skip-on-doubt
        }
        if (attempt < 2 && (errMsg.includes('INTRO_RECIPIENT_NOT_FOUND') || errMsg.includes('IC_INTRO_RECIPIENT_NOT_FOUND'))) {
          log(`  ↻ [${profileName}] ${url}: typeahead miss, retrying once…`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        break;
      }
    }

    // v2.61.0: if intro failed with compose-textbox-did-not-appear AND the row's
    // Connection Accepted Status reads "Connected", that combination is impossible
    // for a real 1st-degree connection. Reverify via profile visit and downgrade
    // the row if not actually connected. Also increment the per-URL cap counter
    // so bulk-check can stop re-queueing this URL after 3 attempts.
    if (!ok && !alreadyMade && errMsg.includes('MESSAGE_SEND_FAILED: compose textbox did not appear')) {
      const prev = campaign.composeAttempts?.get?.(url) || 0;
      campaign.composeAttempts?.set?.(url, prev + 1);

      const currentCc = (row['Connection Accepted Status'] || row['connection accepted status'] || '').toString().trim();
      if (currentCc === 'Connected') {
        await _reverifyAndDowngrade({
          page, url, profileName,
          sheetUrl, linkedinColumn,
          currentCc, log,
        });
      }
    }

    // v2.14.x: was the failure caused by abort or by the browser dying
    // mid-send? If so, this isn't a Failed (LinkedIn-side rejection) — it
    // never got a fair attempt. Reclassify as Skipped so the operator can
    // tell phantom failures apart from real ones.
    const interrupted = !ok && !alreadyMade && (campaign._abort || !_browserAlive());
    const interruptReason = campaign._abort ? 'Stop pressed' : 'browser closed';

    // v2.14.x: Connection Accepted Status is stamped at bulk-check
    // detection (suppressAcceptedStamp=false in the campaign call sites).
    // auto-intro only stamps Introduction Status here.
    const tracking = {
      introductionStatus: alreadyMade
        ? 'Introduction Already Made'
        : ok
          ? 'Introduction Made'
          : interrupted
            ? `Skipped — ${interruptReason}`
            : _friendlyIntroFailure(errMsg),
      // v2.104: a made/already-made intro proves the connection — stamp the
      // connection columns too so the row never reads "Connect Pending".
      ...introConnectionStamp(ok || alreadyMade),
      sender: profileName,
      accountUsed: profileName,
      dateLastAction: _formatLocalDate(new Date()),
      auditAction: alreadyMade
        ? `Introduction thread already exists with ${primaryName}`
        : ok
          ? `Introduction sent to ${primaryName}`
          : interrupted
            ? `Intro skipped: ${interruptReason} (interrupted mid-send)`
            : `Intro failed: ${errMsg || 'unknown'}`,
    };
    progress({ ...baseProgress, step: 'stamping_sheet', stepLabel: ok || alreadyMade ? 'Introduction sent and confirmed' : 'Recording the introduction result', stepDetail: 'Stamping the verified result to the campaign sheet' });
    await updateSheetRow(sheetUrl, url, tracking, linkedinColumn).catch(() => {});
    if (ok) {
      // v2.14.x: blacklist this URL for the rest of the process so the next
      // bulk-check pass (5-min cooldown) doesn't re-fire the same intro.
      // Primary defense against Google Sheets CSV-export cache lag.
      try { campaign.introducedInRun?.add(url); } catch { /* */ }
      result.sent++;
      progress({ ...baseProgress, step: 'intro_complete', stepLabel: 'Introduction complete', stepDetail: 'Confirmed and stamped to the sheet', outcome: 'sent' });
      log(`  🤝 [${profileName}] ${url}: Introduction Made`);
      // v2.91: queue the automated first follow-up. page is still on the group
      // thread here (compose redirected to /messaging/thread/...), so capture it.
      try {
        let _threadUrl = '';
        try { _threadUrl = page.url(); } catch { /* */ }
        const _fu = maybeBuildFollowUp({
          tpl, introData, profileId, profileName, sheetUrl,
          leadName: `${leadFirstName} ${leadLastName}`.trim() || url,
          url, threadUrl: _threadUrl,
        });
        if (_fu) {
          const stored = await enqueueFollowUpBatched(_fu, tpl.followUpDelayMinutes, Date.now());
          if (stored) log(`  ⏳ [${profileName}] ${url}: Follow-up queued · due ${new Date(stored.dueAt).toLocaleTimeString()} · from ${_fu.sender === 'local-browser' ? 'you' : 'the primary'}`);
        }
      } catch (e) {
        log(`  ⚠ [${profileName}] Follow-up queue warning: ${e.message}`);
      }
    } else if (alreadyMade) {
      // Counted as a sent (the intro is effectively done — there's an
      // active thread) so result.sent reflects real coverage rather than
      // creating a third counter the campaign loop would have to learn
      // about. The distinct sheet stamp + log line preserve the audit.
      try { campaign.introducedInRun?.add(url); } catch { /* */ }
      result.sent++;
      progress({ ...baseProgress, step: 'intro_complete', stepLabel: 'Introduction already existed', stepDetail: 'Existing conversation recorded in the sheet', outcome: 'already-made' });
      log(`  ⏳ [${profileName}] ${url}: Introduction Already Made (existing thread detected)`);
    } else if (interrupted) {
      result.skipped++;
      log(`  ■ [${profileName}] ${url}: Skipped — ${interruptReason}`);
      // Browser is dead / abort raised — stamp the rest as skipped and exit
      // the for-loop rather than wasting cycles on guaranteed failures.
      if (i < connectedUrls.length - 1) {
        log(`  ■ [${profileName}] Marking remaining ${connectedUrls.length - i - 1} intro(s) as Skipped.`);
        await _stampSkipped(connectedUrls.slice(i + 1), interruptReason);
      }
      break;
    } else {
      result.failed++;
      progress({ ...baseProgress, step: 'intro_complete', stepLabel: 'Introduction could not be completed', stepDetail: errMsg || 'Unknown introduction error', outcome: 'failed' });
      log(`  ⚠ [${profileName}] ${url}: Failed (${errMsg || 'unknown'})`);
      // v2.57.x — surface every intro failure in the centralized Ops Log
      // sheet. Without this, the Ops Log only shows campaign-start/end and
      // operators discover failures by scrolling the leads-sheet Audit tab
      // after the fact. INTRO_RECIPIENT_NOT_FOUND, MESSAGE_SEND_FAILED,
      // INTRO_DROPDOWN_HANG, and every other actions.js intro throw lands
      // here as errMsg.
      _ops('ERROR', 'Intro failed', {
        account: profileName,
        leadUrl: url,
        details: errMsg || 'unknown',
      });
      _consecutiveFailures++;
      if (_consecutiveFailures >= INTRO_STRIKES) {
        // The pre-check reads the sender→primary degree, but an unreadable
        // degree ('unverified') lets intros proceed — and then every one fails.
        // Three in a row is the signal: assume not connected, hold the sender
        // (campaign._primaryConn 'pending' makes every later intro point hold
        // and note it), and say so on the rows we are no longer attempting.
        const rest = connectedUrls.slice(i + 1);
        log(`  ⛔ [${profileName}] ${INTRO_STRIKES} introductions in a row failed — assuming this account is not connected to ${primaryName}. ${rest.length ? `Noting the remaining ${rest.length} on the sheet; ` : ''}connect them, clear the notes and run a check to retry.`);
        try {
          if (!campaign._primaryConn) campaign._primaryConn = new Map();
          campaign._primaryConn.set(profileId, 'pending');
        } catch { /* singleton absent in unit tests */ }
        if (rest.length) {
          try {
            await batchUpdateSheet(sheetUrl, rest.map((u) => ({ linkedinUrl: u, introductionStatus: INTRO_ASSUMED_PRIMARY_NOT_CONNECTED })));
          } catch (e) {
            log(`  ⚠ [${profileName}] Could not note the assumed disconnection on the sheet: ${e.message}`);
          }
          result.skipped += rest.length;
        }
        break;
      }
    }
    if (ok || alreadyMade) _consecutiveFailures = 0;

    // v2.14.x: brief feed visit between IC DMs. Mirrors the organic
    // browsing the campaign loop does between connect requests — gives
    // the compose page a clean reset before the next intro and pads
    // the cadence to look less robotic. Skipped after the last lead.
    if (i < connectedUrls.length - 1) {
      try {
        log(`  🔄 [${profileName}] Brief feed visit between intros…`);
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 5000));
      } catch (e) {
        // Feed visit is best-effort; don't fail the batch over it.
        log(`  ⚠ [${profileName}] Feed visit warning: ${e.message}`);
      }
    }
  }
  return result;
}
