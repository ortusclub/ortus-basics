/**
 * Bulk Connection Status check.
 *
 * Replaces the per-lead Voyager-degree check with a single paginated fetch
 * of the account's recent connections. Each sweep appends its fetch into the
 * per-campaign "Recent Connections" tab (the accumulating source of truth),
 * then matches sheet rows against that ACCUMULATED set — not the live fetch —
 * so acceptances that fall off LinkedIn's ~80-most-recent window are still
 * remembered. Matched rows get Connected Status = 'Connected' written back
 * via the existing batchUpdate path.
 *
 * Match keys (any one hits): LinkedIn public-id slug, ACoAA member id (URN),
 * or first+last name — each attributed to the owning campaign Sender (the
 * `account` field). "Is this lead connected?" is answered from the account
 * that owns the connection in the tab, not from which profile is sweeping:
 * the row's assigned Sender owning it → Connected; only a different campaign
 * sender owning it → "Already connected to <that account>".
 *
 * Caller is responsible for cooldown gating + navigating the page to a
 * LinkedIn URL before invoking (so JSESSIONID is present for Voyager).
 */

import { getRecentConnections } from './helpers.js';
import { fetchSheet } from '../sheets.js';
import { batchUpdateSheet, writeRecentConnectionsTab } from '../sheets-writer.js';
import { extractLinkedInUrl, campaign } from '../campaign.js';
import { readSourceMemberId } from '../profile-identity.js';
import { isIntroSlotOpen } from './intro-constants.js';
import { plainLine } from '../log-voice.js';

function publicIdFromUrl(url) {
  if (!url) return '';
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase().trim() : '';
}

// Extract LinkedIn's ACwAA-style member ID from any string (URL, URN, etc.).
// Some sheet rows use /in/ACwAA…-style URLs (URN-encoded) instead of the
// vanity /in/firstname-lastname slug. The Voyager connections API returns
// both representations across different fields, so we match on either.
function memberIdFromAny(value) {
  if (!value) return '';
  const m = String(value).match(/(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * Strong-identity keys for a lead row — the SAME signals bulk-check already
 * matches connections on (vanity slug + ACwAA member token + numeric
 * Membership ID). Two rows are "the same person" when ANY key overlaps, so a
 * duplicate profile — whether it's a byte-identical row written underneath
 * another (the boss's 109/110 report) or a different URL form of the same
 * person (trailing slash, ?query, vanity slug vs /in/ACwAA… member-id URL) —
 * collapses to one intro. Each key is type-prefixed so a slug can never
 * collide with a member number. Exported so the auto-intro pass can apply the
 * identical dedup to its work-list (defense in depth).
 */
export function leadIdentityKeys(url, row) {
  const keys = [];
  const slug = publicIdFromUrl(url);
  if (slug) keys.push('slug:' + slug);
  const rowUrn = (row && (row['LinkedIn URN'] || row['linkedin urn'])) || '';
  const mid = memberIdFromAny(rowUrn) || memberIdFromAny(url);
  if (mid) keys.push('mid:' + mid);
  const num = readSourceMemberId(row || {});
  if (num) keys.push('num:' + num);
  return keys;
}

/**
 * Pure helper — given the fetched connections + the sheet rows, decide
 * which rows get Connected stamps vs Still Pending stamps. Extracted from
 * bulkCheckConnections so it can be unit-tested without spinning up a
 * Puppeteer page.
 *
 * @param {object[]} rows - sheet rows (from fetchSheet)
 * @param {object[]} conns - Voyager connections array
 * @param {string} linkedinColumn - operator-specified URL column name (or '')
 * @param {string} stillPendingLabel - timestamped "Still Pending" stamp value
 * @param {object} opts
 * @param {boolean} [opts.suppressAcceptedStamp=false] - when true, matched
 *   URLs are returned in connectedUrls but their cc/connectedAlready writes
 *   are omitted from the updates array
 * @returns {{ updates: object[], connectedUrls: string[], diag: object }}
 */
export function computeBulkCheckUpdates(rows, conns, linkedinColumn, stillPendingLabel, opts = {}) {
  const { suppressAcceptedStamp = false, profileName = '', introducedInRun = null, composeAttempts = null, dmSentTerminal = false } = opts;

  // v2.62: sender-scoped matching. Builds the set of accounts ACTIVELY
  // running this campaign from distinct Sender values in the sheet. Used
  // to prevent cross-account false-positive Connected stamps: if eryca's
  // bulk-check finds a lead in her network but the row's Sender is
  // carmella, eryca shouldn't stamp the row as Connected (carmella's
  // invitation may still be pending). Operator's rule, verbatim:
  // "if Antonio isn't running the campaign, who cares?"
  //
  // Backward-compat: empty profileName or sheets with no Sender column
  // skip the scoping entirely (legacy single-account / pre-sender-column
  // behavior preserved).
  const activeSenders = new Set();
  for (const row of rows) {
    const s = (row['Sender'] || row['sender'] || '').toString().toLowerCase().trim();
    if (s) activeSenders.add(s);
  }
  const profileNameNorm = (profileName || '').toLowerCase().trim();
  const senderScopingActive = !!profileNameNorm && activeSenders.size > 0;
  const callerIsActiveSender = !senderScopingActive || activeSenders.has(profileNameNorm);

  // Build account-attributed match indexes. Each connection carries the
  // `account` (campaign Sender) that owns it — supplied by the caller from
  // the accumulated "Recent Connections" tab, or attributed to the sweeping
  // profile on the live-fetch fallback path. Key → Set<accountNorm>.
  // CONTRACT: on a sender-scoped sheet the caller MUST set `account` on every
  // conn. An account-less conn ('') won't match a row whose Sender is set, so
  // bulkCheckConnections attributes the live-fetch fallback to the sweeping
  // profile (see bulk-check-connections.js fallback path).
  const slugToAccounts = new Map();
  const memberIdToAccounts = new Map();
  const memberNumberToAccounts = new Map();
  const nameToAccounts = new Map();
  const accountDisplay = new Map(); // accountNorm → original-case (for stamps)
  const _addAcct = (map, key, acct) => {
    if (!key) return;
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(acct);
  };
  for (const c of conns) {
    const acctRaw = (c.account || '').toString().trim();
    const acct = acctRaw.toLowerCase();
    if (acct && !accountDisplay.has(acct)) accountDisplay.set(acct, acctRaw);
    const pubId = (c.publicId == null ? '' : String(c.publicId)).trim();
    if (pubId) _addAcct(slugToAccounts, pubId.toLowerCase(), acct);
    const mid = memberIdFromAny(c.urn) || memberIdFromAny(c.publicId);
    if (mid) _addAcct(memberIdToAccounts, mid, acct);
    // v2.86.12: nameToAccounts is still populated for diag continuity but is
    // NO LONGER a match key — name matching caused cross-account false
    // positives (e.g. Vito Mansueto stamped + introduced off a namesake).
    const nameKey = `${(c.firstName || '').toLowerCase().trim()} ${(c.lastName || '').toLowerCase().trim()}`.trim();
    if (nameKey && nameKey !== ' ') _addAcct(nameToAccounts, nameKey, acct);
    const memberNumber = String(c.memberNumber == null ? '' : c.memberNumber).replace(/\D/g, '');
    if (memberNumber) _addAcct(memberNumberToAccounts, memberNumber, acct);
  }

  // Snapshot a few extracted IDs for the diag eyeball-compare.
  const sampleConnectedSlugs = [...slugToAccounts.keys()].slice(0, 3);
  const sampleConnectedMemberIds = [...memberIdToAccounts.keys()].slice(0, 3);
  const sampleConnectedNames = [...nameToAccounts.keys()].slice(0, 3);

  const updates = [];
  const connectedUrls = [];
  let freshConnected = 0;
  let dbgRowsScanned = 0, dbgWithUrl = 0, dbgWithCRS = 0;
  let dbgAlreadyConnected = 0, dbgAlreadyDeclined = 0, dbgPidMatched = 0;
  let dbgAlreadyIntroduced = 0;
  let dbgDuplicateCollapsed = 0;
  let dbgAlreadyDmd = 0;
  let dbgRequestHealed = 0;
  let dbgAlreadyUnverified = 0;
  let dbgComposeCapped = 0;
  let dbgCrossSender = 0;
  let dbgSkippedNotActiveSender = 0;
  const sampleSheetSlugs = [];
  const sampleSheetMemberIds = [];
  const sampleCRSValues = new Set();

  // Defense: if sender scoping is active and this caller isn't a
  // campaign sender, return empty. The bulk-check shouldn't have
  // run for this account; we won't make it worse by touching rows.
  if (senderScopingActive && !callerIsActiveSender) {
    dbgSkippedNotActiveSender = rows.length;
    return {
      updates: [],
      connectedUrls: [],
      freshConnected: 0,
      diag: {
        rowsScanned: rows.length, withUrl: 0, withCRS: 0,
        alreadyConnected: 0, alreadyDeclined: 0, alreadyIntroduced: 0,
        alreadyUnverified: 0, composeCapped: 0, pidMatched: 0,
        crossSender: 0, skippedNotActiveSender: dbgSkippedNotActiveSender,
        slugs: slugToAccounts.size, memberIds: memberIdToAccounts.size,
        memberNumbers: memberNumberToAccounts.size, names: nameToAccounts.size,
        sampleSheetSlugs: [], sampleSheetMemberIds: [],
        sampleConnectedSlugs, sampleConnectedMemberIds, sampleConnectedNames,
        sampleCRSValues: new Set(),
      },
    };
  }

  // ── Duplicate-profile safety check (boss report 2026-06-16) ──────────────
  // Two identical rows (e.g. 109 & 110) both pass the per-row "Introduction
  // Status is blank" guard, so without this the same person is pushed into
  // connectedUrls twice and introduced multiple times. We dedup the intro
  // work-list by STRONG IDENTITY in two layers:
  //
  //   • terminalIntroKeys — a pre-pass over ALL rows recording the identities
  //     already actioned (terminal phase-2 status) anywhere in the sheet. This
  //     is the DURABLE guard: it survives an app restart that wipes the
  //     in-memory introducedInRun set, because the audit trail lives in the
  //     sheet. A blank duplicate of an already-introduced person is skipped.
  //   • queuedIdentityKeys — identities queued earlier in THIS sweep, so two
  //     blank duplicates in the same pass collapse to one (the 109/110 case).
  //
  // Keyed by identity, NOT raw URL, so a different URL form of the same person
  // is recognised too. Terminality mirrors the existing one-shot semantics:
  // any non-open Introduction Status (intro) / 'DM Sent' (dm) is terminal —
  // the operator clears the cell to deliberately re-enable a person.
  const terminalIntroKeys = new Set();
  for (const r of rows) {
    const u = extractLinkedInUrl(r, linkedinColumn);
    if (!u) continue;
    const terminal = dmSentTerminal
      ? ((
          r['DM Status'] || r['dm status'] || r['DM status'] ||
          r['Direct Message Status'] || r['dmStatus'] || ''
        ).toString().trim() === 'DM Sent')
      : !isIntroSlotOpen(r['Introduction Status'] || r['introduction status'] || '');
    if (terminal) for (const k of leadIdentityKeys(u, r)) terminalIntroKeys.add(k);
  }
  const queuedIdentityKeys = new Set();

  // Queue a lead for the auto-intro pass unless its identity is already
  // terminal in the sheet or already queued this sweep. Returns true when
  // queued, false when collapsed as a duplicate (and, in intro mode, stamps
  // the blank duplicate row "Skipped — duplicate …" so the operator can SEE
  // the safeguard fired — best-effort: byte-identical URLs collapse to one
  // addressable row in the Apps Script, so the log/diag count below is the
  // authoritative signal).
  // `alreadyConnected` = the row's Connection Accepted Status was ALREADY at a
  // Connected value before this sweep, so the lead did not accept just now; it
  // is only being re-queued because its intro slot is still open (an intro that
  // was interrupted or failed). Counting those as "newly accepted" made the
  // sweep summary report the same people every hour forever — see
  // tests/bulk-check-fresh-count.test.js.
  const tryQueueIntro = (u, r, introStatusVal, alreadyConnected = false) => {
    const idKeys = leadIdentityKeys(u, r);
    const isDup = idKeys.some((k) => terminalIntroKeys.has(k) || queuedIdentityKeys.has(k));
    if (isDup) {
      dbgDuplicateCollapsed++;
      if (!suppressAcceptedStamp && !dmSentTerminal && isIntroSlotOpen(introStatusVal)) {
        updates.push({
          linkedinUrl: u,
          introductionStatus: 'Skipped — duplicate of an already-introduced profile',
        });
      }
      return false;
    }
    connectedUrls.push(u);
    if (!alreadyConnected) freshConnected++;
    for (const k of idKeys) queuedIdentityKeys.add(k);
    return true;
  };

  for (const row of rows) {
    dbgRowsScanned++;
    const url = extractLinkedInUrl(row, linkedinColumn);
    if (!url) continue;
    dbgWithUrl++;

    // Accepted-status lookup includes both old (Connected Status / CC) and
    // new (Connection Accepted Status) headers for back-compat across the
    // v2.14 rename window.
    const cs = (
      row['Connection Accepted Status'] || row['connection accepted status']
      || row['Check Status'] || row['check status']
      || row['Connected Status']  || row['connected status']
      || row['CC'] || row['cc'] || ''
    ).toString().trim();
    if (cs === 'Connection Declined') { dbgAlreadyDeclined++; continue; }
    // v2.61.0: sticky downgrade — auto-intro.js writes this exact prefix when
    // reverify confirms a Connected stamp was a false positive. Leaving the
    // row alone means subsequent bulk-check passes can't restamp Connected
    // even if Voyager still returns the URN. Operator clears the cell to retry.
    if (cs.startsWith('Unverified — manual review')) {
      dbgAlreadyUnverified++;
      continue;
    }

    const slug = publicIdFromUrl(url);
    const rowUrn = (row['LinkedIn URN'] || row['linkedin urn'] || '').toString();
    const memberId = memberIdFromAny(rowUrn) || memberIdFromAny(url);
    if (sampleSheetSlugs.length < 3 && slug) sampleSheetSlugs.push(slug);
    if (sampleSheetMemberIds.length < 3 && memberId) sampleSheetMemberIds.push(memberId);

    // v2.86.12: row First/Last name no longer read here — NAME was dropped as a
    // match key (cross-account false positives). Strong identity only below.

    // Sender-scoping read — what account does this row's lead belong to?
    // Empty means "no one assigned yet" → legacy behavior. Otherwise we
    // compare against the calling profile (profileNameNorm).
    const rowSenderRaw = (row['Sender'] || row['sender'] || '').toString().trim();
    const rowSenderNorm = rowSenderRaw.toLowerCase();
    const rowSenderMismatch = senderScopingActive
      && rowSenderNorm
      && rowSenderNorm !== profileNameNorm;

    // Which campaign accounts have this lead in the accumulated tab?
    const _matchedAccounts = new Set();
    for (const a of (slugToAccounts.get(slug) || [])) _matchedAccounts.add(a);
    if (memberId) for (const a of (memberIdToAccounts.get(memberId) || [])) _matchedAccounts.add(a);
    // v2.86.12: NAME is no longer a match key (cross-account false positives,
    // e.g. Vito Mansueto stamped + introduced off a namesake on an unsent row).
    // Strong identity only: slug (above), AC**AA token (above), or numeric
    // Membership ID (below). readSourceMemberId reads the sheet's numeric id;
    // memberNumberToAccounts holds the connections' numeric ids.
    const rowMemberNumber = readSourceMemberId(row);
    if (rowMemberNumber) for (const a of (memberNumberToAccounts.get(rowMemberNumber) || [])) _matchedAccounts.add(a);
    const isMatch = _matchedAccounts.size > 0;

    // Is the row's ASSIGNED sender among the accounts connected to this lead?
    // Legacy sheets (no Sender column) → any match counts as the assigned one.
    const _assignedConnected = rowSenderNorm
      ? _matchedAccounts.has(rowSenderNorm)
      : isMatch;

    // v2.79: is the account RUNNING this sweep the one actually connected to the
    // lead? Intros fire from the sweeping account's browser, so ONLY that account
    // may push the lead into connectedUrls — otherwise we'd try to intro from a
    // browser that isn't 1st-degree. When no sweeping-account context is given
    // (unit tests / legacy callers), fall back to the old behaviour (no gate).
    const sweepingConnected = !profileNameNorm || (isMatch && _matchedAccounts.has(profileNameNorm));

    // v2.14.x: extract requestStatus BEFORE the isMatch branch so we can
    // distinguish two match cases:
    //   - wasInvited: bot sent a connect request in a prior run, recipient
    //     has now accepted → "Connected" (normal acceptance flow)
    //   - !wasInvited: lead was already a 1st-degree connection to this
    //     account before the campaign ever started → "Already connected",
    //     with Sender + Stage stamped so the operator sees WHICH account
    //     they're connected to, and pre-filter excludes the row from new
    //     connect sends by other accounts.
    const requestStatus = (
      row['Connection Request Status'] || row['connection request status']
      || row['Connection Status']        || row['connection status']
      || row['Status'] || row['status'] || ''
    ).toString().trim();

    // v2.6x (operator rule 2026-05): 'Connection Request Status' must never
    // read 'Closed - Not Connected'. That stamp came from an older
    // stop-monitoring build, but the LinkedIn invite was never actually
    // withdrawn — so the moment we re-encounter the row we heal the cell back
    // to 'Connection Request Sent'. The heal is pushed as its own update
    // object, BEFORE the isMatch/terminal-skip guards below, so it lands even
    // when the row is subsequently short-circuited (already-DM'd /
    // already-intro'd). handleBatchUpdate applies each update object's fields
    // independently, so co-existing with a cc/stage stamp for the same URL is
    // safe. We also treat a healed row as wasInvited so a later acceptance
    // flows through the normal 'Connected' path (not 'Already connected').
    const needsRequestHeal = requestStatus === 'Closed - Not Connected';
    if (needsRequestHeal) {
      updates.push({ linkedinUrl: url, connectionStatus: 'Connection Request Sent' });
      dbgRequestHealed++;
    }
    const wasInvited = requestStatus === 'Connection Request Sent' || needsRequestHeal;

    if (isMatch) {
      dbgPidMatched++;

      // v2.14.x: check introductionStatus FIRST. The previous code skipped
      // any row with cs='Connected'/'Already connected' before looking at
      // introductionStatus — which meant any lead whose intro got
      // INTERRUPTED (Stop pressed mid-batch, browser died) was stamped
      // 'Skipped — Stop pressed' / 'Skipped — browser closed' but then
      // EXCLUDED FROM RE-PICKUP on every subsequent bulk-check, because
      // the cs guard short-circuited before the introductionStatus check
      // could route them back into connectedUrls. The cs-guard was a stale
      // proxy for "intro already done"; the introductionStatus check below
      // is the authoritative signal — see commit comment about
      // nitin.kumar 2026-05-16 (kanojiya/samson/chaudhary 3× intros).
      const introductionStatus = (
        row['Introduction Status'] || row['introduction status'] || ''
      ).toString().trim();

      // v2.71: Introduction Status is a one-shot column. ANY value blocks
      // re-attempts — 'Introduction Made', 'IC Sent', 'Failed — …',
      // 'Skipped — …', operator notes, anything. Operator intent: never
      // retry an intro automatically; manual reset (clear the cell) is the
      // explicit re-enable signal. Previously only the two success strings
      // blocked, so failed/skipped rows looped on every bulk-check sweep.
      // v2.98: the "reconnect & retry" revive sentinel is the ONE non-blank
      // value treated as open (isIntroSlotOpen) — it's an explicit operator
      // opt-in to retry, so it re-queues until the intro lands or it's cleared.
      if (!isIntroSlotOpen(introductionStatus)) {
        dbgAlreadyIntroduced++;
        continue;
      }
      if (introducedInRun && introducedInRun.has(url)) {
        dbgAlreadyIntroduced++;
        continue;
      }

      // v2.6x — CC+DM symmetry with the introductionStatus guard above. When
      // this campaign's phase-2 action is the 1:1 auto-DM (dmSentTerminal),
      // a row whose DM Status already reads 'DM Sent' is terminal: do NOT
      // re-queue it into connectedUrls. Without this guard every monitoring
      // sweep re-DMs already-messaged 1st-degree connections; the content-
      // dedup in auto-dm.js then overwrites their 'DM Sent' with
      // 'Skipped — DM already sent' (operator confusion), and a since-edited
      // template would send a real duplicate DM. Gated by dmSentTerminal so
      // CC+IC / other modes on a mixed sheet are unaffected.
      if (dmSentTerminal) {
        const dmStatus = (
          row['DM Status'] || row['dm status'] || row['DM status'] ||
          row['Direct Message Status'] || row['dmStatus'] || ''
        ).toString().trim();
        if (dmStatus === 'DM Sent') { dbgAlreadyDmd++; continue; }
      }

      // v2.61.0: per-URL compose-textbox failure cap. If reverify-and-downgrade
      // didn't resolve the row (e.g. getConnectionStatus returned 'unknown'),
      // this caps repeat attempts so a single false-positive doesn't produce a
      // 30+ retry storm over a single process lifetime.
      if (composeAttempts && (composeAttempts.get(url) || 0) >= 3) {
        dbgComposeCapped++;
        continue;
      }

      // v2.62 (v2.63 attribution): a DIFFERENT campaign sender owns this
      // lead in the tab — the row's assigned sender's invite may still be
      // pending. DON'T stamp cc, DON'T push to connectedUrls (the assigned
      // sender fires its own auto-DM/intro), DON'T overwrite an existing
      // Connected stamp. DO write an informational "Already connected to
      // <owning account>" into Stage so the operator sees which campaign
      // account already has this person.
      if (!_assignedConnected) {
        dbgCrossSender++;
        // v2.79: the lead is a 1st-degree connection of a DIFFERENT campaign
        // account than the row's assigned Sender. Reassign the row to the
        // connected account (prefer the sweeping one if it's the connected one)
        // and stamp the green "Already Connected" so it reads + colours like a
        // real connection. The CC+IC intro then fires from the connected
        // account's own sweep (sweepingConnected) — never from a non-1st-degree
        // browser. On that account's next sweep the row is _assignedConnected
        // and flows through the normal intro path above.
        if (suppressAcceptedStamp) continue;
        // Idempotency: never overwrite a row already confirmed connected (by the
        // assigned sender or a prior cross-account pass).
        if (cs === 'Connected' || cs === 'Already Connected' || cs.startsWith('Already connected')) continue;
        // Pick the connected account: the sweeping one if it's the connected
        // account, else the first connected account from the accumulated tab.
        let _connectedAcct = '';
        if (sweepingConnected && profileName) _connectedAcct = profileName;
        else for (const a of _matchedAccounts) { if (a) { _connectedAcct = accountDisplay.get(a) || a; break; } }
        updates.push({
          linkedinUrl: url,
          sender: _connectedAcct,             // reassign to the connected account
          connectionStatus: 'Already Connected', // green + reads "Already Connected"
          cc: 'Already Connected',
          stage: 'Already Connected',
          connectedAlready: 'Yes',
          checkStatus: 'Already Connected',
        });
        // Intro is NOT fired here — once Sender is reassigned, the connected
        // account's own sweep flows through the normal path above and fires it
        // from a genuine 1st-degree browser (sweepingConnected gate).
        continue;
      }

      // Not yet introduced — queue for the auto-intro pass. Even if the
      // CC column is already 'Connected' (from a prior bulk-check), the
      // intro still needs to fire — this is the path that lets
      // 'Skipped — Stop pressed' / 'Skipped — browser closed' / 'Failed'
      // leads recover on the next bulk-check round.
      const ccAlreadyStamped = (cs === 'Connected' || cs === 'Already connected' || cs === 'Already Connected');
      if (ccAlreadyStamped) dbgAlreadyConnected++;
      // v2.79: only the account actually connected (= the sweeping account) may
      // fire the intro, so it runs from a 1st-degree browser.
      // Duplicate-profile guard (2026-06-16): tryQueueIntro collapses a second
      // row for the same person; on a duplicate we skip the Connected re-stamp
      // below (it's already stamped on the twin) and let the dup flag stand.
      if (sweepingConnected && !tryQueueIntro(url, row, introductionStatus, ccAlreadyStamped)) {
        continue;
      }

      // Only stamp the CC column when it's not already at its target
      // value — avoids redundant Apps Script writes for rows we're just
      // re-picking-up for an intro retry.
      if (!suppressAcceptedStamp && !ccAlreadyStamped) {
        // v2.14.x: also stamp checkStatus so the legacy "Check Status"
        // column (still present on operator sheets that haven't been
        // migrated by the Apps Script rename) fills in visibly. In the
        // v2.14 schema both cc and checkStatus map to the same column
        // ("Connection Accepted Status"), so the dual write is a no-op
        // there. In v2.13.x they're separate columns — this fills both.
        if (wasInvited) {
          // Normal acceptance — bot invited, recipient accepted.
          // v2.62: also stamp Stage='Connected' so the Stage column
          // reflects reality. Previously the Stage stayed at 'Connect
          // Pending' while cc flipped to 'Connected', confusing
          // operators reading the row at a glance.
          updates.push({
            linkedinUrl: url,
            cc: 'Connected',
            stage: 'Connected',
            connectedAlready: 'Yes',
            checkStatus: 'Connected',
          });
        } else {
          // Pre-existing 1st-degree connection (no prior outreach by the bot).
          // Mirror Pinky's row pattern from outreach.js's already_connected
          // path: Sender + Stage + Connection Accepted Status all reading
          // "Already connected". Pre-filter (campaign.js:1216) excludes
          // Stage='Already connected' from new connect sends, so other
          // accounts won't try to connect. The existing connectedUrls →
          // runAutoIntros chain fires the IC DM from THIS account
          // immediately in the same bulk-check pass.
          updates.push({
            linkedinUrl: url,
            sender: rowSenderRaw || accountDisplay.get([..._matchedAccounts].find((a) => a) || '') || profileName,
            stage: 'Already connected',
            cc: 'Already connected',
            connectedAlready: 'Yes',
            checkStatus: 'Already connected',
          });
        }
      }
      continue;
    }

    // Not in recent connections — stamp "Still Pending" if the bot invited.
    if (sampleCRSValues.size < 5 && requestStatus) sampleCRSValues.add(requestStatus);

    // v2.82: trust-the-sheet phase-2 retry for connections that have aged off
    // LinkedIn's ~80-most-recent window. This lead is NOT in the current
    // sweep's recent-connections fetch (isMatch=false), but the SHEET already
    // records it as Connected and (when scoping is on) assigned to THIS
    // sweeping account. Operator rule 2026-06-08: trust that audit trail —
    // re-queue the lead for its phase-2 action whenever the terminal column is
    // still blank, so a connection whose intro/DM never landed keeps retrying
    // on every sweep instead of being silently skipped once it leaves the
    // recent window. The caller's willAutoIntro / willAutoDm gate still decides
    // whether the action actually fires for this mode, and the terminal-column
    // check below preserves the one-shot semantics (any value = never retry).
    // Only the row's assigned sender (this sweeping account) may fire, so the
    // intro/DM still originates from the genuinely-connected account.
    if (cs === 'Connected' || cs === 'Already connected' || cs === 'Already Connected') {
      if (!rowSenderMismatch && !(introducedInRun && introducedInRun.has(url))) {
        if (dmSentTerminal) {
          const _dmStatus = (
            row['DM Status'] || row['dm status'] || row['DM status'] ||
            row['Direct Message Status'] || row['dmStatus'] || ''
          ).toString().trim();
          // alreadyConnected=true on both: this whole branch is gated on the
          // sheet ALREADY reading Connected, so nothing here accepted just now.
          if (_dmStatus === '') tryQueueIntro(url, row, '', true);
        } else {
          // v2.98: open slot = genuinely blank OR the reconnect-retry sentinel.
          const _introStatus = row['Introduction Status'] || row['introduction status'] || '';
          if (isIntroSlotOpen(_introStatus)) tryQueueIntro(url, row, _introStatus, true);
        }
      }
      continue;
    }

    if (requestStatus !== 'Connection Request Sent') continue;
    // v2.62: don't let other accounts' bulk-checks downgrade a row to
    // Still Pending. Only the assigned Sender should refresh its own
    // pending timestamp.
    if (rowSenderMismatch) continue;
    // v2.14.x: never overwrite a row that's already known-connected or
    // already-introduced. LinkedIn's recent-connections endpoint returns at
    // most ~80 most-recent connections — older accepted invites silently
    // fall off the list. Without this guard, every bulk-check pass after
    // ~80 newer connections downgrades the older ones from "Connected" /
    // "Already connected" back to "Still Pending", wiping the audit trail
    // even though the lead IS still a connection. Operator screenshot
    // 2026-05-16: Cindy (intro'd 14:48) shown as "Still Pending (17:07)".
    if (cs === 'Connected' || cs === 'Already connected') continue;
    // An already-"Still Pending" row IS re-stamped, so the cell answers "when was
    // this last checked?" rather than "when did it first go pending?".
    //
    // v2.78 skipped these to keep the cell-by-cell Apps Script write small (~155
    // rows/account = minutes). That froze the timestamp forever: operator report
    // 2026-07-30 — leads invited on 27 Jul still read "Still Pending (2026-07-27
    // 16:45)" after three days of hourly sweeps, which reads as "never checked"
    // even though every row is evaluated on every sweep. handleBatchUpdate (the
    // batch write that comment named as the precondition) has since shipped, so
    // the refresh is affordable again.
    //
    // The Connected/Already-connected guard ABOVE still runs first, so this never
    // downgrades an accepted row that aged off the ~80-connection recent window.
    // v2.71: any non-empty Intro Status blocks the Still-Pending downgrade
    // too — same one-shot semantics as the connectedUrls gate above.
    const _introStatusForGuard = (
      row['Introduction Status'] || row['introduction status'] || ''
    ).toString().trim();
    if (_introStatusForGuard !== '') continue;
    dbgWithCRS++;
    // Same dual-write as the matched branch — see comment above.
    updates.push({
      linkedinUrl: url,
      cc: stillPendingLabel,
      checkStatus: stillPendingLabel,
    });
  }

  return {
    updates,
    connectedUrls,
    freshConnected,
    diag: {
      rowsScanned: dbgRowsScanned,
      withUrl: dbgWithUrl,
      withCRS: dbgWithCRS,
      alreadyConnected: dbgAlreadyConnected,
      alreadyDeclined: dbgAlreadyDeclined,
      alreadyIntroduced: dbgAlreadyIntroduced,
      duplicateCollapsed: dbgDuplicateCollapsed,
      alreadyDmd: dbgAlreadyDmd,
      requestHealed: dbgRequestHealed,
      alreadyUnverified: dbgAlreadyUnverified,
      composeCapped: dbgComposeCapped,
      pidMatched: dbgPidMatched,
      crossSender: dbgCrossSender,
      skippedNotActiveSender: dbgSkippedNotActiveSender,
      slugs: slugToAccounts.size,
      memberIds: memberIdToAccounts.size,
      memberNumbers: memberNumberToAccounts.size,
      names: nameToAccounts.size,
      sampleSheetSlugs,
      sampleSheetMemberIds,
      sampleConnectedSlugs,
      sampleConnectedMemberIds,
      sampleConnectedNames,
      sampleCRSValues,
    },
  };
}

/**
 * Say where a tab ended up, in words an operator can read.
 *
 * Never paste the raw URL or path into an error string. LinkedIn's connections
 * URL contains the substring "network", and magellan-diagnose.js rule 73
 * matches /network/i, so appending the path silently reclassified "no-csrf" and
 * "http-429" as a GoLogin connection fault. Caught 2026-08-31 before release by
 * running both classifiers over the new message shapes; the same trap is why
 * helpers.js names the location instead of interpolating location.pathname.
 *
 * The words are chosen to stay classifier-safe: "a security checkpoint" and
 * "the sign-in page" are the two that SHOULD reroute an error to needs-login,
 * and they do, via the existing checkpoint/login rules.
 */
export function describeTabLocation(url) {
  let path = String(url || '');
  try { path = new URL(path).pathname; } catch { /* not an absolute URL */ }
  if (!path || path === 'blank') return 'a blank page';
  if (/\/checkpoint/.test(path)) return 'a security checkpoint';
  if (/\/login|\/uas\//.test(path)) return 'the sign-in page';
  if (/invite-connect\/connections/.test(path)) return 'the connections page';
  if (/mynetwork/.test(path)) return 'the connections area';
  if (/\/feed/.test(path)) return 'the feed';
  return path;
}

/**
 * Run one bulk-check pass for a profile.
 *
 * @param {puppeteer.Page} page - Active page on a LinkedIn URL
 * @param {string} sheetUrl - Sheet URL the campaign is running against
 * @param {string} linkedinColumn - Operator-specified URL column name (or '')
 * @param {string} pName - Profile name for logging
 * @param {object} [opts={}]
 * @param {boolean} [opts.suppressAcceptedStamp=false] - when true, matched
 *   URLs are returned in connectedUrls but their cc/connectedAlready writes
 *   are omitted from the batch update
 * @returns {Promise<{ matched: number, fetched: number, error?: string, connectedUrls?: string[] }>}
 */
export async function bulkCheckConnections(page, sheetUrl, linkedinColumn, pName, opts = {}) {
  // 1) Always navigate to a stable LinkedIn URL so the page context has
  // fresh cookies. /mynetwork/invite-connect/connections/ is what LinkedIn's
  // own UI hits. Then check whether we ended up logged in — a stale-session
  // profile gets redirected to /login or /uas/login, where Voyager doesn't
  // exist (returns 404 from a login-page context).
  //
  // Three attempts, because net::ERR_ABORTED does not mean the network failed:
  // it means a SECOND navigation started and cancelled ours. GoLogin appends
  // --restore-last-session to every launch (gologin-launcher.js:426), so the
  // tab we are handed can still be loading the profile's previous page when we
  // navigate. By the time the abort surfaces, whatever interrupted us has
  // finished, and going again usually just works. Measured 2026-08-29 on
  // cindy.siapno: one abort at 21:24 skipped the account, stamped the whole
  // sweep incomplete and stopped sending, and the same profile then loaded
  // normally on the next check with nothing done in between.
  //
  // about:blank between attempts for the reason already documented in the send
  // path at campaign.js:835 — a same-URL goto on an SPA can be a no-op, so a
  // wedged page never actually reloads.
  //
  // Only an abort is retried. A timeout means the page genuinely did not load
  // and a second 30s wait mostly costs the accounts queued behind this one.
  let postNavUrl = '';
  let navErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
      await page.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      postNavUrl = page.url() || '';
      navErr = null;
      break;
    } catch (err) {
      navErr = err;
      // Aborting the navigation does not close the tab: the browser is still
      // showing something, and that something is the whole diagnosis. Read it
      // before deciding whether another attempt is even worth making.
      let landed = '';
      try { landed = page.url() || ''; } catch { /* page may be gone */ }
      // A sign-in wall or a security checkpoint also cancels our navigation and
      // also reports ERR_ABORTED. Retrying it can never work, and "open the
      // account and retry" is the wrong instruction: this account needs somebody
      // to log it back in. Say so, and stop.
      if (/\/login|\/uas\/|\/checkpoint/.test(landed)) {
        return { matched: 0, freshConnected: 0, fetched: 0, error: `session-expired (redirected to ${landed})` };
      }
      if (attempt === 3 || !/ERR_ABORTED/i.test(String(err && err.message))) {
        postNavUrl = landed;
        break;
      }
      pName && console.warn(`[bulk-check] ${pName}: navigation was interrupted (${err.message}); attempt ${attempt + 1} of 3`);
      await new Promise((r) => setTimeout(r, attempt === 1 ? 2000 : 4000));
    }
  }
  if (navErr) {
    // Keep the "navigation-failed:" prefix: campaign.js sweepHealth() and
    // magellan-diagnose.js both classify on it, and only context is appended.
    return { matched: 0, freshConnected: 0, fetched: 0, error: `navigation-failed: ${navErr.message} (tab was on ${describeTabLocation(postNavUrl)})` };
  }
  // Quick auth check before burning cycles on Voyager calls that will 404.
  if (/\/login|\/uas\/|\/checkpoint/.test(postNavUrl)) {
    return { matched: 0, freshConnected: 0, fetched: 0, error: `session-expired (redirected to ${postNavUrl})` };
  }

  // 2) Fetch recent connections. We pass sinceMs=0 so all pages are fetched
  // (up to the helper's MAX_PAGES cap). Tighter scoping (e.g. since the
  // first invite in this campaign) is a future optimisation.
  const conns = await getRecentConnections(page, 0);
  if (conns.length === 0) {
    // The helper attaches `.error` on the empty array when the failure was
    // something specific (no-csrf, http-XXX, empty-elements, etc.). Surface
    // it so the operator can see exactly why the fetch produced nothing.
    const reason = conns.error || 'no-connections-fetched';
    return { matched: 0, freshConnected: 0, fetched: 0, error: reason };
  }

  // The operator stopped the check while this account's connections were being
  // read. Bail out before anything is written: this account is left exactly as
  // it was, so the next check reads it again from scratch. Deliberately placed
  // here and not inside the sender scan below, which must see every row or the
  // stamps it feeds would be computed against a half-built sender list.
  if (campaign._abortCheck) {
    return { matched: 0, freshConnected: 0, fetched: conns.length, error: 'stopped by you' };
  }

  // 3) Read the sheet. Done BEFORE the sidecar write so we can extract the
  // active-sender set (distinct Sender column values) — Apps Script needs it
  // to filter out non-campaign accounts from the "Recent Connections" tab.
  let rows;
  try {
    rows = await fetchSheet(sheetUrl);
  } catch (err) {
    return { matched: 0, freshConnected: 0, fetched: conns.length, error: `sheet-fetch: ${err.message}` };
  }

  // v2.62: active senders for this campaign — distinct values in the Sender
  // column. Used by the sidecar write to scope the "Recent Connections" tab
  // to accounts running THIS campaign (operator rule: the tab is the Bible
  // for matching, so anyone who isn't a campaign sender doesn't belong in
  // it). Also passed into computeBulkCheckUpdates for sender-scoped matching.
  const activeSendersList = [];
  const activeSendersSeen = new Set();
  for (const row of rows) {
    const s = (row['Sender'] || row['sender'] || '').toString().trim();
    if (s && !activeSendersSeen.has(s.toLowerCase())) {
      activeSendersSeen.add(s.toLowerCase());
      activeSendersList.push(s);
    }
  }

  // Mirror the fetched connections into the accumulating sidecar tab and get
  // back the full accumulated, sender-scoped set. That set — not the live
  // 80-fetch — is what we match against (the tab is the Bible). Best-effort:
  // if the round-trip fails, fall back to the live fetch attributed to this
  // sweeping profile so a sweep is never worse than the pre-tab behavior.
  let matchSet = null;
  let sidecarConfirmed = false;
  try {
    const sidecarRows = conns.map((c) => ({
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      publicId: (c.publicId == null ? '' : String(c.publicId)),
      urn: memberIdFromAny(c.urn) || memberIdFromAny(c.publicId) || '',
      memberNumber: c.memberNumber || '',
      connectedAt: c.connectedAt || 0,
      profileSentBy: pName || '',
    }));
    matchSet = await writeRecentConnectionsTab(sheetUrl, pName, sidecarRows, activeSendersList);
    sidecarConfirmed = Array.isArray(matchSet);
  } catch (err) {
    console.warn(`[bulk-check] sidecar tab write failed: ${err.message}`);
  }
  if (!Array.isArray(matchSet)) {
    // Degrade: match against the live fetch, attributed to the sweeping account.
    console.warn('[bulk-check] accumulated set unavailable — matching against live fetch');
    matchSet = conns.map((c) => ({
      firstName: c.firstName || '',
      lastName: c.lastName || '',
      publicId: (c.publicId == null ? '' : String(c.publicId)),
      urn: memberIdFromAny(c.urn) || memberIdFromAny(c.publicId) || '',
      memberNumber: c.memberNumber || '',
      account: pName || '',
    }));
  }

  // Build a single human-readable timestamp for every "Still Pending" stamp
  // written this sweep. Same string everywhere so the operator can see at a
  // glance which rows were checked in the same pass.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stillPendingLabel = `Still Pending (${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())})`;

  const { updates, connectedUrls, freshConnected, diag } = computeBulkCheckUpdates(
    rows,
    matchSet,
    linkedinColumn,
    stillPendingLabel,
    {
      suppressAcceptedStamp: opts.suppressAcceptedStamp === true,
      // v2.14.x: stamped onto pre-existing 1st-degree matches so the
      // operator sees WHICH account is connected to the lead.
      profileName: pName || '',
      // v2.14.x: read campaign-level in-memory blacklist by default so
      // every call site benefits without needing to pass the Set explicitly.
      introducedInRun: opts.introducedInRun || campaign.introducedInRun,
      composeAttempts: opts.composeAttempts || campaign.composeAttempts,
      // v2.6x — when phase-2 is the 1:1 auto-DM, already-'DM Sent' rows are
      // terminal and must not be re-queued. Defaults from the campaign mode so
      // every call site (in-batch, monitoring, post-campaign) benefits without
      // threading the flag through; an explicit opt still overrides.
      dmSentTerminal: opts.dmSentTerminal !== undefined
        ? opts.dmSentTerminal
        : (campaign.mode === 'connect_and_message'),
    }
  );

  const diagSummary = `scanned=${diag.rowsScanned}, withUrl=${diag.withUrl}, slugs=${diag.slugs}, memberIds=${diag.memberIds}, names=${diag.names}, pidMatched=${diag.pidMatched}, alreadyConnected=${diag.alreadyConnected}, alreadyIntroduced=${diag.alreadyIntroduced}, crossSender=${diag.crossSender}, duplicateCollapsed=${diag.duplicateCollapsed}, alreadyDmd=${diag.alreadyDmd}, requestHealed=${diag.requestHealed}, alreadyUnverified=${diag.alreadyUnverified}, composeCapped=${diag.composeCapped}, alreadyDeclined=${diag.alreadyDeclined}, stamped=${diag.withCRS}\n  ↳ sampleSheetSlugs=${diag.sampleSheetSlugs.join(' | ') || '(none)'}\n  ↳ sampleSheetMemberIds=${diag.sampleSheetMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedSlugs=${diag.sampleConnectedSlugs.join(' | ') || '(none)'}\n  ↳ sampleConnectedMemberIds=${diag.sampleConnectedMemberIds.join(' | ') || '(none)'}\n  ↳ sampleConnectedNames=${diag.sampleConnectedNames.join(' | ') || '(none)'}\n  ↳ sampleCRS=${[...diag.sampleCRSValues].join(' | ') || '(none)'}`;
  // The field dump is FORENSIC and stays on stdout only. It used to be piped
  // into the operator's live log too, where it read as a wall of key=value
  // pairs nobody outside this file can parse. What the operator gets instead
  // is plainSweep() below: one sentence saying how many invitations were
  // looked at, how many people newly accepted, how many rows were refreshed,
  // and whether anything looks wrong.
  console.log(`[bulk-check] diag: ${diagSummary}`);
  // 2026-08-21: a live sweep reported withUrl=0 across 66 rows while the very
  // same sheet, tab and column yielded 66 of 66 when read offline. Nothing in
  // the static code explains the difference, so record the three runtime inputs
  // that could: which sheet was actually read, what column name arrived, and
  // what the first row's keys and lead cell really look like. Diagnostic only,
  // and it goes when this whole diag line is rewritten in plain English.
  if (diag.rowsScanned > 0 && diag.withUrl === 0) {
    const r0 = rows[0] || {};
    console.log(`[bulk-check] withUrl=0 INPUTS: sheet=${sheetUrl}`
      + ` | column=${JSON.stringify(linkedinColumn)}`
      + ` | columnPresentInRow=${Object.prototype.hasOwnProperty.call(r0, linkedinColumn)}`
      + ` | firstRowKeys=${JSON.stringify(Object.keys(r0).slice(0, 20))}`
      + ` | firstRowLeadCell=${JSON.stringify(String(r0[linkedinColumn] ?? '').slice(0, 80))}`
      + ` | anyCellHasLinkedinCom=${Object.values(r0).some((v) => String(v || '').includes('linkedin.com'))}`);
  }
  if (diag.duplicateCollapsed > 0) {
    console.log(`[bulk-check] ⚠ Collapsed ${diag.duplicateCollapsed} duplicate profile(s) — same person appeared on more than one row; introduced once, the extra row(s) stamped "Skipped — duplicate".`);
  }

  // One sentence for the operator's live log. Same numbers as the dump above,
  // said out loud instead of dumped, plus the one thing that genuinely looks
  // wrong from here: rows that carry no LinkedIn address at all, which is why
  // a sweep can read a full sheet and match nobody.
  const plainSweep = (accepted, refreshed) => {
    const base = accepted > 0
      ? plainLine('sweep-found', { account: pName, accepted, outstanding: diag.rowsScanned, refreshed })
      : plainLine('sweep-empty', { account: pName, outstanding: diag.rowsScanned, refreshed });
    if (diag.rowsScanned > 0 && diag.withUrl === 0) {
      return `${base} Something looks wrong: not one of those rows had a LinkedIn address on it, so nobody could be matched. Check that the right column is chosen for this sheet.`;
    }
    return sidecarConfirmed ? base : `${base} Warning: the Recent Connections tab could not be confirmed saved.`;
  };

  if (updates.length === 0) {
    return { matched: 0, freshConnected: 0, fetched: conns.length, diag: diagSummary, plain: plainSweep(0, 0), connectedUrls };
  }

  // Batch-update via the existing Apps Script bridge. cc → 'Connected
  // Status' column on the new schema; FIELD_MAP handles the column mapping.
  try {
    const saved = await batchUpdateSheet(sheetUrl, updates, { requireConfirmation: true });
    if (!saved) throw new Error('Sheet updates were not confirmed saved');
  } catch (err) {
    // Write failed — nothing is confirmed persisted, so freshConnected is 0
    // too, same reasoning as matched:0 below: an unconfirmed acceptance must
    // never reset the caller's empty-check streak.
    return { matched: 0, freshConnected: 0, fetched: conns.length, error: `batch-update: ${err.message}`, diag: diagSummary, connectedUrls };
  }

  const matchedCount = updates.filter((u) => u.cc === 'Connected').length;
  const pendingCount = updates.length - matchedCount;
  // connectedUrls comes from computeBulkCheckUpdates — includes matched URLs
  // regardless of suppressAcceptedStamp, so callers can fire auto-intros.
  // freshConnected (not matched) is the true "accepted THIS sweep" count —
  // matched also includes pre-existing 1st-degree connections re-queued for
  // an intro retry, which are 'Already connected', not new (see
  // tests/bulk-check-fresh-count.test.js). Callers driving the adaptive
  // check cadence must use freshConnected, mirroring the engine.
  return { matched: matchedCount, freshConnected, fetched: conns.length, stamped: pendingCount, diag: diagSummary, plain: plainSweep(freshConnected, pendingCount), connectedUrls };
}
