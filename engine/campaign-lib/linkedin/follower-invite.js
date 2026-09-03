// Follower Growth Phase 2 — automates the LinkedIn page "Invite to follow" modal.
// Self-contained module (mirrors post-amplification.js); reuses only shared
// helpers.js + the launcher. Does NOT touch outreach.js / actions.js.
import { randomDelay, getSenderUrn } from './helpers.js';

// "30/30 credits available · …" → 30 (the LEADING number = currently available).
export function parseCreditsAvailable(text) {
  const m = String(text || '').match(/(\d+)\s*\/\s*\d+\s*credits available/i);
  return m ? Number(m[1]) : 0;
}

// Full credit line → { available, allowance, refill }. The modal reads e.g.
// "5/30 credits available · Credit refill: June 30, 2026" — the parking-lot truth
// (available = 30 − pending-not-yet-accepted/withdrawn). We store THIS, not a
// 30−Sent estimate, so the sheet self-corrects for accepts/withdrawals.
export function parseCreditsMeta(text) {
  const s = String(text || '');
  const m = s.match(/(\d+)\s*\/\s*(\d+)\s*credits available/i);
  const rm = s.match(/credit refill:?\s*([A-Za-z0-9 ,]+?\d{4})/i);
  return {
    available: m ? Number(m[1]) : null,
    allowance: m ? Number(m[2]) : null,
    refill: rm ? rm[1].trim() : '',
  };
}

// Used ONLY to disambiguate duplicate same-name results. true if the headline
// contains the company token, or a significant (>=4-char, non-generic) job-title word.
const TITLE_STOP = new Set(['head', 'senior', 'chief', 'lead', 'manager', 'director', 'officer', 'global', 'group', 'team']);
export function headlineMatches(headline, { jobTitle = '', company = '' } = {}) {
  const h = (headline || '').toLowerCase();
  if (!h) return false;
  const co = (company || '').toLowerCase().trim();
  if (co.length >= 3 && h.includes(co)) return true;
  const words = (jobTitle || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !TITLE_STOP.has(w));
  return words.some((w) => h.includes(w));
}

function nameTokens(s) { return String(s || '').trim().toLowerCase().split(/\s+/).filter(Boolean); }
// Same person despite a middle name LinkedIn shows but our record omits: first AND
// last token match (e.g. "Katie Jackson" ↔ "Katie Whitty Jackson"). Still only used
// to widen the candidate set — the single-result / headline guards below disambiguate.
export function firstLastMatches(resultName, target) {
  const rt = nameTokens(resultName), tt = nameTokens(target);
  if (rt.length < 2 || tt.length < 2) return false;
  return rt[0] === tt[0] && rt[rt.length - 1] === tt[tt.length - 1];
}

// Decide which search result to select for a queued person.
// results: [{ name, headline, canInvite }]. Returns the chosen result or null (skip).
// Rule: among invitable results whose name matches (exact OR first+last) — exactly
// one -> take it; several -> the one whose headline verifies; else (0 or >1) -> null.
export function pickInviteResult(results, person) {
  const target = ((person && person.name) || '').trim().toLowerCase();
  if (!target) return null;
  const byName = (results || []).filter((r) => r.canInvite
    && ((r.name || '').trim().toLowerCase() === target || firstLastMatches(r.name, person.name)));
  if (byName.length === 1) return byName[0];
  if (byName.length === 0) return null;
  const verified = byName.filter((r) => headlineMatches(r.headline, { jobTitle: person.jobTitle, company: person.company }));
  return verified.length === 1 ? verified[0] : null;
}

// Why was a queued person skipped? 'already-follows' when a name-matched result
// exists but LinkedIn won't let us invite them (canInvite=false → already a
// follower/invitee — they cost no credit and should be remembered & not re-tried);
// otherwise 'no-match' (no invitable name match at all).
export function classifySkip(results, person) {
  const target = ((person && person.name) || '').trim().toLowerCase();
  const nameMatched = (results || []).filter((r) =>
    (r.name || '').trim().toLowerCase() === target || firstLastMatches(r.name, person.name));
  if (nameMatched.length === 0) return 'no-match';
  if (nameMatched.some((r) => r.canInvite)) return 'no-match';
  return 'already-follows';
}

const SEL = {
  modal: 'div[data-test-modal-id="invite-to-follow-picker"]',
  search: 'input.artdeco-typeahead__input',
  result: 'ul.artdeco-typeahead__results-list[role="listbox"] li[role="option"]',
  dismiss: 'button[aria-label="Dismiss"]',
};
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The modal renders in stages: the SHELL (header + "N/30 credits available" line)
// mounts FIRST, then ~1.5s later the interactive BODY (search box + invitee list)
// mounts. Waiting only for the credits text returned too early — selectPerson then
// typed into a search box that didn't exist yet ("No element found for selector:
// input.artdeco-typeahead__input"), the first send crashed. So wait for the actual
// SEARCH BOX (or a result row), which is what selectPerson needs — credits are read
// separately afterward. Node-side poll (not page.waitForFunction) so it is unit-
// testable with a fake page. Returns after `timeoutMs` regardless so the caller can
// still proceed (selectPerson guards against a missing box without throwing).
export async function waitForModalContent(page, { timeoutMs = 12000, pollMs = 250, log = () => {}, sleep = _sleep, now = () => Date.now() } = {}) {
  const deadline = now() + timeoutMs;
  let polls = 0;
  while (now() <= deadline) {
    polls++;
    // Exhausted accounts render "No remaining invite credits" with NO search box /
    // list, so don't wait the full window for a body that will never come — bail
    // immediately; readCredits then parses 0 and the run skips the account.
    const txt = await page.$eval(SEL.modal, (m) => m.innerText || '').catch(() => '');
    if (/no remaining invite credits/i.test(txt)) return { ready: true, via: 'no-credits', polls };
    const hasSearch = await page.$(SEL.search).then(Boolean).catch(() => false);
    if (hasSearch) return { ready: true, via: 'search', polls };
    const hasRow = await page.$(SEL.result).then(Boolean).catch(() => false);
    if (hasRow) return { ready: true, via: 'rows', polls };
    await sleep(pollMs);
  }
  return { ready: false, via: 'timeout', polls };
}

// Thrown when the invite-to-follow modal never opens within the wait window. This
// is NOT a reliable "not a Page admin" signal — a slow-loading modal for a real
// admin looks identical to a missing one (a 30s wait mislabeled antonio, who is an
// admin with 0 credits, as "not admin"). Eligibility is decided upfront from the
// SoO Company column; this is just an honest "couldn't open it" soft-skip.
export class InviteModalUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'InviteModalUnavailableError'; this.softSkip = true; }
}

// LinkedIn bounces a logged-out session to one of these paths instead of the
// invite page. Detected from page.url() right after goto so we skip in ms instead
// of waiting out the 2-min modal timeout, and report it distinctly (re-login needed).
const LOGGED_OUT_RE = /linkedin\.com\/(login|authwall|checkpoint|uas\/login)/i;
export function isLoggedOutUrl(url) {
  return LOGGED_OUT_RE.test(String(url || ''));
}

export class LoggedOutError extends Error {
  constructor(message) { super(message); this.name = 'LoggedOutError'; this.softSkip = true; this.loggedOut = true; }
}

export async function openInviteModal(page, inviteUrl, { log = () => {}, getIdentity = getSenderUrn, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  // Operators run on slow/overloaded laptops; the invite page can take a while.
  await page.goto(inviteUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // Logged-out session redirects to a login/authwall URL — detect it now and skip
  // fast with a distinct error instead of waiting 2 min for a modal that won't mount.
  const landed = await page.url();
  if (isLoggedOutUrl(landed)) {
    throw new LoggedOutError('account is logged out of LinkedIn — re-login needed before it can send follow invites');
  }
  // Same fast, DOM-independent login check the other campaigns use: the Voyager
  // /me probe. Catches a logged-out session that LinkedIn serves as a login WALL
  // at the SAME url (no redirect for isLoggedOutUrl to catch) — so we skip in ~1s
  // instead of waiting out the 2-min modal timeout. One retry absorbs a transient
  // /me hiccup so a momentarily-slow but logged-IN account isn't mislabeled.
  let urn = await getIdentity(page).catch(() => '');
  if (!urn) { await sleep(1500); urn = await getIdentity(page).catch(() => ''); }
  if (!urn) {
    throw new LoggedOutError('account is logged out (Voyager /me returned no identity) — re-login needed before it can send follow invites');
  }
  log('login confirmed via Voyager /me');
  // Up to 2 min: a real admin's modal can take a long time to mount on a slow/
  // overloaded machine, and we must NOT cut it short and mislabel them. Even an
  // exhausted admin gets a "No remaining invite credits" modal — let it appear,
  // then read 0 credits.
  try {
    await page.waitForSelector(SEL.modal, { timeout: 120000 });
  } catch (_) {
    throw new InviteModalUnavailableError('invite modal didn’t open in 2 min — slow load, or this account can’t access the Page invite tool. Skipped — try again.');
  }
  const content = await waitForModalContent(page, { log });
  log(content.ready
    ? `invite modal ready (${content.via}, ${content.polls} polls)`
    : `invite modal content did not render within ${content.polls} polls — proceeding anyway`);
  return { ok: true, contentReady: content.ready };
}

export async function readCredits(page, { log = () => {} } = {}) {
  // Read the WHOLE modal's visible text, not a single leaf node. LinkedIn often
  // splits "30/30 credits available" across child spans, so a leaf-only match
  // (the old approach) found nothing and returned 0 → the run thought the cap was
  // reached and bailed instantly. innerText concatenates the spans, so the regex
  // in parseCreditsAvailable still matches.
  const txt = await page.$eval(SEL.modal, (m) => m.innerText || '').catch(() => '');
  const credits = parseCreditsAvailable(txt);
  if (!credits) {
    // Couldn't parse a number — surface the real wording so the regex/selector can
    // be tuned (or confirm the account genuinely has 0 invite credits / isn't admin).
    log(`credits parse miss — modal text: "${String(txt).replace(/\s+/g, ' ').trim().slice(0, 240)}"`);
  }
  return credits;
}

// Read the full credit line (available + allowance + refill date) for write-back.
export async function readCreditsMeta(page) {
  const txt = await page.$eval(SEL.modal, (m) => m.innerText || '').catch(() => '');
  return parseCreditsMeta(txt);
}

export async function scrapeResults(page) {
  return page.$$eval(SEL.result, (lis) => lis.map((li) => {
    const text = (li.innerText || '').trim();
    const canInvite = !!li.querySelector('.invitee-picker-connections-result-item--can-invite');
    const m = text.match(/\b(?:1st|2nd|3rd)\s*•\s*/);
    // LinkedIn prepends the checkbox a11y label "Select <Name>" to each result's
    // first line — strip it so the name equals the queued person's name.
    const name = (m ? text.slice(0, m.index) : text).split('\n')[0].trim().replace(/^select\s+/i, '').trim();
    const headline = m ? text.slice(m.index).replace(/^\s*(?:1st|2nd|3rd)\s*•\s*/, '').trim() : '';
    // raw + class captured for diagnosing skips (name-match / can-invite detection).
    return { name, headline, canInvite, raw: text.replace(/\s+/g, ' ').slice(0, 140), cls: (li.className || '').slice(0, 120) };
  })).catch(() => []);
}

// Type a name, wait for results, decide via pickInviteResult, click the chosen row.
export async function selectPerson(page, person, { log = () => {} } = {}) {
  // Defence in depth: if the search box still isn't present (e.g. modal body never
  // rendered within the wait window), skip this person instead of throwing — a
  // missing-selector throw previously aborted the whole run mid-batch.
  const hasSearch = await page.$(SEL.search).then(Boolean).catch(() => false);
  if (!hasSearch) { log(`skip "${person.name}" — search box not present`); return { selected: false, reason: 'no-match' }; }
  await page.click(SEL.search, { clickCount: 3 }).catch(() => {});
  // Force-clear the box before typing. The triple-click select-all above is
  // unreliable on the VM's headless browser — without this, each name is appended
  // to the last, the box fills with every name concatenated, LinkedIn returns no
  // results, and everyone is skipped. Set the value empty via the native input
  // setter + input event so LinkedIn's controlled input registers the change.
  await page.$eval(SEL.search, (el) => {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }).catch(() => {});
  await page.type(SEL.search, person.name, { delay: 40 });
  await randomDelay(900, 1600);
  const results = await scrapeResults(page);
  const choice = pickInviteResult(results, person);
  if (!choice) {
    const reason = classifySkip(results, person);
    log(`skip "${person.name}" (${reason}) — scraped ${JSON.stringify(results.slice(0, 2))}`);
    return { selected: false, reason };
  }
  const clicked = await page.evaluate((sel, targetName) => {
    // Match on the first line minus the "Select " a11y prefix (same as scrapeResults).
    const norm = (s) => (s || '').split('\n')[0].trim().replace(/^select\s+/i, '').trim().toLowerCase();
    const lis = [...document.querySelectorAll(sel)];
    const li = lis.find((l) => norm(l.innerText).startsWith(targetName.toLowerCase()));
    if (!li) return false;
    const box = li.querySelector('input[type="checkbox"], [role="checkbox"]') || li;
    box.click();
    return true;
  }, SEL.result, choice.name);
  log(`${clicked ? 'selected' : 'click-miss'} "${person.name}"`);
  return { selected: clicked, reason: clicked ? 'ok' : 'no-match' };
}

export async function clickInvite(page, { log = () => {} } = {}) {
  const ok = await page.evaluate((modalSel) => {
    const modal = document.querySelector(modalSel);
    if (!modal) return false;
    const btn = [...modal.querySelectorAll('button.artdeco-button--primary')]
      .find((b) => /invite/i.test(((b.querySelector('.artdeco-button__text') || b).textContent) || ''));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }, SEL.modal);
  log(ok ? 'clicked Invite' : 'Invite button not clickable');
  return ok;
}

// Orchestrator. `deps` is the unit-test seam (defaults to the real page fns above).
// The modal is opened only when `inviteUrl` is passed (real runs); unit tests omit it.
// `deps.sleep` replaces the inter-person pause (default: randomDelay 700–1400 ms).
export async function runFollowerInvites({ page, inviteUrl, queued = [], log = () => {}, shouldAbort = () => false, onProgress = () => {}, deps } = {}) {
  const d = {
    openModal: openInviteModal,
    readCredits,
    readCreditsMeta,
    selectPerson,
    clickInvite,
    sleep: () => randomDelay(700, 1400),
    ...(deps || {}),
  };
  if (inviteUrl) await d.openModal(page, inviteUrl, { log });
  const creditsBefore = await d.readCredits(page, { log });
  log(`credits available: ${creditsBefore}`);
  // Capture the modal's real allowance + refill date for write-back (real runs
  // only; unit tests pass no inviteUrl). `available` here equals creditsBefore.
  let allowance = null, refill = '';
  if (inviteUrl) { const meta = await d.readCreditsMeta(page); allowance = meta.allowance; refill = meta.refill; }
  const invited = [], skipped = [], alreadyFollowing = [];
  let index = 0;
  for (const person of queued) {
    if (shouldAbort()) { log('aborted'); break; }
    if (invited.length >= creditsBefore) { log('credit cap reached'); break; }
    const r = await d.selectPerson(page, person, { log });
    const selected = (r && typeof r === 'object') ? !!r.selected : !!r;
    const reason = (r && typeof r === 'object') ? r.reason : '';
    if (selected) {
      invited.push(person.memberId);
    } else {
      skipped.push(person.memberId);
      if (reason === 'already-follows') alreadyFollowing.push(person.memberId);
    }
    // Best-effort per-person progress tick (default no-op). Fires AFTER each
    // selection so a live viewer sees "selecting N/total" climb during the batch;
    // never affects the send (still one Invite click after the loop).
    index++;
    try { onProgress({ person, ok: selected, index, total: queued.length, selectedSoFar: invited.length }); } catch (_) { /* progress is cosmetic */ }
    await d.sleep();
  }
  let sent = false;
  if (invited.length) sent = await d.clickInvite(page, { log });
  const creditsAfter = sent ? Math.max(0, creditsBefore - invited.length) : creditsBefore;
  return { invited: sent ? invited : [], skipped: sent ? skipped : skipped.concat(invited), alreadyFollowing, creditsBefore, creditsAfter, allowance, refill, sent };
}
