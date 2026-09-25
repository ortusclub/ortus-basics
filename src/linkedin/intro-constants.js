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

// Written to Introduction Status when an accepted lead could not be introduced
// because the SENDING account is not a 1st-degree connection of the primary.
// Terminal like every other non-blank value: the operator clears the cell and
// runs a check once the two are connected (the text says so).
export const INTRO_HELD_PRIMARY_NOT_CONNECTED = "Can't make intro — primary not connected to sender. Once they're connected, delete this text and run the check again.";

// Same idea when the campaign has no primary person at all (2026-09-25,
// "NitaHello": 10 Connected rows, intro step never ran, nothing said).
// Three introductions in a row failed for one sender in one pass: the degree
// read must have been wrong (it can come back 'unverified' and let intros
// proceed), so assume the sender is not connected to the primary, stop trying
// for that sender, and say so on the remaining rows (Sam, 2026-09-25).
export const INTRO_ASSUMED_PRIMARY_NOT_CONNECTED = "Assumed primary not connected to sender — 3 introductions in a row failed. Once they're connected, delete this text and run the check again.";

export const INTRO_HELD_NO_PRIMARY = "Can't make intro — no primary person set on this campaign. Add the primary's name, LinkedIn URL and intro message in the wizard, delete this text and run the check again.";

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
