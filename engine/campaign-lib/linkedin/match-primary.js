/**
 * Pure matcher for the LinkedIn typeahead dropdown when adding a recipient.
 *
 * Three-tier match, attempted in order:
 *   1. Exact / startsWith — configured name equals candidate OR candidate
 *      starts with `${configuredName} ` (catches "Sam" → "Sam Ferrer · CEO").
 *   2. Token-prefix — every whitespace token in the configured name is a
 *      prefix of some whitespace word in the candidate. Catches "Sam Ferrer"
 *      → "Samuel Ferrer".
 *   3. Single-candidate fallback — if LinkedIn returns exactly one suggestion,
 *      click it. Almost always correct for a name-based typeahead.
 *
 * Mirrored inline inside src/linkedin/actions.js sendIntroMessage's
 * page.evaluate block — when this file changes, that block must change too.
 * See the comment at the call site for details.
 */

export function normalizeName(v) {
  return (v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^remove\s+/, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Array<{text: string}>} candidates - candidate rows from the dropdown
 * @param {string} configuredName            - operator-configured primary name
 * @returns {{ matchIndex: number|null, reason: string }}
 *   reason: 'exact' | 'token-prefix' | 'single-candidate' | 'no-match' | 'no-candidates' | 'empty-config'
 */
export function matchPrimaryCandidate(candidates, configuredName) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { matchIndex: null, reason: 'no-candidates' };
  }
  const norm = normalizeName(configuredName);
  if (!norm) return { matchIndex: null, reason: 'empty-config' };

  // Tier 1: exact / startsWith
  for (let i = 0; i < candidates.length; i++) {
    const t = normalizeName(candidates[i].text);
    if (t === norm || t.startsWith(`${norm} `)) {
      return { matchIndex: i, reason: 'exact' };
    }
  }

  // Tier 2: token-prefix match
  const tokens = norm.split(/\s+/);
  for (let i = 0; i < candidates.length; i++) {
    const t = normalizeName(candidates[i].text);
    const words = t.split(/\s+/);
    const allMatched = tokens.every(tok => words.some(w => w.startsWith(tok)));
    if (allMatched) {
      return { matchIndex: i, reason: 'token-prefix' };
    }
  }

  // Tier 3: single-candidate fallback
  if (candidates.length === 1) {
    return { matchIndex: 0, reason: 'single-candidate' };
  }

  return { matchIndex: null, reason: 'no-match' };
}

/**
 * Same-name recipient disambiguation for the CC+IC clean-compose typeahead
 * (Antonio + boss, 2026-06-16). The messaging dropdown exposes NO slug or
 * member-id — only name, degree, headline, and the avatar. Verified live:
 * typing "Kyra De la Cruz" returned TWO different same-name people, neither
 * the intended one. So when more than one candidate shares the name, the ONLY
 * reliable signal is the profile photo — the avatar media-id token, which is
 * identical between the dropdown row and the person's profile page.
 *
 * Rules:
 *   - 0 name matches → 'no-match' (caller treats as recipient-not-found).
 *   - exactly 1 name match → 'single' (the common case — no reference photo
 *     needed, so no profile visit cost).
 *   - >1 name match → require expectedAvatarToken (the intended person's real
 *     profile-photo token) and pick the ONE candidate whose avatar matches.
 *     Zero matches → 'ambiguous-no-photo-match'; >1 → 'ambiguous-multiple-
 *     photo-match'; no reference supplied → 'ambiguous-no-reference'. In every
 *     ambiguous case index is -1 so the caller SKIPS — we never guess a person.
 *
 * 1st-degree candidates are preferred when present (recipients must be
 * connections). Group-message rows are ignored — they aren't people.
 *
 * Pure + exported for unit testing; the browser-side selector in
 * src/linkedin/actions.js (sendIntroViaCleanCompose) mirrors this logic inline
 * — keep the two in sync (same hand-mirrored pattern as matchPrimaryCandidate).
 *
 * @param {Array<{text:string, is1st?:boolean, isGroup?:boolean, avatarToken?:string}>} candidates
 * @param {{ name: string, expectedAvatarToken?: string }} opts
 * @returns {{ index: number, reason: string }}
 */
export function pickRecipientByIdentity(candidates, { name, expectedAvatarToken } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { index: -1, reason: 'no-candidates' };
  }
  const norm = normalizeName(name);
  if (!norm) return { index: -1, reason: 'empty-name' };
  const tokens = norm.split(/\s+/).filter(Boolean);

  const nameMatches = (cand) => {
    const t = normalizeName(cand.text);
    if (t === norm || t.startsWith(`${norm} `)) return true;
    const words = t.split(/\s+/);
    return tokens.length > 0 && tokens.every((tok) => words.some((w) => w.startsWith(tok)));
  };

  // Keep original indices; drop group-message rows (not real recipients).
  let matched = candidates
    .map((cand, index) => ({ cand, index }))
    .filter(({ cand }) => !cand.isGroup && nameMatches(cand));

  // Prefer 1st-degree connections when any name-match is 1st-degree.
  const firstDegree = matched.filter(({ cand }) => cand.is1st);
  if (firstDegree.length > 0) matched = firstDegree;

  if (matched.length === 0) return { index: -1, reason: 'no-match' };
  if (matched.length === 1) return { index: matched[0].index, reason: 'single' };

  // More than one same-name candidate — disambiguate strictly by profile photo.
  if (!expectedAvatarToken) return { index: -1, reason: 'ambiguous-no-reference' };
  const photoMatches = matched.filter(({ cand }) => cand.avatarToken && cand.avatarToken === expectedAvatarToken);
  if (photoMatches.length === 1) return { index: photoMatches[0].index, reason: 'avatar-match' };
  return {
    index: -1,
    reason: photoMatches.length === 0 ? 'ambiguous-no-photo-match' : 'ambiguous-multiple-photo-match',
  };
}
