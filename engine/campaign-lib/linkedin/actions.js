/**
 * LinkedIn actions — v18.
 *
 * CORE PRINCIPLE: Every click uses element.click() via page.evaluate().
 * NEVER page.mouse.click(x, y).
 *
 * This means:
 * - No coordinate calculations
 * - No viewport size dependencies
 * - No zoom dependencies
 * - Works whether element is visible, off-screen, or in Shadow DOM
 *
 * Shadow DOM buttons are reached via:
 *   document.getElementById('interop-outlet').shadowRoot.querySelector(...)
 */

import { randomDelay, clickByAria, clickByText, isNoteOverFreeLimit } from './helpers.js';

// Matches Sales Navigator profile URLs (/sales/people/… or /sales/lead/…).
// Kept in sync with the identical constant in outreach.js — duplication here
// is deliberate (avoids cross-coupling the two files for a 1-line regex).
const SALES_NAV_URL_RE = /\/sales\/(people|lead)\//;

// ─────────────────────────────────────────────────────────────────────────────
// Detect modal — checks both regular DOM and Shadow DOM
// ─────────────────────────────────────────────────────────────────────────────

// v2.112.32 — free LinkedIn accounts have a monthly cap on personalized (noted)
// invites. When it's exhausted, clicking "Add a note" shows a Premium upsell
// ("You're out of free custom notes" / "Send unlimited personalized invites with
// Premium") INSTEAD of the note field, so a noted invite can't be sent. Pure +
// tested; the in-browser detectModal mirrors this check. Distinct from the
// weekly INVITATION cap (hasWeeklyLimit), which blocks invites of any kind.
export function isNoteLimitModalText(text) {
  const t = String(text || '').toLowerCase();
  return t.includes('out of free custom notes')
      || t.includes('send unlimited personalized invites');
}

async function detectModal(page) {
  return page.evaluate(() => {
    // Collect buttons from regular DOM + ALL Shadow DOM roots
    const buttons = Array.from(document.querySelectorAll('button'));
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) buttons.push(...Array.from(el.shadowRoot.querySelectorAll('button')));
    });

    const findByAria = (label) => buttons.find(b =>
      (b.getAttribute('aria-label') || '').toLowerCase() === label.toLowerCase()
    );
    const findByText = (text) => buttons.find(b =>
      b.textContent?.trim().toLowerCase() === text.toLowerCase()
    );

    const sendWithout = findByAria('Send without a note') || findByText('Send without a note');
    const addNote = findByAria('Add a note') || findByText('Add a note');
    const send = findByAria('Send') || findByText('Send') || findByText('send invitation');
    const withdraw = findByText('withdraw');

    // Gather all visible text (regular + all shadow DOMs)
    let pageText = (document.body?.innerText || '').substring(0, 5000).toLowerCase();
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) pageText += (el.shadowRoot.textContent || '').substring(0, 3000).toLowerCase();
    });

    const hasHowDoYouKnow = pageText.includes('how do you know');

    // Weekly/invitation limit detection — matches both modal text and inline banner text
    // Banner says: "weekly limit for connection invitations"
    // Modal says: "weekly invitation limit"
    const hasWeeklyLimit = pageText.includes('weekly invitation limit') ||
                           pageText.includes('weekly limit for connection') ||
                           pageText.includes('invitation was not sent') ||
                           pageText.includes("you've reached") ||
                           pageText.includes('reached the weekly limit') ||
                           pageText.includes('invitation limit') ||
                           pageText.includes('too many pending') ||
                           pageText.includes('try again next week');

    // Email required to connect
    const hasEmailRequired = pageText.includes('enter their email') ||
                             pageText.includes('verify this member knows you') ||
                             pageText.includes('email address to connect');

    // v2.112.32 — "out of free custom notes" Premium upsell (mirrors the tested
    // isNoteLimitModalText). Shown when the monthly noted-invite cap is hit, so a
    // note can't be added. Distinct from the weekly invitation cap above.
    const hasNoteLimit = pageText.includes('out of free custom notes') ||
                         pageText.includes('send unlimited personalized invites');

    const found = !!(sendWithout || addNote || send || withdraw || hasHowDoYouKnow || hasWeeklyLimit || hasEmailRequired || hasNoteLimit);

    return {
      found,
      hasAddNote: !!addNote,
      hasSendWithout: !!sendWithout,
      hasSend: !!send,
      hasWithdraw: !!withdraw,
      hasHowDoYouKnow,
      hasWeeklyLimit,
      hasEmailRequired,
      hasNoteLimit,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if Pending
// ─────────────────────────────────────────────────────────────────────────────

async function isPending(page) {
  // Step 1: Check for Pending as a visible button in the profile's action bar
  // ONLY check buttons and actionable elements — NOT divs/spans (too many false positives)
  const directPending = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const profileName = h1 ? h1.textContent.trim().split('\n')[0].trim().toLowerCase() : '';
    const firstName = profileName.split(/\s+/)[0] || '';

    // Find the "More" button to locate the action bar
    const moreBtn = Array.from(document.querySelectorAll('button')).find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      return a === 'more actions' || a === 'more' || t === 'more';
    });

    // Scope: only check buttons in the action bar area (same parent as More button)
    const actionBar = moreBtn ? (moreBtn.closest('div, section, ul') || moreBtn.parentElement) : null;
    const searchAreas = actionBar ? [actionBar] : [];
    // Also check the h1's parent section
    if (h1) {
      const h1Section = h1.closest('main, section, [class*="top-card"]');
      if (h1Section && !searchAreas.includes(h1Section)) searchAreas.push(h1Section);
    }

    for (const area of searchAreas) {
      const buttons = Array.from(area.querySelectorAll('button, a, [role="button"]'));
      for (const b of buttons) {
        const t = (b.textContent || '').trim().toLowerCase();
        const a = (b.getAttribute('aria-label') || '').toLowerCase();

        if (a.includes('pending')) {
          if (firstName && !a.includes(firstName)) continue;
          return 'aria-scoped';
        }
        if (t === 'pending' && b.offsetWidth > 0) {
          return 'text-scoped';
        }
      }
    }
    return null;
  });

  if (directPending) return true;

  // Step 2: Open the "More" dropdown and check for "Pending" inside it
  const morePending = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const more = buttons.find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      return a === 'more actions' || a === 'more' || t === 'more';
    });
    if (more) { more.click(); return true; }
    return false;
  });

  if (!morePending) return false;

  await new Promise(r => setTimeout(r, 2000));

  const pendingInDropdown = await page.evaluate(() => {
    // Only check dropdown-specific elements
    const items = Array.from(document.querySelectorAll('li, [role="menuitem"], .artdeco-dropdown__item'));
    for (const el of items) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'pending') return true;
      const a = (el.getAttribute('aria-label') || '').toLowerCase();
      if (a.includes('pending')) return true;
    }
    return false;
  });

  // Close the dropdown
  await page.evaluate(() => document.body.click());
  await new Promise(r => setTimeout(r, 500));

  return pendingInDropdown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Voyager invitation-creation network listener (v2.10.0 — Approach A)
//
// Registers a page.on('response') hook that captures LinkedIn's own backend
// response to the invitation POST. This is the gold-standard signal — it
// bypasses toast races, profile-reload latency, and DOM selector drift.
//
// URL pattern matches both with-note and without-note sends; the decoration
// `InvitationCreationResult` is shared across all variants.
//
// On 2xx → ok=true with invitationUrn extracted from data.value.invitationUrn.
// On 4xx → ok=false with status + body parsed for finer-grained skip reason.
// ─────────────────────────────────────────────────────────────────────────────

const VOYAGER_INVITATION_RE = /voyagerRelationshipsDashMemberRelationships.*InvitationCreationResult/i;

function attachVoyagerInvitationCapture(page) {
  const captured = { fired: false, ok: null, status: null, urn: null, errorMessage: null };
  const waiters = [];

  const listener = async (response) => {
    try {
      if (!VOYAGER_INVITATION_RE.test(response.url())) return;
      const status = response.status();
      let body = null;
      try { body = await response.json(); } catch { /* may not be JSON */ }

      const ok = status >= 200 && status < 300;
      const urn = body?.data?.value?.invitationUrn || body?.data?.invitationUrn || null;
      const errorMessage = ok
        ? null
        : (body?.message || body?.errorDetails?.message || body?.errorMessage || `HTTP ${status}`);

      captured.fired = true;
      captured.ok = ok;
      captured.status = status;
      captured.urn = urn;
      captured.errorMessage = errorMessage;

      const result = { ok, status, urn, errorMessage };
      const ws = waiters.splice(0);
      for (const w of ws) w(result);
    } catch (e) {
      console.warn(`[voyager-capture] listener error: ${e.message}`);
    }
  };

  page.on('response', listener);

  return {
    waitFor(timeoutMs) {
      if (captured.fired) {
        return Promise.resolve({
          ok: captured.ok,
          status: captured.status,
          urn: captured.urn,
          errorMessage: captured.errorMessage,
        });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(onFire);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        const onFire = (result) => { clearTimeout(timer); resolve(result); };
        waiters.push(onFire);
      });
    },
    fired() { return captured.fired; },
    detach() {
      try { page.off('response', listener); } catch { /* page may be closed */ }
      const ws = waiters.splice(0);
      for (const w of ws) w(null);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Type into message/note field
// ─────────────────────────────────────────────────────────────────────────────

async function typeIntoField(page, text) {
  // Order matters: most-specific message/note selectors first. Otherwise the
  // generic `div[contenteditable="true"]` can match LinkedIn's top-nav search
  // bar (also contenteditable) and silently type into it.
  // For message composers specifically, if multiple are present we take the
  // LAST one (most recently mounted) — LinkedIn appends new bubbles to the
  // end of `.msg-overlay-list-bubble`, and the most recent is the current lead.
  const SELECTORS = [
    // Connect-note modal
    'textarea[name="message"]', 'textarea#custom-message',
    // Message composer (Quill editor) — scoped to the form container
    '.msg-form__contenteditable',
    '.msg-form__msg-content-container div[contenteditable="true"]',
    '.msg-form div[contenteditable="true"]',
    'div[aria-label*="Write a message"]',
    'div[aria-label*="Add a note"]',
    // InMail / other dialogs
    'div[role="dialog"] textarea',
    'div[role="dialog"] div[contenteditable="true"]',
    // Generic textarea fallback
    'textarea',
  ];
  // Selectors for which we should pick the LAST match (most recently mounted).
  const PICK_LAST_SELECTORS = new Set([
    '.msg-form__contenteditable',
    '.msg-form__msg-content-container div[contenteditable="true"]',
    '.msg-form div[contenteditable="true"]',
    'div[aria-label*="Write a message"]',
  ]);

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Inject value directly using React's native setter so the synthetic
    // onChange fires and LinkedIn's controlled component accepts it.
    const injected = await page.evaluate((selectors, pickLastSelectors, value) => {
      const pickLast = new Set(pickLastSelectors);
      const findField = (root) => {
        for (const sel of selectors) {
          if (pickLast.has(sel)) {
            const all = root.querySelectorAll(sel);
            if (all.length) return all[all.length - 1];
          } else {
            const el = root.querySelector(sel);
            if (el) return el;
          }
        }
        return null;
      };

      let el = findField(document);
      if (!el) {
        const hosts = Array.from(document.querySelectorAll('*')).filter(x => x.shadowRoot);
        for (const host of hosts) {
          el = findField(host.shadowRoot);
          if (el) break;
        }
      }
      if (!el) {
        // v2.112.33 DIAGNOSTIC (temporary): capture what's ACTUALLY on screen when
        // the note field isn't found — dialog text, buttons, editable fields, and
        // iframe presence (the out-of-notes Premium upsell may render in an iframe,
        // which would explain why both the field AND the text scan miss it).
        const dump = { dialogs: [], fields: [], iframes: 0, bodyHasNoteText: false };
        dump.iframes = document.querySelectorAll('iframe').length;
        const bodyText = (document.body?.innerText || '').toLowerCase();
        dump.bodyHasNoteText = bodyText.includes('out of free custom notes') || bodyText.includes('personalized invites') || bodyText.includes('premium');
        for (const d of document.querySelectorAll('[role="dialog"], .artdeco-modal, [data-test-modal]')) {
          const r = d.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const btns = [];
          for (const b of d.querySelectorAll('button')) {
            btns.push((b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 36));
            if (btns.length >= 14) break;
          }
          dump.dialogs.push({ text: (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 320), iframes: d.querySelectorAll('iframe').length, buttons: btns });
          if (dump.dialogs.length >= 4) break;
        }
        for (const f of document.querySelectorAll('textarea, input, [contenteditable="true"], [role="textbox"]')) {
          const r = f.getBoundingClientRect();
          dump.fields.push({ tag: f.tagName, id: f.id || '', name: f.getAttribute('name') || '', aria: f.getAttribute('aria-label') || '', ce: f.getAttribute('contenteditable') || '', vis: r.width > 0 && r.height > 0 });
          if (dump.fields.length >= 15) break;
        }
        return { ok: false, reason: 'field-not-found', dump };
      }

      el.focus();

      const isTextarea = el.tagName === 'TEXTAREA';
      const isInput = el.tagName === 'INPUT';

      if (isTextarea || isInput) {
        const proto = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        nativeSetter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // contenteditable path — LinkedIn's message composer is a Quill
        // editor. Quill maintains its own document model and listens for
        // `paste` events via its Clipboard module, so dispatching a real
        // ClipboardEvent with a DataTransfer is the most reliable way to
        // populate it.
        // 2.8.34: trust the paste; the outer post-400ms verification
        // re-tries on mismatch. The previous synchronous lengthRatio check
        // raced Quill's async render and forced an execCommand fallback that
        // overwrote the in-flight paste, leaving a malformed editor.
        el.focus();
        // Select + delete any existing content
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false);
        } catch { /* */ }

        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', value);
          const pasteEvent = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(pasteEvent);
        } catch { /* */ }

        // 2.8.45: dispatch InputEvent so React's onChange fires. Without this,
        // LinkedIn's React state thinks the composer is empty and keeps the
        // Send button disabled even though the text is visible. Mirrors what
        // the LinkedIn DM Assistant extension does after paste.
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            inputType: 'insertText',
            data: value,
          }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch { /* */ }
      }

      const got = isTextarea || isInput ? el.value : (el.textContent || el.innerText || '');
      return { ok: true, got };
    }, SELECTORS, [...PICK_LAST_SELECTORS], text);

    if (!injected.ok) {
      console.warn(`[actions] Field not found on attempt ${attempt}: ${injected.reason}`);
      if (injected.dump) console.warn(`[actions] NOTE-FIELD DEBUG: ${JSON.stringify(injected.dump)}`);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    await new Promise(r => setTimeout(r, 400));

    // Read back authoritative content after React re-render
    const fieldContent = await page.evaluate((selectors, pickLastSelectors) => {
      const pickLast = new Set(pickLastSelectors);
      const findField = (root) => {
        for (const sel of selectors) {
          if (pickLast.has(sel)) {
            const all = root.querySelectorAll(sel);
            if (all.length) return all[all.length - 1];
          } else {
            const el = root.querySelector(sel);
            if (el) return el;
          }
        }
        return null;
      };
      let el = findField(document);
      if (!el) {
        const hosts = Array.from(document.querySelectorAll('*')).filter(x => x.shadowRoot);
        for (const host of hosts) {
          el = findField(host.shadowRoot);
          if (el) break;
        }
      }
      if (!el) return '';
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
      // 2.8.35: prefer innerText over textContent for contenteditable. Quill
      // renders multi-line as <p>line</p><p>line</p>; textContent strips the
      // tags AND the implicit newlines between blocks ("line1line2"), but
      // innerText respects block layout and emits "line1\nline2". Without
      // this the verification below fails on every multi-line template,
      // returning false and leaving the message un-sent in the composer.
      return el.innerText || el.textContent || '';
    }, SELECTORS, [...PICK_LAST_SELECTORS]);

    // Verification: strict equality for textareas (connect-note modal),
    // whitespace-normalized match for contenteditable (Quill message composer,
    // which wraps content in <p> tags and collapses newlines in textContent).
    const expected = text.replace(/\r\n/g, '\n');
    const got = fieldContent.replace(/\r\n/g, '\n');
    const normalize = s => s.replace(/\s+/g, ' ').trim();
    // 2.8.35: third compare — strip ALL whitespace. Belt-and-suspenders for
    // edge cases where Quill emits a different whitespace pattern than the
    // template (e.g. drops a blank line between paragraphs).
    const stripWs = s => s.replace(/\s+/g, '');

    if (
      got === expected ||
      normalize(got) === normalize(expected) ||
      stripWs(got) === stripWs(expected)
    ) {
      if (attempt > 1) console.log(`[actions] Note verified on attempt ${attempt}.`);
      return true;
    }

    console.warn(
      `[actions] Note mismatch (attempt ${attempt}/${MAX_ATTEMPTS}). ` +
      `Expected ${expected.length} chars, got ${got.length}. ` +
      `Expected head: "${expected.substring(0, 60)}…" Got head: "${got.substring(0, 60)}…"`
    );

    // 2.8.34: keyboard.type fallback removed. Prior runs showed the typing
    // path producing visible mistakes (Quill mid-render fights with synthetic
    // keystrokes). Paste-only is safer: if all paste attempts fail, return
    // false and let the caller surface the error rather than typing.
  }

  console.error('[actions] Failed to type note correctly after all attempts. Will NOT send.');
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Click Connect from More dropdown — ALL via JS click
// ─────────────────────────────────────────────────────────────────────────────

async function clickConnectFromMore(page) {
  console.log('[actions] Opening profile More dropdown…');

  // v2.14.x: Bug 1 fix — anchor the More-button search to the profile
  // top-card region. Previously this was a global document scan that
  // matched the NAV BAR "More" button (For Business / Premium menu)
  // because it appears earlier in DOM order than the profile's "..."
  // button. The bot then opened the nav menu and looked for "Connect"
  // inside it — never found, retry loop burned 30s, lead failed.
  // Repro: /tmp/dev-app.log @ 2026-05-15T21:01 (pravin-bisen).
  // Aria-label variants from the QuickConnect extension's findProfileActionButton.
  const moreClicked = await page.evaluate(() => {
    const h1 = document.querySelector('main h1');
    const topCard = h1?.closest(
      '.pv-top-card, .pv-profile-card, .ph5.pb5, section.artdeco-card, section, article'
    );
    const root = topCard || document.querySelector('main');
    if (!root) return false;

    const isSidebarOrSuggestion = (el) => !!el.closest([
      'aside',
      '[role="complementary"]',
      '.scaffold-layout__aside',
      '.scaffold-layout__sidebar',
      '[aria-label*="People also viewed"]',
      '[aria-label*="People you may know"]',
      '[aria-label*="Similar profiles"]',
      '[aria-label*="More profiles for you"]',
      '[aria-label*="Other profiles viewed"]',
    ].join(','));

    const buttons = Array.from(root.querySelectorAll('button'));
    const more = buttons.find((b) => {
      if (isSidebarOrSuggestion(b)) return false;
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      return a === 'more actions' || a === 'more' || a === 'more options'
          || a === 'see more actions' || t === 'more' || t === '…' || t === '...';
    });
    if (more) { more.click(); return true; }
    return false;
  });

  if (!moreClicked) {
    console.log('[actions] Profile More button not found in top-card region.');
    return false;
  }

  // Step 2: Wait 5 seconds for dropdown to fully render
  console.log('[actions] More clicked. Waiting 5s for dropdown…');
  await new Promise(r => setTimeout(r, 5000));

  // Step 3: Inspect dropdown for Connect OR Pending. Return one of:
  //   'connect'  → Connect item found and clicked
  //   'pending'  → Pending item found (invitation already sent — caller
  //                should treat this as 'already_processed', NOT retry)
  //   null       → neither found
  //
  // v2.14.x Bug 2 fix: previously this only scanned for "Connect" text.
  // For 3rd-degree profiles where the operator already sent a connection,
  // the menu shows "Pending" where "Connect" used to be (per the
  // 2026-05-15 screenshot for pravin-bisen). Without this detection the
  // retry loop times out → misleading "Connect button not found" skip.
  const menuResult = await page.evaluate(() => {
    const selectors = 'li, [role="menuitem"], [role="option"], .artdeco-dropdown__item';

    const matchText = (root) => {
      const items = Array.from(root.querySelectorAll(selectors));
      for (const el of items) {
        const text = (el.textContent || '').trim();
        if (text === 'Connect') { el.click(); return 'connect'; }
        // Pending detection — exact "Pending" item, accounts for case
        // where the menu spans wrap text and contain only the word.
        if (text === 'Pending') return 'pending';
      }
      return null;
    };

    let r = matchText(document);
    if (r) return r;

    // Try spans inside the visible dropdown container only
    const dropdowns = document.querySelectorAll('.artdeco-dropdown__content, [role="menu"], .artdeco-dropdown__content--is-open');
    for (const dropdown of dropdowns) {
      if (!dropdown.offsetWidth) continue;
      const spans = dropdown.querySelectorAll('span, div, a');
      for (const el of spans) {
        const text = (el.textContent || '').trim();
        if (text === 'Connect' && el.offsetWidth > 0) {
          const parent = el.closest('li') || el.closest('[role="menuitem"]') || el;
          parent.click();
          return 'connect';
        }
        if (text === 'Pending' && el.offsetWidth > 0) {
          return 'pending';
        }
      }
    }

    // Shadow DOM dropdown
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.shadowRoot) {
      const r2 = matchText(outlet.shadowRoot);
      if (r2) return r2;
    }

    return null;
  });

  if (menuResult === 'connect') {
    console.log('[actions] ✓ Connect clicked from profile dropdown.');
    return 'connect';
  }
  if (menuResult === 'pending') {
    console.log('[actions] ⏳ Pending item found in profile dropdown — invitation already sent to this lead.');
    // Close dropdown
    await page.evaluate(() => document.body.click());
    return 'pending';
  }

  // Debug: log what IS in the dropdown
  const dropdownItems = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('li, [role="menuitem"]'))
      .map(el => el.textContent?.trim())
      .filter(t => t && t.length < 50)
      .slice(0, 10);
  });
  console.log('[actions] Dropdown items found:', JSON.stringify(dropdownItems));

  // Close dropdown
  await page.evaluate(() => document.body.click());
  console.log('[actions] Neither Connect nor Pending in profile dropdown.');
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// sendConnectionRequest
// ═════════════════════════════════════════════════════════════════════════════

export async function sendConnectionRequest(page, noteArg) {
  let note = noteArg;
  // v2.10.0 (Approach A): register the Voyager invitation-create listener before
  // any user interaction. Captures LinkedIn's own backend response, which is the
  // definitive signal that an invitation actually landed (or was rejected).
  const voyagerCapture = attachVoyagerInvitationCapture(page);
  try {
  // Scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await randomDelay(300, 500);

  let connectClicked = false;

  // Retry loop: keep looking for Connect button for up to 30 seconds
  // Accounts for slow page loads and lazy-rendered elements
  const MAX_WAIT_MS = 30000;
  const POLL_INTERVAL_MS = 3000;
  const startTime = Date.now();

  while (!connectClicked && (Date.now() - startTime) < MAX_WAIT_MS) {
    const direct = await page.evaluate(() => {
      // Lead identity comes from the TOP CARD, not document.querySelector('h1').
      // The first <h1> on a LinkedIn profile can be a hidden/nav heading → empty
      // name → METHOD 1 silently skipped (the 2026-06-22 Choon regression: a
      // visible "Invite Choon Khee Koh to connect" was never clicked). `main h1`
      // is the profile owner's name.
      const main = document.querySelector('main');
      const nameEl = (main && main.querySelector('h1'))
                  || document.querySelector('h1.text-heading-xlarge')
                  || document.querySelector('h1');
      let leadName = nameEl ? (nameEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      if (!leadName) {
        // The profile <h1> can be empty (lazy paint / shadow DOM) — the
        // 2026-06-22 Choon case where her visible Connect was never clicked
        // because the name read "". Fall back to the page title (mirrors
        // leadNameFromTitle() in helpers.js + getConnectionStatus's rescue):
        // strip a "(3)" unread count and the " | LinkedIn" / " - headline" tail.
        leadName = (document.title || '').replace(/^\(\d+\)\s*/, '').split(/\s[|–-]\s/)[0].trim();
      }
      const nameTokens = leadName.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);

      // v2.113.x wrong-person guard. A profile page is full of OTHER people's
      // Connect buttons — the "People you may know" / "More profiles for you"
      // recommendation strips. Clicking one sends the lead's note to a stranger
      // (the 2026-06-22 Mary→Dr David Foo incident: a page-wide custom-invite
      // scan grabbed a recommendation). Reject anything inside such a container.
      const isSidebarOrSuggestion = (el) => !!el.closest([
        'aside',
        '[role="complementary"]',
        '.scaffold-layout__aside',
        '.scaffold-layout__sidebar',
        '[aria-label*="People also viewed"]',
        '[aria-label*="People you may know"]',
        '[aria-label*="Similar profiles"]',
        '[aria-label*="More profiles for you"]',
        '[aria-label*="Other profiles viewed"]',
      ].join(','));

      // Does an "Invite <name> to connect" label refer to THIS lead? Mirrors
      // inviteAriaMatchesLeadName() in helpers.js (unit-tested there) — keep in
      // sync. Requires the lead's FIRST and LAST name as whole words, so a
      // recommended "David Foo" can't satisfy a lead "David Smith".
      const ariaMatchesLead = (ariaLabel) => {
        const a = String(ariaLabel || '').toLowerCase();
        if (!a.includes('invite') || !a.includes('to connect')) return false;
        if (!nameTokens.length) return false;
        const hasWord = (t) => {
          const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          try { return new RegExp(`(^|\\P{L})${safe}(\\P{L}|$)`, 'u').test(a); }
          catch { return a.includes(t); }
        };
        const first = nameTokens[0];
        const last = nameTokens[nameTokens.length - 1];
        if (!hasWord(first)) return false;
        if (last !== first && !hasWord(last)) return false;
        return true;
      };

      // Top-card region = the lead's own action bar. Scopes METHODs 2 & 3 to the
      // profile owner so neither can reach a recommendation card.
      const topCard = nameEl?.closest(
        '.pv-top-card, .pv-profile-card, .ph5.pb5, section.artdeco-card, section, article'
      );

      // METHOD 1: aria-label "Invite [name] to connect" — name MUST match the
      // lead (first + last) AND the button must NOT live in a recommendation.
      if (nameTokens.length) {
        const allInvites = document.querySelectorAll('[aria-label*="Invite"][aria-label*="to connect"]');
        for (const el of allInvites) {
          if (isSidebarOrSuggestion(el)) continue;
          if (ariaMatchesLead(el.getAttribute('aria-label'))) {
            el.click();
            return { method: 'aria-invite-matched', name: leadName };
          }
        }
      }

      // METHOD 2: profile-owner custom-invite <a> link — MUST be inside the top
      // card, never a recommendation. If the link names someone, it has to be
      // the lead.
      if (topCard) {
        const links = Array.from(topCard.querySelectorAll('a'));
        topCard.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot) links.push(...Array.from(el.shadowRoot.querySelectorAll('a')));
        });
        for (const el of links) {
          if (isSidebarOrSuggestion(el)) continue;
          const href = el.getAttribute('href') || '';
          if (!href.includes('custom-invite')) continue;
          const aria = el.getAttribute('aria-label') || '';
          // Name guard only when we actually resolved a name; otherwise trust
          // the top-card scope (recommendations are never inside the top card).
          if (nameTokens.length && /invite/i.test(aria) && /to connect/i.test(aria) && !ariaMatchesLead(aria)) continue;
          el.click();
          return { method: 'custom-invite-link', name: leadName };
        }
      }

      // METHOD 3 (v2.14.x): DOM-anchored structural fallback within the top card,
      // sidebar-excluded. Catches a Connect CTA rendered without an "Invite … to
      // connect" aria-label (profile re-layouts / A/B variants). Less
      // bot-detectable approaches first; DOM walking only when those fail.
      const structuralRoot = topCard || main;
      if (structuralRoot) {
        const candidates = Array.from(
          structuralRoot.querySelectorAll('button, a[role="button"]')
        );
        for (const b of candidates) {
          if (isSidebarOrSuggestion(b)) continue;
          if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
          const rect = b.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const t = (b.textContent || '').trim().toLowerCase();
          const a = (b.getAttribute('aria-label') || '').toLowerCase();
          if (t === 'connect' || a === 'connect') {
            b.click();
            return { method: 'top-card-structural', name: leadName };
          }
        }
      }

      // NO OTHER FALLBACKS — if nothing matched, go to More dropdown (also
      // top-card anchored). A Follow lead with no own Connect ends here → its
      // own More→Connect, or skipped. Never mis-sent.
      return { method: null, name: leadName };
    });

    if (direct.method) {
      console.log(`[actions] ✓ Direct Connect button clicked (${direct.method}) — lead "${direct.name}".`);
      connectClicked = true;
      console.log('[actions] Waiting 5s for modal…');
      await new Promise(r => setTimeout(r, 5000));
      break;
    }

    // PRIORITY 2: Only try More dropdown if direct button wasn't found
    console.log(`[actions] No direct Connect for "${direct.name}" — trying More dropdown… (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
    const moreResult = await clickConnectFromMore(page);
    if (moreResult === 'connect') {
      connectClicked = true;
      console.log('[actions] Waiting 5s for modal…');
      await new Promise(r => setTimeout(r, 5000));
      break;
    }
    if (moreResult === 'pending') {
      // v2.14.x Bug 2 fix: Pending state was found in the profile More
      // dropdown — the invitation has already been sent to this lead.
      // Throw a specific error that outreach.js maps to
      // { action: 'already_processed' } so the row gets stamped Stage =
      // 'Connect Pending' / Connection Request Status = 'Connection
      // Request Sent' instead of the misleading "Connect button not
      // found" we used to emit.
      throw new Error('INVITATION_ALREADY_PENDING');
    }

    // Neither found — wait and retry
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[actions] Connect not found yet (${elapsed}s / 60s). Retrying in 5s…`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!connectClicked) {
    // 2.9.8: capture a diagnostic snapshot of what was actually visible on
    // the page when the finder timed out. Full snapshot goes to stdout
    // (campaign.log via npm pipe). The thrown Error gets a short summary
    // appended so the campaign log line itself shows the most useful
    // breadcrumbs (URL host, errorpg flag, button names).
    let summary = '';
    try {
      const snapshot = await page.evaluate(() => {
        const main = document.querySelector('main');
        const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'))
          .filter(b => b.offsetWidth > 0)
          .slice(0, 20)
          .map(b => ({
            t: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
            a: (b.getAttribute('aria-label') || '').slice(0, 50),
          }));
        return {
          url: window.location.href,
          mainCls: (main?.className || '').toString().slice(0, 80),
          hasEmailField: !!document.querySelector('input[type=email]'),
          hasErrorPg: /errorpg|error-page/i.test(main?.className || ''),
          buttons,
        };
      });
      console.error('[actions] Connect-not-found DIAGNOSTIC: ' + JSON.stringify(snapshot));
      const btnNames = (snapshot.buttons || [])
        .map(b => b.t || b.a)
        .filter(Boolean)
        .slice(0, 6)
        .join(' | ');
      const tags = [];
      if (snapshot.hasErrorPg) tags.push('errorpg');
      if (snapshot.hasEmailField) tags.push('emailField');
      summary = ` [${tags.join(',') || 'no-tags'}; visible: ${btnNames || 'none'}]`;
    } catch (e) {
      console.error(`[actions] Connect-not-found DIAGNOSTIC failed: ${e.message}`);
    }
    throw new Error('Connect button not found after 60s' + summary);
  }

  // ── Wait for modal, success toast, or Pending (8 attempts = ~24s max) ──
  for (let attempt = 1; attempt <= 8; attempt++) {
    // Check for "Invitation sent to X" green toast — definitive proof
    const successToast = await page.evaluate(() => {
      const toasts = document.querySelectorAll('.artdeco-toast-item, [data-test-artdeco-toast-item-type="success"]');
      for (const t of toasts) {
        const text = (t.textContent || '').toLowerCase();
        if (text.includes('invitation sent')) return text.trim().substring(0, 100);
      }
      return null;
    });
    if (successToast) {
      console.log(`[actions] ✓ Success toast: "${successToast}"`);
      return { invitationUrn: null };
    }

    // IMPORTANT: Check modal FIRST — if a modal is open, we MUST handle it.
    // Do NOT check isPending before modal, because isPending can false-positive
    // from recommendation Pending buttons while the modal is still open.
    const modal = await detectModal(page);
    if (modal.found) {
      // Modal is open — handle it below (fall through to modal handling code)
    } else {
      // No modal — safe to check Pending
      if (await isPending(page)) {
        console.log('[actions] ✓ Connection sent (Pending detected).');
        return { invitationUrn: null };
      }
    }

    // Check for inline weekly limit banner (appears instead of modal)
    const inlineBanner = await page.evaluate(() => {
      const text = (document.body?.innerText || '').substring(0, 5000).toLowerCase();
      if (text.includes('invitation was not sent') ||
          text.includes('weekly limit for connection') ||
          text.includes('reached the weekly limit') ||
          text.includes('try again next week')) {
        return true;
      }
      let shadowText = '';
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) shadowText += (el.shadowRoot.textContent || '').substring(0, 2000).toLowerCase();
      });
      return shadowText.includes('invitation was not sent') ||
             shadowText.includes('weekly limit') ||
             shadowText.includes('try again next week');
    });
    if (inlineBanner) {
      console.log('[actions] ⚠ Inline weekly limit banner detected on page.');
      throw new Error('WEEKLY_LIMIT');
    }

    // modal was already detected above — reuse it
    if (modal.found) {
      console.log(`[actions] Modal (attempt ${attempt}):`, JSON.stringify({
        addNote: modal.hasAddNote, sendWithout: modal.hasSendWithout,
        send: modal.hasSend, withdraw: modal.hasWithdraw,
      }));

      // v2.14.x: first-name cross-check between the modal's invitee name
      // and the profile owner's first name. Defends against the case
      // where METHOD 1/2/3 click a Connect button outside the profile's
      // top card (e.g. a sidebar suggestion whose firstName collides
      // with the lead). LinkedIn's invitation modal contains copy like
      // "Personalize your invitation to <Name>" / "Add a note to
      // <Name>'s invitation" — we extract <Name>, take its first token,
      // compare to the profile h1's first token. Mismatch → dismiss
      // the modal and throw so we never send to the wrong person.
      // Operator-chosen policy: first-name-only (lower false-positive
      // risk than full-name match). Skipped silently when the modal
      // doesn't expose a recognizable invitee name, or when h1 is
      // empty — no behaviour change from prior runs in those cases.
      const nameCheck = await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"], .artdeco-modal');
        let modalInvitee = '';
        for (const d of dialogs) {
          const r = d.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const text = d.innerText || '';
          const m = text.match(/invitation to ([^\n.]+?)(?: by adding| by | \.)/i)
                 || text.match(/Add a note to ([^\n.]+?)(?:'s invitation|\.|$)/im)
                 || text.match(/Personalize your invitation to ([^\n.]+?)(?:\b|\.)/i);
          if (m) { modalInvitee = m[1].trim(); break; }
        }
        const h1 = document.querySelector('main h1') || document.querySelector('h1');
        const profileName = h1
          ? h1.textContent.trim().split('\n')[0].trim().toLowerCase()
          : '';
        const profileFirst = profileName.split(/\s+/)[0] || '';
        const modalFirst = (modalInvitee || '').toLowerCase().split(/\s+/)[0] || '';
        return { modalInvitee, profileFirst, modalFirst };
      });
      if (nameCheck.modalFirst && nameCheck.profileFirst &&
          nameCheck.modalFirst !== nameCheck.profileFirst) {
        console.warn(`[actions] ⚠ Modal name mismatch — profile="${nameCheck.profileFirst}" modal="${nameCheck.modalFirst}" ("${nameCheck.modalInvitee}"). Dismissing modal and aborting.`);
        await clickByAria(page, 'Dismiss').catch(() => {});
        await clickByText(page, 'Cancel').catch(() => {});
        throw new Error(`CONNECT_MODAL_WRONG_PERSON: clicked Connect for wrong profile (modal opened for "${nameCheck.modalInvitee}", expected first-name "${nameCheck.profileFirst}")`);
      }
      if (nameCheck.modalFirst && nameCheck.profileFirst) {
        console.log(`[actions] ✓ Modal name check passed: ${nameCheck.modalFirst}`);
      }

      // Withdraw → already pending
      if (modal.hasWithdraw) {
        await clickByText(page, 'cancel');
        console.log('[actions] Already pending (withdraw).');
        return { invitationUrn: null };
      }

      // Weekly/invitation limit → abort this profile
      if (modal.hasWeeklyLimit) {
        // Close the modal
        await clickByAria(page, 'Dismiss').catch(() => {});
        await clickByText(page, 'Got it').catch(() => {});
        throw new Error('WEEKLY_LIMIT');
      }

      // Email required to connect → skip this lead
      if (modal.hasEmailRequired) {
        // Close the modal
        await clickByAria(page, 'Dismiss').catch(() => {});
        await clickByText(page, 'Cancel').catch(() => {});
        throw new Error('EMAIL_REQUIRED');
      }

      // "How do you know"
      if (modal.hasHowDoYouKnow) {
        await clickByText(page, 'Other');
        await randomDelay(600, 1000);
        await clickByText(page, 'Connect');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // "Add a note" flow
      if (note && modal.hasAddNote) {
        console.log('[actions] Clicking "Add a note"…');
        await clickByAria(page, 'Add a note');
        await new Promise(r => setTimeout(r, 5000));
        // v2.112.32 — out of free custom notes? Clicking "Add a note" then shows
        // LinkedIn's Premium upsell instead of the note field. Operator rule: do
        // NOT silently send without a note — bench the account (caller handles it)
        // and leave the lead retryable for an account that still has note credits.
        const afterAddNote = await detectModal(page);
        if (afterAddNote.hasNoteLimit) {
          console.warn('[actions] Out of free custom notes — Premium upsell shown. Cannot send a noted invite; benching account.');
          await clickByAria(page, 'Dismiss').catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
          throw new Error('NOTE_LIMIT_REACHED: account out of free custom notes — cannot send a noted invite');
        }
        const noteTyped = await typeIntoField(page, note);
        if (!noteTyped) {
          console.warn('[actions] Note typing failed after 3 attempts. Clearing field and sending without a note.');
          // Clear any half-typed content so it can't possibly leak
          await page.evaluate(() => {
            const sels = ['textarea[name="message"]', 'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]'];
            for (const sel of sels) {
              const el = document.querySelector(sel);
              if (el) {
                el.focus();
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                  el.innerHTML = '';
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                }
                return;
              }
            }
          });
          await new Promise(r => setTimeout(r, 300));

          // Dismiss the entire invite modal (Cancel button in the Add-a-note view
          // closes the whole flow on current LinkedIn)
          await clickByText(page, 'Cancel').catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
          await new Promise(r => setTimeout(r, 1500));

          // Re-click Connect from scratch — reuses the same direct-click logic
          // as the top of this function
          const reconnected = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            const profileName = h1 ? h1.textContent.trim().split('\n')[0].trim().toLowerCase() : '';
            const firstName = profileName.split(/\s+/)[0] || '';
            if (firstName) {
              const allInvites = document.querySelectorAll('[aria-label*="Invite"][aria-label*="to connect"]');
              for (const el of allInvites) {
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                if (aria.includes(firstName)) { el.click(); return 'aria'; }
              }
            }
            return null;
          });

          if (!reconnected) {
            // Fall back to More dropdown
            const moreOk = await clickConnectFromMore(page);
            if (!moreOk) {
              console.error('[actions] Could not re-open Connect after note failure. Aborting.');
              throw new Error('NOTE_TYPING_FAILED: could not re-open Connect to send without a note');
            }
          }

          await new Promise(r => setTimeout(r, 5000));

          // Now the fresh invite modal is showing; click "Send without a note"
          note = '';
          const sentR = await clickByAria(page, 'Send without a note');
          if (!sentR) {
            // Some modals label it just "Send"
            const sendR = await clickByAria(page, 'Send');
            if (!sendR) {
              const byText = await clickByText(page, 'Send without a note');
              if (!byText) {
                console.error('[actions] Fresh invite modal did not expose Send-without-note button.');
                throw new Error('NOTE_TYPING_FAILED: fresh invite modal missing Send-without-note');
              }
            }
          }
          console.log('[actions] ✓ Sent without a note (note typing fallback).');
          // ── Approach A: Voyager network response (gold-standard signal) ──
          await new Promise(r => setTimeout(r, 1500));
          const voyagerA = await voyagerCapture.waitFor(10000);
          if (voyagerA) {
            if (voyagerA.ok) {
              console.log(`[actions] ✓ Voyager confirmed (fallback): HTTP ${voyagerA.status}, urn=${voyagerA.urn || 'n/a'}`);
              return { invitationUrn: voyagerA.urn };
            }
            console.error(`[actions] ✗ Voyager rejected (fallback): HTTP ${voyagerA.status} — ${voyagerA.errorMessage || ''}`);
            throw new Error(`VOYAGER_REJECTED: HTTP ${voyagerA.status} — ${voyagerA.errorMessage || 'unknown reason'}`);
          }
          console.log('[actions] Voyager did not fire — falling back to DOM-based verification.');

          // Legacy fallback: post-send verification: reload profile and confirm Pending
          console.log('[actions] Verifying connection... waiting 30s for LinkedIn to process.');
          await new Promise(r => setTimeout(r, 30000));
          const currentUrl = page.url();
          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch { /* timeout OK */ }
          await new Promise(r => setTimeout(r, 5000));
          await page.evaluate(() => { document.body.style.zoom = '75%'; });
          if (await isPending(page)) {
            console.log('[actions] ✓ Verified: Pending (fallback send).');
            return { invitationUrn: null };
          }
          console.log('[actions] Not Pending yet. Waiting another 30s...');
          await new Promise(r => setTimeout(r, 30000));
          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch { /* */ }
          await new Promise(r => setTimeout(r, 5000));
          await page.evaluate(() => { document.body.style.zoom = '75%'; });
          if (await isPending(page)) {
            console.log('[actions] ✓ Verified: Pending (fallback send, 2nd check).');
            return { invitationUrn: null };
          }
          throw new Error('SEND_NOT_CONFIRMED: fallback send without note did not land as Pending');
        }
        console.log('[actions] Note typed and verified.');
        await new Promise(r => setTimeout(r, 5000));

        // v2.112.x: LinkedIn caps custom-invite notes (free 200, Premium ~300);
        // a longer note greys out Send so the invite can't fire. Detect it HERE
        // instead of "clicking" the dead Send and then burning ~60s + 3 retries
        // verifying a send that never happens — on every lead, since the
        // template length is the same for all.
        //
        // PRIMARY signal (2026-06-22 DOM capture): LinkedIn's own character
        // counter "<current>/<max>" (203/200 free, 250/300 Premium). Over ⇔
        // current > max — exactly what greys Send, no hard-coded number, and
        // Premium-safe. v2.112.40 keyed on the Send button's `disabled` property
        // instead, but LinkedIn greys Send via a CSS class, so it never tripped.
        // We read the counter, the typed length, AND the Send disabled-state in
        // ALL its forms, and log all of it so a future miss is diagnosable.
        const noteState = await page.evaluate(() => {
          // The invite modal renders inside a web-component SHADOW ROOT (same as
          // why typeIntoField's findField falls back to shadow hosts). A plain
          // document.querySelector reads all-empty (the v2.112.42 miss), so walk
          // the light DOM AND every shadow root (recursively) and query across
          // all of them.
          const roots = [];
          const collect = (root) => {
            roots.push(root);
            let hosts; try { hosts = root.querySelectorAll('*'); } catch { return; }
            for (const el of hosts) if (el.shadowRoot) collect(el.shadowRoot);
          };
          collect(document);
          const deepAll = (sel) => {
            const out = [];
            for (const r of roots) { try { out.push(...r.querySelectorAll(sel)); } catch { /* */ } }
            return out;
          };
          // Character counter — an element whose entire text is "<current>/<max>"
          // (203/200 free, 250/300 Premium). This is the platform-truth signal.
          let counterCurrent = null, counterMax = null, counter = '';
          for (const el of deepAll('*')) {
            const t = (el.textContent || '').replace(/\s+/g, '');
            const m = t.match(/^(\d{2,4})\/(\d{2,4})$/);
            if (m) { counterCurrent = Number(m[1]); counterMax = Number(m[2]); counter = `${m[1]}/${m[2]}`; }
          }
          // Typed note length (fallback signal).
          let typedLen = 0;
          for (const sel of ['textarea[name="message"]', 'textarea#custom-message', 'div[aria-label*="Add a note"]', 'div[role="dialog"] textarea', 'textarea', 'div[contenteditable="true"]', 'div[role="textbox"]']) {
            const el = deepAll(sel)[0];
            if (el) { typedLen = ((el.value != null ? el.value : el.textContent) || '').length; break; }
          }
          // Send button + disabled in ALL forms (property / aria / artdeco class).
          const send = deepAll('button').find((b) => {
            const t = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const a = (b.getAttribute('aria-label') || '').trim().toLowerCase();
            return t === 'send' || a === 'send' || a.startsWith('send ');
          });
          const sendDisabled = !!send && (
            send.disabled
            || send.getAttribute('aria-disabled') === 'true'
            || send.hasAttribute('disabled')
            || /\bdisabled\b|artdeco-button--disabled/.test(send.className || '')
          );
          const upsell = deepAll('.connect-button-send-invite__premium-upsell-message').length > 0;
          return { counter, counterCurrent, counterMax, typedLen, sendFound: !!send, sendDisabled, upsell, rootCount: roots.length };
        });
        console.log(`[actions] note-limit check → ${JSON.stringify(noteState)}`);
        if (isNoteOverFreeLimit({
          counterCurrent: noteState.counterCurrent,
          counterMax: noteState.counterMax,
          sendDisabled: noteState.sendDisabled,
          typedLen: noteState.typedLen,
        })) {
          console.warn(`[actions] Note over LinkedIn's note limit (counter=${noteState.counter || 'n/a'}, typed=${noteState.typedLen}, sendDisabled=${noteState.sendDisabled}, upsell=${noteState.upsell}) — account not Premium. Skipping noted invite.`);
          await clickByText(page, 'Cancel').catch(() => {});
          await page.keyboard.press('Escape').catch(() => {});
          throw new Error('NOTE_TOO_LONG: note exceeds LinkedIn\'s custom-note character limit (account not Premium)');
        }
      }

      // ── Click Send — all via JS ──
      let sent = false;

      if (!sent && modal.hasSendWithout && !note) {
        const r = await clickByAria(page, 'Send without a note');
        if (r) { sent = true; console.log(`[actions] ✓ "Send without a note" clicked (${r}).`); }
      }

      if (!sent && modal.hasSend) {
        const r = await clickByAria(page, 'Send');
        if (r) { sent = true; console.log(`[actions] ✓ "Send" clicked (${r}).`); }
      }

      if (!sent) {
        const r = await clickByAria(page, 'Send without a note');
        if (r) { sent = true; console.log(`[actions] ✓ "Send without a note" fallback (${r}).`); }
      }

      if (!sent) {
        const r = await clickByText(page, 'Send');
        if (r) { sent = true; console.log(`[actions] ✓ "Send" by text (${r}).`); }
      }

      if (!sent) {
        // Last resort: click any primary button in modal that isn't "Add" or "Cancel"
        sent = await page.evaluate(() => {
          const allBtns = [];
          allBtns.push(...Array.from(document.querySelectorAll('button')));
          const outlet = document.getElementById('interop-outlet');
          if (outlet?.shadowRoot) {
            allBtns.push(...Array.from(outlet.shadowRoot.querySelectorAll('button')));
          }
          for (const b of allBtns) {
            const cls = b.className?.toLowerCase() || '';
            const text = b.textContent?.trim().toLowerCase() || '';
            if (cls.includes('primary') && !text.includes('add') && !text.includes('cancel') && !text.includes('follow')) {
              b.click();
              return true;
            }
          }
          return false;
        });
        if (sent) console.log('[actions] ✓ Primary button fallback clicked.');
      }

      if (!sent) {
        const allBtns = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const outlet = document.getElementById('interop-outlet');
          if (outlet?.shadowRoot) btns.push(...Array.from(outlet.shadowRoot.querySelectorAll('button')));
          return btns.filter(b => b.offsetWidth > 0).map(b => ({
            text: b.textContent?.trim().substring(0, 30),
            aria: (b.getAttribute('aria-label') || '').substring(0, 40),
          }));
        });
        console.error('[actions] Send not found. Buttons:', JSON.stringify(allBtns.slice(0, 15)));
        throw new Error('Send button not found in modal');
      }

      // ── Approach A: Voyager network response (gold-standard signal) ──
      // The instant LinkedIn's backend replies to the invitation POST, we know
      // definitively whether it landed. This bypasses toast races and reload
      // latency. Wait up to 10s for the listener to fire.
      await new Promise(r => setTimeout(r, 1500));
      const voyagerMain = await voyagerCapture.waitFor(10000);
      if (voyagerMain) {
        if (voyagerMain.ok) {
          console.log(`[actions] ✓ Voyager confirmed: HTTP ${voyagerMain.status}, urn=${voyagerMain.urn || 'n/a'}`);
          return { invitationUrn: voyagerMain.urn };
        }
        console.error(`[actions] ✗ Voyager rejected: HTTP ${voyagerMain.status} — ${voyagerMain.errorMessage || ''}`);
        throw new Error(`VOYAGER_REJECTED: HTTP ${voyagerMain.status} — ${voyagerMain.errorMessage || 'unknown reason'}`);
      }
      console.log('[actions] Voyager listener did not fire in 10s — falling back to toast/Pending check.');

      // ── Legacy fallback: toast check ──
      // Check for success toast first: "Invitation sent to X"
      const sentToast = await page.evaluate(() => {
        const toasts = document.querySelectorAll('.artdeco-toast-item, [data-test-artdeco-toast-item-type="success"]');
        for (const t of toasts) {
          const text = (t.textContent || '').toLowerCase();
          if (text.includes('invitation sent')) return text.trim().substring(0, 100);
        }
        return null;
      });
      if (sentToast) {
        console.log(`[actions] ✓ Verified via toast: "${sentToast}"`);
        return { invitationUrn: null };
      }
      const errorToast = await page.evaluate(() => {
        const toast = document.querySelector(
          'div[data-test-artdeco-toast-item-type="error"], ' +
          '.artdeco-toast-item--error, ' +
          'li-icon[type="error"]'
        );
        if (toast) {
          const container = toast.closest('.artdeco-toast-item') || toast.parentElement;
          return (container?.textContent || toast.textContent || '').trim().substring(0, 200);
        }
        // Also check all Shadow DOM roots
        const roots = [];
        document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) roots.push(el.shadowRoot); });
        for (const root of roots) {
          const sToast = root.querySelector(
            'div[data-test-artdeco-toast-item-type="error"], .artdeco-toast-item--error'
          );
          if (sToast) {
            const container = sToast.closest('.artdeco-toast-item') || sToast.parentElement;
            return (container?.textContent || sToast.textContent || '').trim().substring(0, 200);
          }
        }
        return null;
      });
      if (errorToast) {
        console.error(`[actions] ⚠ LinkedIn error toast after send: "${errorToast}"`);
        throw new Error(`LINKEDIN_ERROR_TOAST: ${errorToast}`);
      }

      // ── Legacy fallback: reload + isPending ──
      console.log('[actions] Verifying connection... waiting 30s for LinkedIn to process.');
      await new Promise(r => setTimeout(r, 30000));
      const currentUrl = page.url();
      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch { /* timeout OK — page still usable */ }
      await new Promise(r => setTimeout(r, 5000));
      await page.evaluate(() => { document.body.style.zoom = '75%'; });

      if (await isPending(page)) {
        console.log('[actions] ✓ Verified: Pending.');
        return { invitationUrn: null };
      }

      console.log('[actions] Not Pending yet. Waiting another 30s...');
      await new Promise(r => setTimeout(r, 30000));
      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch { /* timeout OK */ }
      await new Promise(r => setTimeout(r, 5000));
      await page.evaluate(() => { document.body.style.zoom = '75%'; });

      if (await isPending(page)) {
        console.log('[actions] ✓ Verified: Pending (2nd check).');
        return { invitationUrn: null };
      }

      console.warn('[actions] ⚠ Send clicked but Pending NOT confirmed after 60s + 2 page reloads.');
      throw new Error('SEND_NOT_CONFIRMED: clicked Send but profile does not show Pending');
    }

    if (attempt < 8) {
      console.log(`[actions] No modal yet (${attempt}/8), waiting 3s…`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Debug dump
  const btns = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button'));
    for (const root of getAllShadowRoots()) {
      all.push(...Array.from(root.querySelectorAll('button')));
    }
    function getAllShadowRoots() {
      const roots = [];
      const outlet = document.getElementById('interop-outlet');
      if (outlet?.shadowRoot) roots.push(outlet.shadowRoot);
      // Search all elements with shadow roots
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot && el.id !== 'interop-outlet') roots.push(el.shadowRoot);
      });
      return roots;
    }
    return all.filter(b => b.offsetWidth > 0).slice(0, 12).map(b => ({
      text: b.textContent?.trim().substring(0, 25),
      aria: (b.getAttribute('aria-label') || '').substring(0, 35),
      src: b.getRootNode() === document ? 'dom' : 'shadow',
    }));
  });
  console.error('[actions] No modal after 8 attempts. Buttons:', JSON.stringify(btns));
  throw new Error('No modal appeared and connection not sent');
  } finally {
    voyagerCapture.detach();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// sendMessage
// ═════════════════════════════════════════════════════════════════════════════

export async function sendMessage(page, message, explicitPublicId = null, freeOnly = false) {
  // ── 2.8.48 — Compose-page navigation + plain Enter to send ──────────
  // History: tried injecting the LinkedIn DM Assistant content.js into the
  // page via a <script> tag — LinkedIn's CSP blocks inline scripts, so the
  // helpers never registered ("DM Assistant injection did not expose
  // helpers"). Tried clicking the profile's Message button to open the
  // floating bubble — getProfileMessageButton couldn't find it on every
  // profile (probably profiles where the running account isn't connected,
  // but unreliable either way).
  //
  // Going back to LinkedIn's dedicated compose URL and using plain Enter
  // to send. The compose page in Orbita has NO Send button (the only "send"
  // is an "Open send options" overflow), but pressing Enter on the
  // composer triggers send because the Ortus accounts have LinkedIn's
  // "Press Enter to send message" setting enabled.
  //
  // v2.61: Optional `explicitPublicId` param lets callers (the DM fast-path
  // in outreach.js — mirror of the IC fast-path) skip the profile-nav step
  // entirely. When passed, the URL parse below is bypassed; otherwise the
  // function works exactly as before (parses from page.url()).
  let publicId;
  if (explicitPublicId) {
    publicId = explicitPublicId;
  } else {
    const currentUrl = page.url();
    const publicIdMatch = currentUrl.match(/\/in\/([^/?#]+)/);
    if (!publicIdMatch) {
      throw new Error(`MESSAGE_SEND_FAILED: not on a profile page (${currentUrl})`);
    }
    publicId = publicIdMatch[1];
  }

  const composeUrl = `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(publicId)}`;
  console.log(`[actions] Navigating to ${composeUrl}`);
  try {
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.warn(`[actions] Compose navigation warning: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 1500));

  // Wait for the compose textbox.
  const composeSelectors = [
    'div[role="textbox"][aria-label*="Write a message" i]',
    '.msg-form__contenteditable',
    'div[class*="msg-form__contenteditable"]',
  ];
  let composerReady = false;
  for (const sel of composeSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      composerReady = true;
      break;
    } catch { /* try next */ }
  }
  if (!composerReady) {
    throw new Error('MESSAGE_SEND_FAILED: compose textbox did not appear');
  }

  // v2.86.4: free-send guard. The /messaging/compose box for an Open-Profile
  // member is labelled "Free message"; for a non-OP non-connection LinkedIn
  // renders the IDENTICAL subject+body box as a PAID InMail (a "Use X of Y
  // credits" counter). With freeOnly set (the Message Campaign LinkedIn door),
  // only send when LinkedIn confirms it's free — otherwise abort WITHOUT sending
  // so we never silently burn an InMail credit. (The intentional InMail path
  // goes through sendInMail / the "Spend an InMail credit" tickbox, not here.)
  if (freeOnly) {
    const billing = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return {
        saysFree: /free message/i.test(text) || /free to (open profile|teamlink)/i.test(text),
        hasCreditCounter: /use\s+\d+\s+of\s+\d+\s+credits?/i.test(text),
      };
    });
    if (billing.hasCreditCounter || !billing.saysFree) {
      throw new Error('NOT_FREE_MESSAGE: compose is not a confirmed free message (would cost an InMail credit) — aborting without sending');
    }
    console.log('[actions] sendMessage: "Free message" confirmed — sending free (no credit cost)');
  }

  await randomDelay(150, 300);
  const typed = await typeIntoField(page, message);
  if (!typed) throw new Error('MESSAGE_SEND_FAILED: could not type message');

  // Let React register the input event.
  await new Promise(r => setTimeout(r, 700));

  // Try Send button first (some account/layout combos do render it).
  const sentByButton = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const activate = (el) => {
      el.scrollIntoView?.({ block: 'center' });
      el.focus?.();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    };

    // Tier 0 — data-test-icon
    const icon = document.querySelector('[data-test-icon*="send"]');
    const iconBtn = icon?.closest?.('button');
    if (iconBtn && isVisible(iconBtn)) return activate(iconBtn);

    // Tier 1 — aria-label
    for (const b of document.querySelectorAll('button[aria-label="Send" i], button[aria-label="Send message" i], button[aria-label="Send a message" i]')) {
      if (isVisible(b)) return activate(b);
    }

    // Tier 2 — exact text "Send" / "Send message"
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const t = (b.textContent || '').trim();
      if ((t === 'Send' || t === 'Send message') && isVisible(b)) return activate(b);
    }

    // Tier 3 — legacy class
    const legacy = document.querySelector(
      'button.msg-form__send-button, .msg-form__send-button, ' +
      'button[type="submit"][class*="msg-form"]'
    );
    if (legacy && isVisible(legacy)) return activate(legacy);

    return false;
  });

  if (!sentByButton) {
    console.log('[actions] No Send button on compose page — using plain Enter');
    // Focus composer and move caret to end before pressing Enter, so the
    // shortcut sends instead of inserting a newline mid-message.
    const focused = await page.evaluate(() => {
      const composer = document.querySelector(
        'div[role="textbox"][aria-label*="Write a message" i], ' +
        '.msg-form__contenteditable, ' +
        '.msg-form div[contenteditable="true"], ' +
        '[role="textbox"][contenteditable="true"]'
      );
      if (!composer) return false;
      composer.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* */ }
      return true;
    });
    if (!focused) {
      throw new Error('MESSAGE_SEND_FAILED: composer not focusable for Enter shortcut');
    }
    // PLAIN Enter — Ortus accounts have "Press Enter to send message" enabled.
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 250));
    // Cmd+Enter and Ctrl+Enter as belt-and-suspenders.
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
  } else {
    console.log('[actions] Clicked Send button on compose page');
  }

  // ── Honest verification (preserved from 2.8.46) ──
  // Old logic falsely returned "sent" whenever a class selector didn't
  // match. Now we require positive proof.
  //
  // v2.14.x: bumped the post-Send wait from 2500ms → 7500ms. On
  // 2026-05-15 we caught a confirmed false-negative for Dianne (IC DM):
  // the bot reported MESSAGE_SEND_FAILED, but the user's manual check of
  // the LinkedIn thread showed the message had landed within seconds.
  // LinkedIn's "compose → thread" DOM transition can take 3-8s on slow
  // GoLogin profiles — the OLD composer still has the body text while
  // the NEW thread-view composer (empty) hasn't yet replaced it, AND
  // the just-sent message hasn't yet appeared in .msg-s-event-listitem.
  // 7.5s window covers the slow-transition case without sacrificing
  // happy-path throughput meaningfully.
  await new Promise(r => setTimeout(r, 7500));
  const verified = await page.evaluate((sentText) => {
    const editor = document.querySelector(
      'div[role="textbox"][aria-label*="Write a message" i], ' +
      '.msg-form__contenteditable, ' +
      '.msg-form div[contenteditable="true"], ' +
      'div[contenteditable="true"][aria-label*="message" i]'
    );
    let composerEmpty = null;
    let editorText = '';
    if (editor) {
      editorText = (editor.textContent || editor.innerText || '').replace(/​/g, '').trim();
      composerEmpty = editorText.length === 0;
    }
    let foundInThread = false;
    const tail = (sentText || '').slice(-40).trim();
    if (tail.length >= 8) {
      const messages = document.querySelectorAll(
        '.msg-s-event-listitem, [class*="msg-s-event"], ' +
        '[class*="msg-event-listitem"], .msg-s-message-list-content li'
      );
      for (const m of messages) {
        if ((m.textContent || '').includes(tail)) { foundInThread = true; break; }
      }
    }
    return {
      composerEmpty,
      foundInThread,
      editorText: editorText.substring(0, 60),
      editorFound: !!editor,
    };
  }, message);

  const success = verified.composerEmpty === true || verified.foundInThread === true;
  if (!success) {
    const why = verified.editorFound
      ? `composer still has text: "${verified.editorText}"`
      : 'composer not found and message not in thread';
    throw new Error(`MESSAGE_SEND_FAILED: send not confirmed (${why})`);
  }
  console.log(`[actions] ✓ Message sent (composerEmpty=${verified.composerEmpty}, foundInThread=${verified.foundInThread})`);
}

// ═════════════════════════════════════════════════════════════════════════════
// sendOpenProfileViaProfileButton — v2.72
// ═════════════════════════════════════════════════════════════════════════════
// For accounts WITHOUT Sales Navigator: message an Open Profile member by
// clicking the "Message" button on their /in/ profile page (the Open Profile
// affordance), which opens a free compose overlay. Works for OP members and
// 1st-degree connections; for everyone else the Message button is absent (or
// only "More" → InMail), so we throw and the caller skips/falls back. The
// /messaging/compose URL (sendMessage) does NOT surface this for OP
// non-connections — hence this profile-page path.
// ═════════════════════════════════════════════════════════════════════════════

export async function sendOpenProfileViaProfileButton(page, publicId, body) {
  const url = `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.warn(`[actions] OP profile nav warning: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 3000));

  // Click the primary "Message" button in the profile top card. The OP/connect
  // free-message button has aria-label "Message <Name>" (or text "Message").
  // We avoid "More"/overflow buttons (those route to InMail upsell).
  const clicked = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    };
    const btns = Array.from(document.querySelectorAll('button, a'));
    for (const b of btns) {
      const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
      const txt = (b.textContent || '').trim().toLowerCase();
      if ((aria.startsWith('message') || txt === 'message') && isVisible(b)) {
        b.scrollIntoView({ block: 'center' });
        b.click();
        return true;
      }
    }
    return false;
  });
  if (!clicked) {
    throw new Error('OP_MSG_BUTTON_NOT_FOUND: no free Message button on profile (not Open Profile / not connected)');
  }

  // Wait for the compose overlay textbox.
  await new Promise(r => setTimeout(r, 2500));
  const composeSelectors = [
    'div[role="textbox"][aria-label*="Write a message" i]',
    '.msg-form__contenteditable',
    '.msg-overlay-conversation-bubble div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="message" i]',
  ];
  let ready = false;
  for (const sel of composeSelectors) {
    try { await page.waitForSelector(sel, { timeout: 5000 }); ready = true; break; } catch { /* try next */ }
  }
  if (!ready) {
    throw new Error('OP_MSG_COMPOSE_NOT_FOUND: Message overlay did not open (likely not Open Profile)');
  }

  const typed = await typeIntoField(page, body);
  if (!typed) throw new Error('OP_MSG_TYPE_FAILED: could not type message');
  await new Promise(r => setTimeout(r, 700));

  // Send: Send button → plain Enter fallback (Ortus accounts have Enter-to-send).
  const sentByButton = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const tiers = [
      'button.msg-form__send-button',
      'button[type="submit"][class*="msg-form"]',
      'button[aria-label="Send" i]',
      'button[aria-label="Send message" i]',
    ];
    for (const sel of tiers) {
      for (const b of document.querySelectorAll(sel)) {
        if (isVisible(b)) { b.click(); return true; }
      }
    }
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const t = (b.textContent || '').trim();
      if ((t === 'Send' || t === 'Send message') && isVisible(b)) { b.click(); return true; }
    }
    return false;
  });
  if (!sentByButton) {
    try {
      await page.focus('div[role="textbox"][aria-label*="Write a message" i], .msg-form__contenteditable');
      await page.keyboard.press('Enter');
    } catch { /* best-effort */ }
  }
  await new Promise(r => setTimeout(r, 2500));
  console.log('[actions] ✓ Open Profile message sent via profile Message button');
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// sendIntroMessage — 2.8.50
// ═════════════════════════════════════════════════════════════════════════════
// Mirrors LinkedIn DM Assistant's Option+I flow. Same /messaging/compose/
// landing as sendMessage, plus:
//   1. Add the intro person as a second recipient (typeahead → exact match)
//   2. Fill the conversation title (group thread)
//   3. Type the body
//   4. Send (Send button → plain Enter fallback)
//
// Helper functions are ports of the DM Assistant's content.js
// (getRecipientSearchInputTarget, selectExactRecipientResult,
// getConversationTitleInputTarget, hasSelectedRecipient).
// ═════════════════════════════════════════════════════════════════════════════

export async function sendIntroMessage(page, body, introName, groupTitle, secondRecipientUrl = '', leadUrl = '') {
  if (!introName) throw new Error('MESSAGE_SEND_FAILED: introName required');

  // v2.14.x: leadUrl arg lets callers supply the lead's /in/<publicId> URL
  // directly so we no longer require the page to be on the profile first.
  // The IC DM fast-path uses this to skip the wasted 5-30s profile-visit
  // detour (networkidle0 + DOM settle) and jump straight to compose.
  // Backward-compat: when leadUrl is empty, parse from page.url() as before.
  const sourceUrl = leadUrl || page.url();
  const publicIdMatch = sourceUrl.match(/\/in\/([^/?#]+)/);
  if (!publicIdMatch) {
    throw new Error(`MESSAGE_SEND_FAILED: not on a profile page (${sourceUrl})`);
  }
  const publicId = publicIdMatch[1];

  // v2.13.14: when the caller provides the second recipient's LinkedIn URL,
  // append a second `recipient=<publicId>` query param so LinkedIn auto-adds
  // BOTH pills via URL routing — same mechanism we use for the lead pill,
  // and the same mechanism the deleted preflight (verify-primary-person.js)
  // proved 100% reliable. The existing `alreadyAdded` check below then
  // detects the URL-added second pill and skips the unreliable typeahead
  // step entirely. Callers that don't pass the URL (e.g. the standalone
  // Introduce Back path) keep the typeahead behaviour byte-for-byte.
  let composeUrl = `https://www.linkedin.com/messaging/compose/?recipient=${encodeURIComponent(publicId)}`;
  if (secondRecipientUrl) {
    const secondMatch = secondRecipientUrl.match(/\/in\/([^/?#]+)/);
    if (secondMatch) {
      composeUrl += `&recipient=${encodeURIComponent(secondMatch[1])}`;
    }
  }
  console.log(`[actions:intro] Navigating to ${composeUrl}`);
  try {
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.warn(`[actions:intro] Compose navigation warning: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 1500));

  // v2.57.x: Step B layered detection. Replaces the previous sequential
  // 3-selector polling (5s × 3 = 15s, budget fragmented across tries) with
  // a single waitForFunction predicate that races all three signals AND
  // adds two stronger readiness gates that the old polling didn't have.
  //
  // Three signals, ALL required to consider the compose form ready:
  //   1. body.boot-complete — LinkedIn's Pemberly/Ember boot is finished.
  //      Without this, the textbox can mount before Ember has bound its
  //      input handlers, and typing silently no-ops (community-confirmed:
  //      OpenOutreach + Dominien/sales-agent both flagged this).
  //   2. ANY of the 3 textbox selectors matches (community consensus —
  //      verified against 9 OSS LinkedIn projects 2026-05-19, all use
  //      .msg-form__contenteditable as the canonical selector).
  //   3. The matched element has contenteditable="true" AND offsetParent
  //      !== null — Ember sometimes mounts the element disabled or hidden
  //      briefly before activating it. Without this check we'd race past
  //      a mid-mount element and try to type into a dead node.
  //
  // Total budget: 30s (vs. 15s before), realized as a SINGLE async wait
  // rather than 3 sequential 5s slices. polling:'mutation' makes the
  // predicate re-run on every DOM mutation rather than every 100ms, so
  // median-case resolution is sub-frame — typical successful detection
  // is now <500ms vs. the old ~3-5s.
  //
  // Why this works for the bug Sam saw 2026-05-19: failure mode was
  // background renderer throttling under parallel-profile CPU load —
  // Ember boot was slipping past 15s. The CalculateNativeWinOcclusion
  // flag (gologin-launcher.js v2.57.x) prevents most of that throttling
  // at the OS level; this wider budget + boot-complete gate covers the
  // residual cases. Belt-and-suspenders.
  let composerReady = false;
  try {
    await page.waitForFunction(() => {
      if (!document.body || !document.body.classList.contains('boot-complete')) {
        return false;
      }
      const selectors = [
        'div[role="textbox"][aria-label*="Write a message" i]',
        '.msg-form__contenteditable',
        'div[class*="msg-form__contenteditable"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (el.getAttribute('contenteditable') !== 'true') continue;
        if (el.offsetParent === null) continue; // display:none / detached
        return true;
      }
      return false;
    }, { timeout: 30000, polling: 'mutation' });
    composerReady = true;
  } catch { /* timed out — fall through to the throw below */ }

  if (!composerReady) throw new Error('MESSAGE_SEND_FAILED: compose textbox did not appear');

  // ── Step 1: add intro person as second recipient ──
  // v2.11.16: previous version dispatched a single synthetic InputEvent
  // after value-setting via the React-style native setter. That fires
  // React's onChange but LinkedIn's typeahead listens for real keystroke
  // events (keydown/keypress/input/keyup) with debounce — so the synthetic
  // single-shot dispatch never triggered the search XHR and the dropdown
  // never opened. Real-keystroke simulation via page.type fixes it.
  //
  // Strategy: tag the recipient input with a unique data-attribute inside
  // page.evaluate, then exit evaluate to use page.type which simulates
  // proper key sequences. Re-enter evaluate to wait for the dropdown and
  // verify the pill.
  const tagged = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"][role="textbox"]'))
      .filter(isVisible);
    for (const el of inputs) {
      const text = [
        el.getAttribute('aria-label'),
        el.getAttribute('placeholder'),
        el.getAttribute('class'),
        el.getAttribute('id'),
      ].join(' ').toLowerCase();
      if (text.includes('enter message recipients') || text.includes('msg-connections-typeahead__search-field')) {
        el.setAttribute('data-ortus-recipient', '1');
        return {
          ok: true,
          tag: el.tagName,
          ariaLabel: el.getAttribute('aria-label') || '',
          placeholder: el.getAttribute('placeholder') || '',
          contentEditable: el.isContentEditable || false,
        };
      }
    }
    return { ok: false };
  });

  if (!tagged.ok) {
    throw new Error('INTRO_RECIPIENT_NOT_FOUND: recipient-input-not-found');
  }
  console.log(`[actions:intro] Recipient input found: ${tagged.tag} aria="${tagged.ariaLabel}" placeholder="${tagged.placeholder}" CE=${tagged.contentEditable}`);

  // Check if intro person is already added (idempotent)
  const alreadyAdded = await page.evaluate((name) => {
    const normalizeName = (v) => (v || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/^remove\s+/, '')
      .replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
    const norm = normalizeName(name);
    return Array.from(document.querySelectorAll(
      '.msg-connections-typeahead__added-recipients button[aria-label^="Remove"], button.artdeco-pill[aria-label^="Remove"]'
    )).some((b) => normalizeName(b.getAttribute('aria-label')).includes(norm));
  }, introName);

  if (alreadyAdded) {
    console.log('[actions:intro] Recipient already added — skipping typeahead');
  } else {
    // Real-keystroke typing. delay=60ms per char gives LinkedIn's debounce
    // time to register each char as the user types — exactly what the
    // typeahead listener expects.
    const recipientSelector = '[data-ortus-recipient="1"]';
    try {
      await page.click(recipientSelector);
      await page.evaluate(() => document.activeElement?.blur());
      await page.click(recipientSelector);
    } catch { /* focus is best-effort */ }
    // v2.14.x: Paste-style insert instead of keystroke-by-keystroke typing.
    // page.type sends 16 separate keystrokes over ~960ms — every one is a
    // chance for the typeahead chip-finalize re-render to drop chars when
    // the renderer is throttled (macOS App Nap, occluded windows, etc.).
    // A paste is atomic: one value mutation + one input event, no drop window.
    // We keep a ~1s wait afterwards so the typeahead's debounce/API has the
    // same render budget the typing flow used to give it. Chrome-flag fix
    // in gologin-launcher.js stays as belt-and-suspenders for click events.
    const pasteRecipient = async () => {
      await page.evaluate((sel, text) => {
        const el = document.querySelector(sel);
        if (!el) return;
        // Native setter so controlled-input wrappers (React/Ember) see the change.
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
                    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: true,
          inputType: 'insertFromPaste', data: text,
        }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, recipientSelector, introName);
      await new Promise(r => setTimeout(r, 1000));
    };
    await pasteRecipient();
    console.log(`[actions:intro] Pasted recipient name: "${introName}"`);

    // Verify the paste actually landed; re-paste once if input is empty.
    try {
      const typedValue = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el.value || el.textContent || '') : '';
      }, recipientSelector);
      const firstNameExpected = String(introName || '').toLowerCase().split(/\s+/)[0];
      if (firstNameExpected && !String(typedValue).toLowerCase().includes(firstNameExpected)) {
        console.warn(`[actions:intro] Input empty after paste ("${typedValue}"); re-pasting "${introName}".`);
        try { await page.click(recipientSelector); } catch { /* best-effort */ }
        await pasteRecipient();
        console.log(`[actions:intro] Re-pasted recipient name: "${introName}"`);
      }
    } catch (e) {
      console.warn(`[actions:intro] Paste verification failed: ${e.message}`);
    }

    // v2.14.x: URL-settle poll BEFORE the dropdown-poll page.evaluate.
    // For recipient combinations that already have a 3-way intro thread
    // (lead + primary + sender), LinkedIn's typeahead API recognizes the
    // combo as the user types and redirects the browser to that existing
    // thread BEFORE the typeahead dropdown opens. The redirect destroys
    // the JS execution context, and the dropdown-poll page.evaluate below
    // would hang at the CDP protocol-timeout (~3 min). Repro: kenya5/peter
    // → pinky-salaria across the 17:00 / 21:44 / 22:36 runs on 2026-05-15
    // — all hit Runtime.callFunctionOn timed out / Execution context was
    // destroyed because the redirect happened mid-type.
    //
    // Settle the URL first (≤6s). If we land on /messaging/thread/{id}
    // (NOT /thread/new which is the legitimate new-thread compose path
    // for fresh intros), the trio already has a thread — throw a dedicated
    // signal that auto-intro maps to 'Introduction Already Made'. This
    // turns a 6-minute CDP timeout into a ~2s clean detection.
    {
      const STABLE_MS   = 1500;
      const HARD_CAP_MS = 6000;
      const POLL_MS     = 250;
      const start = Date.now();
      let lastUrl = page.url();
      let lastChangeAt = Date.now();
      let didNavigate = false;
      while (Date.now() - start < HARD_CAP_MS) {
        await new Promise(r => setTimeout(r, POLL_MS));
        let currentUrl;
        try { currentUrl = page.url(); }
        catch { currentUrl = lastUrl + '?transition'; }
        if (currentUrl !== lastUrl) {
          didNavigate = true;
          console.log(`[actions:intro] URL changed during type: ${lastUrl} → ${currentUrl}`);
          lastUrl = currentUrl;
          lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt >= STABLE_MS) {
          break;
        }
      }
      const finalUrl = lastUrl;
      if (/\/messaging\/thread\/[^/]+/i.test(finalUrl) && !finalUrl.includes('/thread/new')) {
        console.log(`[actions:intro] Existing intro thread detected at ${finalUrl} — already introduced; aborting compose.`);
        await page.evaluate(() => document.querySelector('[data-ortus-recipient="1"]')?.removeAttribute('data-ortus-recipient')).catch(() => {});
        throw new Error('INTRO_ALREADY_EXISTS');
      }
      if (didNavigate) {
        console.log(`[actions:intro] URL settled at ${finalUrl} — continuing to dropdown poll.`);
      }
    }

    // v2.14.x: ALWAYS-fires diagnostic — capture URL + any visible
    // modal/overlay text immediately before the dropdown-poll page.evaluate.
    // The previous fa8595a URL-settle would only log on URL change; for the
    // hang class we just diagnosed (page stays on /compose but becomes
    // unresponsive), nothing logged. This gives us the actual page state
    // at the point of failure for the next run.
    try {
      const preState = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .artdeco-modal'))
          .filter((d) => {
            const r = d.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        const overlayText = dialogs.map((d) => (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160)).join(' || ');
        const recipInput = document.querySelector('[data-ortus-recipient="1"]');
        const inputValue = recipInput ? (recipInput.value || recipInput.textContent || '') : '';
        return { url: window.location.href, overlayText, inputValue };
      });
      console.log(`[actions:intro] Pre-poll state: url="${preState.url}" overlay="${preState.overlayText || 'none'}" inputValue="${preState.inputValue}"`);
    } catch (e) {
      console.warn(`[actions:intro] Pre-poll state capture failed: ${e.message}`);
    }

    // v2.14.x: wrap the dropdown poll in a 30s soft-timeout. If the
    // page.evaluate doesn't return in 30s, the browser tab is hung
    // (native dialog, LinkedIn modal blocking JS, or background-tab
    // throttle). Without this we'd wait for CDP's 180s protocolTimeout,
    // often fired twice (~6 min total). Capture a screenshot + final
    // URL for diagnosis, then throw INTRO_DROPDOWN_HANG.
    const DROPDOWN_SOFT_TIMEOUT_MS = 30000;

    // v2.14.x: wake-up click fallback. The paste + dispatchEvent path
    // sometimes leaves the typeahead in a state where the value is in
    // the input but the debounced search XHR never fired — the dropdown
    // stays closed and we'd throw INTRO_RECIPIENT_NOT_FOUND. Operator
    // manually reproduced (2026-05-17): clicking the recipient input at
    // that point causes LinkedIn to fire the search and open the
    // dropdown immediately.
    //
    // Fire a single page.click on the recipient input 4s into the
    // dropdown poll. If the dropdown already opened naturally by then,
    // a click on the same anchored input doesn't dismiss it (LinkedIn
    // only closes typeahead dropdowns on clicks OUTSIDE). If it hadn't,
    // this nudge triggers the search. We don't await it — page.click
    // runs in parallel with the page.evaluate poll below.
    let _wakeUpFired = false;
    const _wakeUpTimer = setTimeout(() => {
      _wakeUpFired = true;
      page.click(recipientSelector)
        .then(() => console.log('[actions:intro] Wake-up click fired (4s into dropdown poll — fallback for typeahead miss)'))
        .catch((e) => console.warn(`[actions:intro] Wake-up click failed: ${e.message}`));
    }, 4000);

    // Wait for typeahead dropdown, click exact match.
    const dropdownPromise = page.evaluate(async (name) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
      };
      const activate = (el) => {
        el.scrollIntoView?.({ block: 'center' });
        el.focus?.();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
        el.click();
        return true;
      };
      const normalizeName = (v) => (v || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/^remove\s+/, '')
        .replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
      const norm = normalizeName(name);

      // 3-tier matcher (mirrors src/linkedin/match-primary.js — keep in sync).
      //   1. exact / startsWith
      //   2. token-prefix (each token in configured name must prefix some word in candidate)
      //   3. single-candidate fallback (only one suggestion: trust it)
      const matchOne = (cands) => {
        for (let i = 0; i < cands.length; i++) {
          const t = normalizeName(cands[i].innerText || cands[i].textContent);
          if (t === norm || t.startsWith(`${norm} `)) return { idx: i, reason: 'exact' };
        }
        const tokens = norm.split(/\s+/);
        for (let i = 0; i < cands.length; i++) {
          const t = normalizeName(cands[i].innerText || cands[i].textContent);
          const words = t.split(/\s+/);
          if (tokens.every(tok => words.some(w => w.startsWith(tok)))) {
            return { idx: i, reason: 'token-prefix' };
          }
        }
        if (cands.length === 1) return { idx: 0, reason: 'single-candidate' };
        return { idx: -1, reason: 'no-match' };
      };

      let lastCandidateCount = 0;
      let lastCandidatePreview = '';
      // v2.14.x: poll up to 50 * 200ms = 10s for the typeahead dropdown.
      // Was 30 * 200ms = 6s, which was too short for GoLogin profiles on
      // slow laptops (live test 2026-05-15 fell back to URL routing
      // because the dropdown hadn't rendered). Smart poll: short-circuits
      // on first hit, only the slow cases pay the extra wait.
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        const roots = Array.from(document.querySelectorAll(
          '.msg-connections-typeahead__search-results, [role="listbox"], .reusable-search__entity-result-list'
        ));
        const searchRoots = roots.length ? roots : [document];
        for (const root of searchRoots) {
          const candidates = Array.from(root.querySelectorAll(
            'li, [role="option"], button, .msg-connections-typeahead__search-result, .reusable-search__result-container'
          )).filter(isVisible);
          if (candidates.length > lastCandidateCount) {
            lastCandidateCount = candidates.length;
            lastCandidatePreview = candidates.slice(0, 3).map(c => (c.innerText || '').trim().split('\n')[0]).join(' | ');
          }
          const result = matchOne(candidates);
          if (result.idx >= 0) {
            activate(candidates[result.idx]);
            return { ok: true, candidateCount: candidates.length, preview: lastCandidatePreview, matchReason: result.reason };
          }
        }
      }
      return { ok: false, candidateCount: lastCandidateCount, preview: lastCandidatePreview };
    }, introName);

    // v2.14.x: race the dropdown poll against a 30s soft-timeout.
    let clickResult;
    try {
      clickResult = await Promise.race([
        dropdownPromise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('INTRO_DROPDOWN_SOFT_TIMEOUT')),
          DROPDOWN_SOFT_TIMEOUT_MS,
        )),
      ]);
      // Dropdown poll resolved (either ok=true match or ok=false no-match).
      // Cancel the pending wake-up click if it hasn't fired yet — no point
      // clicking once we have an answer.
      clearTimeout(_wakeUpTimer);
    } catch (raceErr) {
      clearTimeout(_wakeUpTimer);
      if (raceErr.message === 'INTRO_DROPDOWN_SOFT_TIMEOUT') {
        // Capture diagnostic state — defensive: screenshot + URL may also
        // hang if the page is fully wedged, race each against a 5s timer.
        const withTimeout = (p, ms) => Promise.race([
          p,
          new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms)),
        ]);
        let urlAtHang = '?';
        try { urlAtHang = page.url(); } catch { /* page.url() is sync but may throw on detached */ }
        let screenshotPath = '';
        try {
          const ts = Date.now();
          const safeName = String(introName).replace(/\W+/g, '_').slice(0, 30);
          screenshotPath = `/tmp/intro-hang-${safeName}-${ts}.png`;
          await withTimeout(page.screenshot({ path: screenshotPath, fullPage: false }), 5000);
          console.warn(`[actions:intro] Captured screenshot: ${screenshotPath}`);
        } catch (sErr) {
          console.warn(`[actions:intro] Screenshot capture failed/timed out: ${sErr.message}`);
          screenshotPath = '';
        }
        let postOverlay = '';
        try {
          const post = await withTimeout(
            page.evaluate(() => {
              const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .artdeco-modal'))
                .filter((d) => {
                  const r = d.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                });
              return dialogs.map((d) => (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200)).join(' || ');
            }),
            5000,
          );
          postOverlay = post;
        } catch { /* page.evaluate also hung — confirms the wedge */ }
        console.warn(`[actions:intro] Dropdown poll soft-timeout after ${DROPDOWN_SOFT_TIMEOUT_MS / 1000}s. urlAtHang="${urlAtHang}" postOverlay="${postOverlay || 'none-or-eval-hung'}" screenshot="${screenshotPath || 'none'}"`);
        await page.evaluate(() => document.querySelector('[data-ortus-recipient="1"]')?.removeAttribute('data-ortus-recipient')).catch(() => {});
        throw new Error(`INTRO_DROPDOWN_HANG: page.evaluate did not return within ${DROPDOWN_SOFT_TIMEOUT_MS / 1000}s. urlAtHang=${urlAtHang} screenshot=${screenshotPath || 'none'}`);
      }
      throw raceErr;
    }

    console.log(`[actions:intro] Dropdown poll result: ok=${clickResult.ok} candidates=${clickResult.candidateCount} preview="${clickResult.preview}" matchReason=${clickResult.matchReason || 'n/a'}`);

    if (!clickResult.ok) {
      // Clean up the attribute before throwing
      await page.evaluate(() => document.querySelector('[data-ortus-recipient="1"]')?.removeAttribute('data-ortus-recipient'));
      const detail = clickResult.candidateCount === 0
        ? 'recipient-not-in-results (dropdown never opened — confirm 1st-degree connection)'
        : `recipient-not-in-results (${clickResult.candidateCount} suggestions but no match; saw: ${clickResult.preview})`;
      throw new Error(`INTRO_RECIPIENT_NOT_FOUND: ${detail}`);
    }

    // v2.14.x: poll page.url() until it stops changing for STABLE_MS
    // before continuing. After clicking the typeahead candidate, LinkedIn
    // navigates /messaging/compose/?recipient=… → /messaging/thread/new/
    // ?isTYAHFlow=true&… for some recipient combinations (typically when
    // an existing thread between the same participants already exists).
    // The navigation destroys the JS execution context and breaks any
    // subsequent page.evaluate. Both reproductions in 2026-05-15 logs
    // (kenya5/peter → pinky-salaria):
    //   17:00 run: "Execution context was destroyed"
    //   21:44 run: "Runtime.callFunctionOn timed out" (CDP protocolTimeout)
    // User-confirmed via manual GoLogin repro 2026-05-16 00:20 — the URL
    // transition fires for pinky+antonio for kenya5's account. Without
    // this wait, the pill-verify page.evaluate below races the navigation.
    //
    // If LinkedIn doesn't redirect (most leads), the URL stays constant
    // and we exit within ~1.7s. Cost is bounded by HARD_CAP_MS.
    {
      const STABLE_MS   = 1500;
      const HARD_CAP_MS = 8000;
      const POLL_MS     = 250;
      const start = Date.now();
      let lastUrl = page.url();
      let lastChangeAt = Date.now();
      let didNavigate = false;
      while (Date.now() - start < HARD_CAP_MS) {
        await new Promise(r => setTimeout(r, POLL_MS));
        let currentUrl;
        try { currentUrl = page.url(); }
        catch { currentUrl = lastUrl + '?transition'; }
        if (currentUrl !== lastUrl) {
          didNavigate = true;
          console.log(`[actions:intro] URL changed mid-flow: ${lastUrl} → ${currentUrl}`);
          lastUrl = currentUrl;
          lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt >= STABLE_MS) {
          break;
        }
      }
      if (didNavigate) {
        console.log(`[actions:intro] URL settled at ${lastUrl} — re-acquiring DOM and continuing.`);
      }
    }

    // Verify the pill appeared
    await new Promise(r => setTimeout(r, 600));
    const verified = await page.evaluate((name) => {
      const normalizeName = (v) => (v || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/^remove\s+/, '')
        .replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
      const norm = normalizeName(name);
      return Array.from(document.querySelectorAll(
        '.msg-connections-typeahead__added-recipients button[aria-label^="Remove"], button.artdeco-pill[aria-label^="Remove"]'
      )).some((b) => normalizeName(b.getAttribute('aria-label')).includes(norm));
    }, introName);

    if (!verified) {
      await page.evaluate(() => document.querySelector('[data-ortus-recipient="1"]')?.removeAttribute('data-ortus-recipient'));
      throw new Error('INTRO_RECIPIENT_NOT_FOUND: recipient-pill-not-confirmed (clicked dropdown match but pill never appeared)');
    }
  }

  // Clean up the temporary tag attribute.
  await page.evaluate(() => document.querySelector('[data-ortus-recipient="1"]')?.removeAttribute('data-ortus-recipient'));
  console.log(`[actions:intro] Recipient added: ${introName} (alreadyAdded=${alreadyAdded})`);

  // ── Step 2: fill the conversation title (group thread) ──
  await new Promise(r => setTimeout(r, 600));
  const titleResult = await page.evaluate((title) => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    // DM Assistant's getConversationTitleInputTarget
    const candidates = Array.from(document.querySelectorAll('input, textarea')).filter(isVisible);
    const target = candidates.find((c) => {
      const text = [
        c.getAttribute('aria-label'),
        c.getAttribute('placeholder'),
        c.getAttribute('name'),
        c.getAttribute('id'),
        c.getAttribute('title'),
      ].join(' ').toLowerCase();
      return text.includes('subject') || text.includes('group name') || text.includes('thread');
    });
    if (!target) return { ok: false, reason: 'title-input-not-found' };
    target.focus();
    const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(target, title); else target.value = title;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: title }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, groupTitle);
  if (!titleResult.ok) {
    console.warn(`[actions:intro] Group title field not found (${titleResult.reason}) — proceeding without title`);
  } else {
    console.log(`[actions:intro] Group title set: ${groupTitle}`);
  }

  // ── Step 3: type body via existing typeIntoField (matches the regular composer) ──
  await randomDelay(150, 300);
  const typed = await typeIntoField(page, body);
  if (!typed) throw new Error('MESSAGE_SEND_FAILED: could not type body');

  await new Promise(r => setTimeout(r, 700));

  // ── Step 4: try Send button, fall back to plain Enter (same as sendMessage) ──
  const sentByButton = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const activate = (el) => {
      el.scrollIntoView?.({ block: 'center' });
      el.focus?.();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    };
    const icon = document.querySelector('[data-test-icon*="send"]');
    const iconBtn = icon?.closest?.('button');
    if (iconBtn && isVisible(iconBtn)) return activate(iconBtn);
    for (const b of document.querySelectorAll('button[aria-label="Send" i], button[aria-label="Send message" i], button[aria-label="Send a message" i]')) {
      if (isVisible(b)) return activate(b);
    }
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const t = (b.textContent || '').trim();
      if ((t === 'Send' || t === 'Send message') && isVisible(b)) return activate(b);
    }
    const legacy = document.querySelector('button.msg-form__send-button, .msg-form__send-button, button[type="submit"][class*="msg-form"]');
    if (legacy && isVisible(legacy)) return activate(legacy);
    return false;
  });

  if (!sentByButton) {
    console.log('[actions:intro] No Send button — using plain Enter');
    await page.evaluate(() => {
      const composer = document.querySelector(
        'div[role="textbox"][aria-label*="Write a message" i], ' +
        '.msg-form__contenteditable, ' +
        '.msg-form div[contenteditable="true"], ' +
        '[role="textbox"][contenteditable="true"]'
      );
      if (!composer) return;
      composer.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* */ }
    });
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 250));
    await page.keyboard.down('Meta');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Meta');
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
  } else {
    console.log('[actions:intro] Clicked Send button');
  }

  // ── Step 5: honest verification (same as sendMessage) ──
  // v2.14.x: bumped 2500ms → 7500ms to fix the IC DM / IB false-negative
  // caught for Dianne on 2026-05-15. See the matching comment in
  // sendMessage above for the full rationale.
  await new Promise(r => setTimeout(r, 7500));
  const verified = await page.evaluate((sentText) => {
    const editor = document.querySelector(
      'div[role="textbox"][aria-label*="Write a message" i], ' +
      '.msg-form__contenteditable, ' +
      '.msg-form div[contenteditable="true"], ' +
      'div[contenteditable="true"][aria-label*="message" i]'
    );
    let composerEmpty = null;
    let editorText = '';
    if (editor) {
      editorText = (editor.textContent || editor.innerText || '').replace(/​/g, '').trim();
      composerEmpty = editorText.length === 0;
    }
    let foundInThread = false;
    const tail = (sentText || '').slice(-40).trim();
    if (tail.length >= 8) {
      const messages = document.querySelectorAll(
        '.msg-s-event-listitem, [class*="msg-s-event"], ' +
        '[class*="msg-event-listitem"], .msg-s-message-list-content li'
      );
      for (const m of messages) {
        if ((m.textContent || '').includes(tail)) { foundInThread = true; break; }
      }
    }
    return { composerEmpty, foundInThread, editorText: editorText.substring(0, 60), editorFound: !!editor };
  }, body);

  const success = verified.composerEmpty === true || verified.foundInThread === true;
  if (!success) {
    const why = verified.editorFound
      ? `composer still has text: "${verified.editorText}"`
      : 'composer not found and message not in thread';
    throw new Error(`MESSAGE_SEND_FAILED: send not confirmed (${why})`);
  }
  console.log(`[actions:intro] ✓ Intro sent (composerEmpty=${verified.composerEmpty}, foundInThread=${verified.foundInThread})`);
}

// ═════════════════════════════════════════════════════════════════════════════
// sendIntroViaCleanCompose — v2.58.x (STANDALONE INTRODUCTION CAMPAIGN ONLY)
// ═════════════════════════════════════════════════════════════════════════════
// Why this exists alongside sendIntroMessage:
//
// sendIntroMessage navigates to /messaging/compose/?recipient=<leadSlug> —
// it URL-routes the lead as the first pill. When the operator has prior 1:1
// message history with that lead, LinkedIn's compose URL parameter collapses
// the page into the existing 1:1 thread instead of opening fresh compose.
// The "Group name (optional)" field never renders, and sending in that state
// delivers the body as a 1:1 DM to the lead, silently discarding the 2nd pill.
// Operator-confirmed root cause 2026-05-19.
//
// sendIntroViaCleanCompose mirrors the operator's MANUAL workflow:
//   1. Open plain /messaging/compose/ (no ?recipient= param)
//   2. Typeahead-add the LEAD by name (firstName + lastName from sheet)
//   3. Typeahead-add the PRIMARY by name
//   4. LinkedIn now treats this as a fresh group thread (Group name field
//      renders, send creates a NEW thread, no existing-1:1 interference).
//   5. Title → body → send.
//
// SCOPE: standalone Introduction Campaign (introduce_back mode) only.
// CC+IC's auto-intro path keeps using sendIntroMessage above — unchanged.
// Operator constraint 2026-05-19: do NOT touch CC+IC.
// ═════════════════════════════════════════════════════════════════════════════

export async function sendIntroViaCleanCompose(page, body, leadFullName, primaryName, groupTitle = '', opts = {}) {
  if (!body) throw new Error('IC_INTRO_FAILED: body required');
  if (!leadFullName) throw new Error('IC_INTRO_FAILED: leadFullName required (combine First Name + Last Name from sheet)');
  if (!primaryName) throw new Error('IC_INTRO_FAILED: primaryName required (templates.introName)');

  const composeUrl = 'https://www.linkedin.com/messaging/compose/';
  console.log(`[actions:ic-clean] Opening plain compose (no recipient param) → ${composeUrl}`);
  try {
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.warn(`[actions:ic-clean] Compose navigation warning: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 1500));

  // Wait for compose to be fully booted + the recipient input + body textbox.
  try {
    await page.waitForFunction(() => {
      if (!document.body || !document.body.classList.contains('boot-complete')) return false;
      const hasRecipient = !!document.querySelector(
        'input[aria-label*="recipient" i], input[placeholder*="name" i], ' +
        'input[class*="msg-connections-typeahead__search-field"]'
      );
      const hasBody = !!document.querySelector(
        'div[role="textbox"][aria-label*="Write a message" i], .msg-form__contenteditable'
      );
      return hasRecipient && hasBody;
    }, { timeout: 30000, polling: 'mutation' });
  } catch {
    throw new Error('IC_INTRO_FAILED: compose UI did not load (recipient input or body missing)');
  }

  // Add a recipient via the LinkedIn typeahead. Mirrors the proven pattern
  // from sendIntroMessage's typeahead path but tagged with a different
  // data-attribute so the two functions can't interfere if both run in the
  // same session.
  async function addRecipientViaTypeahead(name, expectedAvatarToken = '') {
    const TAG = 'data-ortus-ic-recipient';

    // Locate + tag a visible recipient input.
    const tagged = await page.evaluate((tagAttr) => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const candidates = Array.from(document.querySelectorAll(
        'input, [contenteditable="true"][role="textbox"]'
      )).filter(visible);
      for (const el of candidates) {
        const text = [
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.getAttribute('class'),
          el.getAttribute('id'),
        ].join(' ').toLowerCase();
        // Avoid the message body (Write a message...) and group name input.
        if (text.includes('write a message') || text.includes('group name') || text.includes('subject')) continue;
        if (text.includes('recipient') || text.includes('type a name')
            || text.includes('msg-connections-typeahead__search-field')
            || text.includes('enter message recipients')) {
          el.setAttribute(tagAttr, '1');
          return { ok: true, tag: el.tagName };
        }
      }
      return { ok: false };
    }, TAG);
    if (!tagged.ok) throw new Error(`IC_INTRO_FAILED: recipient input not found before adding "${name}"`);

    const sel = `[${TAG}="1"]`;

    // Click to focus, then paste the name (single atomic input — avoids
    // per-char debounce drops on slow renderers).
    try { await page.click(sel); } catch { /* best-effort */ }
    await page.evaluate((s, text) => {
      const el = document.querySelector(s);
      if (!el) return;
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
                  || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true,
        inputType: 'insertFromPaste', data: text,
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, sel, name);
    console.log(`[actions:ic-clean] Pasted recipient: "${name}"`);
    await new Promise(r => setTimeout(r, 1500));

    // Poll for the typeahead dropdown to open, then click the best match.
    //
    // Selection rules (operator-confirmed 2026-05-19):
    //   1. The candidate's NAME must match firstName + lastName
    //   2. The candidate must be a 1st-degree connection (innerText contains "1st")
    //   3. Usually the first dropdown result satisfies both — but we don't
    //      assume that, we verify.
    //
    // Why innerText (not textContent): plain compose typeahead rows include
    // hidden accessibility nodes like "status is offline" / "in a meeting".
    // textContent picks those up and produces false matches; innerText only
    // returns visibly-rendered text. The existing sendIntroMessage in this
    // file uses the same pattern — kept identical for parity.
    const clickResult = await page.evaluate(async (wantName, expectedToken) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
      };
      const activate = (el) => {
        el.scrollIntoView?.({ block: 'center' });
        el.focus?.();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
        el.click();
      };
      const normalizeName = (v) => (v || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/^remove\s+/, '')
        .replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
      const norm = normalizeName(wantName);
      const tokens = norm.split(/\s+/).filter(Boolean);
      const isFirstDegree = (text) => /\b1st\b|1st\s*degree|·\s*1st/i.test(text);
      const isGroupRow = (text) => /participants|group message/i.test(text);
      // Stable avatar media-id token — identical between this dropdown row and
      // the person's profile-page photo (verified live 2026-06-16). This is the
      // ONLY per-candidate identity signal the messaging typeahead exposes (no
      // slug, no member-id), so it's how we tell same-name people apart.
      const avatarTokenOf = (el) => {
        const img = el.querySelector('img');
        const src = img ? (img.getAttribute('src') || img.getAttribute('data-delayed-url') || '') : '';
        return (String(src).match(/image\/v2\/([^\/]+)\//) || [])[1] || '';
      };
      // Collect ALL name-matching, non-group candidates (1st-degree preferred),
      // returning each one's avatar token. We never auto-click the first of
      // several same-name rows — the caller disambiguates by photo. Mirrors the
      // pure pickRecipientByIdentity in match-primary.js (keep in sync).
      const collectMatches = (cands) => {
        const nameHit = (text) => {
          const t = normalizeName(text);
          if (t === norm || t.startsWith(`${norm} `)) return true;
          const words = t.split(/\s+/);
          return tokens.length > 0 && tokens.every(tok => words.some(w => w.startsWith(tok)));
        };
        const people = cands
          .map((el, i) => ({ el, i, text: el.innerText || '' }))
          .filter(p => !isGroupRow(p.text) && nameHit(p.text));
        const firstDeg = people.filter(p => isFirstDegree(p.text));
        const chosen = firstDeg.length > 0 ? firstDeg : people;
        return chosen.map(p => ({
          idx: p.i,
          token: avatarTokenOf(p.el),
          name: (p.text || '').trim().split('\n')[0].slice(0, 120),
        }));
      };
      const decide = (matched) => {
        if (matched.length === 0) return { action: 'none' };
        if (matched.length === 1) return { action: 'click', idx: matched[0].idx, reason: 'single', name: matched[0].name };
        if (!expectedToken) return { action: 'ambiguous', reason: 'ambiguous-no-reference', names: matched.map(m => m.name) };
        const photo = matched.filter(m => m.token && m.token === expectedToken);
        if (photo.length === 1) return { action: 'click', idx: photo[0].idx, reason: 'photo-match', name: photo[0].name };
        return { action: 'ambiguous', reason: photo.length === 0 ? 'ambiguous-no-photo-match' : 'ambiguous-multiple-photo-match', names: matched.map(m => m.name) };
      };

      let lastCandidateCount = 0, lastCandidatePreview = '';
      let stableMatchCount = -1, stableTicks = 0, lastMatched = [];
      // Poll up to 50 * 200ms = 10s. Mirrors sendIntroMessage timing.
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        const roots = Array.from(document.querySelectorAll(
          '.msg-connections-typeahead__search-results, [role="listbox"], .reusable-search__entity-result-list'
        ));
        const searchRoots = roots.length ? roots : [document];
        let candidates = [];
        for (const root of searchRoots) {
          const found = Array.from(root.querySelectorAll(
            'li, [role="option"], button, .msg-connections-typeahead__search-result, .reusable-search__result-container'
          )).filter(isVisible);
          if (found.length > candidates.length) candidates = found;
        }
        if (candidates.length > lastCandidateCount) {
          lastCandidateCount = candidates.length;
          lastCandidatePreview = candidates.slice(0, 3).map(c => (c.innerText || '').trim().split('\n')[0]).join(' | ');
        }
        const matched = collectMatches(candidates);
        if (matched.length === 0) { stableMatchCount = -1; stableTicks = 0; continue; }
        // Wait for the match set to stop growing (same count across 2 ticks)
        // before deciding — a mid-render list can paint one same-name row before
        // the second, which would defeat the photo-disambiguation check.
        if (matched.length === stableMatchCount) stableTicks++;
        else { stableMatchCount = matched.length; stableTicks = 0; }
        lastMatched = matched;
        if (stableTicks >= 1) {
          const d = decide(matched);
          if (d.action === 'click') {
            activate(candidates[d.idx]);
            return { ok: true, matched: d.name, reason: d.reason, candidateCount: candidates.length };
          }
          if (d.action === 'ambiguous') {
            return { ok: false, ambiguous: true, reason: d.reason, names: d.names, candidateCount: candidates.length };
          }
        }
      }
      // Timed out without a stable set — if the last snapshot was ambiguous,
      // surface that (skip-on-doubt); otherwise report no usable match.
      if (lastMatched.length > 1) {
        const d = decide(lastMatched);
        if (d.action === 'ambiguous') return { ok: false, ambiguous: true, reason: d.reason, names: d.names, candidateCount: lastCandidateCount };
      }
      return { ok: false, candidateCount: lastCandidateCount, preview: lastCandidatePreview };
    }, name, expectedAvatarToken);

    if (clickResult.ambiguous) {
      // Two+ people share this name and we can't be SURE which is the intended
      // one by profile photo. Never guess — throw so runAutoIntros stamps the
      // row "Skipped — multiple same-name matches" (boss report 2026-06-16).
      throw new Error(`IC_INTRO_AMBIGUOUS_RECIPIENT: "${name}" — ${clickResult.reason} (${(clickResult.names || []).join(' / ')})`);
    }
    if (!clickResult.ok) {
      const detail = clickResult.candidateCount === 0
        ? 'typeahead dropdown never opened — confirm 1st-degree connection'
        : `dropdown had ${clickResult.candidateCount} suggestion(s) but none matched (saw: ${clickResult.preview})`;
      throw new Error(`IC_INTRO_RECIPIENT_NOT_FOUND: "${name}" — ${detail}`);
    }
    console.log(`[actions:ic-clean] Clicked typeahead match for "${name}" (${clickResult.reason}): ${clickResult.matched}`);

    // Cleanup the tag so the next iteration's locator hits a fresh input.
    await page.evaluate((tagAttr) => {
      document.querySelector(`[${tagAttr}="1"]`)?.removeAttribute(tagAttr);
    }, TAG);

    // Settle: pill needs to render and recipient input refocuses for next entry.
    await new Promise(r => setTimeout(r, 1200));
  }

  // Step 1 — add the lead. opts.leadAvatarToken (the lead's real profile-photo
  // token) disambiguates same-name people; empty unless the caller resolved it.
  await addRecipientViaTypeahead(leadFullName, opts.leadAvatarToken || '');

  // Step 2 — add the primary.
  await addRecipientViaTypeahead(primaryName, opts.primaryAvatarToken || '');

  // Settle for LinkedIn to render the "Group name (optional)" field. With
  // both pills added via typeahead (no URL routing), LinkedIn renders this
  // field on the 2nd pill commit. The wait is operator-confirmed safety
  // margin for slow renderers.
  await new Promise(r => setTimeout(r, 1500));

  // Gated dedupe probe (CC+IC note-branch only; IB passes no opts so this is
  // skipped → IB behaviour byte-for-byte identical). With both pills committed,
  // LinkedIn surfaces an existing lead+primary GROUP thread's history inline.
  // Any message events ⇒ the trio already has an intro thread ⇒ abort with the
  // SAME signal the URL path throws so runAutoIntros stamps "Introduction Already
  // Made" and sends nothing. The connection note lives in the 1:1 chat (sender +
  // lead only), which cannot appear in this lead+primary group compose — so the
  // note can never false-trip this. See spec 2026-06-10-ccic-note-group-intro.
  if (opts && opts.dedupeProbe) {
    await new Promise(r => setTimeout(r, 800));
    const eventCount = await page.evaluate(() => document.querySelectorAll(
      '.msg-s-event-listitem, [class*="msg-s-event"], [class*="msg-event-listitem"], .msg-s-message-list-content li'
    ).length);
    if (eventCount > 0) {
      console.log(`[actions:ic-clean] Existing group thread detected (${eventCount} msg events) — already introduced; aborting before send.`);
      throw new Error('INTRO_ALREADY_EXISTS');
    }
    console.log('[actions:ic-clean] Group compose empty — proceeding to send.');
  }

  // Step 3 — fill the Group name (conversation title) if provided.
  if (groupTitle) {
    const titleResult = await page.evaluate((title) => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const candidates = Array.from(document.querySelectorAll('input, textarea')).filter(visible);
      const target = candidates.find((c) => {
        const text = [
          c.getAttribute('aria-label'),
          c.getAttribute('placeholder'),
          c.getAttribute('name'),
          c.getAttribute('id'),
          c.getAttribute('title'),
        ].join(' ').toLowerCase();
        return text.includes('group name') || text.includes('subject') || text.includes('thread');
      });
      if (!target) return { ok: false, reason: 'title-input-not-found' };
      target.focus();
      const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(target, title); else target.value = title;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: title }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }, groupTitle);
    if (titleResult.ok) console.log(`[actions:ic-clean] Group title set: ${groupTitle}`);
    else console.warn(`[actions:ic-clean] Group title field not found (${titleResult.reason}) — proceeding without title`);
  }

  // Step 4 — type body into the composer.
  await randomDelay(150, 300);
  const typed = await typeIntoField(page, body);
  if (!typed) throw new Error('IC_INTRO_FAILED: could not type body into composer');
  await new Promise(r => setTimeout(r, 700));

  // Step 5 — click Send (button → plain Enter fallback). Same pattern
  // as sendMessage / sendIntroMessage.
  const sentByButton = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
    };
    const activate = (el) => {
      el.scrollIntoView?.({ block: 'center' });
      el.focus?.();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
      el.click();
      return true;
    };
    const icon = document.querySelector('[data-test-icon*="send"]');
    const iconBtn = icon?.closest?.('button');
    if (iconBtn && isVisible(iconBtn)) return activate(iconBtn);
    for (const b of document.querySelectorAll('button[aria-label="Send" i], button[aria-label="Send message" i], button[aria-label="Send a message" i]')) {
      if (isVisible(b)) return activate(b);
    }
    for (const b of document.querySelectorAll('button, [role="button"]')) {
      const t = (b.textContent || '').trim();
      if ((t === 'Send' || t === 'Send message') && isVisible(b)) return activate(b);
    }
    const legacy = document.querySelector('button.msg-form__send-button, .msg-form__send-button, button[type="submit"][class*="msg-form"]');
    if (legacy && isVisible(legacy)) return activate(legacy);
    return false;
  });

  if (!sentByButton) {
    console.log('[actions:ic-clean] No Send button — using plain Enter');
    await page.evaluate(() => {
      const composer = document.querySelector(
        'div[role="textbox"][aria-label*="Write a message" i], ' +
        '.msg-form__contenteditable, ' +
        '.msg-form div[contenteditable="true"], ' +
        '[role="textbox"][contenteditable="true"]'
      );
      if (!composer) return;
      composer.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch { /* */ }
    });
    await page.keyboard.press('Enter');
  } else {
    console.log('[actions:ic-clean] Clicked Send button');
  }

  await new Promise(r => setTimeout(r, 1500));
  console.log('[actions:ic-clean] ✓ Intro sent via clean compose typeahead path');
}

// ═════════════════════════════════════════════════════════════════════════════
// resolveSalesNavUrlFromInProfile
// ═════════════════════════════════════════════════════════════════════════════
// Pure helper: clicks the More dropdown on a /in/ profile and extracts the
// "View in Sales Navigator" href via a three-tier lookup (dropdown-scoped
// anchor → any anchor with /sales/{lead,people}/ → text-match item with
// child a[href]). Does NOT navigate. Returns the absolute URL string on
// success or null on failure. Never throws — callers choose their own
// failure mode.
// ═════════════════════════════════════════════════════════════════════════════

export async function resolveSalesNavUrlFromInProfile(page) {
  console.log('[actions] resolveSalesNavUrlFromInProfile: opening More dropdown…');

  let moreOk = false;
  try {
    moreOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const more = btns.find(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const t = (b.textContent || '').trim().toLowerCase();
        return a === 'more actions' || a === 'more' || t === 'more';
      });
      if (more) { more.click(); return true; }
      return false;
    });
  } catch (e) {
    console.warn(`[actions] resolveSalesNavUrlFromInProfile: More click failed: ${e.message}`);
    return null;
  }

  if (!moreOk) {
    console.warn('[actions] resolveSalesNavUrlFromInProfile: More button not found');
    return null;
  }

  await new Promise(r => setTimeout(r, 2500));

  let salesNavUrl = null;
  try {
    salesNavUrl = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/sales/lead/') || href.includes('/sales/people/')) {
          const inDropdown = a.closest('.artdeco-dropdown__content, [role="menu"]');
          if (inDropdown) return a.href;
        }
      }
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (href.includes('/sales/lead/') || href.includes('/sales/people/')) return a.href;
      }
      const items = Array.from(document.querySelectorAll('[role="button"], .artdeco-dropdown__item, li'));
      for (const el of items) {
        const text = (el.textContent || '').trim();
        if (text.includes('View in Sales Navigator')) {
          const a = el.querySelector('a[href]');
          if (a) return a.href;
        }
      }
      return null;
    });
  } catch (e) {
    console.warn(`[actions] resolveSalesNavUrlFromInProfile: href extract failed: ${e.message}`);
    return null;
  }

  if (salesNavUrl) {
    console.log(`[actions] resolveSalesNavUrlFromInProfile: resolved → ${salesNavUrl}`);
  } else {
    console.warn('[actions] resolveSalesNavUrlFromInProfile: no Sales Nav href found in dropdown');
  }
  return salesNavUrl || null;
}

// ═════════════════════════════════════════════════════════════════════════════
// sendInMail
// ═════════════════════════════════════════════════════════════════════════════

export async function sendInMail(page, subject, message) {
  // InMail goes through Sales Navigator for both local and gologin accounts.
  // Path: More dropdown → extract Sales Nav href → page.goto(href) →
  // click Message on the Sales Nav lead page → type → Send.
  //
  // If caller already navigated to Sales Nav (performOutreach's upfront
  // conversion for OP/InMail modes), skip the internal resolve+goto —
  // backward-compatible for /in/ callers, no-op for Sales Nav callers.
  const alreadyOnSalesNav = SALES_NAV_URL_RE.test(page.url());
  if (!alreadyOnSalesNav) {
    const salesNavUrl = await resolveSalesNavUrlFromInProfile(page);
    if (!salesNavUrl) throw new Error('INMAIL_SEND_FAILED: View in Sales Navigator href not found');

    console.log(`[actions] Navigating to Sales Nav: ${salesNavUrl}`);
    try {
      await page.goto(salesNavUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.warn(`[actions] Sales Nav navigation issue: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  // Click Message on the Sales Nav lead page, inspect panel, type and send.
  // Uses the shared Sales Nav primitives defined below.
  const msgClicked = await clickSalesNavMessageButton(page);
  if (!msgClicked) throw new Error('INMAIL_SEND_FAILED: Sales Nav Message button missing');

  await new Promise(r => setTimeout(r, 3500));

  const panel = await readSalesNavComposerState(page);
  if (panel.creditsAvailable === 0) {
    throw new Error('INMAIL_NO_CREDITS: 0 InMail credits remaining — stopping InMail sends');
  }
  if (panel.creditsAvailable !== null) {
    console.log(`[actions] InMail credits available before send: ${panel.creditsAvailable}`);
  } else {
    console.warn('[actions] Could not read InMail credit counter (regex miss)');
  }

  const sendResult = await typeAndSendSalesNavComposer(page, subject, message);
  if (!sendResult.ok) throw new Error(`INMAIL_SEND_FAILED: ${sendResult.error}`);

  const creditsLeft = panel.creditsAvailable !== null ? Math.max(0, panel.creditsAvailable - 1) : null;
  console.log(`[actions] ✓ InMail sent via Sales Navigator. Credits remaining: ${creditsLeft ?? 'unknown'}`);
  return { creditsLeft };
}

// ═════════════════════════════════════════════════════════════════════════════
// Sales Nav router — shared primitives + entry point
// ═════════════════════════════════════════════════════════════════════════════
// Some sheets contain direct Sales Navigator URLs (linkedin.com/sales/people/…
// or /sales/lead/…) instead of standard /in/… profile URLs. The regular
// /in/-shaped status check + Open Profile / InMail flows misread the Sales
// Nav DOM. This router short-circuits both flows for Sales Nav URLs and
// drives the Sales Nav Message composer directly.
//
// The same three primitives are also reused by sendInMail, which ends up on a
// Sales Nav page via the /in/ More-dropdown. Zero duplicated Sales Nav logic.
// ═════════════════════════════════════════════════════════════════════════════

async function clickSalesNavMessageButton(page) {
  return await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    for (const b of btns) {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.textContent || '').trim().toLowerCase();
      if ((t === 'message' || aria.startsWith('message') || aria.includes('message')) && b.offsetWidth > 0) {
        b.click();
        return true;
      }
    }
    return false;
  });
}

async function readSalesNavComposerState(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    // v2.72: positive "this send is free" signals. LinkedIn shows distinct copy
    // per free path: "Free to Open Profile", "Free to TeamLink, which means you
    // can send them a message", or a plain "free message" (e.g. existing
    // connections). Any of these confirms a no-credit send.
    const isFreeToTeamLink = /free to teamlink/i.test(text);
    const isFreeToOpenProfile = /free to open profile/i.test(text);
    const isFree = /free message/i.test(text) || isFreeToTeamLink || isFreeToOpenProfile;
    const creditMatch = text.match(/Use\s+\d+\s+of\s+(\d+)\s+credits?/i);
    const hasCreditCounter = !!creditMatch;
    const creditsAvailable = creditMatch ? parseInt(creditMatch[1], 10) : null;
    const hasSubject = !!document.querySelector('input[name="subject"], input[aria-label*="Subject" i], input[placeholder*="Subject" i]');
    const hasCompose = !!document.querySelector(
      '.msg-form__contenteditable, ' +
      'div[role="textbox"][aria-label*="message" i], ' +
      'textarea[name="message"], ' +
      'textarea[aria-label*="type your message" i], ' +
      'form[data-x-conversation-widget="compose-form"] textarea'
    );
    // v2.11.3: when an account has 0 InMail credits AND the lead is NOT
    // Open Profile, Sales Nav renders the New-message panel without a
    // textbox and shows the literal copy "Sorry, you've used up all your
    // InMail credits" (body) and "No InMail credits left" (header). This
    // is a dual-fact signal: account is out of credits (eject for run)
    // AND the lead is confirmed non-OP (mark in sheet).
    const noInMailCredits =
      /sorry,?\s*you'?ve used up all your inmail credits/i.test(text) ||
      /no inmail credits left/i.test(text);
    return { isFree, isFreeToOpenProfile, isFreeToTeamLink, hasCreditCounter, creditsAvailable, hasSubject, hasCompose, noInMailCredits };
  });
}

async function typeAndSendSalesNavComposer(page, subject, body) {
  // Subject (optional — Sales Nav paid panel has it; free panel sometimes doesn't)
  if (subject) {
    await page.evaluate((subj) => {
      const subjInput = document.querySelector('input[name="subject"], input[aria-label*="Subject" i], input[placeholder*="Subject" i]');
      if (!subjInput) return;
      subjInput.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(subjInput, subj);
      subjInput.dispatchEvent(new Event('input', { bubbles: true }));
      subjInput.dispatchEvent(new Event('change', { bubbles: true }));
    }, subject);
    await new Promise(r => setTimeout(r, 600));
  }

  const typedOk = await typeIntoField(page, body);
  if (!typedOk) return { ok: false, error: 'Could not type message (Sales Nav composer)' };

  await new Promise(r => setTimeout(r, 800));
  const sendOk = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const btns = Array.from(document.querySelectorAll('button'));
      const send = btns.find(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const isSend = t === 'send' || aria === 'send' || aria.startsWith('send ');
        const isDisabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
        return isSend && !isDisabled && b.offsetWidth > 0;
      });
      if (send) { send.click(); return true; }
      await sleep(150);
    }
    return false;
  });
  if (!sendOk) return { ok: false, error: 'Send button never enabled' };

  await new Promise(r => setTimeout(r, 3000));
  return { ok: true };
}

/**
 * Assumes the page is already on a Sales Nav URL
 * (linkedin.com/sales/people/… or /sales/lead/…).
 * Decision rules match the /in/ flow exactly:
 *   - force_open_profile : free panel → send, paid panel → do NOT send.
 *   - force_inmail       : free panel → send free (OP template),
 *                          paid panel → spend 1 credit (InMail template),
 *                          0 credits  → skip.
 *
 * Returns a status object; never throws.
 */
export async function sendViaSalesNav(page, { mode, opSubject, opBody, inmailSubject, inmailBody, connectionNote }) {
  console.log(`[actions] SalesNavRouter: mode=${mode} — looking for Message button on Sales Nav page…`);

  // For the connect-with-OP-fallback mode, a missing Message button is
  // acceptable — we'll jump straight to the overflow → Connect path.
  const clicked = await clickSalesNavMessageButton(page);
  if (!clicked && mode !== 'force_connect_op_fallback') return { ok: false, reason: 'message_button_not_found' };

  let panel = { hasCompose: false, hasCreditCounter: false, creditsAvailable: null, hasSubject: false, isFree: false };
  if (clicked) {
    await new Promise(r => setTimeout(r, 3500));
    panel = await readSalesNavComposerState(page);
    console.log(`[actions] SalesNavRouter panel: ${JSON.stringify(panel)}`);
  }

  // v2.11.3: dual-fact dialog detection — checked BEFORE the generic
  // hasCompose check because in this state hasCompose is also false but
  // the cause is specific and actionable (eject account + mark lead non-OP).
  if (panel.noInMailCredits) {
    return { ok: false, reason: 'inmail_no_credits_lead_not_op' };
  }

  // force_connect_op_fallback intentionally handles the no-composer case by
  // falling through to the "..." → Connect path, so skip the early bail.
  if (!panel.hasCompose && mode !== 'force_connect_op_fallback') {
    return { ok: false, reason: 'no_compose_textbox' };
  }

  if (mode === 'force_open_profile') {
    // v2.72: "free to send" is broader than the literal "Free to Open Profile"
    // badge — TeamLink and existing 1st-degree connections also compose for
    // free. The reliable "this costs a credit" signal is the "Use X of Y
    // credits" counter (panel.hasCreditCounter). So when the compose box is
    // present (guaranteed above) with NO credit counter, the send is free
    // regardless of why. A visible credit counter means a paid InMail —
    // force_open_profile never spends credits, so skip it (the InMail-tickbox
    // path routes through force_inmail instead).
    if (panel.hasCreditCounter) {
      return { ok: false, reason: 'not_open_profile' };
    }
    const result = await typeAndSendSalesNavComposer(page, opSubject, opBody);
    if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
    console.log('[actions] ✓ Sales Nav free message sent (Open Profile / TeamLink / connected)');
    return { ok: true, kind: 'op_message_sent' };
  }

  if (mode === 'force_inmail') {
    if (!panel.hasCreditCounter) {
      // v2.72: free to send (Open Profile, TeamLink, or already connected) —
      // no credit counter means no credit cost, so send free via the OP
      // template even though the operator opted into spending credits.
      const result = await typeAndSendSalesNavComposer(page, opSubject, opBody);
      if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
      console.log('[actions] ✓ Sales Nav free message sent (InMail mode, free path)');
      return { ok: true, kind: 'op_message_sent' };
    }
    if (panel.creditsAvailable === 0) {
      return { ok: false, reason: 'no_credits' };
    }
    const result = await typeAndSendSalesNavComposer(page, inmailSubject, inmailBody);
    if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
    const creditsLeft = panel.creditsAvailable !== null ? Math.max(0, panel.creditsAvailable - 1) : null;
    console.log(`[actions] ✓ Sales Nav InMail sent. Credits remaining: ${creditsLeft ?? 'unknown'}`);
    return { ok: true, kind: 'inmail_sent', creditsLeft };
  }

  if (mode === 'force_connect_op_fallback') {
    // Connection campaign + "Message OPs Directly": try Message → if the
    // "Free to Open Profile" badge is present, send OP; otherwise close
    // and fall through to "..." → Connect.
    if (clicked) {
      // v2.72: free to send whenever the compose box is present with no credit
      // counter (Open Profile, TeamLink, or connected) — not just the literal
      // OP badge. Paid InMail (credit counter shown) falls through to Connect.
      if (panel.hasCompose && !panel.hasCreditCounter) {
        const result = await typeAndSendSalesNavComposer(page, opSubject, opBody);
        if (!result.ok) return { ok: false, reason: 'send_failed', error: result.error };
        console.log('[actions] ✓ Sales Nav free message sent (connect-with-OP-fallback)');
        return { ok: true, kind: 'op_message_sent' };
      }
      // Paid InMail panel, no composer, or not OP — close before trying Connect.
      await closeSalesNavComposer(page);
      await new Promise(r => setTimeout(r, 1000));
    }

    const overflowOpen = await clickSalesNavOverflowMenu(page);
    if (!overflowOpen) return { ok: false, reason: 'unreachable', error: 'Overflow menu button not found' };
    await new Promise(r => setTimeout(r, 1500));

    const connectOpened = await clickSalesNavConnectMenuItem(page);
    if (!connectOpened) return { ok: false, reason: 'unreachable', error: 'Connect menu item not found' };
    await new Promise(r => setTimeout(r, 2500));

    const sent = await fillAndSendSalesNavConnectModal(page, connectionNote);
    if (!sent.ok) return { ok: false, reason: 'send_failed', error: sent.error };
    console.log('[actions] ✓ Sales Nav Connect request sent (OP fallback)');
    return { ok: true, kind: 'connection_sent' };
  }

  return { ok: false, reason: 'unknown_mode' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sales Nav overflow-menu + Connect modal primitives
// ─────────────────────────────────────────────────────────────────────────────

async function clickSalesNavOverflowMenu(page) {
  return await page.evaluate(() => {
    const candidates = [
      'button[aria-label="Open actions overflow menu"]',
      'button[data-x--lead-actions-bar-overflow-menu]',
      'button[aria-haspopup="true"][aria-expanded="false"]',
    ];
    for (const sel of candidates) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetWidth > 0) { btn.click(); return true; }
    }
    return false;
  });
}

async function clickSalesNavConnectMenuItem(page) {
  // The overflow menu renders into #hue-web-menu-outlet and becomes visible
  // when .<something>_visible_... is added. We text-match "Connect" inside
  // the visible menu to find the option regardless of hashed class names.
  return await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const outlet = document.getElementById('hue-web-menu-outlet');
      if (outlet) {
        const menus = outlet.querySelectorAll('[class*="_visible_"]');
        for (const menu of menus) {
          const items = menu.querySelectorAll('li, button, [role="menuitem"], a');
          for (const item of items) {
            const txt = (item.textContent || '').trim();
            if (/^connect$/i.test(txt) && item.offsetWidth > 0) {
              item.click();
              return true;
            }
          }
        }
      }
      await sleep(150);
    }
    return false;
  });
}

async function fillAndSendSalesNavConnectModal(page, note) {
  // Fill the invitation note (optional) and click Send in .artdeco-modal__actionbar.
  if (note) {
    const filled = await page.evaluate((noteText) => {
      const ta = document.querySelector('#connect-cta-form__invitation, textarea[maxlength="300"]');
      if (!ta) return false;
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, noteText);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, note.slice(0, 300));
    if (!filled) return { ok: false, error: 'Connect modal note textarea not found' };
    await new Promise(r => setTimeout(r, 600));
  }

  const sent = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const bar = document.querySelector('.artdeco-modal__actionbar');
      if (bar) {
        const btns = Array.from(bar.querySelectorAll('button'));
        const send = btns.find(b => {
          const t = (b.textContent || '').trim().toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const isSend = t === 'send' || t === 'send invitation' || t === 'send now' || aria === 'send' || aria.startsWith('send ');
          const isDisabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
          return isSend && !isDisabled && b.offsetWidth > 0;
        });
        if (send) { send.click(); return true; }
      }
      await sleep(150);
    }
    return false;
  });
  if (!sent) return { ok: false, error: 'Send button never enabled in Connect modal' };

  await new Promise(r => setTimeout(r, 2500));
  return { ok: true };
}

async function closeSalesNavComposer(page) {
  // Close the message overlay before attempting Connect — the panel covers
  // the profile header which we need to click into.
  await page.evaluate(() => {
    const close = document.querySelector('button[aria-label*="Close" i][class*="_close_"], .msg-overlay-bubble-header__control[aria-label*="close" i]');
    if (close) { close.click(); return; }
    // Fallback: any visible close button inside the message overlay region
    const overlays = document.querySelectorAll('#message-overlay, [data-sn-view-name="subpage-message-overlay"]');
    for (const o of overlays) {
      const closeBtn = o.querySelector('button[aria-label*="close" i], button[aria-label*="dismiss" i]');
      if (closeBtn && closeBtn.offsetWidth > 0) { closeBtn.click(); return; }
    }
  });
}
