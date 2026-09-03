/**
 * src/linkedin/thread-message.js — net-new. Reopen a known group thread (the
 * one created when the intro was sent) and post the automated first follow-up.
 * Off-limits actions.js/outreach.js are NOT touched.
 *
 * isUsableThreadUrl is pure + tested; sendInThread is verified manually.
 */

import { getConversationsPage } from './helpers.js';

/** A captured page.url() is a usable thread target only if it's a real
 *  /messaging/thread/<id> URL — not a /compose, /feed, or empty fallback. */
export function isUsableThreadUrl(url) {
  if (!url) return false;
  // The segment after /thread/ must be a real thread id (2-<b64> or numeric).
  // "new" is the compose route (/thread/new/?isTYAHFlow=…) — navigating to it
  // hangs (45s nav timeout), so treat it as unusable and let the caller fall
  // back to searching Messaging by lead name.
  const m = String(url).match(/\/messaging\/thread\/([^/?#]+)/);
  return !!m && m[1] !== 'new';
}

/**
 * Type `body` into the composer of the thread at `threadUrl` and send it.
 * Falls back to searching messaging by lead name when the URL is unusable.
 * Throws on failure so the runner can mark the task failed/retry.
 */
export async function sendInThread(page, threadUrl, body, { introTitle = '', leadName = '', log = () => {} } = {}) {
  if (!body || !body.trim()) throw new Error('FOLLOWUP_EMPTY_BODY');

  let target = threadUrl;
  if (!isUsableThreadUrl(target)) {
    log(`  ↻ Follow-up: thread URL unusable, searching messaging for "${leadName}"…`);
    target = await _findThreadByLead(page, leadName, introTitle);
    if (!target) throw new Error('FOLLOWUP_THREAD_NOT_FOUND');
  }

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise(r => setTimeout(r, 2500));

  const box = await page.waitForSelector(
    'div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
    { timeout: 15000 },
  ).catch(() => null);
  if (!box) throw new Error('FOLLOWUP_COMPOSER_NOT_FOUND');

  await box.click();
  await page.keyboard.type(body, { delay: 12 });
  // 700ms (matches actions.js) — slow/overloaded operator machines need time for
  // React to process the input event and enable the send button.
  await new Promise(r => setTimeout(r, 700));

  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('button.msg-form__send-button');
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;
  });
  if (!clicked) {
    // Belt-and-suspenders keyboard fallback (mirrors actions.js): plain Enter
    // (Ortus accounts have "press Enter to send"), then Cmd+Enter, then Ctrl+Enter.
    await page.keyboard.press('Enter');
    await page.keyboard.down('Meta'); await page.keyboard.press('Enter'); await page.keyboard.up('Meta');
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  }

  // Verify the send actually landed before reporting success. Without this a
  // no-op click (React not bound yet on a slow machine) would mark the task done
  // and the follow-up would never be retried. Confirmed when the composer
  // cleared OR the sent text echoes into the thread. If neither, throw so the
  // runner retries (capped at 3 attempts).
  await new Promise(r => setTimeout(r, 3000));
  const confirmed = await page.evaluate((sentBody) => {
    const composer = document.querySelector('div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]');
    const composerEmpty = !composer || !(composer.textContent || '').trim();
    const snippet = (sentBody || '').trim().slice(0, 40).toLowerCase();
    let echoed = false;
    if (snippet) {
      const bubbles = Array.from(document.querySelectorAll('.msg-s-event-listitem__body, .msg-s-event-listitem, p'));
      echoed = bubbles.some(b => (b.textContent || '').toLowerCase().includes(snippet));
    }
    return composerEmpty || echoed;
  }, body);
  if (!confirmed) throw new Error('FOLLOWUP_SEND_UNCONFIRMED');
  log(`  ✓ Follow-up sent in the group thread${leadName ? ` (${leadName})` : ''}.`);
}

async function _findThreadByLead(page, leadName, introTitle) {
  const needle = (leadName || introTitle || '').trim();
  if (!needle) return '';
  const want = needle.toLowerCase();
  try {
    await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Let LinkedIn's own inbox XHR fire so getConversationsPage can reuse its URL.
    await new Promise(r => setTimeout(r, 4000));

    // Primary path — Voyager conversations. A CC+IC intro creates a GROUP thread;
    // the DOM conversation-list row shows a group title (not the lead's name), so
    // the old text scrape missed it. The API exposes each thread's participants,
    // so we match the lead by full name and return the real /thread/<id>/ URL.
    try {
      const res = await getConversationsPage(page, { start: 0, count: 40 });
      const convs = (res && (res.elements || res.conversations)) || (Array.isArray(res) ? res : []);
      for (const c of (Array.isArray(convs) ? convs : [])) {
        const names = c.names || c.participantNames || c.participants || [];
        const matched = names.some((n) => {
          const full = `${n.firstName || ''} ${n.lastName || ''}`.trim().toLowerCase();
          return full && (full === want || full.includes(want) || want.includes(full));
        });
        if (matched) {
          const url = c.conversationUrl || c.threadUrl || c.url
            || (c.threadId ? `https://www.linkedin.com/messaging/thread/${c.threadId}/` : '');
          if (url) return url;
        }
      }
    } catch { /* fall through to the DOM scrape */ }

    // Fallback — DOM scrape of the visible conversation list (works for 1:1s).
    return await page.evaluate((w) => {
      const rows = Array.from(document.querySelectorAll('a.msg-conversation-listitem__link, a[href*="/messaging/thread/"]'));
      const hit = rows.find(a => (a.textContent || '').toLowerCase().includes(w));
      return hit ? hit.href : '';
    }, want);
  } catch {
    return '';
  }
}
