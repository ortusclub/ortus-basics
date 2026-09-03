/**
 * Shared Introduction Status string constants + helpers.
 *
 * Kept in a tiny leaf module (no imports) so auto-intro.js, bulk-check-
 * connections.js and server.js can all share them without circular deps.
 */

// The terminal failure stamp written when a 3-way intro can't add the primary
// because the sending account isn't a 1st-degree connection of the primary.
// MUST match the string produced by _friendlyIntroFailure in auto-intro.js.
export const INTRO_FAILED_PRIMARY_NOT_CONNECTED = 'Failed — Primary not in your connections';

// v2.98 — non-terminal retry sentinel written by the "reconnect & retry" revive
// flow (solo check). We can't clear the cell back to blank (the shared Apps
// Script skips empty-string writes), so we overwrite the terminal failure with
// this marker instead. bulk-check treats it as "not yet introduced" so the
// intro re-fires automatically once the primary accepts the connection request.
export const INTRO_RETRY_RECONNECT = 'Reconnecting to primary — will retry';

/** True when an Introduction Status value is the retry sentinel (≈ blank for
 *  re-queue purposes). Trimmed, case-sensitive on the canonical string. */
export function isIntroRetrySentinel(s) {
  return String(s || '').trim() === INTRO_RETRY_RECONNECT;
}

/** Treat the cell as "open for an intro attempt": genuinely blank OR the retry
 *  sentinel. Any other non-blank value is terminal (one-shot column, v2.71). */
export function isIntroSlotOpen(s) {
  const v = String(s || '').trim();
  return v === '' || v === INTRO_RETRY_RECONNECT;
}
