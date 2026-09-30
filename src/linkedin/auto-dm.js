/**
 * Auto-DM pass for the connect_and_message (CC+DM) campaign mode.
 *
 * Mirrors src/linkedin/auto-intro.js byte-for-byte EXCEPT:
 *   - Sends a plain 1:1 DM via sendMessage() instead of a 3-way intro
 *     group thread via sendIntroMessage(). No primary person involved.
 *   - Uses `templates.ccDmBody` (operator-edited in #tpl-cc-dm-body) as
 *     the body template — NOT primaryIntroBody.
 *   - Stamps `DM Status = 'DM Sent'` on the sheet — NOT
 *     `Introduction Status = 'IC Sent'`. Matches the v2.62 standalone-DM
 *     stamp pattern (campaign.js:1017-1037 for mode=message_only).
 *
 * Given a list of leads that just flipped to Connected (returned by
 * bulkCheckConnections.connectedUrls), use the LinkedIn compose URL
 * directly (skipping profile-nav + Voyager + degree check) and send a
 * personalised DM.
 */

import { sendMessage } from './actions.js';
import { personalizeTemplate, getConnectionStatus } from './helpers.js';
import { fetchSheet } from '../sheets.js';
import { updateSheetRow } from '../sheets-writer.js';
import { extractLinkedInUrl, campaign, _ops } from '../campaign.js';
import { hasDmBeenSent, recordDmSent } from '../dm-sent-log.js';

function _formatLocalDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = d.getDate();
  const ord = (n) => (n % 10 === 1 && n % 100 !== 11) ? 'st'
    : (n % 10 === 2 && n % 100 !== 12) ? 'nd'
    : (n % 10 === 3 && n % 100 !== 13) ? 'rd' : 'th';
  return `${months[d.getMonth()]} ${day}${ord}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Pure decision helper for reverify-and-downgrade (mirrors auto-intro.js).
// Given getConnectionStatus(page) result + the row's current CC value,
// decide whether to downgrade. Strict: only clear-negative signals
// ('connect', 'pending') downgrade; ambiguous reads keep the stamp.
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

// Translate raw sendMessage error strings into operator-friendly
// "Failed — <reason>" labels for the DM Status column. Mirrors the
// auto-intro friendly-failure mapping but trimmed to the error patterns
// sendMessage actually throws (no recipient-typeahead / dropdown-hang
// patterns — those are intro-specific).
function _friendlyDmFailure(errMsg) {
  const m = errMsg || '';
  if (m.includes('MESSAGE_SEND_FAILED: compose textbox did not appear')) {
    return "Failed — Compose page didn't load";
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
  // Unknown — preserve truncated raw so new patterns aren't lost.
  const trunc = m.length > 60 ? m.slice(0, 57) + '…' : m;
  return `Failed — ${trunc || 'unknown'}`;
}

/**
 * @param {object} args
 * @param {puppeteer.Page} args.page          - active page on a logged-in LinkedIn session
 * @param {string} args.profileId             - sender's GoLogin profile id
 * @param {string} args.profileName           - sender's display label (email)
 * @param {string} args.sheetUrl              - target sheet URL
 * @param {string} args.linkedinColumn        - operator-specified URL column name
 * @param {string[]} args.connectedUrls       - leads that just flipped to Connected
 * @param {object} args.templates             - wizard templates (full object — ccDmBody, etc.)
 * @param {Record<string,string>} [args.senderFirstNames] - operator-configured nice names per profileId
 * @param {Function} [args.log]               - log function (defaults to console.log)
 * @returns {Promise<{sent: number, failed: number, skipped: number}>}
 */
export async function runAutoDms({
  page,
  profileId,
  profileName,
  sheetUrl,
  linkedinColumn,
  connectedUrls,
  templates = {},
  senderFirstNames = {},
  log = console.log,
}) {
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (!Array.isArray(connectedUrls) || connectedUrls.length === 0) return result;

  const ccDmBody = (templates.ccDmBody || '').trim();

  if (!ccDmBody) {
    log(`  ⚠ [${profileName}] ${connectedUrls.length} acceptance(s) found but CC+DM body template missing — skipping auto-DM.`);
    result.skipped = connectedUrls.length;
    _ops('WARN', 'Auto-DM skipped (body missing)', {
      account: profileName,
      details: `${connectedUrls.length} lead(s) — ccDmBody empty`,
    });
    return result;
  }

  // Re-fetch sheet to map URLs → row data for placeholder substitution.
  let rows = [];
  try { rows = await fetchSheet(sheetUrl); } catch { /* best-effort */ }
  const rowByUrl = new Map();
  for (const r of rows) {
    const u = extractLinkedInUrl(r, linkedinColumn);
    if (u) rowByUrl.set(u, r);
  }

  async function _stampSkipped(skippedUrls, reason) {
    for (const skippedUrl of skippedUrls) {
      await updateSheetRow(sheetUrl, skippedUrl, {
        dmStatus: `Skipped — ${reason}`,
        sender: profileName,
        accountUsed: profileName,
        dateLastAction: _formatLocalDate(new Date()),
        auditAction: `DM skipped: ${reason} (lead never attempted)`,
      }, linkedinColumn).catch(() => {});
      result.skipped++;
    }
  }
  function _browserAlive() {
    try {
      const b = page.browser?.();
      if (!b || b.connected === false) return false;
      if (page.isClosed?.()) return false;
      return true;
    } catch { return false; }
  }

  log(`  💬 [${profileName}] Auto-DMing ${connectedUrls.length} new connection(s)…`);
  for (let i = 0; i < connectedUrls.length; i++) {
    const url = connectedUrls[i];

    // Stop lands within one person, not at the end of the account. The leads
    // left over are abandoned WITHOUT a stamp, so the next check reads them
    // again. Nothing is written here, unlike the Stop branch below, which
    // marks the rest as Skipped because the whole run is over.
    if (campaign._abortCheck) {
      log(`  ■ [${profileName}] Check stopped by you. ${connectedUrls.length - i} person(s) were left untouched, so the next check reads them again.`);
      break;
    }

    if (campaign._abort) {
      log(`  ■ [${profileName}] Stop detected — marking remaining ${connectedUrls.length - i} DM(s) as Skipped.`);
      await _stampSkipped(connectedUrls.slice(i), 'Stop pressed');
      break;
    }
    if (!_browserAlive()) {
      log(`  ■ [${profileName}] Browser closed — marking remaining ${connectedUrls.length - i} DM(s) as Skipped.`);
      await _stampSkipped(connectedUrls.slice(i), 'browser closed');
      break;
    }

    const row = rowByUrl.get(url) || {};

    // v2.6x — defense-in-depth (primary guard is in bulk-check's connectedUrls
    // builder, computeBulkCheckUpdates + dmSentTerminal). If this row already
    // shows DM Status='DM Sent' on the freshly-fetched sheet, skip it silently:
    // never overwrite a terminal 'DM Sent' with 'Skipped — DM already sent',
    // and never send a duplicate DM if the template was since edited.
    const _existingDm = (
      row['DM Status'] || row['dm status'] || row['DM status'] ||
      row['Direct Message Status'] || row['dmStatus'] || ''
    ).toString().trim();
    if (_existingDm === 'DM Sent') {
      log(`  ⤼ [${profileName}] ${url}: already 'DM Sent' on the sheet — skipping (no re-stamp).`);
      result.skipped++;
      continue;
    }

    const resolvedFirst = senderFirstNames[profileId];
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
      'first name': leadFirstName,
      'last name': leadLastName,
      company: row['Company'] || row['company'] || '',
      title: row['Title'] || row['title'] || row['Job Title'] || '',
      senderName: profileName || '',
      senderFirstName: (resolvedFirst && resolvedFirst.trim())
        || (profileName || '').split(/\s+/)[0]
        || '',
    };
    log(`     · row matched=${!!rowByUrl.get(url)} firstName="${leadFirstName}" lastName="${leadLastName}"`);
    log(`  ✓ [${profileName}] ${url}: Connection Accepted (stamped at detection)`);

    // CC+DM fast-path — bypass performOutreach + profile-nav. bulk-check
    // confirmed degree=1 within the last ~60s and sendMessage navigates
    // to its own compose URL via explicitPublicId. Mirrors the
    // auto-intro.js fast-path comment at L353-369.
    const m = url.match(/\/in\/([^/?#]+)/);
    if (!m) {
      log(`  ⚠ [${profileName}] ${url}: URL not in /in/<publicId> format — skipping.`);
      await updateSheetRow(sheetUrl, url, {
        dmStatus: 'Failed — Invalid lead URL',
        sender: profileName,
        accountUsed: profileName,
        dateLastAction: _formatLocalDate(new Date()),
        auditAction: 'DM failed: URL not in /in/<publicId> format',
      }, linkedinColumn).catch(() => {});
      result.failed++;
      continue;
    }
    const publicId = m[1];
    const body = personalizeTemplate(ccDmBody, data);

    // Content-level dedup (cross-campaign): never re-send the SAME message to
    // the same person. If we recorded sending this exact rendered message to
    // this lead in a past campaign, skip + stamp instead of re-DMing. Changing
    // the template produces a different render → not a match → sends normally.
    if (await hasDmBeenSent(publicId, body)) {
      log(`  ⤼ [${profileName}] ${url}: identical DM already sent before — skipping.`);
      await updateSheetRow(sheetUrl, url, {
        dmStatus: 'Skipped — DM already sent',
        sender: profileName,
        accountUsed: profileName,
        dateLastAction: _formatLocalDate(new Date()),
        auditAction: 'DM skipped: identical message already sent (prior campaign)',
      }, linkedinColumn).catch(() => {});
      result.skipped++;
      continue;
    }

    let ok = false;
    let errMsg = '';
    try {
      await sendMessage(page, body, publicId);
      ok = true;
    } catch (err) {
      errMsg = err.message || String(err);
    }

    // Reverify-and-downgrade safety net — mirrors auto-intro.js L420-432.
    // If DM failed with compose-textbox-did-not-appear AND row's CC reads
    // Connected, that combination is impossible for a real 1st-degree
    // connection. Reverify via profile visit and downgrade if not connected.
    if (!ok && errMsg.includes('MESSAGE_SEND_FAILED: compose textbox did not appear')) {
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

    const interrupted = !ok && (campaign._abort || !_browserAlive());
    const interruptReason = campaign._abort ? 'Stop pressed' : 'browser closed';

    // CC+DM stamps DM Status (parallel to standalone DM mode in
    // campaign.js:1017-1037). Connection Accepted Status is already
    // stamped at bulk-check detection.
    const tracking = {
      dmStatus: ok
        ? 'DM Sent'
        : interrupted
          ? `Skipped — ${interruptReason}`
          : _friendlyDmFailure(errMsg),
      sender: profileName,
      accountUsed: profileName,
      dateLastAction: _formatLocalDate(new Date()),
      auditAction: ok
        ? 'DM sent'
        : interrupted
          ? `DM skipped: ${interruptReason} (interrupted mid-send)`
          : `DM failed: ${errMsg || 'unknown'}`,
    };
    await updateSheetRow(sheetUrl, url, tracking, linkedinColumn).catch(() => {});
    if (ok) {
      // Same blacklist pattern as auto-intro — defends against Sheets
      // CSV-export cache lag so the next bulk-check sweep doesn't
      // re-fire the same DM.
      try { campaign.dmSentInRun?.add(url); } catch { /* */ }
      // Record the exact message so a future campaign won't re-send an
      // identical DM to this person.
      try { await recordDmSent(publicId, body); } catch { /* non-fatal */ }
      result.sent++;
      log(`  💬 [${profileName}] ${url}: DM Sent`);
    } else if (interrupted) {
      result.skipped++;
      log(`  ■ [${profileName}] ${url}: Skipped — ${interruptReason}`);
      if (i < connectedUrls.length - 1) {
        log(`  ■ [${profileName}] Marking remaining ${connectedUrls.length - i - 1} DM(s) as Skipped.`);
        await _stampSkipped(connectedUrls.slice(i + 1), interruptReason);
      }
      break;
    } else {
      result.failed++;
      log(`  ⚠ [${profileName}] ${url}: Failed (${errMsg || 'unknown'})`);
      _ops('ERROR', 'CC+DM auto-DM failed', {
        account: profileName,
        leadUrl: url,
        details: errMsg || 'unknown',
      });
    }

    // Brief feed visit between DMs — mirrors auto-intro.js L505-518.
    // Gives the compose page a clean reset before the next DM and pads
    // cadence to look less robotic. Skipped after last lead.
    if (i < connectedUrls.length - 1) {
      try {
        log(`  🔄 [${profileName}] Brief feed visit between DMs…`);
        await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 5000));
      } catch (e) {
        log(`  ⚠ [${profileName}] Feed visit warning: ${e.message}`);
      }
    }
  }
  return result;
}
