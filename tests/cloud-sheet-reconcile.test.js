import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudLeadToLocalSheetData,
  engineErrorToLocalReason,
  sentStageToAction,
} from '../src/cloud-sheet-reconcile.js';
import { normalizeSkipReason } from '../src/campaign.js';

// The cloud sheet write-back must be 1:1 with what a LOCAL campaign writes.
// These lock the mapping from the engine's per-lead rows to local's exact stamps.

test('connect sent → local "Connect Pending" / "Connection Request Sent" + Sender', () => {
  const d = cloudLeadToLocalSheetData('connect_only', { status: 'sent', stage: 'CC' }, 'alex.sheeraz@ortus.solutions');
  assert.equal(d.stage, 'Connect Pending');           // NOT the engine's 'CC'
  assert.equal(d.status, 'Connection Request Sent');
  assert.equal(d.connectionStatus, 'Connection Request Sent');
  assert.equal(d.sender, 'alex.sheeraz@ortus.solutions');
  assert.equal(d.accountUsed, 'alex.sheeraz@ortus.solutions');
});

test('already connected → local positive stamp, not a skip', () => {
  const d = cloudLeadToLocalSheetData('connect_only', { status: 'error', error: 'Already connected' }, 'alex');
  assert.equal(d.stage, 'Connected');
  assert.equal(d.status, 'Already Connected');
  assert.equal(d.connectionStatus, 'Already Connected');
  assert.equal(d.connectedAlready, 'Yes');
});

test('dead profile → "Skipped: Profile not found (404)", NOT "URL not found"', () => {
  const d = cloudLeadToLocalSheetData('connect_only', { status: 'error', error: 'Profile not found' }, 'alex');
  assert.equal(d.stage, 'Skipped: Profile not found (404)');
  assert.equal(d.status, 'Skipped: Profile not found (404)');
  assert.equal(d.connectionStatus, 'Skipped: Profile not found (404)');
});

test('open-profile message send maps to op stamp', () => {
  assert.equal(sentStageToAction('OP Msg'), 'op_message_sent');
  const d = cloudLeadToLocalSheetData('open_profile_only', { status: 'sent', stage: 'OP Msg' }, 'alex');
  assert.equal(d.opStatus, 'OP Sent');
  assert.equal(d.stage, 'OP Sent');
});

test('pending / claimed → nothing to stamp', () => {
  assert.equal(cloudLeadToLocalSheetData('connect_only', { status: 'pending' }, 'a'), null);
  assert.equal(cloudLeadToLocalSheetData('connect_only', { status: 'claimed' }, 'a'), null);
});

// already_processed — the connect/DM/InMail is already in flight. Local stamps
// the SAME Stage it would for a fresh send in that mode; the reconciler must too
// (agrees with the engine's stageLabel(already_processed, mode)).
test('already_processed (connect_and_introduce) → Connect Pending', () => {
  const d = cloudLeadToLocalSheetData('connect_and_introduce', { status: 'sent', stage: 'already_processed' }, 'alex');
  assert.equal(d.stage, 'Connect Pending');
  assert.equal(d.connectionStatus, 'Connection Request Sent');
});
test('already_processed (message_only) → DM Sent, NOT a connection send', () => {
  const d = cloudLeadToLocalSheetData('message_only', { status: 'sent', stage: 'already_processed' }, 'alex');
  assert.equal(d.stage, 'DM Sent');
  assert.equal(d.dmStatus, 'DM Sent');
});
test('already_processed (introduce_back) → IC Sent', () => {
  const d = cloudLeadToLocalSheetData('introduce_back', { status: 'sent', stage: 'already_processed' }, 'alex');
  assert.equal(d.stage, 'IC Sent');
});
test('already_processed (open_profile_only) → OP Sent', () => {
  const d = cloudLeadToLocalSheetData('open_profile_only', { status: 'sent', stage: 'already_processed' }, 'alex');
  assert.equal(d.stage, 'OP Sent');
});

// Anti-dupe re-encounter → readable duplicate skip, never the empty-error
// fallback's 'Skipped: Skipped'. Agrees with the engine's stageLabel('dup').
test('dup (skipped, no error) → Skipped: Duplicate', () => {
  const d = cloudLeadToLocalSheetData('connect_and_introduce', { status: 'skipped', stage: 'dup' }, 'alex');
  assert.equal(d.stage, 'Skipped: Duplicate');
  assert.equal(d.status, 'Skipped: Duplicate');
  // connect_only routes the reason into the Connection Request Status column too.
  const c = cloudLeadToLocalSheetData('connect_only', { status: 'skipped', stage: 'dup' }, 'alex');
  assert.equal(c.connectionStatus, 'Skipped: Duplicate');
});

// The engine phrases errors its own way. Each must translate to the SAME
// canonical "Skipped: …" a local run produces. Table = [engine error, expected].
const ENGINE_ERROR_CASES = [
  ['Profile not found',                                              'Skipped: Profile not found (404)'],
  ['NOT_OPEN_PROFILE: lead is not Open Profile (tick "Spend an InMail credit" to message anyway)', 'Skipped: contact is either not Open Profile or the sending account has reached its monthly OP credit limit'],
  ['Connect failed: Connect button not found after 60s [no-tags]',   'Skipped: Connect button not found'],
  ['Session expired — please log in again',                          'Skipped: Session expired'],
  ['Redirected to /authwall',                                        'Skipped: Session expired'],
  ['Landed on /checkpoint/challenge',                                'Skipped: Session expired'],
  ['Email required to connect',                                      'Skipped: Email required'],
  ['Send not confirmed after click',                                 'Skipped: Send not confirmed'],
  ['HTTP 429 Too Many Requests',                                     'Skipped: Rate-limited (HTTP 429) — confirming…'],
  ['Request was throttled',                                          'Skipped: Rate limited'],
  ['Note too long for a non-premium account (200 char limit)',       'Skipped: Profile not premium, custom notes limit'],
  ['Weekly invitation limit reached',                                'Skipped: Weekly limit reached'],
  ['InMail credits exhausted',                                       'Skipped: InMail credits exhausted'],
  ['Lead timed out (watchdog)',                                      'Skipped: Lead timed out'],
  ['Connect modal did not appear',                                   'Skipped: Connect modal did not appear'],
  ['LinkedIn error toast shown',                                     'Skipped: LinkedIn error toast'],
  ['Legacy Sales Nav URL',                                           'Skipped: Legacy Sales Nav URL'],
];

for (const [engineErr, expected] of ENGINE_ERROR_CASES) {
  test(`engine "${engineErr.slice(0, 40)}…" → ${expected}`, () => {
    const d = cloudLeadToLocalSheetData('connect_only', { status: 'error', error: engineErr }, 'alex');
    assert.equal(d.status, expected, `status for: ${engineErr}`);
    assert.equal(d.stage, expected, `stage for: ${engineErr}`);
  });
}

test('every translated reason is a real local skip wording (round-trips through normalizeSkipReason)', () => {
  // Whatever engineErrorToLocalReason returns must, via normalizeSkipReason,
  // equal one of local's canonical outputs (never a raw engine dump for a
  // known category).
  for (const [engineErr, expected] of ENGINE_ERROR_CASES) {
    assert.equal(normalizeSkipReason(engineErrorToLocalReason(engineErr)), expected);
  }
});

test('unknown engine error falls back to a "Skipped: …" wording (never blank)', () => {
  const d = cloudLeadToLocalSheetData('connect_only', { status: 'error', error: 'Some brand new failure' }, 'alex');
  assert.match(d.status, /^Skipped: /);
});

// ── CC+IC / CC+DM multi-step pipeline (engine sub-status fields → local cols) ──

test('CC+DM: connect sent, not yet accepted → Connect Pending only', () => {
  const d = cloudLeadToLocalSheetData('connect_and_message', { status: 'sent', stage: 'CC' }, 'alex');
  assert.equal(d.stage, 'Connect Pending');
  assert.equal(d.connectionStatus, 'Connection Request Sent');
  assert.equal(d.dmStatus, undefined); // no DM yet
});

test('CC+DM: accepted + DM sent → Connected · DM Now + DM Status "DM Sent"', () => {
  const d = cloudLeadToLocalSheetData('connect_and_message',
    { status: 'sent', stage: 'CC', connectionAcceptedStatus: 'Accepted', dmStatus: 'DM Sent' }, 'alex');
  assert.equal(d.cc, 'Connected');               // → Connection Accepted Status
  assert.equal(d.stage, 'Connected · DM Now');
  assert.equal(d.dmStatus, 'DM Sent');           // → DM Status
});

test('CC+IC: accepted + intro made → Stage Connected, Introduction Status "Introduction Made", Connected Yes', () => {
  const d = cloudLeadToLocalSheetData('connect_and_introduce',
    { status: 'sent', stage: 'CC', connectionAcceptedStatus: 'Connected', introductionStatus: 'Introduction Made' }, 'alex');
  assert.equal(d.introductionStatus, 'Introduction Made'); // → Introduction Status
  assert.equal(d.stage, 'Connected');                      // introConnectionStamp
  assert.equal(d.cc, 'Connected');
  assert.equal(d.connectedAlready, 'Yes');                 // → Connected column
});

test('engine sub-status VALUE variants normalize to local wording', () => {
  // Whatever the engine calls it, it maps to local's canonical strings.
  for (const v of ['made', 'sent', 'Introduction sent', 'done']) {
    const d = cloudLeadToLocalSheetData('connect_and_introduce', { status: 'sent', introductionStatus: v }, 'a');
    assert.equal(d.introductionStatus, 'Introduction Made', `intro value: ${v}`);
  }
  for (const v of ['sent', 'DM sent', 'done', 'success']) {
    const d = cloudLeadToLocalSheetData('connect_and_message', { status: 'sent', dmStatus: v }, 'a');
    assert.equal(d.dmStatus, 'DM Sent', `dm value: ${v}`);
  }
  const already = cloudLeadToLocalSheetData('connect_and_introduce', { status: 'sent', introductionStatus: 'already made' }, 'a');
  assert.equal(already.introductionStatus, 'Introduction Already Made');
});

test('a "not accepted"/pending acceptance value does NOT mark connected', () => {
  for (const v of ['Not accepted', 'pending', 'awaiting acceptance', 'no']) {
    const d = cloudLeadToLocalSheetData('connect_and_message', { status: 'sent', connectionAcceptedStatus: v }, 'a');
    assert.equal(d.stage, 'Connect Pending', `acceptance value: ${v}`);
    assert.notEqual(d.cc, 'Connected');
  }
});

test('failed/skipped intro or DM lands verbatim-ish in the RIGHT column', () => {
  const iSkip = cloudLeadToLocalSheetData('connect_and_introduce', { status: 'sent', introductionStatus: 'skipped — no primary' }, 'a');
  assert.match(iSkip.introductionStatus, /^Skipped — /);
  const dFail = cloudLeadToLocalSheetData('connect_and_message', { status: 'sent', dmStatus: 'failed — compose box not found' }, 'a');
  assert.match(dFail.dmStatus, /^Failed — /);
});
