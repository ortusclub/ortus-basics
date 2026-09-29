/**
 * Manual bulk reply sweep — identity-safe, preview-only inbox scan.
 *
 * Self-contained on purpose: reuses helpers.getConversationsPage +
 * fetchNewConversations but does NOT touch check-dms.js (the disabled
 * scheduler + its tests depend on it). Matching is identity-first
 * (URN/profileUrl), name only as a fallback, skip-on-doubt → unmatched.
 */

import * as helpers from './helpers.js';
import { updateSheetRow, appendReplyRow as _appendReplyRow } from '../sheets-writer.js';
import * as sheetsWriter from '../sheets-writer.js';

// Member-URN encoding shared with outreach.js / check-dms.js.
const SALES_MEMBER_URN_RE = /\/sales\/(?:lead|people)\/(AC[A-Za-z0-9_-]{10,})(?:[,/?#]|$)/;
const URN_RE = /^AC[A-Za-z0-9_-]+$/;

/** Canonical match token from a LinkedIn URL. URN (case-kept) > vanity slug (lowercased) > null. */
export function identityToken(linkedinUrl) {
  if (!linkedinUrl) return null;
  const url = String(linkedinUrl);
  const sales = url.match(SALES_MEMBER_URN_RE);
  if (sales) return sales[1];
  const inMatch = url.match(/\/in\/([^/?#,]+)/);
  if (inMatch) {
    const id = inMatch[1];
    return URN_RE.test(id) ? id : id.toLowerCase();
  }
  return null;
}

/** identityToken of the conversation's (single) participant. */
export function conversationToken(conv) {
  const p = Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null);
  return p ? identityToken(p.profileUrl) : null;
}

/** The row's LinkedIn URL: configured column > 'Linkedin URL' > first linkedin.com value > ''. */
export function rowLinkedinUrl(row, linkedinColumn) {
  if (!row || typeof row !== 'object') return '';
  if (linkedinColumn && row[linkedinColumn]) return String(row[linkedinColumn]);
  if (row['Linkedin URL']) return String(row['Linkedin URL']);
  for (const k of Object.keys(row)) {
    const v = String(row[k] || '');
    if (v.includes('linkedin.com')) return v;
  }
  return '';
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function fullName(firstName, lastName) {
  return `${normName(firstName)} ${normName(lastName)}`.trim();
}

/** Numeric memberId from a sheet row ('Linkedin Membership ID' / 'Linkedin Member' / 'memberId' …). */
export function rowMemberId(row) {
  if (!row || typeof row !== 'object') return '';
  for (const k of ['Linkedin Membership ID', 'LinkedIn Membership ID', 'Linkedin Member', 'LinkedIn Member', 'Linkedin Member ID', 'memberId', 'Member ID']) {
    const v = String(row[k] ?? '').trim();
    if (/^\d{4,}$/.test(v)) return v;
  }
  // Fallback: any column whose value is a bare numeric id of plausible length.
  for (const k of Object.keys(row)) {
    const v = String(row[k] ?? '').trim();
    if (/^\d{6,}$/.test(v)) return v;
  }
  return '';
}

/**
 * True when the lead sent the last message. Prefer the parser's authoritative
 * `lastMessage.isInbound` (sender ≠ viewer); fall back to actor/name comparison
 * only for legacy/test shapes that don't carry it.
 */
export function isInboundConversation(conv) {
  const last = conv?.lastMessage || null;
  if (!last) return false;
  if (typeof last.isInbound === 'boolean') return last.isInbound;
  const participant = Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null);
  if (!participant) return false;
  const actor = last.actor || {};
  const sameUrl = participant.profileUrl && actor.profileUrl && participant.profileUrl === actor.profileUrl;
  const sameName = participant.firstName && actor.firstName &&
    fullName(participant.firstName, participant.lastName) === fullName(actor.firstName, actor.lastName);
  return !!(sameUrl || sameName);
}

/**
 * Match ONE participant against the candidate rows. memberId → fsd → slug → name,
 * each: 1 hit → identity (name for the last stage), >1 → ambiguous, 0 → next.
 */
function matchParticipant(p, rows, linkedinColumn) {
  if (!p) return { row: null, reason: 'unmatched' };
  const mid = String(p.memberId || '').trim();
  if (/^\d{4,}$/.test(mid)) {
    const hits = rows.filter((r) => rowMemberId(r) === mid);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }
  const fsd = String(p.fsdProfile || '').trim();
  if (fsd) {
    const hits = rows.filter((r) => identityToken(rowLinkedinUrl(r, linkedinColumn)) === fsd
      || String(r['LinkedIn URN'] || r['Linkedin URN'] || '').trim() === fsd);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }
  const ptoken = identityToken(p.profileUrl);
  if (ptoken) {
    const hits = rows.filter((r) => identityToken(rowLinkedinUrl(r, linkedinColumn)) === ptoken);
    if (hits.length === 1) return { row: hits[0], reason: 'identity' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }
  const full = fullName(p.firstName, p.lastName);
  if (full) {
    const hits = rows.filter((r) => fullName(r.firstName || r['First Name'], r.lastName || r['Last Name']) === full);
    if (hits.length === 1) return { row: hits[0], reason: 'name' };
    if (hits.length > 1) return { row: null, reason: 'ambiguous' };
  }
  return { row: null, reason: 'unmatched' };
}

/**
 * Identity-safe match, GROUP-AWARE. In a 3-way CC+IC thread the participants are
 * [the campaign account ("me", excluded by the parser), the lead, the primary
 * person]. The lead is NOT necessarily participants[0] (it's often the primary),
 * so we test EVERY participant against the leads and return the matched LEAD.
 * Returns { row, reason, lead } — `lead` is the matched participant (for correct
 * name/direction attribution). >1 distinct lead row → ambiguous (skip-on-doubt).
 */
export function matchConversationIdentitySafe(conv, candidateRows, linkedinColumn) {
  const rows = Array.isArray(candidateRows) ? candidateRows : [];
  const parts = (Array.isArray(conv?.participants) && conv.participants.length)
    ? conv.participants
    : (conv?.participant ? [conv.participant] : []);
  if (!parts.length) return { row: null, reason: 'unmatched', lead: null };

  const matched = [];           // { row, lead, reason }
  let sawAmbiguous = false;
  for (const p of parts) {
    const r = matchParticipant(p, rows, linkedinColumn);
    if (r.reason === 'ambiguous') sawAmbiguous = true;
    else if (r.row) matched.push({ row: r.row, lead: p, reason: r.reason });
  }
  const uniq = [...new Map(matched.map((x) => [x.row, x])).values()];
  if (uniq.length === 1) return { row: uniq[0].row, reason: uniq[0].reason, lead: uniq[0].lead };
  if (uniq.length > 1) return { row: null, reason: 'ambiguous', lead: null };   // two leads in one thread
  if (sawAmbiguous) return { row: null, reason: 'ambiguous', lead: null };
  return { row: null, reason: 'unmatched', lead: null };
}

function previewOf(conv, row, linkedinColumn, lead) {
  // Attribute to the matched lead (groups: NOT participants[0], which may be the primary).
  const p = lead || (Array.isArray(conv?.participants) ? conv.participants[0] : (conv?.participant || null));
  const last = conv?.lastMessage || null;
  const isGroup = conv?.groupChat === true ||
    (Array.isArray(conv?.participants) && conv.participants.length > 1);
  return {
    leadName: p ? `${p.firstName || ''} ${p.lastName || ''}`.replace(/\s+/g, ' ').trim() : '(unknown)',
    snippet: String(last?.text || '').slice(0, 160),
    fullText: String(last?.text || ''),
    profileUrl: p?.profileUrl || '',
    memberId: p?.memberId || '',
    threadId: conv?.threadId || '',
    timestamp: last?.deliveredAt || conv?.lastActivityAt || null,
    linkedinUrl: row ? rowLinkedinUrl(row, linkedinColumn) : (p?.profileUrl || ''),
    row: row || null,
    suspected: false,
    isGroup,
    // Who actually wrote the last message (so the UI can show "Luca replied",
    // not the primary). Empty when the parser couldn't resolve a sender.
    lastSender: [last?.actor?.firstName, last?.actor?.lastName].filter(Boolean).join(' ').trim(),
  };
}

/** True when the LEAD (matched participant) sent the last message — not us, not the primary. */
function leadSentLast(conv, lead) {
  const last = conv?.lastMessage || null;
  if (!last || !lead) return false;
  const senderMid = String(last.actor?.memberId || '').trim();
  const leadMid = String(lead.memberId || '').trim();
  if (senderMid && leadMid) return senderMid === leadMid;        // exact, group-safe
  // memberId missing on the message actor → fall back to name/url comparison.
  const sUrl = last.actor?.profileUrl, lUrl = lead.profileUrl;
  if (sUrl && lUrl) return sUrl === lUrl;
  const sName = fullName(last.actor?.firstName, last.actor?.lastName);
  const lName = fullName(lead.firstName, lead.lastName);
  return !!(sName && sName === lName);
}

/**
 * Split conversations into matched campaign replies vs unmatched new replies.
 * Group-aware: a thread is a campaign reply only when a campaign LEAD is a
 * participant AND that lead sent the last message (so the primary's own intro
 * message is never mistaken for the lead replying).
 */
export function classifyConversations(convs, candidateRows, linkedinColumn) {
  const campaignReplies = [];
  const unmatched = [];
  for (const conv of (Array.isArray(convs) ? convs : [])) {
    const m = matchConversationIdentitySafe(conv, candidateRows, linkedinColumn);
    const inbound = isInboundConversation(conv);
    if (m.reason === 'identity' || m.reason === 'name') {
      // A campaign lead is in this thread. Surface as a reply only when the LEAD
      // spoke last (group-safe); if the actor carries no memberId, fall back to
      // the coarse inbound signal so 1:1 DM threads still work.
      const hasActorMid = !!String(conv?.lastMessage?.actor?.memberId || '').trim();
      if (leadSentLast(conv, m.lead) || (!hasActorMid && inbound)) {
        campaignReplies.push(previewOf(conv, m.row, linkedinColumn, m.lead));
      }
      // else: we / the primary spoke last → not a fresh lead reply; skip silently.
    } else if (inbound) {
      // No campaign lead in the thread, but someone messaged us → unmatched bucket.
      const item = previewOf(conv, null, linkedinColumn, null);
      item.suspected = (m.reason === 'ambiguous');
      unmatched.push(item);
    }
  }
  return { campaignReplies, unmatched };
}

// ── Dependency injection (test hook; mirrors check-dms.js) ───────────────────
const _realDeps = {
  async getConversationsPage(page, opts) { return helpers.getConversationsPage(page, opts); },
  async getInboxCategoryPage(page, opts) { return helpers.getInboxCategoryPage(page, opts); },
  async getSalesNavThreadsPage(page, opts) { return helpers.getSalesNavThreadsPage(page, opts); },
  async getSheetRowStatus(sheetUrl, url, col) { return sheetsWriter.getSheetRowStatus(sheetUrl, url, col); },
  async updateSheetRow(sheetUrl, url, tracking, col) { return updateSheetRow(sheetUrl, url, tracking, col); },
  async appendReplyRow(sheetUrl, reply) { return _appendReplyRow(sheetUrl, reply); },
};
let _deps = { ..._realDeps };
export function _setDeps(stubs) { _deps = stubs === null ? { ..._realDeps } : { ..._realDeps, ...stubs }; }

/**
 * Non-destructive: don't rewrite a row already marked as replied — by the Reply
 * column, a Replied stage, or a Y in the operator's Responded column (tabs
 * without a Reply column would otherwise be rewritten on every check).
 */
export function shouldWriteReply(currentStatus, _newReply) {
  if (!currentStatus) return true;
  if (String(currentStatus.Reply || '').toLowerCase().trim() === 'yes') return false;
  if (String(currentStatus.Stage || '').trim().toLowerCase() === 'replied') return false;
  if (/^y(es)?$/i.test(String(currentStatus.Responded || '').trim())) return false;
  return true;
}

export function makeInitialSweepStatus(profileNames, dryRun) {
  const names = Array.isArray(profileNames) ? profileNames : [];
  return {
    running: true, phase: 'scanning', dryRun: !!dryRun,
    totalProfiles: names.length, doneProfiles: 0, currentProfile: null,
    campaignReplies: [], unmatched: [], wrote: 0,
    perProfile: names.map((n) => ({ profileName: n, status: 'waiting', replies: 0, unmatched: 0, error: '' })),
    logs: [], error: null,
  };
}

/**
 * Write matched campaign replies to the sheet (Replies tab + Reply/Stage).
 * Non-destructive + per-row isolated. Only called when dry-run is OFF.
 */
export async function applyReplyWriteBack({ sheetUrl, linkedinColumn, campaignReplies }) {
  let wrote = 0, skipped = 0;
  const errors = [];
  for (const r of (campaignReplies || [])) {
    const url = r.linkedinUrl || '';
    if (!url) { errors.push(`missing LinkedIn URL for ${r.leadName || '(unknown)'}`); continue; }
    try {
      const current = await _deps.getSheetRowStatus(sheetUrl, url, linkedinColumn);
      if (!shouldWriteReply(current, r)) { skipped++; continue; }
      const tsIso = new Date(r.timestamp || Date.now()).toISOString();
      await _deps.appendReplyRow(sheetUrl, {
        leadUrl: url, timestamp: tsIso, direction: 'in', sender: r.leadName || 'lead', body: String(r.snippet || ''),
      });
      await _deps.updateSheetRow(sheetUrl, url, {
        Reply: 'yes', ReplyAt: tsIso, ReplyPreview: String(r.snippet || '').slice(0, 100), stage: 'Replied', responded: 'Y',
      }, linkedinColumn);
      wrote++;
    } catch (e) {
      errors.push(`write-back failed for ${url}: ${e.message}`);
    }
  }
  return { wrote, skipped, errors };
}

// Paging bounds for the manual reply check: 20 threads a page, so 40 pages
// reaches ~800 threads back — far past any single campaign — while a short
// pause between pages keeps the reads looking like someone scrolling.
const MAX_INBOX_PAGES = 40;
const PAGE_DELAY_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function oldestActivity(elements) {
  const ts = (Array.isArray(elements) ? elements : []).map((e) => e.lastActivityAt || 0);
  return ts.length ? Math.min(...ts) : 0;
}

function dedupeConvs(convs) {
  const seen = new Map();
  for (const c of convs) {
    const k = c.threadId || c.entityUrn;
    if (!k) { seen.set(Symbol('conv'), c); continue; }
    if (!seen.has(k)) seen.set(k, c);
  }
  return [...seen.values()];
}

/**
 * Walk the regular inbox back past `watermark` with the cursor-paged category
 * query. That query only fires once the conversation list is scrolled, so
 * scroll first and wait for it. Returns [] when it can't be discovered — the
 * caller still has page 1.
 */
async function pageInboxBack(page, watermark, log) {
  if (typeof page.evaluate === 'function' && typeof page.waitForFunction === 'function') {
    try {
      await page.evaluate(() => {
        document.querySelectorAll('*').forEach((e) => {
          if (e.scrollHeight > e.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight;
        });
      });
      await page.waitForFunction(
        () => performance.getEntriesByType('resource').some((e) => {
          try { return decodeURIComponent(e.name).includes('conversationCategoryPredicate'); } catch { return false; }
        }),
        { timeout: 15000 },
      );
    } catch { /* fall through — the first category fetch returns null */ }
  }
  const out = [];
  let complete = false;
  let cursor = null;
  for (let pages = 0; pages < MAX_INBOX_PAGES; pages++) {
    if (pages) await sleep(PAGE_DELAY_MS);
    let batch;
    try { batch = await _deps.getInboxCategoryPage(page, { cursor }); }
    catch { break; }
    if (!batch || !Array.isArray(batch.elements)) break;
    if (batch.elements.length === 0) { complete = true; break; }
    out.push(...batch.elements);
    if (oldestActivity(batch.elements) <= watermark || !batch.nextCursor) { complete = true; break; }
    cursor = batch.nextCursor;
  }
  try { log(`📬 Inbox: read ${out.length} thread(s)${out.length ? ` back to ${new Date(oldestActivity(out)).toISOString().slice(0, 10)}` : ' (paging unavailable — newest 20 only)'}`); } catch (_) {}
  return { convs: out, complete };
}

/** Navigate /messaging/, wait for the conversations XHR, fetch + paginate, filter by watermark. */
export async function loadInboxConversations(page, { watermark = 0, log = () => {} } = {}) {
  try {
    if (typeof page.goto === 'function') {
      try {
        await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        return { convs: [], error: `couldn't open inbox: ${e.message}` };
      }
      if (typeof page.waitForFunction === 'function') {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          await page.evaluate(() => {
            const list = document.querySelector('.msg-conversations-container__conversations-list, ul[class*="conversations-list"], .scaffold-layout__list-detail, .scaffold-layout__list');
            if (list) { list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll', { bubbles: true })); }
            window.scrollTo(0, document.body.scrollHeight);
          });
        } catch { /* best-effort nudge */ }
        try {
          await page.waitForFunction(
            () => performance.getEntriesByType('resource').some((e) => typeof e.name === 'string' && e.name.includes('queryId=messengerConversations')),
            { timeout: 20000 },
          );
        } catch { /* fall through — getConversationsPage will return null */ }
      }
    }

    let first;
    try { first = await _deps.getConversationsPage(page, { start: 0, count: 20 }); }
    catch (e) { return { convs: [], error: `couldn't read inbox: ${e.message}` }; }
    if (first === null || first === undefined) {
      return { convs: [], error: "couldn't load inbox for this account (rate-limited or session expired) — try again" };
    }

    // Page 1 (sync-token query) is only ever the newest 20 threads. Go further
    // back with the cursor-paged category query until we pass the watermark.
    const firstEls = first.elements || [];
    const deeper = (firstEls.length >= 20 && oldestActivity(firstEls) > watermark)
      ? await pageInboxBack(page, watermark, log)
      : { convs: [], complete: true };
    const convs = dedupeConvs([...firstEls, ...deeper.convs])
      .filter((el) => (el.lastActivityAt || 0) > watermark);
    return { convs, error: '', complete: deeper.complete };
  } catch (e) {
    return { convs: [], error: `inbox scan failed: ${e.message}` };
  }
}

// True when ANY candidate lead was reached via Sales Navigator (Open Profile /
// InMail) — so their replies live in the Sales Nav inbox, not the regular one.
// Detected from the sheet's channel markers (Stage / OP Status / Last Action).
export function hasSalesNavChannel(rows) {
  const re = /\bop\b|open profile|in[\s-]?mail|sales nav/i;
  return (Array.isArray(rows) ? rows : []).some((r) => {
    if (!r) return false;
    const sentVia = String(r['Sent via'] || '').trim().toLowerCase();
    if (sentVia === 'linkedin') return false;
    if (sentVia === 'sales navigator') return true;
    const vals = [r.Stage, r['OP Status'], r['Op Status'], r['InM Status'], r['Last Action'], r['Last Acti'], r.Channel]
      .filter(Boolean).map(String);
    return vals.some((v) => re.test(v) || /^InM Sent$/i.test(v));
  });
}

/**
 * Load the Sales Navigator inbox thread list, normalized to the internal
 * conversation shape. Best-effort — returns { convs, error } and never throws.
 * OPs/InMails are sent through Sales Nav so their replies land here.
 */
export async function loadSalesNavConversations(page, { watermark = 0, log = () => {} } = {}) {
  try {
    if (typeof page.goto === 'function') {
      try {
        await page.goto('https://www.linkedin.com/sales/inbox/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        return { convs: [], error: `couldn't open Sales Nav inbox: ${e.message}` };
      }
      if (typeof page.waitForFunction === 'function') {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          await page.waitForFunction(
            () => performance.getEntriesByType('resource').some((e) => typeof e.name === 'string' && e.name.includes('salesApiMessagingThreads')),
            { timeout: 20000 },
          );
        } catch { /* fall through — getSalesNavThreadsPage returns null */ }
      }
    }
    let res;
    try { res = await _deps.getSalesNavThreadsPage(page); }
    catch (e) { return { convs: [], error: `couldn't read Sales Nav inbox: ${e.message}` }; }
    if (res === null || res === undefined) {
      return { convs: [], error: "couldn't load Sales Nav inbox (no seat, rate-limited, or session expired)" };
    }
    // Newest-first, 20 per page. Keep paging until a page reaches back past the
    // watermark — a busy account can have several pages of newer sends on top.
    const all = [...(res.elements || [])];
    let next = res.nextPageStartsAt || null;
    let complete = !next || oldestActivity(res.elements) <= watermark;
    for (let pages = 1; pages < MAX_INBOX_PAGES && next && oldestActivity(res.elements) > watermark; pages++) {
      await sleep(PAGE_DELAY_MS);
      let batch;
      try { batch = await _deps.getSalesNavThreadsPage(page, { pageStartsAt: next }); }
      catch { break; }
      if (!batch || !Array.isArray(batch.elements)) break;
      if (batch.elements.length === 0) { complete = true; break; }
      all.push(...batch.elements);
      complete = !batch.nextPageStartsAt || oldestActivity(batch.elements) <= watermark;
      if (!batch.nextPageStartsAt || batch.nextPageStartsAt === next) break;
      res = batch;
      next = batch.nextPageStartsAt;
    }
    try { log(`🧭 Sales Nav: read ${all.length} thread(s) back to ${new Date(oldestActivity(all)).toISOString().slice(0, 10)}`); } catch (_) {}
    const convs = dedupeConvs(all).filter((el) => (el.lastActivityAt || 0) > watermark);
    return { convs, error: '', complete };
  } catch (e) {
    return { convs: [], error: `Sales Nav scan failed: ${e.message}` };
  }
}

/**
 * Preview-only sweep for one profile. Never throws — per-profile isolated.
 * Reads the regular DM inbox, and ALSO the Sales Nav inbox when the candidate
 * leads include OP/InMail rows (auto-detected) — combined in one classify pass,
 * so DM and OP/InMail replies for the account surface together. A Sales Nav
 * failure is logged but does not fail the regular sweep.
 */
export async function sweepProfileInbox({ page, sheetUrl, linkedinColumn, candidateRows, watermark = 0, log = () => {}, includeSalesNav } = {}) {
  const { convs, error, complete } = await loadInboxConversations(page, { watermark, log });
  if (error) return { campaignReplies: [], unmatched: [], conversationsScanned: 0, error };

  let allConvs = convs;
  const channelChecks = { linkedin: complete ? 'Done' : 'Incomplete' };
  const wantSalesNav = includeSalesNav === undefined ? hasSalesNavChannel(candidateRows) : !!includeSalesNav;
  if (wantSalesNav) {
    try { log('🧭 Also scanning Sales Navigator inbox (OP / InMail)…'); } catch (_) {}
    const sn = await loadSalesNavConversations(page, { watermark, log });
    channelChecks.salesnav = sn.error ? 'Failed' : sn.complete ? 'Done' : 'Incomplete';
    if (sn.error) { try { log(`⚠ Sales Nav inbox skipped — ${sn.error}`); } catch (_) {} }
    else { allConvs = convs.concat(sn.convs); try { log(`🧭 Sales Nav: ${sn.convs.length} thread(s)`); } catch (_) {} }
  }

  const { campaignReplies, unmatched } = classifyConversations(allConvs, candidateRows, linkedinColumn);
  return { campaignReplies, unmatched, conversationsScanned: allConvs.length, error: '', channelChecks };
}

export function replyCheckResultsForRows(rows, linkedinColumn, outcome, checkedAt, stopped = false) {
  const replies = new Set((outcome.campaignReplies || []).map((r) => r.row));
  return rows.map((row) => {
    const channel = hasSalesNavChannel([row]) ? 'salesnav' : 'linkedin';
    const status = stopped ? 'Stopped' : outcome.error ? 'Failed'
      : (outcome.channelChecks?.[channel] || 'Incomplete');
    return {
      linkedinUrl: rowLinkedinUrl(row, linkedinColumn), status, checkedAt,
      result: replies.has(row) ? 'Reply found'
        : status === 'Done' ? 'No reply found in scanned messages' : 'Unknown — check not completed',
    };
  });
}
