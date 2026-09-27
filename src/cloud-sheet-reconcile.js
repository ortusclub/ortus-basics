/**
 * Cloud → leads-sheet write-back parity (1:1 with local).
 *
 * The engine writes SOME rows back to the source sheet, but with its OWN wording
 * (Stage 'CC', blank Sender) and it leaves error/skip rows blank — so a cloud
 * campaign's sheet does NOT look like the same campaign run locally. This module
 * maps each engine per-lead row to the EXACT sheetData a LOCAL campaign writes,
 * by reusing local's own builders (buildSheetDataForAction / buildSkipSheetData /
 * normalizeSkipReason). The reconciler then stamps every terminal row so the
 * cloud sheet is byte-for-byte what local would have produced.
 *
 * Reference (what local writes — src/campaign.js buildSheetDataForAction):
 *   connect sent      → Stage 'Connect Pending', (Connection Request) Status
 *                       'Connection Request Sent', Sender/Account Used filled
 *   already connected → Stage 'Connected', Status 'Already Connected',
 *                       Connected 'Yes'
 *   dead profile      → 'Skipped: Profile not found (404)'  (NOT 'URL not found')
 */

import { buildSheetDataForAction, buildSkipSheetData, normalizeSkipReason } from './campaign.js';

// The engine phrases errors differently from the internal reason tokens local's
// send path produces. Translate the engine's error → the token that makes
// normalizeSkipReason emit local's EXACT canonical "Skipped: …" wording, across
// local's whole skip vocabulary.
//
// Order is deliberate — specific before generic (mirrors normalizeSkipReason),
// with two real collisions handled:
//   • the engine's NOT_OPEN_PROFILE message literally contains "InMail credit",
//     so "not open profile" MUST be checked before the inmail-credits branch;
//   • "connect button not found" MUST be checked before the generic "connect
//     failed" (the engine string is "Connect failed: Connect button not found…").
export function engineErrorToLocalReason(err) {
  const s = String(err || '');
  const l = s.toLowerCase();
  if (!l) return s;
  // Dead profile → local's 404 wording (NOT the generic "URL not found").
  if (l.includes('profile not found') || l.includes('does not exist') || l.includes('page not found') || l.includes('/404')) return 'profile_not_found_404';
  if (l.includes('legacy sales nav')) return 'legacy sales nav';
  // Not-Open-Profile BEFORE inmail-credits (the engine's message mentions both).
  if (l.includes('not open profile') || l.includes('not_open_profile')) return 'not_open_profile';
  if (l.includes('session') || l.includes('login page') || l.includes('/login') || l.includes('authwall') || l.includes('checkpoint') || l.includes('logged out') || l.includes('not logged in')) return 'session expired';
  // Connect-button-not-found BEFORE the generic connect-failed.
  if (l.includes('connect button not found')) return 'connect button not found';
  if (l.includes('modal did not appear') || l.includes('no modal')) return 'no modal appeared';
  if (l.includes('wrong person') || l.includes('connect_modal_wrong_person')) return 'connect_modal_wrong_person';
  // 'email_required' (underscore) = the engine's raw EMAIL_REQUIRED throw — the
  // "enter their email to connect" gate. Previously missed (space-only match) and
  // fell through to the generic 'connect failed' stamp.
  if (l.includes('email required') || l.includes('email_required') || (l.includes('email') && l.includes('verif'))) return 'email required';
  if (l.includes('send not confirmed') || l.includes('send_not_confirmed')) return 'send_not_confirmed';
  // 429 (specific) before the generic rate-limit.
  if (l.includes('429') || l.includes('too many requests')) return 'voyager_rejected HTTP 429';
  if (l.includes('rate-limit') || l.includes('rate limit') || l.includes('rate_limited') || l.includes('throttl')) return 'rate_limited';
  if (l.includes('note') && (l.includes('long') || l.includes('premium') || l.includes('200') || l.includes('character'))) return 'note_too_long';
  if (l.includes('weekly') || l.includes('invitation limit') || l.includes('invite limit')) return 'weekly_limit';
  if (l.includes('inmail') && l.includes('credit')) return 'inmail_no_credits';
  if (l.includes('timed out') || l.includes('timeout') || l.includes('lead_timeout')) return 'lead_timeout_watchdog';
  if (l.includes('linkedin error toast') || l.includes('linkedin_error_toast')) return 'linkedin_error_toast';
  if (l.includes('not yet connected')) return 'not yet connected';
  if (l.includes('not confirmed connected')) return 'not confirmed connected';
  if (l.includes('connect failed')) return 'connect failed';
  return s; // unknown → normalizeSkipReason default: "Skipped: <engine text>"
}

// Map an engine 'sent' lead's stage → the local outreach action whose sheet
// stamp we reproduce. 'CC' (and anything unrecognized) is a connection send;
// OP / InMail / IC / DM map to their respective sends.
export function sentStageToAction(stage) {
  const s = String(stage || '').toLowerCase().trim();
  if (s.startsWith('op')) return 'op_message_sent';  // 'OP Msg'
  if (s.includes('inm')) return 'inmail_sent';       // 'InM Sent'
  if (s.includes('ic')) return 'message_sent';       // introduce_back
  if (s.includes('dm')) return 'message_sent';       // 'DM Sent'
  return 'connection_sent';                          // 'CC' + default
}

// Connect-based modes run a MULTI-STEP pipeline (connect → accept → intro/DM),
// each step stamping a DIFFERENT column. The engine tracks the same steps in its
// per-lead sub-status fields, so for these modes we layer the engine's
// connectionAcceptedStatus / introductionStatus / dmStatus onto the connect
// stamp — reproducing local's exact multi-column output.
const CONNECT_MODES = new Set(['connect_only', 'connect_and_introduce', 'connect_and_message']);

// The engine's sub-status field VALUES aren't yet observed (no CC+IC/CC+DM cloud
// run has reached these steps), so normalize by keyword to local's canonical
// wording, with a verbatim fallback so an unrecognized value still lands in the
// correct column. Column placement is certain (engine field ≈ local column).
function isAcceptedValue(v) {
  const l = String(v || '').toLowerCase();
  if (!l) return false;
  if (/\bnot\b|pending|await|declin|ignor|withdraw|\bno\b/.test(l)) return false;
  return /accept|connected|1st|first[- ]degree|\byes\b|true/.test(l);
}
function normalizeIntroValue(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const l = s.toLowerCase();
  if (l.includes('already')) return 'Introduction Already Made';
  if (/made|sent|done|success/.test(l)) return 'Introduction Made';
  if (/skip/.test(l)) return `Skipped — ${s}`;
  if (/fail|error/.test(l)) return `Failed — ${s}`;
  return s; // verbatim → correct column
}
function introIsPositive(v) {
  return /made|sent|done|success|already/.test(String(v || '').toLowerCase());
}
function normalizeDmValue(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const l = s.toLowerCase();
  if (/skip/.test(l)) return `Skipped — ${s}`;
  if (/fail|error/.test(l)) return `Failed — ${s}`;
  if (/sent|done|success|made/.test(l)) return 'DM Sent';
  return s; // verbatim → correct column
}

/**
 * The exact sheetData a LOCAL campaign would write for one engine per-lead row,
 * or null when there's nothing to stamp yet (pending / claimed).
 * @param {string} mode        campaign mode
 * @param {object} lead        engine per-lead row { status, stage, error,
 *                             connectionAcceptedStatus, introductionStatus, dmStatus }
 * @param {string} senderName  GoLogin account label (→ Sender / Account Used)
 */
export function cloudLeadToLocalSheetData(mode, lead, senderName = '') {
  if (!lead) return null;
  const status = lead.status;
  const err = String(lead.error || '');

  if (status === 'error' || status === 'skipped') {
    // "Already connected" — the engine reports it as an error, but local records
    // it as a positive already_connected outcome (Stage 'Connected', …).
    if (err.toLowerCase().includes('already connected')) {
      return buildSheetDataForAction({ action: 'already_connected', mode, profileName: senderName });
    }
    // Anti-dupe re-encounter — the engine marks a person it already actioned in
    // this campaign as skipped/stage 'dup' with NO error. Local dedups before it
    // ever writes, so there's no exact local string; surface a readable duplicate
    // skip (matches the engine's own stageLabel) instead of the empty-error
    // fallback's 'Skipped: Skipped'.
    if (String(lead.stage) === 'dup') {
      return buildSkipSheetData(mode, 'Skipped: Duplicate', senderName);
    }
    const reason = normalizeSkipReason(engineErrorToLocalReason(err) || (status === 'skipped' ? 'Skipped' : 'Error'));
    return buildSkipSheetData(mode, reason, senderName);
  }
  if (status !== 'sent') return null; // pending / claimed → nothing to stamp yet

  // already_processed — the connect/DM/InMail is already in flight (a real
  // vendored-outreach outcome). Local has a dedicated MODE-AWARE stamp for it
  // (Connect Pending for connect modes; DM/IC/InM/OP Sent for the send-only
  // modes), so route straight to that action rather than letting sentStageToAction
  // default the unrecognized code to a connection send (wrong Stage for send-only
  // modes). Matches the engine's stageLabel(already_processed, mode) 1:1.
  if (String(lead.stage) === 'already_processed') {
    return buildSheetDataForAction({ action: 'already_processed', mode, profileName: senderName });
  }

  // Non-connect single-step sends (message_only / introduce_back / open_profile /
  // inmail) map straight to their action.
  if (!CONNECT_MODES.has(String(mode))) {
    return buildSheetDataForAction({ action: sentStageToAction(lead.stage), mode, profileName: senderName, sentVia: lead.sentVia });
  }

  // Connect-based modes — start from the connect stamp, then layer the pipeline.
  const out = buildSheetDataForAction({ action: 'connection_sent', mode, profileName: senderName });
  // Accepted → Connection Accepted Status 'Connected' + Stage 'Connected · DM Now'
  // (local buildSheetDataForAction status_accepted).
  if (isAcceptedValue(lead.connectionAcceptedStatus)) {
    out.cc = 'Connected';          // FIELD_MAP: cc → 'Connection Accepted Status'
    out.checkStatus = 'Connected';
    out.stage = 'Connected · DM Now';
  }
  // CC+DM step → 'DM Status' column (auto-dm.js).
  const dm = normalizeDmValue(lead.dmStatus);
  if (dm) out.dmStatus = dm;
  // CC+IC step → 'Introduction Status' column + intro connection stamp
  // (auto-intro.js: introConnectionStamp sets Stage 'Connected', Connected 'Yes').
  const intro = normalizeIntroValue(lead.introductionStatus);
  if (intro) {
    out.introductionStatus = intro;
    if (introIsPositive(lead.introductionStatus)) {
      out.cc = 'Connected';
      out.checkStatus = 'Connected';
      out.stage = 'Connected';
      out.connectedAlready = 'Yes';
    }
  }
  return out;
}
