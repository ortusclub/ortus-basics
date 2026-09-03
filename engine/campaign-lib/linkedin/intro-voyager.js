/**
 * Voyager intro-send module — 3-way introduction DM via direct API.
 *
 * Spec: docs/superpowers/specs/2026-05-18-voyager-intro-send-design.md
 * Endpoint: POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
 *
 * Used by auto-intro.js as the preferred path. If this rejects (4xx, network
 * error), the caller falls through to the existing DOM typeahead at
 * actions.js:sendIntroMessage.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { resolveProfileUrn, getSenderUrn } from './helpers.js';

const ENDPOINT = 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage';

/**
 * Build the JSON payload for the createMessage POST.
 *
 * Shape grounded in the 2026-05-18 DevTools recon captured at
 * docs/superpowers/specs/2026-05-18-voyager-intro-send-design.md.
 *
 * @param {object} args
 * @param {string} args.senderUrn        - urn:li:fsd_profile:ACoAA…
 * @param {string[]} args.recipientUrns  - [leadUrn, primaryUrn] in that order
 * @param {string} args.body             - the message body text
 * @param {string} [args.title]          - optional conversation title; omitted from payload if empty/whitespace
 * @returns {object} payload object (caller JSON.stringify's it for the POST)
 */
export function buildCreateMessagePayload({ senderUrn, recipientUrns, body, title } = {}) {
  if (!senderUrn || typeof senderUrn !== 'string') {
    throw new Error('buildCreateMessagePayload: senderUrn required');
  }
  if (!Array.isArray(recipientUrns) || recipientUrns.length === 0) {
    throw new Error('buildCreateMessagePayload: recipientUrns required (non-empty array)');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('buildCreateMessagePayload: body required');
  }

  const payload = {
    message: {
      body: { attributes: [], text: body },
      originToken: randomUUID(),
      renderContentUnions: [],
    },
    mailboxUrn: senderUrn,
    hostRecipientUrns: recipientUrns.slice(),
    dedupeByClientGeneratedToken: false,
    // 16-char alphanumeric tracking id (LinkedIn's UI uses 16 random bytes;
    // hex encoding of 8 random bytes yields exactly 16 chars reliably and
    // survives JSON encoding cleanly).
    trackingId: randomBytes(8).toString('hex'),
  };
  const t = (title || '').trim();
  if (t) payload.conversationTitle = t;
  return payload;
}

/**
 * Parse the response from a createMessage POST.
 *
 * Success shape (status 200): { value: { conversationUrn, backendConversationUrn, deliveredAt, ... } }
 * Error shape (status 4xx/5xx): arbitrary JSON or plain text; we just pass it through.
 *
 * @param {object} args
 * @param {number} args.status   - HTTP status code
 * @param {object|string} args.body - parsed JSON body (or raw string if non-JSON)
 * @returns {object} either:
 *   { ok: true,  conversationUrn, backendConversationUrn, deliveredAt }
 *   { ok: false, status, errorBody, reason? }
 */
export function parseCreateMessageResponse({ status, body } = {}) {
  if (status !== 200) {
    return { ok: false, status, errorBody: body };
  }
  const value = body && typeof body === 'object' ? body.value : null;
  if (!value || !value.conversationUrn) {
    return { ok: false, status, errorBody: body, reason: 'missing conversationUrn in response' };
  }
  return {
    ok: true,
    conversationUrn: value.conversationUrn,
    backendConversationUrn: value.backendConversationUrn || '',
    deliveredAt: value.deliveredAt || 0,
  };
}

/**
 * Resolve URNs, build payload, POST, parse response. Returns a result object
 * the caller can act on. NEVER throws — all failure modes are returned as
 * { ok: false, ... } so the caller can decide to fall back.
 *
 * @param {object} args
 * @param {puppeteer.Page} args.page     - active LinkedIn page (sender's session)
 * @param {string} args.leadUrl          - sheet URL of the lead (e.g. linkedin.com/in/cindy-pambid-1b7113338/)
 * @param {string} args.primaryUrl       - operator-configured primary person URL
 * @param {string} args.body             - personalized message body
 * @param {string} [args.title]          - personalized conversation title (best-effort)
 * @returns {Promise<object>} parseCreateMessageResponse output, with an extra
 *   `phase` field telling the caller WHICH step failed if ok=false:
 *     'resolve-lead-urn' | 'resolve-primary-urn' | 'resolve-sender-urn' |
 *     'post-network-error' | 'post-non-200' | 'parse'
 */
export async function sendIntroViaVoyager({ page, leadUrl, primaryUrl, body, title } = {}) {
  // Parse public ids from URLs (sheet-stored as full linkedin.com/in/<id>/ URLs).
  const leadPublicId = _extractPublicId(leadUrl);
  const primaryPublicId = _extractPublicId(primaryUrl);
  if (!leadPublicId) return { ok: false, phase: 'resolve-lead-urn', reason: `bad leadUrl: ${leadUrl}` };
  if (!primaryPublicId) return { ok: false, phase: 'resolve-primary-urn', reason: `bad primaryUrl: ${primaryUrl}` };

  // Resolve all three URNs (in parallel for speed).
  const [leadUrn, primaryUrn, senderUrn] = await Promise.all([
    resolveProfileUrn(page, leadPublicId),
    resolveProfileUrn(page, primaryPublicId),
    getSenderUrn(page),
  ]);
  if (!leadUrn)    return { ok: false, phase: 'resolve-lead-urn',    reason: `URN lookup empty for ${leadPublicId}` };
  if (!primaryUrn) return { ok: false, phase: 'resolve-primary-urn', reason: `URN lookup empty for ${primaryPublicId}` };
  if (!senderUrn)  return { ok: false, phase: 'resolve-sender-urn',  reason: 'URN lookup empty for self' };

  const doPost = async (payload) => {
    return await page.evaluate(async (endpoint, payloadJson) => {
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        if (!csrf) return { network: 'no-csrf' };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const resp = await fetch(endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'accept': 'application/json',
            'content-type': 'text/plain;charset=UTF-8',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
          },
          body: payloadJson,
        });
        const status = resp.status;
        const text = await resp.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        return { status, body: parsed };
      } catch (err) {
        return { network: String(err && err.message || err) };
      }
    }, ENDPOINT, JSON.stringify(payload));
  };

  // Attempt 1: with title (if present)
  const payload1 = buildCreateMessagePayload({
    senderUrn, recipientUrns: [leadUrn, primaryUrn], body, title,
  });
  const resp1 = await doPost(payload1);
  if (resp1.network) {
    return { ok: false, phase: 'post-network-error', reason: resp1.network };
  }
  const parsed1 = parseCreateMessageResponse(resp1);
  if (parsed1.ok) return { ...parsed1, phase: 'ok', titleSent: !!payload1.conversationTitle };

  // Attempt 2: retry without title, but only if title WAS set in attempt 1
  // (otherwise there's nothing to vary — fail immediately)
  if (payload1.conversationTitle) {
    const payload2 = buildCreateMessagePayload({
      senderUrn, recipientUrns: [leadUrn, primaryUrn], body, title: '',
    });
    const resp2 = await doPost(payload2);
    if (resp2.network) {
      return { ok: false, phase: 'post-network-error', reason: resp2.network, firstAttempt: parsed1 };
    }
    const parsed2 = parseCreateMessageResponse(resp2);
    if (parsed2.ok) return { ...parsed2, phase: 'ok', titleSent: false, retriedWithoutTitle: true };
    return { ok: false, phase: 'post-non-200', firstAttempt: parsed1, secondAttempt: parsed2 };
  }

  return { ok: false, phase: 'post-non-200', firstAttempt: parsed1 };
}

function _extractPublicId(url) {
  if (!url || typeof url !== 'string') return '';
  const m = url.match(/\/in\/([^/?#]+)/);
  return m ? m[1] : '';
}
