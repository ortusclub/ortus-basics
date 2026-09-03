/**
 * v2.78 — Connect + Introduce "is this account connected to the primary?" check.
 *
 * The 3-way intro only makes sense when the SENDING account is a 1st-degree
 * connection of the primary person. Before a CC+IC account starts its turn we
 * navigate to the primary's profile, read the connection-degree badge, and — on
 * the first check only — send a bare connect request to the primary if the
 * account isn't already connected. While an account is unconnected its intros
 * are held (see campaign.js); each subsequent turn re-reads the degree and
 * releases the intros once it flips to 1st-degree.
 *
 * Pure browser helper: reuses the exported sendConnectionRequest. Does NOT
 * modify the off-limits action/outreach files.
 */
import { sendConnectionRequest } from './actions.js';
import { getVoyagerDegree, getDegreeBadge } from './helpers.js';

// How many times readPrimaryDegree re-reads (and twice re-navigates) before
// giving up with 'unknown'. The 2026-06-15 incident showed a single read is
// fragile: a rate-limited session 429s Voyager and an encoded /in/ACwAA…
// primary URL may not finish its redirect on the first try.
const PRIMARY_DEGREE_MAX_ATTEMPTS = 4;

/**
 * Normalize a saved primary URL for the degree read. A Sales-Nav lead/people
 * URL is rewritten to /in/<urn> so getVoyagerDegree can derive a publicId from
 * the path; a vanity or encoded /in/ URL passes through unchanged (LinkedIn
 * resolves an encoded /in/ACwAA… to its canonical slug on navigation). Pure.
 */
export function normalizePrimaryUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  const m = u.match(/linkedin\.com\/sales\/(?:lead|people)\/([^,/?#]+)/i);
  if (m) return `https://www.linkedin.com/in/${m[1]}`;
  return u;
}

/**
 * Map a read degree to a tri-state connection verdict. Pure.
 *   '1st'/'self'        → true  (connected)
 *   '2nd'/'3rd'/'3rd+'  → false (CONFIRMED not connected)
 *   anything else       → null  (couldn't determine — a read failure, NOT a
 *                                 non-connection). This distinction is the fix
 *                                 for the 2026-06-15 "everything NO PRIMARY" bug.
 */
export function degreeToConnected(degree) {
  if (degree === '1st' || degree === 'self') return true;
  if (degree === '2nd' || degree === '3rd' || degree === '3rd+') return false;
  return null;
}

/**
 * Map the tri-state `connected` to the per-account status string the UI badge
 * and intro gate read. Pure.
 *   true  → 'connected'   (Primary ✓, intros flow)
 *   false → 'pending'     (No primary, a connect was sent, intros held)
 *   null  → 'unverified'  (couldn't check — distinct neutral badge, NO connect
 *                          sent, intros still proceed via the self-validating
 *                          intro attempt)
 */
export function primaryConnState(connected) {
  if (connected === true) return 'connected';
  if (connected === false) return 'pending';
  return 'unverified';
}

/**
 * Classify a sendConnectionRequest failure into the connectResult verdict. An
 * INVITATION_ALREADY_PENDING throw means a connect request to this profile is
 * ALREADY outstanding (we didn't send a new one this run, but there IS a pending
 * invite the primary can still accept) — distinct from a genuine send failure
 * where nothing is pending. The 'already_pending' verdict is what lets the
 * pre-flight handshake auto-accept a request the account sent in a PRIOR run
 * that was never accepted (otherwise the account stays non-1st-degree and its
 * intros stay held forever). Pure.
 * @returns {'already_pending'|'failed'}
 */
export function classifyConnectError(message) {
  return message === 'INVITATION_ALREADY_PENDING' ? 'already_pending' : 'failed';
}

/**
 * Read the connection degree to the profile at `primaryUrl`.
 * Returns '1st' | '2nd' | '3rd' | 'unknown'.
 *
 * v2.99: the old implementation scraped "1st"/"2nd"/"3rd" out of broad page
 * containers ('main section', the top-card panel, the header region). Those
 * containers also hold "People also viewed" / "More profiles for you" cards
 * whose entries carry the VIEWER's degree to *those* people — so a non-
 * connection routinely false-positived as '1st', the connect-to-primary gate
 * thought the account was already connected and skipped the connect, and the
 * intro then failed with INTRO_RECIPIENT_NOT_FOUND. We now use LinkedIn's
 * authoritative Voyager /networkinfo distance (viewer ↔ this exact profile),
 * with the careful slug-matched DOM badge as a fallback only when Voyager
 * returns nothing.
 */
export async function readPrimaryDegree(page, primaryUrl, { attempts = PRIMARY_DEGREE_MAX_ATTEMPTS } = {}) {
  // v2.102: normalize Sales-Nav → /in/, and retry. A single read is fragile
  // under a rate-limited session (Voyager 429 → null) or an encoded primary URL
  // whose redirect hasn't settled (publicId not yet canonical). Re-navigate on
  // the first attempt and once midway (a fresh page can land the redirect /
  // shed a 429); cheap re-reads in between (Voyager + badge re-fetch live).
  const navUrl = normalizePrimaryUrl(primaryUrl);
  const reNavOn = new Set([1, Math.ceil(attempts / 2) + 1]);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (reNavOn.has(attempt)) {
      try {
        await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch { /* nav hiccup — the read below just misses and we retry */ }
    }
    await new Promise((r) => setTimeout(r, attempt === 1 ? 2500 : 1500)); // let it hydrate

    // 1) Authoritative: Voyager networkinfo distance for the profile in the URL.
    try {
      const deg = await getVoyagerDegree(page);
      if (deg === 1) return '1st';
      if (deg === 2) return '2nd';
      if (deg === 3) return '3rd';
    } catch { /* fall through to DOM badge */ }

    // 2) Fallback: the slug-matched degree badge (rejects sidebar/recommendation
    //    matches), only consulted when Voyager gave us nothing.
    try {
      const badge = await getDegreeBadge(page);
      if (badge === '1st') return '1st';
      if (badge === '2nd') return '2nd';
      if (badge === '3rd' || badge === '3rd+') return '3rd';
    } catch { /* fall through */ }
    // Neither signal resolved this pass — retry (re-read, periodically re-nav).
  }

  return 'unknown';
}

/**
 * Check (and optionally connect to) the primary from the current account's page.
 *
 * v2.102: `connected` is now TRI-STATE — true (1st), false (CONFIRMED 2nd/3rd),
 * or null (couldn't read the degree). A read failure must NOT masquerade as
 * "not connected": on null we send NO connect request, the account is badged
 * 'unverified' (not "No primary"), and its intros still proceed (the intro
 * compose is self-validating). Only a CONFIRMED non-connection (false) sends a
 * connect + holds intros. This fixes the 2026-06-15 "everything NO PRIMARY /
 * no introductions" incident, where a rate-limited Voyager read on encoded
 * primary URLs coerced every account to false.
 *
 * @returns {{degree:string, connected:(boolean|null), connectAttempted:boolean, connectResult?:string, error?:string}}
 */
export async function checkAndConnectPrimary(page, primaryUrl, { log = () => {}, pName = '', attemptConnect = true } = {}) {
  const out = { degree: 'unknown', connected: null, connectAttempted: false };
  if (!primaryUrl) return out;
  try {
    const degree = await readPrimaryDegree(page, primaryUrl);
    out.degree = degree;
    out.connected = degreeToConnected(degree); // true | false | null

    if (out.connected === true) {
      log(`  🔗 [${pName}] Connected to primary (${degree}).`);
      return out;
    }
    if (out.connected === null) {
      // Couldn't read the degree (Voyager + badge both empty: rate-limit, an
      // encoded primary URL that didn't resolve, or a slow page). Do NOT treat
      // this as "not connected" — no connect, no "No primary" badge. Intros
      // still proceed; a genuinely-unconnected account fails the intro compose
      // and is picked up by reconnect-&-retry.
      log(`  ❓ [${pName}] Could not verify connection to primary (degree unreadable) — leaving unverified, not sending a connect.`);
      return out;
    }
    // out.connected === false: a CONFIRMED non-connection (2nd/3rd).
    if (!attemptConnect) {
      log(`  🔗 [${pName}] Still not connected to primary (degree=${degree}).`);
      return out;
    }
    log(`  🔗 [${pName}] Not connected to primary (degree=${degree}) — sending connect request to the primary.`);
    out.connectAttempted = true;
    try {
      await sendConnectionRequest(page); // bare request, no note
      out.connectResult = 'sent';
      log(`  🔗 [${pName}] Connect request sent to the primary.`);
    } catch (e) {
      out.connectResult = classifyConnectError(e.message); // 'already_pending' | 'failed'
      out.error = e.message;
      if (out.connectResult === 'already_pending') {
        // A request from this account to the primary is already outstanding
        // (sent on a prior run, never accepted). NOT a failure — the primary
        // can still accept it, so the caller queues an auto-accept for it.
        log(`  🔗 [${pName}] Already invited the primary (request still pending) — will accept it from the primary side.`);
      } else {
        log(`  ⚠ [${pName}] Connect to primary failed: ${e.message}`);
      }
    }
  } catch (e) {
    out.error = e.message;
    out.connected = null; // a thrown read = "couldn't determine", not "not connected"
    log(`  ⚠ [${pName}] Primary connection check failed: ${e.message}`);
  }
  return out;
}
