/**
 * Connect-time identity verification.
 *
 * Background (2026-06-08 connect_and_introduce incident): lead URLs in the
 * encoded member-URN form (`/in/ACwAA…`) sometimes fail to load — under
 * LinkedIn rate-limiting / session degradation the browser lands on a junk
 * fallback page. The connect flow then read THAT page as "already a 1st-degree
 * connection" and `captureProfileMeta` stamped the stray page's URN onto the
 * lead's row, with no check it was the right person. bulk-check later matched
 * the lead to that stranger's acceptance → false "Already Connected" → the
 * CC+IC intro fired at someone who was never connected → "compose page didn't
 * load". The tell: a genuine connection round-trips a NUMERIC member id; a
 * false one carries a URN but an EMPTY member id.
 *
 * This pure helper is the guard: only trust a connect/already-connected stamp
 * when the captured identity provably belongs to the intended lead.
 */

// Pull the AC**AA member token (LinkedIn's encoded member id) out of any
// string — a /in/ACwAA… URL, an ACoAA… URN, etc. Mirrors memberIdFromAny in
// bulk-check-connections.js so the two stay consistent.
function memberToken(value) {
  if (!value) return '';
  const m = String(value).match(/(ACoAA[A-Za-z0-9_-]+|ACwAA[A-Za-z0-9_-]+)/);
  return m ? m[0] : '';
}

// Everything after the 5-char AC**AA tag. The leading bytes of this body
// encode the member id, so the SAME person's ACwAA (URL) and ACoAA (captured
// URN) forms share a long common prefix here even though their tags differ.
function tokenBody(value) {
  const tok = memberToken(value);
  return tok ? tok.slice(5) : '';
}

function commonPrefixLen(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Empirically, same-member ACwAA/ACoAA bodies share ~7 leading chars; different
// members share 0–1. 6 is a safe floor that separates the two cleanly.
const MIN_BODY_PREFIX = 6;

const digitsOnly = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// ── Name matching (v2.96.0) ───────────────────────────────────────────────
// The pre-send gate compares the loaded profile's display name to the sheet
// lead's First + Last name. This catches the "right note, wrong profile" class
// even when no numeric member id is available (e.g. a sheet whose link points
// at a different real person). Tolerant of credentials, emoji, accents.
const _NAME_SUFFIXES = new Set([
  'jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'mba', 'md', 'cfa', 'cpa', 'esq',
  'msc', 'bsc', 'pmp', 'csp', 'itil', 'pe', 'rn', 'do', 'jd', 'pmc',
]);

function nameTokens(value) {
  if (!value) return [];
  // Drop anything after a comma / pipe / middot — that's where LinkedIn puts
  // titles, credentials and the degree badge ("Jane Doe, VP | Consultant · 2nd").
  let s = String(value).split(/[,|·•]/)[0];
  // Strip diacritics, then keep letters + spaces only.
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.toLowerCase().replace(/[^a-z\s]/g, ' ');
  return s.split(/\s+/).filter((t) => t && !_NAME_SUFFIXES.has(t));
}

// true  = strong match  (source first AND last token both present in loaded name)
// false = strong mismatch (NEITHER first nor last token present — a different person)
// null  = inconclusive  (partial overlap, or not comparable) — let other signals decide
function namesMatch(sourceName, capturedName) {
  const src = nameTokens(sourceName);
  const cap = nameTokens(capturedName);
  if (!src.length || !cap.length) return null;
  const capSet = new Set(cap);
  if (src.length === 1) return capSet.has(src[0]); // single-token name: present/absent is decisive
  const first = src[0];
  const last = src[src.length - 1];
  const hasFirst = capSet.has(first);
  const hasLast = capSet.has(last);
  if (hasFirst && hasLast) return true;
  if (!hasFirst && !hasLast) return false;
  return null; // partial → inconclusive
}

// v2.112.26 (#4): a dead/non-existent profile. LinkedIn either redirects to
// /404 or to /in/unavailable when a profile URL no longer resolves. Either way
// the page will NEVER become the intended member, so the pre-send identity gate
// must skip the row terminally instead of burning all MAX_IDENTITY_ATTEMPTS
// retries on it. Matches only when "404"/"unavailable" is a whole PATH SEGMENT
// (followed by /, ?, # or end) so a vanity slug like /in/john404smith — or
// /in/marie-unavailable — is never misread as a dead page. Pure + tested.
export function is404Url(url) {
  return /\/(?:404|unavailable)(?:[/?#]|$)/i.test(String(url || ''));
}

// The vanity slug of a /in/ URL, or '' for an encoded AC**AA member-URN URL.
// A vanity slug is LinkedIn's stable public handle — if we navigate to one and
// the browser STAYS on it, that is strong proof we're on the intended profile.
function vanitySlug(url) {
  const m = String(url || '').match(/\/in\/([^/?#]+)/i);
  if (!m) return '';
  const slug = m[1];
  if (/^AC[ow]AA/i.test(slug)) return ''; // encoded member-URN token, not a vanity slug
  return slug.toLowerCase();
}

// Sheets carry the lead's numeric member id under a few header spellings (and
// a SECOND, run-stamped "LinkedIn Membership ID" column that starts empty).
// Read the first NON-EMPTY numeric value across the known spellings so the
// source id wins over the empty run-stamped column. Returns digits-only or ''.
const _SOURCE_MEMBER_ID_KEYS = [
  'Linkedin Membership ID', 'LinkedIn Membership ID', 'linkedin membership id',
  'Linkedin Member ID', 'LinkedIn Member ID', 'linkedin member id',
  'Member ID', 'member id', 'memberId', 'membershipId', 'membership id',
];

export function readSourceMemberId(row) {
  if (!row || typeof row !== 'object') return '';
  for (const k of _SOURCE_MEMBER_ID_KEYS) {
    if (k in row) {
      const digits = digitsOnly(row[k]);
      if (digits) return digits;
    }
  }
  return '';
}

/**
 * Decide whether a captured profile identity can be trusted as the intended
 * lead before stamping Connected / Already Connected and writing its URN.
 *
 * @param {object}  args
 * @param {string}  args.capturedMemberNumber - numeric member id read off the
 *   loaded profile (captureProfileMeta.memberNumber). Empty = profile did not
 *   resolve a real member → do NOT trust.
 * @param {string}  args.capturedUrn          - the AC**AA URN captured from the
 *   loaded page (captureProfileMeta.memberId).
 * @param {string}  args.leadUrl              - the lead's own LinkedIn URL from
 *   the sheet (extractLinkedInUrl), used for URN-token corroboration.
 * @param {string}  args.sourceMemberId       - the lead's known numeric member
 *   id from the sheet, if present. The strongest anchor when available.
 * @param {string}  [args.capturedName]       - the display name read off the
 *   loaded profile (captureProfileMeta.name). Used for name corroboration.
 * @param {string}  [args.landedUrl]          - page.url() AFTER navigation +
 *   settle. For a vanity slug, staying on it proves we're on the right profile.
 * @param {string}  [args.sourceName]         - the lead's "First Last" from the
 *   sheet row. Enables the name match/mismatch checks.
 * @param {boolean} [args.strict=false]       - PRE-send gate mode. When true, a
 *   bare member id with no corroboration is NOT enough to risk a send (skip-on-
 *   doubt). When false (post-send write-back guard) the original lenient
 *   behaviour is preserved.
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyConnectIdentity({
  capturedMemberNumber = '',
  capturedUrn = '',
  capturedName = '',
  leadUrl = '',
  landedUrl = '',
  sourceMemberId = '',
  sourceName = '',
  strict = false,
} = {}) {
  const captured = digitsOnly(capturedMemberNumber);
  const source = digitsOnly(sourceMemberId);
  const leadBody = tokenBody(leadUrl);
  const capBody = tokenBody(capturedUrn);
  const urnComparable = !!(leadBody && capBody);
  const urnMatch = urnComparable && commonPrefixLen(leadBody, capBody) >= MIN_BODY_PREFIX;
  const nameVerdict = namesMatch(sourceName, capturedName); // true | false | null
  const leadSlug = vanitySlug(leadUrl);
  const landedSlug = vanitySlug(landedUrl);
  const slugStayed = !!(leadSlug && landedSlug && leadSlug === landedSlug);

  // ── 1) Hard contradictions first — the strongest "wrong person" signals. ──
  //    A numeric mismatch is decisive; never let a coincidental URN-token
  //    overlap override it.
  if (source && captured && captured !== source) {
    return { ok: false, reason: `member-number-mismatch (captured ${captured} ≠ lead ${source})` };
  }
  // A clear NAME mismatch overrides everything — even a matching member id. If
  // the loaded profile shares NEITHER first nor last name with the intended
  // lead, we are on the wrong person; never send. This is the guard that would
  // have stopped "Hi Divya" reaching "Dion Kadriu". (v2.96.0)
  if (nameVerdict === false) {
    return { ok: false, reason: `name-mismatch (loaded "${capturedName}" ≠ lead "${sourceName}")` };
  }

  // ── 2) Positive confirmation — any ONE strong signal confirms the lead. ──
  if (source && captured && captured === source) {
    return { ok: true, reason: 'member-number-match' };
  }
  if (nameVerdict === true) {
    return { ok: true, reason: 'name-match' };
  }
  if (slugStayed) {
    return { ok: true, reason: 'vanity-slug-stable' };
  }
  if (urnMatch) {
    return { ok: true, reason: 'urn-prefix-match' };
  }

  // ── 3) No numeric member id at all → we never resolved the lead's profile.
  //    This is the exact false-positive fingerprint from the incident. ──
  if (!captured) {
    return { ok: false, reason: 'no-member-number-captured (profile did not load)' };
  }

  // ── 4) A URN was captured and it points at a different profile than the lead. ──
  if (urnComparable && !urnMatch) {
    return { ok: false, reason: 'urn-prefix-mismatch (captured a different profile)' };
  }

  // ── 5) A real member id was captured and nothing on the row refutes it.
  //    - strict (PRE-send gate): a bare member id with NO corroborating
  //      member-number / name / slug / URN match is NOT enough to risk a send.
  //    - lenient (post-send write-back guard): trust it rather than over-skip
  //      (preserves the original 2026-06-09 behaviour). ──
  if (strict) {
    return { ok: false, reason: 'unconfirmed (no member-number/name/slug/URN corroboration)' };
  }
  return { ok: true, reason: 'member-number-present-unverified' };
}
