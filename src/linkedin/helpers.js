/**
 * LinkedIn helpers — v18.
 * ALL clicks use element.click() via page.evaluate().
 * NEVER page.mouse.click(). No coordinates. No viewport dependencies.
 */

/**
 * Human-like delay using a skewed (log-normal-ish) distribution.
 * Clusters near the minimum, occasionally produces longer pauses —
 * mimics how humans actually behave (quick actions with occasional longer gaps).
 */
export function randomDelay(min = 500, max = 2000) {
  const u = Math.random();
  const skewed = Math.pow(u, 0.5); // sqrt gives right-skew: most values near min
  const ms = Math.floor(min + skewed * (max - min));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Collect all Shadow DOM roots on the page — not just interop-outlet.
 * LinkedIn may use multiple Shadow DOM containers.
 */
function getAllShadowRootsScript() {
  return `
    function __getAllShadowRoots() {
      const roots = [];
      const outlet = document.getElementById('interop-outlet');
      if (outlet?.shadowRoot) roots.push(outlet.shadowRoot);
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot && el.id !== 'interop-outlet') roots.push(el.shadowRoot);
      });
      return roots;
    }
  `;
}

/**
 * LinkedIn's messaging overlay — the chat bubbles docked bottom-right of every
 * page, including profile pages.
 *
 * WHY THIS EXISTS (2026-08-10, Joyce Wong / Gerardo Salandra incident): the
 * overlay carries its own contenteditable composer AND its own "Send" button.
 * The connect-note flow looked for both page-wide, so when an operator left a
 * conversation open, the invite note was typed into the CHAT BOX and sent into
 * that thread — the lead's note delivered to whoever the operator happened to
 * be talking to, with the lead's first name in it, and no invitation ever sent
 * ("Send clicked but Pending NOT confirmed"). Cloud log 08:06:49-08:08:39
 * showed the tell: 174 typed chars with NO `x/200` note counter on screen.
 *
 * Only the invite path passes this exclusion. The messaging paths (sendMessage,
 * intro composers) must still find these elements, so it is strictly opt-in.
 */
export const MESSAGING_OVERLAY_SELECTOR = [
  '.msg-overlay-list-bubble',
  '.msg-overlay-conversation-bubble',
  '.msg-overlay-container',
  '.msg-form',
  '#msg-overlay',
].join(',');

/**
 * True when `el` sits inside the messaging overlay. Pure — `el` only needs a
 * `.closest()`. Mirrored inline inside the page.evaluate callers in actions.js
 * (browser context can't see this module) — keep the two in sync.
 */
export function isInMessagingOverlay(el, selector = MESSAGING_OVERLAY_SELECTOR) {
  if (!el || typeof el.closest !== 'function') return false;
  try { return !!el.closest(selector); } catch { return false; }
}

/**
 * Click a button by aria-label — searches regular DOM AND all Shadow DOM roots.
 * Uses element.click() which works regardless of visibility or viewport.
 *
 * `excludeWithin` (optional CSS selector) skips any button inside a matching
 * container — used by the invite flow to stay out of the messaging overlay.
 * Omitted/empty ⇒ byte-for-byte the previous behaviour.
 */
export async function clickByAria(page, ariaLabel, { excludeWithin = '' } = {}) {
  return page.evaluate((label, exclude) => {
    const skip = (el) => {
      if (!exclude || !el || typeof el.closest !== 'function') return false;
      try { return !!el.closest(exclude); } catch { return false; }
    };
    const pick = (root) => {
      for (const b of root.querySelectorAll(`button[aria-label="${label}"]`)) {
        if (!skip(b)) return b;
      }
      return null;
    };

    // Regular DOM
    const btn = pick(document);
    if (btn) { btn.click(); return 'dom'; }

    // All Shadow DOM roots
    const roots = [];
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.shadowRoot) roots.push(outlet.shadowRoot);
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot && el.id !== 'interop-outlet') roots.push(el.shadowRoot);
    });
    for (const root of roots) {
      const sBtn = pick(root);
      if (sBtn) { sBtn.click(); return 'shadow'; }
    }

    return null;
  }, ariaLabel, excludeWithin);
}

/**
 * Click a button by its exact text content — searches regular DOM + all Shadow DOMs.
 * `excludeWithin` behaves exactly as in clickByAria.
 */
export async function clickByText(page, text, { excludeWithin = '' } = {}) {
  return page.evaluate((t, exclude) => {
    const skip = (el) => {
      if (!exclude || !el || typeof el.closest !== 'function') return false;
      try { return !!el.closest(exclude); } catch { return false; }
    };
    const pick = (root) => Array.from(root.querySelectorAll('button'))
      .find(b => b.textContent?.trim() === t && !skip(b)) || null;

    // Regular DOM
    const btn = pick(document);
    if (btn) { btn.click(); return 'dom'; }

    // All Shadow DOM roots
    const roots = [];
    const outlet = document.getElementById('interop-outlet');
    if (outlet?.shadowRoot) roots.push(outlet.shadowRoot);
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot && el.id !== 'interop-outlet') roots.push(el.shadowRoot);
    });
    for (const root of roots) {
      const sBtn = pick(root);
      if (sBtn) { sBtn.click(); return 'shadow'; }
    }

    return null;
  }, text, excludeWithin);
}

/**
 * Find a button by text and click it via JS (regular DOM only).
 */
export async function findButtonByText(page, text) {
  const byAria = await page.$(`button[aria-label*="${text}"]`);
  if (byAria) return byAria;

  const byText = await page.evaluateHandle((t) => {
    return Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === t) || null;
  }, text);
  return byText.asElement();
}

/**
 * Fast connection degree check via LinkedIn's internal Voyager API.
 * Runs fetch() inside the page context so it inherits all cookies/headers.
 * Returns 1, 2, 3, or null (if API call fails or profile not found).
 *
 * This is much more reliable than DOM scraping for degree detection.
 * Falls back gracefully — callers should still use getConnectionStatus() as backup.
 */
/**
 * Fetch the account's recent connections via Voyager. One paginated API call
 * per page (up to MAX_PAGES) — far cheaper than checking N pending invites
 * individually. Returns an array of { urn, publicId, firstName, lastName,
 * memberNumber, location, connectedAt } objects sorted recent-first (location
 * is filled only for connections that go through the enrichment pass). Empty
 * array on any failure
 * (caller should fall back to per-lead checks if needed).
 *
 * The page must already be on a LinkedIn URL so JSESSIONID is available.
 * If you're not sure, navigate to /mynetwork/invite-connect/connections/
 * before calling this. We intentionally do NOT navigate inside the helper
 * so the caller can decide pacing.
 *
 * @param {puppeteer.Page} page
 * @param {number} sinceMs - Only return connections with connectedAt >= this
 *   (epoch ms). Pass 0 to fetch all pages up to maxPages.
 * @param {Object} [opts]
 * @param {number} [opts.maxPages=2] - How many 40-row pages to walk. The
 *   default keeps the 6h bulk-check sweep cheap. Operation Magellan passes a
 *   large value to walk the whole network instead of just recent acceptances.
 */
export async function getRecentConnections(page, sinceMs = 0, { maxPages = 2, onEnrichProgress = null } = {}) {
  try {
    const result = await page.evaluate(async ({ since, maxPages: pageCap }) => {
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        // Name the location instead of pasting the path. Two reasons: the log
        // has to read out loud to an operator, and the raw path is actively
        // dangerous here — LinkedIn's connections URL contains the substring
        // "network", which magellan-diagnose.js rule 73 matches, so pasting it
        // reclassified "no-csrf" and "http-429" as a GoLogin connection fault.
        // Caught 2026-08-31 before release by running both classifiers over the
        // new message shapes.
        const whereTab = () => {
          const path = (location.pathname || '');
          if (!path || path === 'blank') return 'a blank page';
          if (/\/checkpoint/.test(path)) return 'a security checkpoint';
          if (/\/login|\/uas\//.test(path)) return 'the sign-in page';
          if (/invite-connect\/connections/.test(path)) return 'the connections page';
          if (/mynetwork/.test(path)) return 'the connections area';
          if (/\/feed/.test(path)) return 'the feed';
          return path;
        };
        // "no-csrf" reads like a glitch, but a logged-out tab and a security
        // checkpoint have no JSESSIONID either, so this is the most common way
        // an expired session shows up. The location says which it was.
        if (!csrf) return { error: `no-csrf (tab was on ${whereTab()})` };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const headers = {
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': token,
          'x-restli-protocol-version': '2.0.0',
        };

        const PAGE_SIZE = 40;
        // Default caps at the 80 most-recent connections — covers ~2-3 days of
        // acceptances at the steady-state pace, plenty for the 6h
        // bulk-check cadence. Old caps (8 pages × 40 = 320) pulled too
        // much history each sweep and made the sidecar tab churn a lot.
        // Magellan overrides this to walk the whole network.
        const MAX_PAGES = pageCap;

        // Try endpoints in priority order. LinkedIn has shipped multiple
        // connection-list endpoints over the years; the /relationshipsDash/
        // and legacy /relationships/connections variants are still around
        // on different account types. We probe each on page 0 to see which
        // one returns 200, then settle on it for the remaining pages.
        const endpointFactories = [
          (start) => `https://www.linkedin.com/voyager/api/relationships/dash/connections`
            + `?count=${PAGE_SIZE}&start=${start}&q=search&sortType=RECENTLY_ADDED`,
          (start) => `https://www.linkedin.com/voyager/api/relationships/connections`
            + `?count=${PAGE_SIZE}&start=${start}&q=search&sortType=RECENTLY_ADDED`,
          (start) => `https://www.linkedin.com/voyager/api/relationships/connectionsV2`
            + `?count=${PAGE_SIZE}&start=${start}&q=search&sortType=RECENTLY_ADDED`,
        ];

        let chosenFactory = null;
        let probeStatus = null;
        let probeBodySample = '';
        for (const factory of endpointFactories) {
          const probe = await fetch(factory(0), { headers, credentials: 'include' });
          probeStatus = probe.status;
          if (probe.ok) {
            // Sample the first ~400 chars in case this returns a non-JSON
            // gateway page (Cloudflare interstitial, login redirect HTML).
            const text = await probe.clone().text();
            probeBodySample = text.slice(0, 400);
            // Quick sanity: must look like JSON, not an HTML login page.
            if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
              chosenFactory = factory;
              break;
            }
          }
        }
        if (!chosenFactory) {
          return { error: `no-endpoint-ok (last status: ${probeStatus}, sample: ${probeBodySample.slice(0, 120)})` };
        }

        const out = [];
        let stoppedEarly = false;
        let firstPageKeys = '';
        let totalHint = null;
        // Set when the walk ended early on a network failure past page 1. The
        // connections collected before it are still good.
        let partial = null;
        // Progress beacon. The whole walk happens inside this one evaluate(), so
        // without it a 7,000-connection account looks frozen for minutes. Node
        // polls window.__ortusConnProgress; callers that don't care just ignore it.
        const _beat = (pagesDone) => {
          try {
            window.__ortusConnProgress = {
              pages: pagesDone, count: out.length, total: totalHint, at: Date.now(),
            };
          } catch { /* progress must never break the walk */ }
        };

        for (let p = 0; p < MAX_PAGES && !stoppedEarly; p++) {
          const start = p * PAGE_SIZE;
          // A page-context fetch throws a bare "Failed to fetch" for anything
          // network-level: the tab navigating away, LinkedIn dropping the
          // connection, the browser going down. One retry rides out a blip
          // rather than throwing away everything collected so far, and the
          // error we do report says where it happened and where the tab was —
          // "Failed to fetch" on its own is unactionable.
          // A non-OK status used to end the account on the spot. LinkedIn hands
          // back 429 and 999 here routinely under load, and those are momentary
          // throttles, not a verdict: one of them cost a whole sweep and stopped
          // the campaign's sending. Retried like the network errors below, but
          // with a longer pause, because a throttle wants seconds. 401/403 are
          // deliberately NOT retryable — they mean logged out, and repeating
          // them only delays telling the operator to sign the account back in.
          const RETRYABLE_STATUS = [429, 500, 502, 503, 504, 999];
          let resp = null;
          let fetchErr = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            let throttled = false;
            try {
              fetchErr = null;
              resp = await fetch(chosenFactory(start), { headers, credentials: 'include' });
              if (resp.ok || !RETRYABLE_STATUS.includes(resp.status)) break;
              throttled = true;
            } catch (e) {
              fetchErr = e;
            }
            if (attempt < 2) await new Promise((r) => setTimeout(r, throttled ? 3000 * (attempt + 1) : 1500));
          }
          if (fetchErr) {
            const where = `${fetchErr.message} (page ${p + 1}, ${out.length} collected, tab was on ${whereTab()})`;
            if (p === 0) return { error: where };
            // Past the first page: keep what we have and say so upstream.
            partial = where;
            break;
          }
          if (!resp.ok) {
            // Same shape as the fetch-error line above. The "http-NNN" prefix is
            // load-bearing: sweepHealth() and magellan-diagnose.js both classify
            // 429/999 off it, so it stays first and only context is appended.
            if (p === 0) return { error: `http-${resp.status} (page ${p + 1}, ${out.length} collected, tab was on ${whereTab()})` };
            break;
          }

          const data = await resp.json();
          if (p === 0) {
            firstPageKeys = Object.keys(data || {}).join(',');
            // LinkedIn reports the network size on the first page. Used to show
            // "1,240 of 7,213" instead of a counter with no end in sight.
            const t = data?.paging?.total ?? data?.data?.paging?.total ?? null;
            if (typeof t === 'number' && t > 0) totalHint = t;
          }

          // Build a urn → entity map from `included` once per page so any
          // strategy can resolve member references in O(1).
          const includedById = {};
          // ALSO build a memberId-portion → entity map. LinkedIn often stores
          // Profile entities under `urn:li:fs_miniProfile:ACoAA...` while the
          // Connection's connectedMember references `urn:li:fsd_profile:ACoAA...`
          // (different prefix for the same person). This second index lets us
          // match by the ACoAA portion regardless of prefix differences.
          const includedByMemberId = {};
          // Helper extracts ACoAA / ACwAA from any URN-like string.
          const _midOf = (s) => {
            if (!s) return '';
            const m = String(s).match(/(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
            return m ? m[1] : '';
          };
          if (Array.isArray(data.included)) {
            for (const item of data.included) {
              if (!item) continue;
              if (item.entityUrn) includedById[item.entityUrn] = item;
              const mid = _midOf(item.entityUrn);
              if (mid && (item.publicIdentifier || item.firstName || item.lastName)) {
                // Prefer entries that have actual name/slug data — overwrite
                // a stub if a fuller entry comes along later in `included`.
                const existing = includedByMemberId[mid];
                if (!existing || (!existing.publicIdentifier && !existing.firstName)) {
                  includedByMemberId[mid] = item;
                }
              }
            }
          }
          // Resolve a connectedMember URN (or any URN) to its richest profile
          // entity by trying direct match first, then ACoAA-portion match.
          const _resolveMember = (memberUrn) => {
            if (typeof memberUrn !== 'string' || !memberUrn) return {};
            const direct = includedById[memberUrn];
            if (direct && (direct.publicIdentifier || direct.firstName)) return direct;
            const mid = _midOf(memberUrn);
            const byMid = mid ? includedByMemberId[mid] : null;
            return byMid || direct || {};
          };

          let pageOut = 0;

          // Strategy A — direct elements array (older Voyager endpoints).
          const directElements = data?.elements || data?.data?.elements || [];
          if (directElements.length) {
            for (const el of directElements) {
              const createdAt = el.createdAt || el.connectedAt || 0;
              if (since && createdAt && createdAt < since) { stoppedEarly = true; break; }
              const memberUrn = el.connectedMember || el['*connectedMember'] || el.miniProfile || '';
              const member = (typeof memberUrn === 'string' ? _resolveMember(memberUrn) : el.connectedMember) || {};
              out.push({
                urn: typeof memberUrn === 'string' ? memberUrn : (member.entityUrn || ''),
                publicId: member.publicIdentifier || '',
                firstName: member.firstName || '',
                lastName: member.lastName || '',
                memberNumber: (member.objectUrn && typeof member.objectUrn === 'string'
                  && (member.objectUrn.match(/urn:li:member:(\d+)/) || [])[1]) || '',
                connectedAt: createdAt || 0,
              });
              pageOut++;
            }
          }

          // Strategy B — normalized JSON: data["*elements"] is an array of
          // URN refs, resolved against `included`. The newer connections
          // endpoint returns this shape.
          if (pageOut === 0) {
            const elementUrns = data?.data?.['*elements'] || data?.['*elements'] || [];
            if (Array.isArray(elementUrns) && elementUrns.length) {
              for (const connectionUrn of elementUrns) {
                const conn = includedById[connectionUrn];
                if (!conn) continue;
                const createdAt = conn.createdAt || conn.connectedAt || 0;
                if (since && createdAt && createdAt < since) { stoppedEarly = true; break; }
                const memberUrn = conn.connectedMember || conn['*connectedMember'] || '';
                const member = _resolveMember(memberUrn);
                out.push({
                  urn: typeof memberUrn === 'string' ? memberUrn : (member.entityUrn || ''),
                  publicId: member.publicIdentifier || '',
                  firstName: member.firstName || '',
                  lastName: member.lastName || '',
                  // Strategies A and C already read this; B dropped it. The numeric
                  // member id is the ONLY identity that bridges a Sales-Nav
                  // /in/ACwAA… sheet URL to a Voyager ACoAA… URN (the two token
                  // forms share no substring), so without it an ACwAA-sourced sheet
                  // can never detect an acceptance.
                  memberNumber: (member.objectUrn && typeof member.objectUrn === 'string'
                    && (member.objectUrn.match(/urn:li:member:(\d+)/) || [])[1]) || '',
                  connectedAt: createdAt || 0,
                });
                pageOut++;
              }
            }
          }

          // Strategy C — fallback: scan `included` for any profile-shaped
          // entity. Match risk: same response can include "people you may
          // know" suggestions, but we'll filter strictly by URN/publicId
          // matching against the sheet later, so non-connections that
          // happen to live here won't false-positive someone who's actually
          // pending. Worst case: they'd be marked Connected when they're
          // really a strong-signal suggestion. Acceptable for the operator's
          // workflow given Voyager's shape variance.
          if (pageOut === 0 && Array.isArray(data.included)) {
            for (const item of data.included) {
              if (!item) continue;
              const urn = item.entityUrn || '';
              const isProfileUrn = urn.indexOf('urn:li:fsd_profile:') === 0
                || urn.indexOf('urn:li:fs_miniProfile:') === 0
                || urn.indexOf('urn:li:fsd_lazyLoadedActions:') === 0;
              if (!isProfileUrn) continue;
              if (!item.publicIdentifier && !item.firstName) continue;
              out.push({
                urn,
                publicId: item.publicIdentifier || '',
                firstName: item.firstName || '',
                lastName: item.lastName || '',
                memberNumber: (item.objectUrn && typeof item.objectUrn === 'string'
                  && (item.objectUrn.match(/urn:li:member:(\d+)/) || [])[1]) || '',
                connectedAt: 0,
              });
              pageOut++;
            }
          }

          _beat(p + 1);

          if (pageOut === 0) {
            if (p === 0) return { error: `empty-after-3-strategies (keys: ${firstPageKeys}, included.len: ${(data.included || []).length})` };
            break;
          }
          if (pageOut < PAGE_SIZE) break;
        }

        return { connections: out, firstPageKeys, total: totalHint, partial };
      } catch (err) {
        return { error: err.message };
      }
    }, { since: sinceMs, maxPages });

    if (result?.error) {
      console.log(`[helpers] getRecentConnections error: ${result.error}`);
      // Return a special sentinel so callers can surface the exact reason
      // upward (instead of just an empty array meaning "nothing found").
      const empty = [];
      empty.error = result.error;
      return empty;
    }
    let conns = result?.connections || [];
    if (result?.partial) console.warn(`[helpers] getRecentConnections stopped early: ${result.partial}`);
    console.log(`[helpers] Voyager bulk: ${conns.length} recent connections fetched (keys: ${result?.firstPageKeys || ''})`);

    // Enrichment pass — when the connections list returns URNs only (no
    // publicIdentifier or firstName), do a follow-up bulk lookup against
    // /voyager/api/identity/dash/profiles to fill in those fields. Lets
    // matching by slug or name work even when the slim connections payload
    // doesn't carry them.
    // Also enrich a conn that HAS a slug/name but no numeric member id — that id
    // is the only bridge to a Sales-Nav /in/ACwAA… sheet URL, and the slim
    // connections payload rarely carries it.
    const needsEnrich = conns.filter((c) => c.urn && ((!c.publicId && !c.firstName) || !c.memberNumber));
    if (needsEnrich.length > 0) {
      try {
        const enriched = await _enrichProfilesByUrn(page, needsEnrich.map((c) => c.urn), onEnrichProgress);
        if (enriched && enriched.size > 0) {
          conns = conns.map((c) => {
            const e = enriched.get(c.urn);
            if (!e) return c;
            return {
              ...c,
              publicId: c.publicId || e.publicId || '',
              firstName: c.firstName || e.firstName || '',
              lastName: c.lastName || e.lastName || '',
              memberNumber: c.memberNumber || e.memberNumber || '',
              // Location lives ONLY on the enriched profile — the slim
              // connections payload never carries it (Operation Magellan 2026-08).
              location: c.location || e.location || '',
            };
          });
          const filledSlugs = conns.filter((c) => c.publicId).length;
          const filledNames = conns.filter((c) => c.firstName || c.lastName).length;
          const filledNums = conns.filter((c) => c.memberNumber).length;
          const filledLocs = conns.filter((c) => c.location).length;
          console.log(`[helpers] Profile enrichment: ${filledSlugs} slugs, ${filledNames} names, ${filledNums} member-numbers, ${filledLocs} locations filled (of ${conns.length})`);
        }
      } catch (err) {
        console.log(`[helpers] Profile enrichment threw: ${err.message}`);
      }
    }

    // Same array-with-a-property convention as `.error`: existing callers keep
    // treating it as a plain array, Magellan reads the note.
    if (result?.partial) conns.partial = result.partial;
    return conns;
  } catch (err) {
    console.log(`[helpers] getRecentConnections threw: ${err.message}`);
    const empty = [];
    empty.error = err.message;
    return empty;
  }
}

/**
 * Bulk-resolve URN → {publicId, firstName, lastName} via Voyager's identity
 * profiles batch endpoint. Used to enrich the connections list when its
 * primary endpoint returns slim entities (URNs only). Batches in groups of
 * 25 to keep URLs under typical proxy length limits.
 *
 * Returns a Map keyed by the FULL URN string (e.g. urn:li:fsd_profile:ACoAA…).
 */
async function _enrichProfilesByUrn(page, urns, onProgress = null) {
  const out = new Map();
  if (!Array.isArray(urns) || urns.length === 0) return out;

  // Dedup + filter to URNs that look right.
  const unique = [...new Set(urns.filter((u) => typeof u === 'string' && u.includes('urn:li:fsd_profile:')))];
  if (unique.length === 0) return out;

  const BATCH = 25;
  // 6,000 connections is ~250 sequential round-trips here. Without a beat the
  // caller has nothing to show for several minutes and the run reads as hung —
  // the page walk already publishes progress, so this half must too.
  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    if (onProgress) onProgress({ done: i, total: unique.length });
    const batchOut = await page.evaluate(async (urnBatch) => {
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        // Name the location instead of pasting the path. Two reasons: the log
        // has to read out loud to an operator, and the raw path is actively
        // dangerous here — LinkedIn's connections URL contains the substring
        // "network", which magellan-diagnose.js rule 73 matches, so pasting it
        // reclassified "no-csrf" and "http-429" as a GoLogin connection fault.
        // Caught 2026-08-31 before release by running both classifiers over the
        // new message shapes.
        const whereTab = () => {
          const path = (location.pathname || '');
          if (!path || path === 'blank') return 'a blank page';
          if (/\/checkpoint/.test(path)) return 'a security checkpoint';
          if (/\/login|\/uas\//.test(path)) return 'the sign-in page';
          if (/invite-connect\/connections/.test(path)) return 'the connections page';
          if (/mynetwork/.test(path)) return 'the connections area';
          if (/\/feed/.test(path)) return 'the feed';
          return path;
        };
        // "no-csrf" reads like a glitch, but a logged-out tab and a security
        // checkpoint have no JSESSIONID either, so this is the most common way
        // an expired session shows up. The location says which it was.
        if (!csrf) return { error: `no-csrf (tab was on ${whereTab()})` };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        // Voyager's List(...) format with each URN URL-encoded individually.
        const idsParam = 'List(' + urnBatch.map((u) => encodeURIComponent(u)).join(',') + ')';
        const base = `https://www.linkedin.com/voyager/api/identity/dash/profiles?ids=${idsParam}`;

        // A DECORATION is what makes LinkedIn resolve each profile's geoLocation
        // into a named Geo entity inside `included` (e.g. "New York, New York,
        // United States"). The plain call returns only an unresolvable geo URN.
        // The -NN version rotates and a stale one 400s, so try a couple of
        // known-good full-profile decorations, then fall back to the plain call —
        // identity (name / publicId / member id) still works there, just without
        // location. Full-profile decorations carry objectUrn, so the member id
        // the sheet matches on is preserved.
        const attempts = [
          `${base}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfile-58`,
          `${base}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-66`,
          base,
        ];
        let data = null;
        for (const u of attempts) {
          const resp = await fetch(u, {
            headers: {
              'accept': 'application/vnd.linkedin.normalized+json+2.1',
              'csrf-token': token,
              'x-restli-protocol-version': '2.0.0',
            },
            credentials: 'include',
          });
          if (resp.ok) { data = await resp.json(); break; }
        }
        if (!data) return { error: 'http-all-decorations-failed' };

        // Index `included` by entityUrn so a profile's geoLocation reference can
        // be resolved to a human location string (e.g. "New York, United
        // States"). The dash Profile carries geo as a URN pointing at a Geo
        // entity; the display name lives on that entity.
        const includedById = {};
        if (Array.isArray(data?.included)) {
          for (const it of data.included) if (it && it.entityUrn) includedById[it.entityUrn] = it;
        }
        // Defensive: LinkedIn returns geo in several shapes across decorations.
        // Try the direct string forms, then a nested geo object, then resolve a
        // geo URN against `included`. Returns '' when nothing usable is present.
        const locationOf = (item) => {
          if (!item || typeof item !== 'object') return '';
          if (typeof item.geoLocationName === 'string' && item.geoLocationName) return item.geoLocationName;
          if (typeof item.locationName === 'string' && item.locationName) return item.locationName;
          const gl = item.geoLocation;
          let geoUrn = '';
          if (typeof gl === 'string') geoUrn = gl;
          else if (gl && typeof gl === 'object') {
            if (gl.geo && typeof gl.geo === 'object' && gl.geo.defaultLocalizedName) return gl.geo.defaultLocalizedName;
            geoUrn = gl['*geo'] || gl['*geoLocation'] || gl.geoUrn || gl.entityUrn || '';
          }
          if (!geoUrn && typeof item['*geoLocation'] === 'string') geoUrn = item['*geoLocation'];
          const g = geoUrn && includedById[geoUrn];
          if (g) {
            return g.defaultLocalizedName
              || g.defaultLocalizedNameWithoutCountryName
              || (g.geo && g.geo.defaultLocalizedName) || '';
          }
          return '';
        };

        // Walk both `results` (newer) and `included` (normalized) for profile
        // entities — different decorations land them in different places.
        const profiles = [];
        if (data?.results && typeof data.results === 'object') {
          for (const u of urnBatch) {
            const p = data.results[u];
            if (p) profiles.push({ urn: u, ...p, location: locationOf(p) });
          }
        }
        if (Array.isArray(data?.included)) {
          for (const item of data.included) {
            if (item && item.entityUrn && (item.publicIdentifier || item.firstName)) {
              profiles.push({
                urn: item.entityUrn,
                publicId: item.publicIdentifier || '',
                firstName: item.firstName || '',
                lastName: item.lastName || '',
                // urn:li:member:NNN — the numeric identity the sheet's Member ID
                // column matches on.
                memberNumber: (typeof item.objectUrn === 'string'
                  && (item.objectUrn.match(/urn:li:member:(\d+)/) || [])[1]) || '',
                location: locationOf(item),
              });
            }
          }
        }
        return { profiles };
      } catch (err) {
        return { error: err.message };
      }
    }, slice);

    if (batchOut?.error) {
      console.log(`[helpers] Profile enrich batch error: ${batchOut.error}`);
      continue; // try the next batch — partial results are still useful
    }
    for (const p of (batchOut?.profiles || [])) {
      // Index by both the original requested URN and any URN we found in
      // included (they may differ slightly in prefix). The bulk-check
      // matcher already handles ACoAA-portion fallback.
      out.set(p.urn, {
        publicId: p.publicId || p.publicIdentifier || '',
        firstName: p.firstName || '',
        lastName: p.lastName || '',
        memberNumber: p.memberNumber
          || (typeof p.objectUrn === 'string' && (p.objectUrn.match(/urn:li:member:(\d+)/) || [])[1])
          || '',
        location: p.location || '',
      });
    }
  }
  return out;
}

/**
 * Capture the current profile page's URN + member ID so the campaign can
 * stamp it into the sheet alongside the connect action. Future bulk-check
 * sweeps then have a precise (URN-format) identifier to match against —
 * no more relying on slugs vs URNs vs names.
 *
 * Runs from a logged-in profile page. Returns { urn, memberId } where:
 *   - `urn`      = full string like "urn:li:fs_profile:ACoAA…"
 *   - `memberId` = the ACoAA / ACwAA portion (what bulk-check uses)
 * Either field may be empty if Voyager refuses or the page isn't loaded.
 *
 * Kept as a thin wrapper over captureProfileMeta for backward compatibility.
 */
export async function getProfileUrn(page) {
  const meta = await captureProfileMeta(page);
  return { urn: meta.urn || '', memberId: meta.memberId || '' };
}

/**
 * Wait for the profile top-card to actually render before reading identity.
 *
 * Why this exists (2026-06-15): the identity gate captured at
 * `domcontentloaded + 2.5s`, but LinkedIn paints the profile <h1> (the display
 * name) client-side AFTER that. So `captureProfileMeta` read an empty name on
 * EVERY lead — the `name-match` identity signal never fired, leaving the gate
 * to lean entirely on the Voyager member-number API. Under rate-limiting that
 * API is throttled, so healthy profiles (right person, fully loadable) were
 * skipped as "no-member-number-captured (profile did not load)". Polling for
 * the rendered <h1> first lets the DOM-based name read succeed, so name-match
 * can confirm the lead independently of the throttled API. Resolves the instant
 * the name paints (≈1-2s on a healthy load — faster than the old fixed 2.5s);
 * only a genuinely-stuck page waits the full timeout. Best-effort: a timeout
 * just proceeds and captures whatever is there (no worse than before).
 */
export async function waitForProfileRender(page, { timeoutMs = 10000 } = {}) {
  try {
    await page.waitForFunction(() => {
      const h1 = document.querySelector('main h1')
              || document.querySelector('h1.text-heading-xlarge')
              || document.querySelector('h1');
      return !!(h1 && (h1.textContent || '').trim().length > 0);
    }, { timeout: timeoutMs }).catch(() => { /* fall through — capture what's there */ });
  } catch { /* best-effort */ }
}

/**
 * Capture URN + member ID + Open Profile flag + connection degree in one
 * pass from the current profile page. Used immediately after a connect
 * action so the campaign can stamp all four columns at once.
 *
 * Returns { urn, memberId, isOpenProfile, connectionDegree } where:
 *   - `urn`              = full URN string or '' if not found
 *   - `memberId`         = the ACoAA / ACwAA portion of the URN or ''
 *   - `isOpenProfile`    = true | false | null (null = couldn't tell)
 *   - `connectionDegree` = 1 | 2 | 3 | null
 *
 * Defensive: tries Voyager profile endpoint, then dash variant, then
 * scans the rendered HTML for a URN pattern. Network info (degree) is
 * a separate Voyager call and falls back to the existing helper.
 */
// v2.113.x — does an "Invite <name> to connect" aria-label refer to THIS lead?
// A profile page renders many such labels (the lead's own Connect button PLUS
// every "People you may know" / "More profiles for you" recommendation). The
// connect flow must bind its click to the lead, or a note for "Mary" fires on a
// recommended "Dr David Foo" (the 2026-06-22 wrong-send).
//
// `leadName` is the FULL profile name (from the top-card h1). The label must
// carry the lead's FIRST and LAST name (as whole words) — first-name-only would
// let a recommended "David Foo" satisfy a lead "David Smith"; requiring every
// token would break on credential suffixes ("Pauline Loo MBA, MSc") or a dropped
// middle name. Word-boundary + unicode-aware so "mary" never matches "Rosemary"
// and an accented name counts as a whole word. Initials (<2 chars, e.g. "L.")
// are ignored. Returns false when either side is empty (cannot confirm → caller
// must skip, never guess). Pure — no DOM/I/O. Mirrored inline inside
// sendConnectionRequest's page.evaluate (keep the two in sync).
// v2.113.x — recover the lead's name from the page <title> when the profile
// <h1> comes back empty (lazy paint / shadow DOM — the 2026-06-22 Choon case
// where her visible Connect was never clicked because the name read "").
// Strips a "(3)" unread-count prefix and the " | LinkedIn" / " - <headline>"
// tail, leaving just the name. Hyphenated names survive (the split requires
// spaces around the separator). Mirrors getConnectionStatus's title fallback;
// mirrored inline in sendConnectionRequest's page.evaluate. Pure — no DOM/I/O.
export function leadNameFromTitle(title) {
  return String(title || '')
    .replace(/^\(\d+\)\s*/, '')
    .split(/\s[|–-]\s/)[0]
    .trim();
}

export function inviteAriaMatchesLeadName(ariaLabel, leadName) {
  const aria = String(ariaLabel || '').toLowerCase();
  if (!aria.includes('invite') || !aria.includes('to connect')) return false;
  const tokens = String(leadName || '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  if (!tokens.length) return false;
  const hasWord = (t) => {
    const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return new RegExp(`(^|\\P{L})${safe}(\\P{L}|$)`, 'u').test(aria); }
    catch { return aria.includes(t); }
  };
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (!hasWord(first)) return false;
  if (last !== first && !hasWord(last)) return false;
  return true;
}

// v2.112.x — LinkedIn caps custom-invite notes (free = 200 chars, Premium ~300);
// a longer note greys out Send so the invite can't go. The old flow "clicked"
// the dead Send, then burned ~60s + 3 retries verifying a send that never
// happened — on every lead, since the template length is the same for all.
//
// PRIMARY signal (v2.112.x, after the 2026-06-22 DOM capture): LinkedIn's own
// character counter "<current>/<max>" (e.g. 203/200 free, 250/300 Premium). The
// note is over the platform's limit ⇔ current > max. This is exactly the
// condition that greys Send, needs NO hard-coded number, and is Premium-safe
// (250/300 is under → not skipped). It also fixes the v2.112.40 miss: that
// version keyed on the Send button's `disabled` property, but LinkedIn greys
// Send via a CSS class, so `sendDisabled` read false and it never tripped.
//
// FALLBACK (counter unreadable): a disabled Send + an over-`freeLimit` typed
// note. Caller reads `sendDisabled` in all its forms (property / aria / class).
// Pure — caller reads the facts off the modal and passes them in.
export function isNoteOverFreeLimit({ counterCurrent, counterMax, sendDisabled, typedLen, freeLimit = 200 } = {}) {
  if (Number.isFinite(counterMax) && counterMax > 0 && Number.isFinite(counterCurrent)) {
    return counterCurrent > counterMax;
  }
  if (!sendDisabled) return false;
  if (!Number.isFinite(typedLen)) return false;
  return typedLen > freeLimit;
}

// v2.112.31 — choose the TARGET profile entity from a Voyager `included` array.
// The array carries BOTH the viewer's own profile (often FIRST) and the lead's,
// so taking the first profile entity grabs the SENDER (the 2026-06-22 Candice/
// Pravin false-skip). Match by the page's publicId instead: a vanity slug matches
// `publicIdentifier`; an encoded /in/AC?AA token matches by member-token body
// prefix (same-member ACwAA/ACoAA forms share ≥6 leading body chars, per
// profile-identity.js). Returns the entity object, or null when nothing matches
// (caller falls back to its previous best-effort pick). Pure — no DOM/I/O.
export function pickTargetProfile(included, publicId) {
  if (!Array.isArray(included) || !publicId) return null;
  const isProfileUrn = (s) => typeof s === 'string'
    && (s.indexOf('urn:li:fsd_profile:') === 0
        || s.indexOf('urn:li:fs_miniProfile:') === 0
        || s.indexOf('urn:li:fs_profile:') === 0);
  const tokenBody = (s) => { const m = String(s || '').match(/AC[ow]AA([A-Za-z0-9_-]+)/); return m ? m[1] : ''; };
  const encoded = /^AC[ow]AA/i.test(publicId);
  const pidLow = String(publicId).toLowerCase();
  const pidBody = encoded ? tokenBody(publicId) : '';
  let prefixMatch = null;
  for (const it of included) {
    if (!it || !isProfileUrn(it.entityUrn)) continue;
    if (!encoded && it.publicIdentifier && String(it.publicIdentifier).toLowerCase() === pidLow) return it;
    if (encoded && pidBody && !prefixMatch) {
      const eBody = tokenBody(it.entityUrn);
      let n = 0; const len = Math.min(eBody.length, pidBody.length);
      while (n < len && eBody[n] === pidBody[n]) n++;
      if (n >= 6) prefixMatch = it;
    }
  }
  return prefixMatch;
}

export async function captureProfileMeta(page) {
  const out = { urn: '', memberId: '', memberNumber: '', name: '', isOpenProfile: null, connectionDegree: null };

  // ── Voyager calls (URN + openProfile + numeric member number) ──
  try {
    const voyResult = await page.evaluate(async () => {
      function extractMemberId(urnStr) {
        const m = urnStr && urnStr.match(/(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
        return m ? m[1] : '';
      }
      // Find the numeric member ID OF THE TARGET PROFILE (not the
      // requesting account, whose URN is also present in many fields).
      // Strategy: walk `included` for the entity whose entityUrn's ACoAA
      // portion matches the target's ACoAA portion, then read its
      // `objectUrn` (LinkedIn convention: `urn:li:member:NNN`).
      function extractTargetMemberNumber(data, targetUrn) {
        const targetMidM = targetUrn && targetUrn.match(/(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
        const targetMid = targetMidM ? targetMidM[1] : '';
        if (!targetMid || !Array.isArray(data?.included)) return '';
        for (const item of data.included) {
          if (!item || typeof item.entityUrn !== 'string') continue;
          if (item.entityUrn.indexOf(targetMid) === -1) continue;
          const obj = item.objectUrn || '';
          const m = typeof obj === 'string' && obj.match(/urn:li:member:(\d+)/);
          if (m) return m[1];
        }
        return '';
      }
      function findOpenProfileFlag(obj, depth) {
        if (!obj || depth > 6 || typeof obj !== 'object') return null;
        // Common LinkedIn field names indicating Open Profile membership.
        const keys = ['openLink', 'openProfile', 'openProfileMember', 'isOpenProfile', 'openLinkSettings'];
        for (const k of keys) {
          if (k in obj) {
            const v = obj[k];
            if (v === true || v === false) return v;
            if (v && typeof v === 'object') return true; // settings present = enabled
          }
        }
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (v && typeof v === 'object') {
            const r = findOpenProfileFlag(v, depth + 1);
            if (r !== null) return r;
          }
        }
        return null;
      }
      // v2.112.30/31 — the lead's display name straight from the Voyager JSON we
      // already fetched, for the chosen TARGET URN only. Used as the fallback
      // when pickTargetProfile didn't supply a name directly. Deliberately does
      // NOT scan for "any named profile": the response also holds the viewer's
      // (sender's) profile, and a loose scan grabbed it (the Pravin false-skip).
      // No match → '' (caller treats an empty name as no signal → safe skip).
      function extractProfileName(d, profileUrn) {
        function nameOf(o) {
          if (!o || typeof o !== 'object') return '';
          const fn = typeof o.firstName === 'string' ? o.firstName.trim() : '';
          const ln = typeof o.lastName === 'string' ? o.lastName.trim() : '';
          return (fn + ' ' + ln).trim();
        }
        if (Array.isArray(d && d.included) && profileUrn) {
          for (const it of d.included) {
            if (it && it.entityUrn === profileUrn) { const n = nameOf(it); if (n) return n; }
          }
        }
        return '';
      }
      try {
        const m = window.location.pathname.match(/\/in\/([^/]+)/);
        if (!m) return { reason: 'not-on-profile-url', url: window.location.href };
        const publicId = m[1];

        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        if (!csrf) return { reason: 'no-csrf' };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const endpoints = [
          `https://www.linkedin.com/voyager/api/identity/profiles/${publicId}`,
          `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${publicId}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-7`,
        ];
        let data = null;
        let lastStatus = 0;
        for (const url of endpoints) {
          try {
            const resp = await fetch(url, {
              headers: {
                'accept': 'application/vnd.linkedin.normalized+json+2.1',
                'csrf-token': token,
                'x-restli-protocol-version': '2.0.0',
              },
              credentials: 'include',
            });
            lastStatus = resp.status;
            if (resp.ok) { data = await resp.json(); break; }
          } catch { /* try next */ }
        }
        if (!data) return { reason: 'voyager-failed', lastStatus };

        // Only accept profile-typed URNs. The dash endpoint's top-level
        // entityUrn is `urn:li:collectionResponse:…` (the response envelope
        // itself), which is NOT what we want — we need the entity inside.
        function isProfileUrn(s) {
          return typeof s === 'string'
            && (s.indexOf('urn:li:fsd_profile:') === 0
                || s.indexOf('urn:li:fs_miniProfile:') === 0
                || s.indexOf('urn:li:fs_profile:') === 0);
        }
        const urnCandidates = [];
        for (const cand of [data?.entityUrn, data?.data?.entityUrn,
                            data?.profile?.entityUrn, data?.miniProfile?.entityUrn]) {
          if (isProfileUrn(cand)) urnCandidates.push(cand);
        }
        // Scan the `included` array (collection responses put the actual
        // profile entity here) AND `data["*elements"]` (URN references).
        if (Array.isArray(data?.included)) {
          for (const item of data.included) {
            if (item && isProfileUrn(item.entityUrn)) urnCandidates.push(item.entityUrn);
          }
        }
        if (Array.isArray(data?.data?.['*elements'])) {
          for (const ref of data.data['*elements']) {
            if (isProfileUrn(ref)) urnCandidates.push(ref);
          }
        }
        // v2.112.31 — pick the TARGET entity (NOT the viewer). `included` carries
        // both the sender's own profile (often first) and the lead's; matching by
        // the page's publicId selects the right one. In-browser twin of the tested
        // pickTargetProfile() in this file — keep the two in sync.
        let targetEntity = null;
        {
          const enc = /^AC[ow]AA/i.test(publicId);
          const pidLow = String(publicId).toLowerCase();
          const body = (s) => { const mm = String(s || '').match(/AC[ow]AA([A-Za-z0-9_-]+)/); return mm ? mm[1] : ''; };
          const pidBody = enc ? body(publicId) : '';
          let pre = null;
          if (Array.isArray(data?.included)) {
            for (const it of data.included) {
              if (!it || !isProfileUrn(it.entityUrn)) continue;
              if (!enc && it.publicIdentifier && String(it.publicIdentifier).toLowerCase() === pidLow) { targetEntity = it; break; }
              if (enc && pidBody && !pre) {
                const eb = body(it.entityUrn);
                let n = 0; const len = Math.min(eb.length, pidBody.length);
                while (n < len && eb[n] === pidBody[n]) n++;
                if (n >= 6) pre = it;
              }
            }
          }
          if (!targetEntity) targetEntity = pre;
        }
        // urn drives memberId + memberNumber + name, so selecting the target
        // entity's URN fixes all of them at once. Fall back to the old best-effort
        // pick only when no entity matched the publicId.
        const urn = (targetEntity && targetEntity.entityUrn) || urnCandidates[0] || '';
        const memberId = extractMemberId(urn);
        const memberNumber = extractTargetMemberNumber(data, urn);
        const openProfile = findOpenProfileFlag(data, 0); // true | null
        let name = '';
        if (targetEntity) {
          const fn = (targetEntity.firstName || '').toString().trim();
          const ln = (targetEntity.lastName || '').toString().trim();
          name = (fn + ' ' + ln).trim();
        }
        if (!name) name = extractProfileName(data, urn);
        return { urn, memberId, memberNumber, openProfile, name, reason: 'ok' };
      } catch (err) {
        return { reason: 'evaluate-threw', message: String(err && err.message || err) };
      }
    });
    if (voyResult && voyResult.urn) out.urn = voyResult.urn;
    if (voyResult && voyResult.memberId) out.memberId = voyResult.memberId;
    if (voyResult && voyResult.memberNumber) out.memberNumber = voyResult.memberNumber;
    // v2.112.30 — seed the name from Voyager; the DOM <h1> read below still
    // overrides it when present (so the literal displayed name wins), but this
    // recovers the name when the <h1> scrape comes back empty.
    if (voyResult && voyResult.name) out.name = voyResult.name;
    if (voyResult && voyResult.openProfile === true) out.isOpenProfile = true;
    // Track whether Voyager actually returned data — used at the end to
    // default isOpenProfile to false (definitive negative) only when we
    // successfully fetched the profile data and saw no OP signals.
    if (voyResult && voyResult.reason === 'ok') out._voyagerSucceeded = true;
    if (voyResult && voyResult.reason && voyResult.reason !== 'ok') {
      console.log(`[helpers] captureProfileMeta voyager: ${voyResult.reason}${voyResult.lastStatus ? ' (status=' + voyResult.lastStatus + ')' : ''}${voyResult.url ? ' (url=' + voyResult.url + ')' : ''}`);
    }
  } catch (err) {
    console.log(`[helpers] captureProfileMeta voyager threw: ${err.message}`);
  }

  // ── HTML-scan fallback for URN + numeric member number ──
  // For memberNumber: pick the most-frequent `urn:li:member:NNN` in the
  // page — the target profile is referenced dozens of times (profile
  // card, work history, sidebar mentions) while the viewing account
  // appears only in auth/nav context. Most-frequent ≈ target.
  if (!out.urn || !out.memberNumber) {
    try {
      const scanResult = await page.evaluate(() => {
        try {
          const html = document.documentElement.outerHTML;
          const urnM = html.match(/urn:li:fsd_profile:(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/)
                    || html.match(/urn:li:fs_miniProfile:(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/)
                    || html.match(/urn:li:fs_profile:(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
          const counts = new Map();
          const re = /urn:li:member:(\d+)/g;
          let m;
          while ((m = re.exec(html)) !== null) {
            counts.set(m[1], (counts.get(m[1]) || 0) + 1);
          }
          let bestId = '';
          let bestCount = 0;
          for (const [id, c] of counts) {
            if (c > bestCount) { bestCount = c; bestId = id; }
          }
          return {
            urn: urnM ? urnM[0] : '',
            memberId: urnM ? urnM[1] : '',
            memberNumber: bestId,
          };
        } catch { return null; }
      });
      if (scanResult) {
        if (!out.urn && scanResult.urn) {
          out.urn = scanResult.urn;
          out.memberId = scanResult.memberId || out.memberId;
          console.log(`[helpers] captureProfileMeta HTML-scan recovered URN`);
        }
        if (!out.memberNumber && scanResult.memberNumber) {
          out.memberNumber = scanResult.memberNumber;
          console.log(`[helpers] captureProfileMeta HTML-scan recovered member number (most-frequent)`);
        }
      }
    } catch { /* best-effort */ }
  }

  // ── Connection degree: Voyager networkinfo, then DOM badge fallback ──
  try {
    const deg = await getVoyagerDegree(page);
    if (typeof deg === 'number') out.connectionDegree = deg;
  } catch { /* best-effort */ }
  if (out.connectionDegree === null) {
    try {
      const badge = await getDegreeBadge(page);
      if (badge === '1st') out.connectionDegree = 1;
      else if (badge === '2nd') out.connectionDegree = 2;
      else if (badge === '3rd' || badge === '3rd+') out.connectionDegree = 3;
    } catch { /* best-effort */ }
  }

  // ── Open Profile fallback: scan rendered HTML for the badge text ──
  // LinkedIn shows "Open to" / "Open Profile" labels in several spots on
  // premium-with-Open-Profile members. If the Voyager scan above didn't
  // yield a boolean, we look for the visible badge as a last resort.
  if (out.isOpenProfile === null) {
    try {
      const opScan = await page.evaluate(() => {
        try {
          const html = document.documentElement.outerHTML || '';
          // Strong signals — these only appear on Open Profile members.
          if (/"openLink"\s*:\s*\{/.test(html)) return true;
          if (/"openProfile"\s*:\s*true/.test(html)) return true;
          if (/openProfileMember"?\s*:\s*true/.test(html)) return true;
          // Visible-text fallback: the "Message" button reads
          // "Send Open Profile message" on OP members.
          if (/Send Open Profile message/i.test(html)) return true;
          return null; // unknown — don't write false on negative
        } catch { return null; }
      });
      if (opScan === true) out.isOpenProfile = true;
    } catch { /* best-effort */ }
  }

  // If Voyager fetched cleanly and the HTML scan also found no OP signal,
  // record a definitive 'No' rather than leaving the column blank.
  if (out.isOpenProfile === null && out._voyagerSucceeded) {
    out.isOpenProfile = false;
  }
  delete out._voyagerSucceeded;

  // ── Display name (v2.96.0 — for pre-send identity verification) ──
  // Read the profile top-card <h1>. The caller compares this to the sheet
  // lead's First+Last name so a mis-loaded profile is caught BEFORE any
  // connection request is sent (the "Hi Divya → Dion Kadriu" class of bug).
  try {
    const nm = await page.evaluate(() => {
      try {
        const h1 = document.querySelector('main h1')
                || document.querySelector('h1.text-heading-xlarge')
                || document.querySelector('h1');
        return h1 ? (h1.textContent || '').replace(/\s+/g, ' ').trim() : '';
      } catch { return ''; }
    });
    if (nm) out.name = nm;
  } catch { /* best-effort */ }

  if (out.urn || out.memberId || out.memberNumber || out.name || out.isOpenProfile !== null || out.connectionDegree !== null) {
    console.log(`[helpers] captureProfileMeta: name="${out.name || '(none)'}", urn=${out.urn ? out.urn.slice(0, 40) + '…' : '(none)'}, memberId=${out.memberId || '(none)'}, memberNumber=${out.memberNumber || '(none)'}, openProfile=${out.isOpenProfile === null ? '(unknown)' : out.isOpenProfile}, degree=${out.connectionDegree === null ? '(unknown)' : out.connectionDegree}`);
  } else {
    console.log(`[helpers] captureProfileMeta: nothing captured`);
  }
  return out;
}

export async function getVoyagerDegree(page) {
  try {
    const degree = await page.evaluate(async () => {
      try {
        // Extract public identifier from current URL
        const m = window.location.pathname.match(/\/in\/([^/]+)/);
        if (!m) return null;
        const publicId = m[1];

        // CSRF token from JSESSIONID cookie
        const csrf = document.cookie.split(';')
          .map(c => c.trim())
          .find(c => c.startsWith('JSESSIONID='));
        if (!csrf) return null;
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const resp = await fetch(
          `https://www.linkedin.com/voyager/api/identity/profiles/${publicId}/networkinfo`,
          {
            headers: {
              'accept': 'application/vnd.linkedin.normalized+json+2.1',
              'csrf-token': token,
              'x-restli-protocol-version': '2.0.0',
            },
            credentials: 'include',
          }
        );
        if (!resp.ok) return null;

        const data = await resp.json();
        // The distance field is like "DISTANCE_1", "DISTANCE_2", "DISTANCE_3", "OUT_OF_NETWORK"
        const distance = data?.data?.distance?.value || data?.distance?.value || null;
        if (distance === 'DISTANCE_1') return 1;
        if (distance === 'DISTANCE_2') return 2;
        if (distance === 'DISTANCE_3') return 3;

        // Fallback: look through included entities
        if (data?.included) {
          for (const entity of data.included) {
            if (entity.distance?.value) {
              const d = entity.distance.value;
              if (d === 'DISTANCE_1') return 1;
              if (d === 'DISTANCE_2') return 2;
              if (d === 'DISTANCE_3') return 3;
            }
          }
        }

        return null;
      } catch {
        return null;
      }
    });

    if (degree !== null) {
      console.log(`[helpers] Voyager API: degree=${degree}`);
    }
    return degree;
  } catch {
    return null; // Graceful fallback
  }
}

/**
 * 2.8.43 — Read the connection-degree badge ("1st" / "2nd" / "3rd" / "3rd+")
 * shown next to the profile name. ONLY trustworthy signal of connection state.
 *
 * Returns: '1st' | '2nd' | '3rd' | '3rd+' | null
 *
 * The 2026 LinkedIn redesign:
 *   - rotated/obfuscated all CSS class names (`_9e348bbd ...`)
 *   - dropped `dist-value`, `distance-badge`, and `*degree*` classes entirely
 *   - dropped `aria-label*="degree connection"`
 *   - moved the badge into a `<p>` tag (not `<span>`) with text `"· 1st"`
 *   - demoted the profile name from `<h1>` to `<h2>`
 *
 * So we can't rely on tag, class, or aria. We TreeWalker the document for any
 * text node whose trimmed value matches the badge pattern, prefer the one
 * physically closest to the profile name heading, and ignore matches inside
 * the "More profiles for you" sidebar / recommendation cards.
 */
export async function getDegreeBadge(page) {
  try {
    await page.waitForFunction(() => {
      const text = document.body?.innerText || '';
      return /(?:^|[\s·])(1st|2nd|3rd\+?)(?:\s|$)/.test(text);
    }, { timeout: 10000 }).catch(() => { /* fall through */ });

    const badge = await page.evaluate(() => {
      const TOKEN_RE = /^(?:·\s*)?(1st|2nd|3rd\+?)(?:\s*degree)?(?:\s*connection)?$/i;
      const norm = s => {
        const t = s.toLowerCase();
        return (t === '3rd+') ? '3rd+' : t;
      };
      const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;

      // Pull profile slug out of the URL so we can validate matches are tied
      // to the actual profile (not a sidebar recommendation).
      const slug = (window.location.pathname.match(/\/in\/([^/]+)/) || [])[1] || '';

      // Strategy A — aria-label. Kept first as a defensive fallback in case
      // LinkedIn restores it on some layouts.
      const ariaEls = document.querySelectorAll('[aria-label*="degree" i]');
      for (const el of ariaEls) {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        if (a.includes('1st degree')) return '1st';
        if (a.includes('2nd degree')) return '2nd';
        if (a.includes('3rd+ degree') || a.includes('3rd degree+')) return '3rd+';
        if (a.includes('3rd degree')) return '3rd';
      }

      // Strategy B — TreeWalker over text nodes. Collect every match, then
      // pick the one inside the profile-name container.
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const matches = [];
      let n;
      while ((n = w.nextNode())) {
        const raw = (n.nodeValue || '').trim();
        const m = raw.match(TOKEN_RE);
        if (!m) continue;
        const parent = n.parentElement;
        if (!parent || !isVisible(parent)) continue;
        // Reject huge containers — that's a sentence, not a badge.
        if (parent.offsetWidth > 240) continue;
        matches.push({ token: norm(m[1]), node: n, parent });
      }

      if (matches.length === 0) return null;

      // Score each match: prefer ones whose container also contains an h1/h2
      // whose href links to /in/<slug>/ — i.e., the profile owner's name
      // heading. Walk up to 6 ancestors looking for that anchor.
      const scoreMatch = ({ parent }) => {
        let cur = parent;
        for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
          // Look for an H1 or H2 inside this ancestor
          const heading = cur.querySelector?.('h1, h2');
          if (!heading) continue;
          // Check for an anchor pointing back to this profile slug
          const anchors = cur.querySelectorAll?.('a[href*="/in/"]');
          for (const a of anchors || []) {
            const href = a.getAttribute('href') || '';
            if (slug && href.includes(`/in/${slug}`)) return 100 - i; // strong match
            if (slug && href.includes('/in/') && cur.contains(heading)) return 50 - i;
          }
          // Heading with no slug-matching anchor still beats nothing
          return 10 - i;
        }
        return 0;
      };

      matches.forEach(m => { m.score = scoreMatch(m); });
      matches.sort((a, b) => b.score - a.score);
      return matches[0].token;
    });

    console.log(`[helpers] Degree badge: ${badge ?? 'NOT FOUND'}`);
    return badge;
  } catch (err) {
    console.warn(`[helpers] getDegreeBadge error: ${err.message}`);
    return null;
  }
}

/**
 * Get connection status. Uses aria-label + text only.
 */
export async function getConnectionStatus(page) {
  try {
    const result = await page.evaluate(() => {
      // Profile name
      let profileName = '';
      const h1 = document.querySelector('h1');
      if (h1) profileName = h1.textContent.trim().split('\n')[0].trim();
      if (!profileName) {
        const m = (document.title || '').match(/^(.+?)(?:\s*[\|–-]\s*LinkedIn)?$/);
        if (m) profileName = m[1].trim();
      }

      // Collect ALL clickable elements from everywhere
      const els = Array.from(document.querySelectorAll('button, a, [role="button"]'));

      // Search ALL Shadow DOM roots (not just interop-outlet)
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          els.push(...Array.from(el.shadowRoot.querySelectorAll('button, a, [role="button"]')));
        }
      });

      // Build a list of action-relevant elements for debugging
      const actionEls = [];
      for (const el of els) {
        const aria = el.getAttribute('aria-label') || '';
        const text = (el.textContent || '').trim();
        const tag = el.tagName;

        // Skip nav bar "Messaging" and "My Network" links
        if (aria === 'Messaging' || text === 'Messaging') continue;
        if (aria.includes('My Network')) continue;

        // Check if this element is relevant
        const ariaLow = aria.toLowerCase();
        const textLow = text.toLowerCase();

        if (ariaLow.includes('message') || textLow === 'message' ||
            ariaLow.includes('connect') || ariaLow.includes('invite') || textLow === 'connect' ||
            ariaLow.includes('follow') || textLow === 'follow' ||
            ariaLow.includes('pending') || textLow === 'pending') {
          actionEls.push({ tag, text: text.substring(0, 40), aria: aria.substring(0, 60) });
        }
      }

      // ── 0. Degree badge check — most reliable "already connected" signal ──
      // 2.8.43: rewritten for the 2026 LinkedIn redesign. The badge now lives
      // in a <p> tag (not <span>), text is "· 1st" with a leading bullet, all
      // class names are obfuscated hashes that rotate. We walk text nodes and
      // pick the match whose container is tied to the profile's slug heading.
      let degree = null;
      {
        const TOKEN_RE = /^(?:·\s*)?(1st|2nd|3rd\+?)(?:\s*degree)?(?:\s*connection)?$/i;
        const isVisible = el => el && el.offsetWidth > 0 && el.offsetHeight > 0;
        const slug = (window.location.pathname.match(/\/in\/([^/]+)/) || [])[1] || '';

        // Aria-label first (defensive, in case LinkedIn brings it back).
        const ariaEls = document.querySelectorAll('[aria-label*="degree" i]');
        for (const el of ariaEls) {
          const a = (el.getAttribute('aria-label') || '').toLowerCase();
          if (a.includes('1st degree')) { degree = '1st'; break; }
          if (a.includes('2nd degree')) { degree = '2nd'; break; }
          if (a.includes('3rd+ degree') || a.includes('3rd degree+')) { degree = '3rd+'; break; }
          if (a.includes('3rd degree')) { degree = '3rd'; break; }
        }

        if (!degree) {
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const matches = [];
          let tn;
          while ((tn = w.nextNode())) {
            const raw = (tn.nodeValue || '').trim();
            const m = raw.match(TOKEN_RE);
            if (!m) continue;
            const parent = tn.parentElement;
            if (!parent || !isVisible(parent)) continue;
            if (parent.offsetWidth > 240) continue;
            const tok = m[1].toLowerCase();
            matches.push({ token: tok === '3rd+' ? '3rd+' : tok, parent });
          }
          if (matches.length > 0) {
            const score = ({ parent }) => {
              let cur = parent;
              for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
                const heading = cur.querySelector?.('h1, h2');
                if (!heading) continue;
                const anchors = cur.querySelectorAll?.('a[href*="/in/"]') || [];
                for (const a of anchors) {
                  const href = a.getAttribute('href') || '';
                  if (slug && href.includes(`/in/${slug}`)) return 100 - i;
                  if (slug && href.includes('/in/')) return 50 - i;
                }
                return 10 - i;
              }
              return 0;
            };
            matches.forEach(m => { m.score = score(m); });
            matches.sort((a, b) => b.score - a.score);
            degree = matches[0].token;
          }
        }
      }

      // If "1st" degree → already connected, return 'message' status
      if (degree === '1st') {
        return { status: 'message', debug: actionEls, profileName, degree };
      }

      // ── 1. Pending — scoped to THIS profile only ──
      const firstName = profileName.split(/\s+/)[0]?.toLowerCase() || '';
      for (const el of els) {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        const t = (el.textContent || '').trim().toLowerCase();
        if (t === 'pending' || a.includes('pending')) {
          // Check if this Pending button is for the profile owner
          // aria-label like "Pending, click to withdraw invitation sent to Isaac"
          if (a.includes('pending') && firstName && !a.includes(firstName)) {
            continue; // This is a Pending button for someone else (recommendations)
          }
          // If it's just text "Pending" with no aria, check position (top section only)
          if (!a.includes('pending')) {
            const rect = el.getBoundingClientRect();
            if (rect.top > 800) continue; // Below the fold — probably recommendations
          }
          return { status: 'pending', debug: actionEls, profileName, degree };
        }
      }

      // ── 2. Connect — scoped to THIS profile's buttons only ──
      for (const el of els) {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        if (a.includes('invite') && a.includes('to connect')) {
          // Only count if it matches this profile's name, or there's only one such button
          if (firstName && a.includes(firstName)) {
            return { status: 'connect', debug: actionEls, profileName, degree };
          }
        }
      }
      //    If only one "Invite to connect" exists, it's this profile's
      const allInvites = els.filter(el => {
        const a = (el.getAttribute('aria-label') || '').toLowerCase();
        return a.includes('invite') && a.includes('to connect');
      });
      if (allInvites.length === 1) {
        return { status: 'connect', debug: actionEls, profileName, degree };
      }
      //    Fallback: button/a with text "Connect" in the top section only
      for (const el of els) {
        const t = (el.textContent || '').trim();
        if (t === 'Connect' && (el.tagName === 'BUTTON' || el.tagName === 'A')) {
          if (el.offsetWidth > 30) {
            const rect = el.getBoundingClientRect();
            if (rect.top < 800) {
              return { status: 'connect', debug: actionEls, profileName, degree };
            }
          }
        }
      }

      // ── 3. Follow — aria starts with "Follow " ──
      for (const el of els) {
        const aria = el.getAttribute('aria-label') || '';
        if (aria.startsWith('Follow ')) {
          return { status: 'follow', debug: actionEls, profileName, degree };
        }
      }

      // 2.8.38: "Message" button as a positive signal of being connected
      // is REMOVED. A profile can have a Message button without being
      // 1st-degree (existing conversation thread, Open Profile, premium
      // InMail). The ONLY trustworthy signal of "accepted" is the degree
      // badge ("1st" near the name) — handled at step 0 above. If we got
      // this far and didn't find a 1st badge, pending, connect, or follow,
      // return 'unknown' so the caller can decide (typically: leave the
      // sheet untouched rather than risk a false positive).
      return { status: 'unknown', debug: actionEls, profileName, degree };
    });

    console.log(`[helpers] Status: ${result.status} (name: "${result.profileName || '?'}", degree: ${result.degree || '?'})`);
    if (result.debug.length > 0) {
      console.log('[helpers] Action elements:', JSON.stringify(result.debug));
    } else {
      console.log('[helpers] WARNING: No action elements found on page at all');
    }
    return result.status;
  } catch (err) {
    console.warn(`[helpers] Error: ${err.message}`);
    return 'unknown';
  }
}

// Normalize a token / column header to a canonical key so that {first name},
// {First Name}, {firstName}, {first_name}, {first-name} and a non-English
// {Nome} all match whatever the sheet's header actually is. Names are not
// special-cased — they are matched exactly like any other column.
//   - case-insensitive
//   - all whitespace / underscores / hyphens are removed, so spaced,
//     snake_case and camelCase spellings of the same token converge
//     ("First Name", "first_name", "firstName" → "firstname").
function normalizeToken(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .trim();
}

// Build a normalized {canonical key → value} lookup from the data object.
// Insertion order is preserved, so the real sheet header (spread first via
// data = { ...row }) wins over any alias added afterwards on a collision.
// First non-empty value for a given canonical key is kept.
function buildTokenLookup(data) {
  const lookup = new Map();
  for (const [key, value] of Object.entries(data || {})) {
    const nk = normalizeToken(key);
    if (!nk) continue;
    const v = value == null ? '' : String(value);
    if (!lookup.has(nk) || (lookup.get(nk) === '' && v !== '')) {
      lookup.set(nk, v);
    }
  }
  return lookup;
}

// Replace every {token} in the template with its resolved value. A token is
// resolved by matching its normalized form against the data's normalized keys
// (see normalizeToken). Unresolved tokens are stripped so a lead never sees a
// raw {placeholder}. Scanning the template once (rather than building a RegExp
// per key) means column headers with regex metachars — "Job Title (Current)",
// "Company (HQ)" — are matched safely without escaping (was the P-03 / 2.8.18
// crash class).
export function personalizeTemplate(template, data = {}) {
  if (!template) return '';
  const lookup = buildTokenLookup(data);
  return template
    .replace(/\{([^{}]+)\}/g, (_whole, token) => {
      const nk = normalizeToken(token);
      return lookup.has(nk) ? lookup.get(nk) : '';
    })
    .trim();
}

// Return the raw token names in `template` that would render empty against
// `data` — either no matching column/alias, or the matched value is blank.
// Drives the template-preview's "{x} not resolved" warnings.
export function findUnresolvedPlaceholders(template, data = {}) {
  if (!template) return [];
  const lookup = buildTokenLookup(data);
  const unresolved = [];
  const seen = new Set();
  const matches = template.match(/\{([^{}]+)\}/g) || [];
  for (const m of matches) {
    const raw = m.slice(1, -1);
    if (seen.has(raw)) continue;
    seen.add(raw);
    const v = lookup.get(normalizeToken(raw));
    if (v === undefined || v === '') unresolved.push(raw);
  }
  return unresolved;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 11.3 — Voyager GraphQL messenger conversations fetch + normalization.
// Caller is responsible for having the page already navigated to
// https://www.linkedin.com/messaging/ so LinkedIn's React app has fired the
// messengerConversations XHR (we discover the queryId by reading performance
// entries rather than hardcoding it — queryId hashes rotate occasionally).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch (and normalize) one page of inbox conversations.
 * Returns { elements: [...], metadata } or null on failure.
 *
 * Normalized element shape (11.3-RESEARCH.md Finding 1):
 *   { entityUrn, threadId, lastActivityAt, unreadCount,
 *     participants: [{firstName, lastName, profileUrl}],
 *     lastMessage?: {text, deliveredAt, actor: {firstName, lastName, profileUrl}} }
 */
export async function getConversationsPage(page, { start = 0, count = 20 } = {}) {
  try {
    const raw = await page.evaluate(async ({ start, count }) => {
      try {
        // ── 1. Discover the XHR URL from LinkedIn's own recent requests ──
        // This avoids hardcoding queryId hashes (which rotate). We rely on the
        // caller to have already loaded the /messaging/ inbox so the XHR has
        // fired and lives in performance entries.
        const entries = performance.getEntriesByType('resource')
          .filter(e => typeof e.name === 'string' && e.name.includes('queryId=messengerConversations'))
          .sort((a, b) => b.startTime - a.startTime);

        if (entries.length === 0) {
          return null; // inbox not loaded yet — orchestrator navigates and retries
        }

        const urlObj = new URL(entries[0].name);
        // Tune pagination ONLY on URLs that already expose top-level count/start
        // params. The current messengerConversationsBySyncToken query encodes
        // paging inside the `variables=(mailboxUrn:…)` tuple and has NO top-level
        // count — adding one makes LinkedIn return HTTP 400 (verified live
        // 2026-06-29). Its first page = 20 most-recent threads, which is what the
        // reply check needs; deeper history is a separate refinement.
        if (count && urlObj.searchParams.has('count')) urlObj.searchParams.set('count', String(count));
        if (start && urlObj.searchParams.has('start')) urlObj.searchParams.set('start', String(start));

        // ── 2. Auth headers — copy exactly what getVoyagerDegree uses ──
        const csrf = document.cookie.split(';').map(c => c.trim())
          .find(c => c.startsWith('JSESSIONID='));
        if (!csrf) return null;
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const resp = await fetch(urlObj.toString(), {
          headers: {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
          },
          credentials: 'include',
        });
        if (!resp.ok) return null;
        return await resp.json();
      } catch {
        return null;
      }
    }, { start, count });

    if (!raw || typeof raw !== 'object') return null;
    return normalizeConversationsEnvelope(raw);
  } catch (err) {
    console.warn(`[helpers] getConversationsPage failed: ${err.message || err}`);
    return null;
  }
}

/**
 * Fetch one page of the PRIMARY inbox by cursor (newest first). LinkedIn's own
 * list pages with `messengerConversationsByCategoryQuery` + `nextCursor`; the
 * sync-token query getConversationsPage replays only ever returns the newest 20,
 * and its start/count/lastUpdatedBefore are ignored (verified live 2026-09-29 —
 * every "page" came back identical). The category queryId only fires once the
 * conversation list has been scrolled, so the caller scrolls first; the mailbox
 * URN comes from any messengerConversations request on the page.
 *
 * Returns { elements, nextCursor } or null when the query can't be discovered
 * or the fetch fails.
 */
export async function getInboxCategoryPage(page, { cursor = null } = {}) {
  try {
    const raw = await page.evaluate(async ({ cursor }) => {
      try {
        const names = performance.getEntriesByType('resource')
          .map(e => e.name)
          .filter(n => typeof n === 'string' && n.includes('queryId=messengerConversations'));
        const decoded = names.map(n => { try { return decodeURIComponent(n); } catch { return n; } });
        const tmplIdx = decoded.findIndex(n => n.includes('conversationCategoryPredicate'));
        if (tmplIdx === -1) return null;
        const mbox = decoded.map(n => n.match(/mailboxUrn:([^,)]+)/)?.[1]).find(Boolean);
        if (!mbox) return null;
        const u = new URL(names[tmplIdx]);
        const queryId = u.searchParams.get('queryId');
        const vars = '(query:(predicateUnions:List((conversationCategoryPredicate:(category:PRIMARY_INBOX)))),count:20,'
          + `mailboxUrn:${encodeURIComponent(mbox)}`
          + (cursor ? `,nextCursor:${encodeURIComponent(cursor)}` : '')
          + ')';
        const csrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('JSESSIONID='));
        if (!csrf) return null;
        const token = csrf.split('=')[1]?.replace(/"/g, '');
        const resp = await fetch(`${u.origin}${u.pathname}?queryId=${queryId}&variables=${vars}`, {
          headers: {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
          },
          credentials: 'include',
        });
        if (!resp.ok) return null;
        return await resp.json();
      } catch {
        return null;
      }
    }, { cursor });
    if (!raw || typeof raw !== 'object') return null;
    const { elements, metadata } = normalizeConversationsEnvelope(raw);
    return { elements, nextCursor: metadata?.nextCursor || null };
  } catch (err) {
    console.warn(`[helpers] getInboxCategoryPage failed: ${err.message || err}`);
    return null;
  }
}

/** Pure: messenger GraphQL `normalized+json+2.1` envelope → { elements, metadata }. */
function normalizeConversationsEnvelope(raw) {
  // ── Normalize the `normalized+json+2.1` envelope → internal shape ──
  // Real schema (captured live 2026-06-29 — see docs/manual-bulk-reply-check-SCHEMA.md):
  //   { data: { data: { messengerConversationsBySyncToken: { "*elements": [URN refs] } } },
  //     included: [ Conversation | Message | MessagingParticipant ... ] }
  // The conversation node only holds URN string REFERENCES (`*elements`); the real
  // objects live in the flat `included[]` array. We index `included` by entityUrn and
  // resolve references by hand.
  const dataData = raw.data?.data ?? raw.data ?? {};
  const convKey = Object.keys(dataData).find(k => /messengerConversations/i.test(k));
  const convNode = convKey ? dataData[convKey] : null;

  // `*elements` = URN refs; older shape `elements` = inline objects (kept as a fallback).
  const refs = Array.isArray(convNode?.['*elements']) ? convNode['*elements']
             : Array.isArray(convNode?.elements) ? convNode.elements
             : [];

  const index = new Map();
  for (const e of (Array.isArray(raw.included) ? raw.included : [])) {
    if (e && e.entityUrn) index.set(e.entityUrn, e);
  }

  const elements = refs
    .map(ref => (typeof ref === 'string' ? index.get(ref) : ref))
    .map(rawConv => normalizeConversation(rawConv, index))
    .filter(Boolean);

  return { elements, metadata: convNode?.metadata || null };
}

/** Extract the fsd_profile token from any messaging/participant/conversation URN. */
function fsdFromUrn(urn) {
  const s = String(urn || '');
  const i = s.indexOf('fsd_profile:');
  if (i === -1) return '';
  return s.slice(i + 'fsd_profile:'.length).replace(/[),].*$/, '');
}

/** Best-effort avatar URL from a MemberParticipantInfo.profilePicture VectorImage. */
function buildPhotoUrl(pic) {
  const root = pic?.rootUrl;
  const seg = pic?.artifacts?.find(a => a.width === 100)?.fileIdentifyingUrlPathSegment
           || pic?.artifacts?.[0]?.fileIdentifyingUrlPathSegment;
  return root && seg ? `${root}${seg}` : '';
}

/** MessagingParticipant included entity → flat identity (superset of the old shape). */
function participantIdentity(p) {
  if (!p || typeof p !== 'object') return null;
  const member = p.participantType?.member;
  const fsdProfile = fsdFromUrn(p.hostIdentityUrn || p.entityUrn || '');
  const memberId = String(p.backendUrn || '').replace(/^urn:li:member:/, '');
  return {
    // Old fields (keep the scheduler path working) …
    firstName: member?.firstName?.text || '',
    lastName: member?.lastName?.text || '',
    profileUrl: member?.profileUrl || '',
    // … new identity fields for the memberId-primary matcher
    fsdProfile,
    memberId: /^\d+$/.test(memberId) ? memberId : '',
    headline: member?.headline?.text || '',
    distance: member?.distance || '',
    photoUrl: buildPhotoUrl(member?.profilePicture),
  };
}

/**
 * Normalize one resolved Conversation included entity → internal shape.
 * `index` is the entityUrn→entity Map over `included` (to resolve participant/message refs).
 *
 * Output shape is a SUPERSET of the legacy shape: `participants` holds only the OTHER
 * party (self excluded, so participants[0] === the lead and length===1 means 1:1), and
 * `lastMessage.actor` is the resolved sender. Adds `memberId`/`fsdProfile` per participant.
 */
function normalizeConversation(raw, index = new Map()) {
  if (!raw || typeof raw !== 'object') return null;

  const backendUrn = String(raw.backendUrn || '');
  const threadId = backendUrn.replace(/^urn:li:messagingThread:/, '') ||
                   String(raw.entityUrn || '').split(',').pop()?.replace(/\)$/, '') ||
                   '';

  // "Me" (the viewer) anchors the conversation entityUrn tuple:
  //   urn:li:msg_conversation:(urn:li:fsd_profile:<ME>, <threadId>)
  const meFsd = fsdFromUrn(raw.entityUrn || '');

  const participantRefs = Array.isArray(raw['*conversationParticipants'])
    ? raw['*conversationParticipants'] : [];
  const allParticipants = participantRefs
    .map(ref => participantIdentity(typeof ref === 'string' ? index.get(ref) : ref))
    .filter(Boolean);
  // Exclude self → participants[0] is the lead; length===1 means a 1:1 thread.
  const participants = allParticipants.filter(p => !meFsd || p.fsdProfile !== meFsd);

  // Latest message lives behind a URN ref in messages.*elements.
  const msgRef = raw.messages?.['*elements']?.[0] ?? raw.messages?.elements?.[0];
  const lastMessageRaw = typeof msgRef === 'string' ? index.get(msgRef) : msgRef;
  let lastMessage = null;
  if (lastMessageRaw) {
    const senderRef = lastMessageRaw['*sender'] ?? lastMessageRaw['*actor'];
    const actor = participantIdentity(typeof senderRef === 'string' ? index.get(senderRef) : senderRef);
    const senderFsd = actor?.fsdProfile || fsdFromUrn(senderRef);
    lastMessage = {
      text: lastMessageRaw.body?.text || '',
      deliveredAt: lastMessageRaw.deliveredAt || raw.lastActivityAt || 0,
      actor: actor || null,
      // Inbound reply iff the last sender is not the viewer.
      isInbound: !!(meFsd && senderFsd && senderFsd !== meFsd),
    };
  }

  return {
    entityUrn: raw.entityUrn || '',
    threadId,
    backendUrn,
    conversationUrl: raw.conversationUrl || '',
    lastActivityAt: raw.lastActivityAt || 0,
    unreadCount: raw.unreadCount || 0,
    read: raw.read === true,
    groupChat: raw.groupChat === true,
    meFsd,
    participants,
    lastMessage,
  };
}

// ── Sales Navigator inbox (OP / InMail reply-check) ─────────────────────────
// OPs and InMails are sent THROUGH Sales Navigator, so their replies live in the
// Sales Nav inbox (/sales-api/salesApiMessagingThreads), NOT the regular
// messengerConversations inbox. Different envelope, same downstream logic: we
// normalize to the SAME internal conversation shape normalizeConversation emits,
// so classifyConversations / matchConversationIdentitySafe / previewOf all work
// unchanged. Schema captured live 2026-06-29 — see docs/salesnav-inbox-SCHEMA.md.

/** Extract the ACwAA-style member token from a salesProfile URN. */
function salesProfileToken(urn) {
  const m = String(urn || '').match(/fs_salesProfile:\(([^,)]+)/);
  return m ? m[1] : '';
}

/** Best-effort avatar URL from a Sales Nav profilePictureDisplayImage. */
function buildSalesNavPhoto(pic) {
  const root = pic?.rootUrl || '';
  const seg = pic?.artifacts?.find(a => a.width === 100)?.fileIdentifyingUrlPathSegment
           || pic?.artifacts?.[0]?.fileIdentifyingUrlPathSegment || '';
  if (!seg) return '';
  return /^https?:\/\//.test(seg) ? seg : `${root}${seg}`;
}

/** Sales Nav Profile included entity → flat identity (same fields as participantIdentity). */
function salesNavIdentity(p) {
  if (!p || typeof p !== 'object') return null;
  const memberId = String(p.objectUrn || '').replace(/^urn:li:member:/, '');
  const token = salesProfileToken(p.entityUrn || '');
  return {
    firstName: p.firstName || '',
    lastName: p.lastName || '',
    profileUrl: token ? `https://www.linkedin.com/in/${token}` : '',
    fsdProfile: '',
    memberId: /^\d+$/.test(memberId) ? memberId : '',
    headline: '',
    distance: p.degree ? `DISTANCE_${p.degree}` : '',
    photoUrl: buildSalesNavPhoto(p.profilePictureDisplayImage),
    salesUrn: String(p.entityUrn || ''),
  };
}

/** Normalize ONE Sales Nav thread → internal conversation shape. `index` = entityUrn→Profile. */
function normalizeSalesNavThread(thread, index = new Map()) {
  if (!thread || typeof thread !== 'object') return null;
  const threadId = String(thread.id || '');
  // Oldest → newest. WE always send the opener (OP / InMail), so the first
  // message's author is "me" — owner-agnostic, works for OP and InMail alike.
  const msgs = (Array.isArray(thread.messages) ? thread.messages : [])
    .slice().sort((a, b) => (a.deliveredAt || 0) - (b.deliveredAt || 0));
  const firstMsg = msgs[0] || null;
  const lastMsg = msgs[msgs.length - 1] || null;
  const meUrn = firstMsg ? String(firstMsg.author || '') : '';

  const allParticipants = (Array.isArray(thread.participants) ? thread.participants : [])
    .map(ref => salesNavIdentity(typeof ref === 'string' ? index.get(ref) : ref))
    .filter(Boolean);
  // Exclude "me" → participants[0] is the lead; length===1 means a 1:1 thread.
  const participants = meUrn ? allParticipants.filter(p => p.salesUrn !== meUrn) : allParticipants;

  let lastMessage = null;
  if (lastMsg) {
    const actor = salesNavIdentity(typeof lastMsg.author === 'string' ? index.get(lastMsg.author) : lastMsg.author);
    lastMessage = {
      text: String(lastMsg.body || ''),
      deliveredAt: lastMsg.deliveredAt || 0,
      actor: actor || null,
      // Inbound iff the last message's author is not the opener (us).
      isInbound: !!(meUrn && lastMsg.author && String(lastMsg.author) !== meUrn),
      type: lastMsg.type || '',
      subject: lastMsg.subject || '',
    };
  }

  return {
    entityUrn: '',
    threadId,
    backendUrn: '',
    conversationUrl: threadId ? `https://www.linkedin.com/sales/inbox/${threadId}` : '',
    lastActivityAt: lastMsg?.deliveredAt || 0,
    unreadCount: thread.unreadMessageCount || 0,
    read: (thread.unreadMessageCount || 0) === 0,
    groupChat: participants.length > 1,
    meFsd: '',
    participants,
    lastMessage,
  };
}

/** Pure: Sales Nav threads envelope → { elements, metadata } in internal shape. */
export function normalizeSalesNavThreads(raw) {
  if (!raw || typeof raw !== 'object') return { elements: [], metadata: null };
  const threads = Array.isArray(raw.data?.elements) ? raw.data.elements : [];
  const index = new Map();
  for (const e of (Array.isArray(raw.included) ? raw.included : [])) {
    if (e && e.entityUrn) index.set(e.entityUrn, e);
  }
  return {
    elements: threads.map(t => normalizeSalesNavThread(t, index)).filter(Boolean),
    metadata: null,
  };
}

/**
 * Fetch the Sales Navigator inbox thread list and normalize it. Mirrors
 * getConversationsPage: replays the page's own salesApiMessagingThreads XHR
 * (so the decoration/query params stay current) with the JSESSIONID csrf token.
 * Requires the Sales Nav inbox to already be loaded so the XHR has fired.
 */
export async function getSalesNavThreadsPage(page, { pageStartsAt = null } = {}) {
  try {
    const raw = await page.evaluate(async ({ pageStartsAt }) => {
      try {
        const entries = performance.getEntriesByType('resource')
          .filter(e => typeof e.name === 'string' && e.name.includes('salesApiMessagingThreads'))
          .sort((a, b) => b.startTime - a.startTime);
        if (entries.length === 0) return null; // inbox not loaded yet
        // Use the list endpoint (no trailing /<threadId>) which embeds messages.
        let listUrl = entries.map(e => e.name).find(u => !/salesApiMessagingThreads\/[^?]/.test(u));
        if (!listUrl) return null;
        // Paging: the list is newest-first; each thread carries nextPageStartsAt,
        // and the LAST thread's value is the next page's pageStartsAt.
        if (pageStartsAt) {
          const u = new URL(listUrl);
          u.searchParams.set('pageStartsAt', String(pageStartsAt));
          listUrl = u.toString();
        }
        const csrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('JSESSIONID='));
        if (!csrf) return null;
        const token = csrf.split('=')[1]?.replace(/"/g, '');
        const resp = await fetch(listUrl, {
          headers: {
            // MUST be the normalized envelope → { data: { elements }, included }.
            // Plain application/json returns a flat { elements, paging } with no
            // `included`, so participant names can't be resolved (verified live).
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
          },
          credentials: 'include',
        });
        if (!resp.ok) return null;
        return await resp.json();
      } catch {
        return null;
      }
    }, { pageStartsAt });
    if (!raw || typeof raw !== 'object') return null;
    const out = normalizeSalesNavThreads(raw);
    const rawThreads = Array.isArray(raw.data?.elements) ? raw.data.elements : [];
    out.nextPageStartsAt = rawThreads.length ? (rawThreads[rawThreads.length - 1].nextPageStartsAt || null) : null;
    return out;
  } catch (err) {
    console.warn(`[helpers] getSalesNavThreadsPage failed: ${err.message || err}`);
    return null;
  }
}

/**
 * Extract a profile URN from a Voyager /identity/profiles/* response payload.
 *
 * Voyager returns the profile URN in several shapes depending on the endpoint
 * variant and decoration version. This helper walks the known locations in
 * priority order and returns the first `urn:li:fsd_profile:` / `fs_miniProfile`
 * / `fs_profile` URN it finds. Returns '' if none.
 *
 * Pure function — no page/network. Extracted as a separate export so the URN
 * resolver in intro-voyager.js and the existing captureProfileMeta both
 * exercise the same logic (currently captureProfileMeta inlines it at L584).
 */
export function extractProfileUrnFromVoyagerResponse(data) {
  if (!data || typeof data !== 'object') return '';
  const isProfileUrn = (s) =>
    typeof s === 'string' &&
    (s.indexOf('urn:li:fsd_profile:') === 0 ||
     s.indexOf('urn:li:fs_miniProfile:') === 0 ||
     s.indexOf('urn:li:fs_profile:') === 0);

  const candidates = [
    data.entityUrn,
    data.data?.entityUrn,
    data.profile?.entityUrn,
    data.miniProfile?.entityUrn,
  ];
  for (const c of candidates) {
    if (isProfileUrn(c)) return c;
  }
  if (Array.isArray(data.included)) {
    for (const item of data.included) {
      if (item && isProfileUrn(item.entityUrn)) return item.entityUrn;
    }
  }
  if (Array.isArray(data.data?.['*elements'])) {
    for (const ref of data.data['*elements']) {
      if (isProfileUrn(ref)) return ref;
    }
  }
  return '';
}

/**
 * Resolve a LinkedIn public-id (`samueladcock`, `cindy-pambid-1b7113338`, etc.)
 * to its profile URN (`urn:li:fsd_profile:ACoAA…`) WITHOUT navigating to the
 * profile page. Uses the same Voyager `/identity/profiles/<publicId>` endpoint
 * already proven by captureProfileMeta (helpers.js:560).
 *
 * Returns '' if the lookup fails for any reason (network error, 404, 403,
 * non-JSON response, no URN in response). Callers fall back to typeahead.
 *
 * @param {puppeteer.Page} page  - active LinkedIn page (any URL works — needs
 *                                  only the JSESSIONID cookie for CSRF)
 * @param {string} publicId      - the slug after /in/ in a LinkedIn URL
 * @returns {Promise<string>}    - profile URN or '' on any failure
 */
export async function resolveProfileUrn(page, publicId) {
  if (!publicId || typeof publicId !== 'string') return '';
  try {
    const result = await page.evaluate(async (pid) => {
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        if (!csrf) return { ok: false, reason: 'no-csrf' };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const url = `https://www.linkedin.com/voyager/api/identity/profiles/${encodeURIComponent(pid)}`;
        const resp = await fetch(url, {
          headers: {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
          },
          credentials: 'include',
        });
        if (!resp.ok) return { ok: false, reason: `http-${resp.status}` };
        const data = await resp.json();
        return { ok: true, data };
      } catch (err) {
        return { ok: false, reason: 'fetch-threw', message: String(err && err.message || err) };
      }
    }, publicId);

    if (!result || !result.ok) return '';
    return extractProfileUrnFromVoyagerResponse(result.data);
  } catch (err) {
    return '';
  }
}

// Per-page-session cache for the sender's URN. WeakMap so the entry is GC'd
// when the page is closed. Cleared implicitly per profile relaunch.
const _senderUrnCache = new WeakMap();

/**
 * Get the URN of the currently-logged-in LinkedIn account on this page.
 * Calls /voyager/api/me which returns the viewer's profile entity. Cached
 * per-page so the second+ intro in the same auto-intro loop is free.
 *
 * Returns '' on any failure. Callers fall back to typeahead.
 *
 * @param {puppeteer.Page} page - active LinkedIn page
 * @returns {Promise<string>}   - sender's profile URN or ''
 */
export async function getSenderUrn(page) {
  const cached = _senderUrnCache.get(page);
  if (cached) return cached;

  try {
    const result = await page.evaluate(async () => {
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        if (!csrf) return { ok: false };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const resp = await fetch('https://www.linkedin.com/voyager/api/me', {
          headers: {
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': token,
            'x-restli-protocol-version': '2.0.0',
          },
          credentials: 'include',
        });
        if (!resp.ok) return { ok: false };
        return { ok: true, data: await resp.json() };
      } catch {
        return { ok: false };
      }
    });

    if (!result || !result.ok) return '';
    const urn = extractProfileUrnFromVoyagerResponse(result.data);
    if (urn) _senderUrnCache.set(page, urn);
    return urn;
  } catch {
    return '';
  }
}

// v2.58.x — Per-page-session cache for name→publicId lookups so an IC
// campaign that intros 50 leads to the same primary person only hits the
// typeahead endpoint once. Keyed by lowercased trimmed name.
const _namePublicIdCache = new WeakMap();

/**
 * v2.58.x — Resolve a connection by NAME to their LinkedIn publicIdentifier
 * (slug). Uses LinkedIn's compose-recipient typeahead endpoint — the same
 * one the web client hits when an operator types into the "To" field. Scoped
 * to MEMBER (people), which is what shows up in the compose typeahead.
 *
 * Used by the standalone Introduction Campaign (introduce_back mode): the
 * wizard collects only the primary person's NAME (no URL field), so we
 * resolve their publicId here so intro-voyager.js can fire the Voyager
 * POST with a proper URN.
 *
 * Returns '' on any failure — callers should treat as "could not resolve"
 * and stamp a friendly error on the row.
 *
 * @param {puppeteer.Page} page  - active LinkedIn page (sender's session)
 * @param {string} name          - operator-typed primary name, e.g. "Sam Adcock"
 * @returns {Promise<string>}    - publicIdentifier (slug) or ''
 */
export async function resolvePublicIdByName(page, name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return '';

  // Per-page-session cache hit?
  let cache = _namePublicIdCache.get(page);
  if (cache && cache.has(key)) return cache.get(key);

  try {
    const result = await page.evaluate(async (query) => {
      const log = [];
      try {
        const csrf = document.cookie.split(';').map((c) => c.trim())
          .find((c) => c.startsWith('JSESSIONID='));
        if (!csrf) return { slug: '', log: ['no-csrf'] };
        const token = csrf.split('=')[1]?.replace(/"/g, '');

        const headers = {
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': token,
          'x-restli-protocol-version': '2.0.0',
        };

        const encoded = encodeURIComponent(query);
        // Endpoints ordered by community evidence (tomquirk/linkedin-api,
        // nsandman/linkedin-api, beeper/linkedin-messaging-api):
        //   1. blended search — the people-search endpoint, well-documented,
        //      filters by 1st-degree network (network->F).
        //   2. modern Dash typeahead — what LinkedIn's compose UI uses
        //      (different shape per account type, hence multiple keys to try).
        //   3. legacy typeahead — works on older account types.
        const endpoints = [
          `https://www.linkedin.com/voyager/api/search/blended?keywords=${encoded}&filters=List((key:network,value:List(F)))&q=all&queryContext=List(spellCorrectionEnabled->true)&count=10`,
          `https://www.linkedin.com/voyager/api/search/blended?keywords=${encoded}&filters=List(network-%3EF)&q=all&count=10`,
          `https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerHostRecipients?q=findHostRecipients&keyword=${encoded}&count=10`,
          `https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerHostRecipients?q=findHostRecipients&keywords=${encoded}&count=10`,
          `https://www.linkedin.com/voyager/api/typeaheadHitsV2?keywords=${encoded}&q=type&types=List(CONNECTIONS)&count=10`,
          `https://www.linkedin.com/voyager/api/typeaheadHits?keywords=${encoded}&q=type&types=List(CONNECTIONS)&count=10`,
        ];

        // Pick a publicIdentifier from a single entity, tolerating the
        // different shapes the endpoints above return.
        function pid(ent) {
          return ent?.publicIdentifier
              || ent?.targetUrnResolutionResult?.publicIdentifier
              || ent?.hitInfo?.['com.linkedin.voyager.search.SearchProfile']?.miniProfile?.publicIdentifier
              || ent?.hitInfo?.['com.linkedin.voyager.search.SearchProfile']?.publicIdentifier
              || ent?.miniProfile?.publicIdentifier
              || '';
        }
        function fullName(ent) {
          const first = (ent?.firstName || ent?.miniProfile?.firstName || ent?.hitInfo?.['com.linkedin.voyager.search.SearchProfile']?.miniProfile?.firstName || '').toString();
          const last  = (ent?.lastName  || ent?.miniProfile?.lastName  || ent?.hitInfo?.['com.linkedin.voyager.search.SearchProfile']?.miniProfile?.lastName  || '').toString();
          return `${first} ${last}`.trim().toLowerCase();
        }

        const wantLower = query.toLowerCase();
        for (const url of endpoints) {
          let resp;
          try {
            resp = await fetch(url, { headers, credentials: 'include' });
          } catch (e) {
            log.push(`${url.slice(0, 70)}… → fetch-threw:${String(e.message || e).slice(0, 80)}`);
            continue;
          }
          if (!resp.ok) {
            log.push(`${url.slice(0, 70)}… → HTTP ${resp.status}`);
            continue;
          }
          let data;
          try {
            data = await resp.json();
          } catch (e) {
            log.push(`${url.slice(0, 70)}… → non-JSON (${String(e.message).slice(0, 50)})`);
            continue;
          }
          const candidates = [];
          if (Array.isArray(data?.elements)) candidates.push(...data.elements);
          if (Array.isArray(data?.included)) candidates.push(...data.included);
          log.push(`${url.slice(0, 70)}… → 200 OK, ${candidates.length} candidates`);

          // Exact name match preferred; fall back to substring; fall back to
          // first publicIdentifier seen (results are already ranked by relevance).
          for (const ent of candidates) { const p = pid(ent); if (p && fullName(ent) === wantLower) return { slug: p, log }; }
          for (const ent of candidates) { const p = pid(ent); const fn = fullName(ent); if (p && fn && (fn.includes(wantLower) || wantLower.includes(fn))) return { slug: p, log }; }
          for (const ent of candidates) { const p = pid(ent); if (p) return { slug: p, log }; }
        }
        return { slug: '', log };
      } catch (err) {
        log.push(`outer-threw: ${String(err.message || err).slice(0, 100)}`);
        return { slug: '', log };
      }
    }, name);

    // Always log the probe trail so we can see why a lookup failed.
    console.log(`[helpers:name-resolve] "${name}" — slug=${result.slug || '(none)'}, probe:`);
    for (const line of (result.log || [])) console.log(`  · ${line}`);

    if (result.slug) {
      if (!cache) { cache = new Map(); _namePublicIdCache.set(page, cache); }
      cache.set(key, result.slug);
    }
    return result.slug || '';
  } catch (err) {
    console.warn(`[helpers:name-resolve] outer error: ${err.message}`);
    return '';
  }
}
