/**
 * src/linkedin/accept-invitation.js — net-new (the codebase has NO accept-
 * invitation capability). Lets the primary's LOCAL browser accept exactly the
 * incoming connection request sent by a known campaign account — never any
 * other invitation. The off-limits actions.js/outreach.js are NOT touched.
 *
 * pickInvitation is a pure, high-precision matcher: a profile-URL match, or an
 * EXACT display-name match — and nothing softer. Unlike the intro typeahead
 * (a pre-filtered 1–5 suggestion list), the invitation manager lists EVERY
 * pending invite from any stranger, so fuzzy/token-prefix/single-candidate
 * matching is deliberately excluded to avoid accepting the wrong person.
 * The two DOM functions are verified manually against LinkedIn.
 */
import { normalizeName } from './match-primary.js';

/** Pull the LinkedIn profile slug out of any /in/<slug> URL, lowercased. */
function urlKey(u) {
  const m = String(u || '').match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

// LinkedIn's invitation cards use hashed/randomized CSS classes and the Accept
// button's label is localized (the operator's UI language), so we identify the
// Accept button by a language-stem match on its aria-label / text — and we
// EXCLUDE ignore/decline stems so a stray match can never click "Ignore".
// Stems are lowercase substrings covering the common operator locales.
export const ACCEPT_STEMS = [
  'accept',   // EN accept · FR accepter · NL accepteren · RO acceptă · DA acceptér
  'annehm',   // DE annehmen
  'accett',   // IT accetta / accettare
  'acept',    // ES aceptar
  'aceit',    // PT aceitar
  'godkänn',  // SV
  'godta',    // NO
  'hyväksy',  // FI
  'zaakcept', // PL zaakceptuj
  'przyjmij', // PL przyjmij
  'elfogad',  // HU
  'принять',  // RU
  'tanggap',  // TL (Tagalog/Filipino) tanggapin — NOT a substring of the decline "tanggihan"
];
export const IGNORE_STEMS = [
  'ignor',    // EN/DE/IT/ES ignore/ignorieren/ignora/ignorar
  'negeren',  // NL
  'odrzuc',   // PL
  'rifiut',   // IT rifiuta
  'rechaz',   // ES rechazar
  'refus',    // FR refuser
  'avvis',    // NO/DA avvis
  'hylkää',   // FI
  'elutasít', // HU
  'отклон',   // RU
  'tanggih',  // TL decline (tanggihan) — vetoes the Tanggapin look-alike
  'pansin',   // TL ignore (huwag pansinin)
  'balewala', // TL ignore (balewalain)
];

/**
 * Pure: is this button label an ACCEPT action (and not an ignore/decline)?
 * Matches an accept stem AND no ignore stem. Locale-independent of CSS classes.
 * @param {string} label  aria-label or visible text of a button
 */
export function isAcceptLabel(label, accept = ACCEPT_STEMS, ignore = IGNORE_STEMS) {
  const s = (label || '').toLowerCase();
  if (!s) return false;
  if (ignore.some((v) => s.includes(v))) return false;
  return accept.some((v) => s.includes(v));
}

/**
 * Pure decision: which received-invitation candidate (if any) belongs to the
 * target campaign account. Precision over recall — only a profile-URL match or
 * an EXACT normalized-name match accepts; anything else returns no-match so a
 * stranger is never accepted. (No token-prefix / single-candidate fallback.)
 * @param {Array<{name:string, profileUrl?:string}>} candidates
 * @param {{name:string, profileUrl?:string}} target
 * @returns {{ index: number|null, reason: string }}
 */
export function pickInvitation(candidates, target) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { index: null, reason: 'no-candidates' };
  }
  // 1) Profile-URL corroboration — airtight, cannot false-positive.
  const tUrl = urlKey(target && target.profileUrl);
  if (tUrl) {
    const i = candidates.findIndex(c => urlKey(c.profileUrl) === tUrl);
    if (i >= 0) return { index: i, reason: 'profile-url' };
  }
  // 2) Exact display-name match only. The campaign account's name (read from
  //    its own global nav) and the invitation card name are both LinkedIn's
  //    canonical display name for the same account, so they match exactly.
  const norm = normalizeName((target && target.name) || '');
  if (norm) {
    const i = candidates.findIndex(c => normalizeName(c.name) === norm);
    if (i >= 0) return { index: i, reason: 'exact-name' };
  }
  return { index: null, reason: 'no-match' };
}

/**
 * Read the logged-in account's OWN identity (name + profile URL). Runs on the
 * campaign account right after it sends the connect request to the primary; the
 * result is used to match this account's invitation on the primary's side.
 *
 * v2.105.3: PRIMARY source is the Voyager /me API — DOM-independent. The old
 * global-nav scrape silently returned EMPTY on (a) accounts with no profile
 * photo (LinkedIn renders a ghost icon, not an <img alt="Name">) and (b) slow /
 * rate-limited sessions where the nav hydrates after the 10s wait. Either way
 * the caller skipped queuing the auto-accept, so the primary never opened to
 * accept (the 2026-06-16 "it didn't auto-accept" report — confirmed via the
 * field log: a flat 10s gap = the nav waitForFunction timing out every send).
 * /me returns firstName/lastName/publicIdentifier from one lightweight GET,
 * regardless of photo, hashed CSS classes, or nav timing. The nav scrape is
 * kept as a fallback. Mirrors the proven getVoyagerDegree() idiom in helpers.js.
 * @returns {Promise<{name:string, profileUrl:string}>}
 */
export async function readSelfIdentity(page, { log = () => {} } = {}) {
  // 1) Voyager /me — DOM-independent, immune to no-photo / slow-nav / hashing.
  try {
    const viaApi = await page.evaluate(async () => {
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        if (!csrf) return null;
        const token = csrf.split('=')[1]?.replace(/"/g, '');
        const r = await fetch('https://www.linkedin.com/voyager/api/me', {
          headers: { 'accept': 'application/json', 'csrf-token': token, 'x-restli-protocol-version': '2.0.0' },
          credentials: 'include',
        });
        if (!r.ok) return null;
        const j = await r.json();
        const mp = j && j.miniProfile;
        if (!mp) return null;
        const name = ((mp.firstName || '') + ' ' + (mp.lastName || '')).replace(/\s+/g, ' ').trim();
        const profileUrl = mp.publicIdentifier ? ('https://www.linkedin.com/in/' + mp.publicIdentifier + '/') : '';
        return { name, profileUrl };
      } catch { return null; }
    });
    if (viaApi && (viaApi.name || viaApi.profileUrl)) {
      log(`  ⓘ self-identity via Voyager /me: ${viaApi.name || '(no name)'}`);
      return viaApi;
    }
  } catch { /* fall through to the nav scrape */ }

  // 2) Fallback: global-nav scrape (v2.103.1). Works when there's a photo and a
  // hydrated nav; the Voyager path above covers the cases where it doesn't.
  try {
    await page.waitForFunction(() => {
      const img = document.querySelector('img.global-nav__me-photo, .global-nav__me img');
      const me = document.querySelector('.global-nav__me');
      const link = me ? me.querySelector('a[href*="/in/"]') : null;
      return !!((img && (img.alt || '').trim()) || (link && link.href));
    }, { timeout: 10000 }).catch(() => { /* fall through — read what's there */ });
    const viaNav = await page.evaluate(() => {
      const out = { name: '', profileUrl: '' };
      const meImg = document.querySelector('img.global-nav__me-photo, .global-nav__me img');
      if (meImg && meImg.alt) out.name = meImg.alt.replace(/\s+/g, ' ').trim();
      // Scope the profile link to the Me control only — querying the whole
      // document would match a sidebar "people you may know" link first.
      const me = document.querySelector('.global-nav__me');
      const link = me ? me.querySelector('a[href*="/in/"]') : null;
      if (link) out.profileUrl = link.href;
      return out;
    });
    if (viaNav.name || viaNav.profileUrl) log(`  ⓘ self-identity via nav scrape: ${viaNav.name || '(no name)'}`);
    else log('  ⚠ self-identity: both Voyager /me and the nav scrape came back empty');
    return viaNav;
  } catch {
    return { name: '', profileUrl: '' };
  }
}

/**
 * On the LOCAL browser (= the primary), accept ONLY the invitation matching
 * `target`. If none matches, accept nothing.
 * @returns {Promise<{accepted:boolean, reason:string}>}
 */
export async function acceptInvitationFrom(page, target, { log = () => {} } = {}) {
  await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/received/', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  // Wait for the received list to actually render an Accept button (the cards
  // load async), or 12s if the list is genuinely empty. The cards use hashed
  // CSS classes, so we anchor on the language-stem Accept label instead.
  await page.waitForFunction(
    (acc, ign) => {
      const isAcc = (s) => {
        s = (s || '').toLowerCase();
        if (!s) return false;
        if (ign.some((v) => s.includes(v))) return false;
        return acc.some((v) => s.includes(v));
      };
      return Array.from(document.querySelectorAll('button'))
        .some((b) => isAcc(b.getAttribute('aria-label') || b.textContent || ''));
    },
    { timeout: 12000 },
    ACCEPT_STEMS, IGNORE_STEMS,
  ).catch(() => { /* empty list / slow — fall through and scrape what's there */ });
  await new Promise((r) => setTimeout(r, 1500));

  // Build candidates by walking each Accept button up to its card's profile
  // link — class-independent. Each candidate ties a sender identity to its own
  // Accept button.
  const candidates = await page.evaluate((acc, ign) => {
    const isAcc = (s) => {
      s = (s || '').toLowerCase();
      if (!s) return false;
      if (ign.some((v) => s.includes(v))) return false;
      return acc.some((v) => s.includes(v));
    };
    const out = [];
    for (const btn of Array.from(document.querySelectorAll('button'))) {
      if (!isAcc(btn.getAttribute('aria-label') || btn.textContent || '')) continue;
      let el = btn, link = null;
      for (let k = 0; k < 10 && el; k++) {
        el = el.parentElement;
        if (!el) break;
        link = el.querySelector('a[href*="/in/"]');
        if (link) break;
      }
      if (!link) continue; // an Accept-like button with no profile card — skip
      const nameEl = el.querySelector('a[href*="/in/"] strong') || link;
      out.push({
        name: (nameEl.textContent || '').replace(/\s+/g, ' ').trim(),
        profileUrl: link.href || '',
      });
    }
    return out;
  }, ACCEPT_STEMS, IGNORE_STEMS);

  const { index, reason } = pickInvitation(candidates, target);
  if (index == null) {
    log(`  ⚠ Auto-accept: no pending invitation matches ${target?.name || 'the account'} (${reason}; ${candidates.length} pending) — accepting nothing.`);
    return { accepted: false, reason };
  }

  // Click by IDENTITY: re-find the matched person's Accept button inside the
  // same evaluate (same anchor logic) so a SPA re-render can never land us on a
  // different card, and so we click ONLY that person's Accept (never Ignore).
  const matched = candidates[index];
  const clicked = await page.evaluate((want, acc, ign) => {
    const isAcc = (s) => {
      s = (s || '').toLowerCase();
      if (!s) return false;
      if (ign.some((v) => s.includes(v))) return false;
      return acc.some((v) => s.includes(v));
    };
    const slug = (u) => { const m = String(u || '').match(/\/in\/([^/?#]+)/i); return m ? m[1].toLowerCase() : ''; };
    const wantSlug = slug(want.profileUrl);
    const wantName = (want.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    for (const btn of Array.from(document.querySelectorAll('button'))) {
      if (!isAcc(btn.getAttribute('aria-label') || btn.textContent || '')) continue;
      let el = btn, link = null;
      for (let k = 0; k < 10 && el; k++) {
        el = el.parentElement;
        if (!el) break;
        link = el.querySelector('a[href*="/in/"]');
        if (link) break;
      }
      if (!link) continue;
      const nameEl = el.querySelector('a[href*="/in/"] strong') || link;
      const rn = (nameEl.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if ((wantSlug && slug(link.href) === wantSlug) || (wantName && rn === wantName)) {
        btn.click();
        return true;
      }
    }
    return false;
  }, matched, ACCEPT_STEMS, IGNORE_STEMS);

  if (!clicked) return { accepted: false, reason: 'matched-row-not-found-at-click' };
  await new Promise((r) => setTimeout(r, 1500));

  // Some invitations (cold / high-mutual) trigger a "Take care when connecting"
  // confirmation modal AFTER the card Accept — the invite is NOT actually
  // accepted until its "Accept invite" button is clicked. The modal doesn't
  // always appear, so this is best-effort: look for a dialog, click its
  // accept-stem button (scoped to the dialog, never "View profile" or the X),
  // then settle. Reuses the same locale-aware accept-stem logic as the card.
  try {
    const confirmed = await page.evaluate((acc, ign) => {
      const isAcc = (s) => {
        s = (s || '').toLowerCase();
        if (!s) return false;
        if (ign.some((v) => s.includes(v))) return false;
        return acc.some((v) => s.includes(v));
      };
      // v2.105.3: the current "Take care when connecting" modal is a NATIVE
      // <dialog data-testid="dialog"> (hashed classes, no explicit role attr),
      // so the old '[role="dialog"], .artdeco-modal' selector never matched it
      // and the confirm "Accept invite" button was never clicked — the invite
      // stayed un-accepted. Match the native dialog + the SDUI confirm screen.
      const dialog = document.querySelector(
        'dialog[open], [data-testid="dialog"], [data-sdui-screen*="AcceptConfirmationDialog"], [role="dialog"], .artdeco-modal'
      );
      if (!dialog) return false;
      for (const btn of Array.from(dialog.querySelectorAll('button'))) {
        if (isAcc(btn.getAttribute('aria-label') || btn.textContent || '')) { btn.click(); return true; }
      }
      return false;
    }, ACCEPT_STEMS, IGNORE_STEMS).catch(() => false);
    if (confirmed) {
      await new Promise((r) => setTimeout(r, 1200));
      log(`  ✓ Auto-accept: confirmed via "Take care when connecting" for ${target?.name || 'the account'}.`);
    }
  } catch { /* no modal / already accepted — fine */ }

  log(`  ✓ Auto-accept: accepted the invitation from ${target?.name || 'the account'} (${reason}).`);
  return { accepted: true, reason };
}

/**
 * Confirm the "Take care when connecting" dialog if it appeared after clicking a
 * card's Accept. Clicks ONLY the dialog's accept-stem button (never "View
 * profile"/"Ignore"/the X). Best-effort → returns whether it confirmed.
 *
 * Intentionally MIRRORS the inline block in acceptInvitationFrom (kept separate
 * so the verified single-account accept path stays byte-for-byte unchanged); the
 * accept-all sweep below is the only caller.
 */
async function _confirmAcceptDialog(page) {
  try {
    const confirmed = await page.evaluate((acc, ign) => {
      const isAcc = (s) => {
        s = (s || '').toLowerCase();
        if (!s) return false;
        if (ign.some((v) => s.includes(v))) return false;
        return acc.some((v) => s.includes(v));
      };
      const dialog = document.querySelector(
        'dialog[open], [data-testid="dialog"], [data-sdui-screen*="AcceptConfirmationDialog"], [role="dialog"], .artdeco-modal'
      );
      if (!dialog) return false;
      for (const btn of Array.from(dialog.querySelectorAll('button'))) {
        if (isAcc(btn.getAttribute('aria-label') || btn.textContent || '')) { btn.click(); return true; }
      }
      return false;
    }, ACCEPT_STEMS, IGNORE_STEMS).catch(() => false);
    if (confirmed) await new Promise((r) => setTimeout(r, 1200));
    return confirmed;
  } catch { return false; }
}

/**
 * Accept-all sweep (opt-in, default OFF — driven by the per-campaign
 * "Accept all pending invitations" toggle). On the primary's browser, accept
 * EVERY pending received invitation — campaign sender OR stranger. Unlike
 * acceptInvitationFrom (precise, single target), this is deliberately
 * indiscriminate, which is why it ships behind an explicit operator opt-in.
 *
 * Bounded by maxAccepts AND maxMs so a huge inbox can't stall pre-flight, and by
 * a stall guard so a card that refuses to clear can't spin the loop. Best-effort,
 * DOM-dependent (hashed CSS classes → anchored on the locale-aware accept stem),
 * verified manually against LinkedIn. Returns the count cleared.
 */
export async function acceptAllPendingInvitations(page, { log = () => {}, maxAccepts = 100, maxMs = 90_000 } = {}) {
  await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/received/', {
    waitUntil: 'domcontentloaded', timeout: 45000,
  });
  // Wait for at least one Accept button to render (or 12s if the list is empty).
  await page.waitForFunction(
    (acc, ign) => {
      const isAcc = (s) => {
        s = (s || '').toLowerCase();
        if (!s) return false;
        if (ign.some((v) => s.includes(v))) return false;
        return acc.some((v) => s.includes(v));
      };
      return Array.from(document.querySelectorAll('button'))
        .some((b) => isAcc(b.getAttribute('aria-label') || b.textContent || ''));
    },
    { timeout: 12000 },
    ACCEPT_STEMS, IGNORE_STEMS,
  ).catch(() => { /* empty list / slow — counts as 0 below */ });
  await new Promise((r) => setTimeout(r, 1500));

  const countAccepts = () => page.evaluate((acc, ign) => {
    const isAcc = (s) => {
      s = (s || '').toLowerCase();
      if (!s) return false;
      if (ign.some((v) => s.includes(v))) return false;
      return acc.some((v) => s.includes(v));
    };
    return Array.from(document.querySelectorAll('button'))
      .filter((b) => isAcc(b.getAttribute('aria-label') || b.textContent || '')).length;
  }, ACCEPT_STEMS, IGNORE_STEMS);

  let cleared = 0, stall = 0;
  const startedAt = Date.now();
  while (cleared < maxAccepts && (Date.now() - startedAt) < maxMs) {
    const before = await countAccepts();
    if (before === 0) break;
    const clicked = await page.evaluate((acc, ign) => {
      const isAcc = (s) => {
        s = (s || '').toLowerCase();
        if (!s) return false;
        if (ign.some((v) => s.includes(v))) return false;
        return acc.some((v) => s.includes(v));
      };
      const btn = Array.from(document.querySelectorAll('button'))
        .find((b) => isAcc(b.getAttribute('aria-label') || b.textContent || ''));
      if (!btn) return false;
      btn.click();
      return true;
    }, ACCEPT_STEMS, IGNORE_STEMS);
    if (!clicked) break;
    await new Promise((r) => setTimeout(r, 1200));
    await _confirmAcceptDialog(page);
    await new Promise((r) => setTimeout(r, 800));
    const after = await countAccepts();
    if (after < before) { cleared += (before - after); stall = 0; }
    else if (++stall >= 3) { log('  ⓘ Accept-all: a pending card would not clear — stopping the sweep.'); break; }
  }
  if (cleared) log(`  ✓ Accept-all: accepted ${cleared} pending invitation(s) on the primary.`);
  else log('  ⓘ Accept-all: no additional pending invitations to accept.');
  return cleared;
}
