import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates } from '../src/linkedin/bulk-check-connections.js';

const baseRow = (overrides = {}) => ({
  'First Name': 'Jane',
  'Last Name': 'Doe',
  'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
  'Connection Request Status': 'Connection Request Sent',
  'Connected Status': '',
  ...overrides,
});

const baseConns = [
  { firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'eryca.bilazon@ortus.solutions' },
];

const stillPendingLabel = 'Still Pending (2026-05-12 10:00)';
const linkedinColumn = 'LinkedIn URL';

test('suppressAcceptedStamp=false: matched URL gets cc + connectedAlready in updates', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 1);
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match, 'matched URL should be in updates');
  assert.equal(match.cc, 'Connected');
  assert.equal(match.connectedAlready, 'Yes');
});

test('suppressAcceptedStamp=true: matched URL returned in connectedUrls but NOT in updates', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: true }
  );
  assert.equal(connectedUrls.length, 1, 'connectedUrls preserved');
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(match, undefined, 'matched URL stamp suppressed from updates');
});

test('suppressAcceptedStamp=true: still-pending rows STILL get stamped', () => {
  const pendingRow = baseRow({
    'First Name': 'Bob',
    'Last Name': 'Smith',
    'LinkedIn URL': 'https://linkedin.com/in/bob-smith',
  });
  const { updates } = computeBulkCheckUpdates(
    [pendingRow], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: true }
  );
  const pendingStamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/bob-smith');
  assert.ok(pendingStamp, 'still-pending row should be stamped regardless of flag');
  assert.equal(pendingStamp.cc, stillPendingLabel);
});

test('back-compat: row with CC=Connected (new header) AND introduction made is skipped', () => {
  // v2.14.x: CC=Connected alone is NOT enough to skip — the intro might
  // have been interrupted (Stop pressed, browser died) leaving a Skipped
  // stamp that needs re-pickup. The authoritative "intro done" signal is
  // introductionStatus='Introduction Made'. See bulk-check-connections.js
  // re-ordering for SB-2.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'Introduction Status': 'Introduction Made',
  })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'rows with intro already made are skipped');
});

test('SB-2 fix: row with CC=Connected but BLANK introductionStatus is re-pushed for intro retry', () => {
  // Repro of the SB-2 bug: a lead whose intro was interrupted mid-batch
  // had CC=Connected but no introductionStatus. Previous filter skipped
  // them forever; new filter re-pushes them to connectedUrls so the next
  // auto-intro pass fires.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    // No Introduction Status — intro never fired or got interrupted.
  })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'CC=Connected without intro IS re-pushed for retry');
  // CC is already at its target value — don't redundantly re-stamp it.
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(stamp, undefined, 'no CC re-stamp when already Connected');
});

test('v2.82: aged-off connection (NOT in recent conns) + blank intro IS re-pushed (trust the sheet)', () => {
  // The lead accepted long ago and has fallen off LinkedIn's ~80-most-recent
  // window, so it is absent from `conns` (isMatch=false). The sheet records it
  // Connected + assigned to the sweeping account, intro never landed. Operator
  // rule 2026-06-08: trust the sheet — re-queue for the intro retry.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'Sender': 'kenya5@ortus.solutions',
    // No Introduction Status — intro never landed.
  })];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, [], linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'aged-off Connected + blank intro re-queued for retry');
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  // Trust-the-sheet retry must NOT downgrade the row to Still Pending.
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(stamp, undefined, 'no Still-Pending downgrade for an aged-off Connected row');
});

test('v2.82: aged-off connection + ANY intro status is NOT re-pushed (one-shot honored)', () => {
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'Sender': 'kenya5@ortus.solutions',
    'Introduction Status': 'Failed — compose box not found',
  })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, [], linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 0, 'non-blank Intro Status blocks the aged-off retry');
});

test('v2.82: aged-off connection assigned to a DIFFERENT account is NOT re-pushed by this sweep', () => {
  // Sender-scoping: only the row's assigned account may fire the intro, so the
  // retry never originates from a non-connected browser.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'Sender': 'someone-else@ortus.solutions',
  })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, [], linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 0, 'a different account does not retry another sender\'s row');
});

test('v2.71: row with CC=Connected + Skipped — Stop pressed is NOT re-pushed (Intro Status one-shot)', () => {
  // v2.71 spec change: Intro Status is one-shot. ANY non-empty value blocks
  // a retry — 'Skipped — Stop pressed', 'Skipped — browser closed',
  // 'Failed — …', operator notes, anything. Operator must clear the cell
  // manually to re-enable. Reverses the SB-2 design where Skipped statuses
  // were treated as re-introducible.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Introduction Status': 'Skipped — Stop pressed',
  })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 0, 'any non-empty Intro Status blocks re-intro');
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(stamp, undefined, 'no CC re-stamp');
});

test('empty conns: pending rows still get Still Pending stamp; matched-set lookups yield no false matches', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, [], linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'no connections → no matches');
  // Row's request status IS "Connection Request Sent" → gets stamped Still Pending.
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(stamp, 'row should be stamped Still Pending');
  assert.equal(stamp.cc, stillPendingLabel);
});

test('empty rows: returns empty updates, empty connectedUrls, zero counters', () => {
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(updates.length, 0);
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.rowsScanned, 0);
  assert.equal(diag.withUrl, 0);
});

test('row with missing LinkedIn URL: silently skipped, doesn\'t throw', () => {
  const rowWithoutUrl = { 'First Name': 'No', 'Last Name': 'URL' };
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [rowWithoutUrl], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(updates.length, 0, 'no URL → no stamp');
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.rowsScanned, 1, 'still counted as scanned');
  assert.equal(diag.withUrl, 0, 'but withUrl=0 since URL was missing');
});

// v2.14.x — pre-existing 1st-degree connection branching
test('matched + wasInvited: stamps Connected + Stage=Connected (v2.62 sync fix)', () => {
  // v2.62: Stage now flips to 'Connected' alongside cc so the row reads
  // consistently. Previously Stage stayed at 'Connect Pending' while cc
  // showed 'Connected' — operator confusion fix.
  const rows = [baseRow({ 'Connection Request Status': 'Connection Request Sent' })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { updates } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match);
  assert.equal(match.cc, 'Connected');
  assert.equal(match.checkStatus, 'Connected');
  assert.equal(match.stage, 'Connected', 'v2.62: wasInvited path stamps stage to keep columns in sync');
  assert.equal(match.sender, undefined, 'wasInvited path does NOT stamp sender (assigned sender stays)');
});

test('matched + NOT invited: stamps Sender + Stage = "Already connected" (pre-existing 1st-degree)', () => {
  // Row has no prior outreach by the bot — it's a lead the operator
  // already had as a 1st-degree connection. Bulk-check should stamp the
  // account that's connected so the operator sees WHO, and pre-filter
  // can skip the row from new connect sends.
  const rows = [baseRow({ 'Connection Request Status': '' })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'still pushed to connectedUrls so runAutoIntros fires');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match);
  assert.equal(match.sender, 'kenya5@ortus.solutions');
  assert.equal(match.stage, 'Already connected');
  assert.equal(match.cc, 'Already connected');
  assert.equal(match.checkStatus, 'Already connected');
  assert.equal(match.connectedAlready, 'Yes');
});

test('matched + NOT invited + suppressAcceptedStamp: no stamp but URL returned for IC DM', () => {
  const rows = [baseRow({ 'Connection Request Status': '' })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: true, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'connectedUrls still populated');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(match, undefined, 'no stamp when suppressAcceptedStamp is true');
});

test('row marked "Already connected" + introduction already made: skipped (no re-stamp)', () => {
  // v2.14.x: CC='Already connected' alone is NOT enough — the row could
  // need an intro retry if the introductionStatus is blank/Skipped/Failed.
  // Authoritative "skip me" signal is introductionStatus='Introduction Made'
  // (or 'Introduction Already Made').
  const rows = [baseRow({
    'Connection Accepted Status': 'Already connected',
    'Connected Status': '',
    'Introduction Status': 'Introduction Made',
  })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 0, 'intro-already-made rows not re-pushed');
  assert.equal(updates.length, 0, 'no re-stamp');
});

test('sticky downgrade: row with CC starting with "Unverified — manual review" is skipped before isMatch', () => {
  const downgradedRow = baseRow({
    'First Name': 'Jane',
    'Last Name': 'Doe',
    'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
    'Connection Request Status': 'Connection Request Sent',
    'Connection Accepted Status': 'Unverified — manual review (May 27th, 2026)',
  });
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [downgradedRow], baseConns, linkedinColumn, stillPendingLabel, {}
  );
  assert.ok(
    !connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'downgraded row must NOT be queued for auto-intro'
  );
  assert.ok(
    !updates.some((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe'),
    'downgraded row must NOT receive any stamp write this pass'
  );
  assert.equal(diag.alreadyUnverified, 1, 'diag counter should record the skip');
});

test('cap: URL with composeAttempts >= 3 is excluded from connectedUrls', () => {
  const matchingRow = baseRow();
  const composeAttempts = new Map([['https://linkedin.com/in/jane-doe', 3]]);
  const { connectedUrls, diag } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, { composeAttempts }
  );
  assert.ok(
    !connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'URL with 3+ compose-textbox failures must not re-enter the intro queue'
  );
  assert.equal(diag.composeCapped, 1, 'diag counter should record the cap skip');
});

test('cap: URL with composeAttempts < 3 still flows through to connectedUrls', () => {
  const matchingRow = baseRow();
  const composeAttempts = new Map([['https://linkedin.com/in/jane-doe', 2]]);
  const { connectedUrls } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, { composeAttempts }
  );
  assert.ok(
    connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'URL below the cap must still be queued for auto-intro retry'
  );
});

test('cap: no composeAttempts opt (undefined) defaults to allow', () => {
  const matchingRow = baseRow();
  const { connectedUrls } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, {}
  );
  assert.ok(
    connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'omitted composeAttempts must not block any URL (back-compat)'
  );
});

// ──────────────────────────────────────────────────────────────────────
// v2.62 — sender-scoped matching (cross-account false-positive prevention)
// ──────────────────────────────────────────────────────────────────────

const rowWithSender = (sender, overrides = {}) => baseRow({
  Sender: sender,
  ...overrides,
});

test('v2.62: cross-sender match → Stage="Already connected to X", no CC stamp, no connectedUrls push', () => {
  // Row's Sender is carmella but eryca's bulk-check finds the lead in her
  // network. Eryca should NOT stamp cc=Connected (would be a false positive
  // for carmella's still-pending invite) and should NOT push to connectedUrls
  // (would fire eryca's auto-DM/intro on a row that isn't hers).
  const rows = [rowWithSender('carmella.s@ortus.solutions')];
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  // activeSenders = { carmella, eryca? } — no, only carmella. So eryca isn't
  // in activeSenders. Hmm need a second sheet row with Sender=eryca to put
  // her in activeSenders. Re-run with both senders present.
  assert.equal(updates.length, 0, 'eryca not in activeSenders → no stamps');
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.skippedNotActiveSender, 1, 'caller-not-active-sender defense fired');
});

test('v2.79: cross-sender match → reassign Sender to connected account + green "Already Connected", no intro from wrong account', () => {
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other',
      'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  // Jane is in eryca's connections (baseConns). Eryca's bulk-check runs.
  // Jane's row has Sender=carmella. → cross-sender match.
  const janeUpdate = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(janeUpdate, 'jane gets reassigned + stamped');
  assert.equal(janeUpdate.stage, 'Already Connected');
  assert.equal(janeUpdate.cc, 'Already Connected', 'green Already Connected stamp');
  assert.equal(janeUpdate.connectionStatus, 'Already Connected', 'Connection Request Status reads Already Connected');
  assert.equal(janeUpdate.sender, 'eryca.bilazon@ortus.solutions', 'Sender reassigned to the connected account');
  assert.ok(!connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'no intro pushed from this branch — fires on the connected account\'s own sweep after reassignment');
  assert.equal(diag.crossSender, 1);
});

test('v2.62: same-sender match still works (normal acceptance, with Stage=Connected fix)', () => {
  const rows = [rowWithSender('eryca.bilazon@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match);
  assert.equal(match.cc, 'Connected');
  assert.equal(match.stage, 'Connected', 'Bug 2 fix: Stage flips to Connected alongside cc');
  assert.equal(connectedUrls.length, 1, 'auto-DM/intro can fire (same-sender)');
});

test('v2.62: cross-sender no-match does NOT downgrade to Still Pending', () => {
  // Two-sender campaign. Jane's row Sender=carmella. Eryca's bulk-check runs
  // but doesn't have Jane in her connections (empty conns). Eryca should NOT
  // stamp Still Pending on carmella's row.
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const emptyConns = []; // eryca has no matching connections
  const { updates } = computeBulkCheckUpdates(
    rows, emptyConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const janeStamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(janeStamp, undefined,
    'eryca must not stamp Still Pending on carmella\'s row');
});

test('v2.62: cross-sender match where assigned sender already stamped Connected → leave alone', () => {
  // Carmella already stamped cc=Connected on Jane. Eryca then finds Jane.
  // Eryca should NOT overwrite Stage with "Already connected to eryca" because
  // the assigned sender's acceptance has already been confirmed.
  const rows = [rowWithSender('carmella.s@ortus.solutions', {
    'Connection Accepted Status': 'Connected',
  }), rowWithSender('eryca.bilazon@ortus.solutions', {
    'First Name': 'Other', 'Last Name': 'Person',
    'LinkedIn URL': 'https://linkedin.com/in/other-person',
  })];
  const { updates } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const janeStamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(janeStamp, undefined,
    'eryca leaves the already-Connected row alone (idempotency)');
});

test('v2.62: legacy sheet with no Sender column behaves like pre-fix code', () => {
  // baseRow doesn't include a Sender column. activeSenders is empty →
  // senderScopingActive=false → no scoping applied → existing behavior.
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match, 'legacy no-Sender sheet still gets stamped');
  assert.equal(match.cc, 'Connected');
  assert.equal(connectedUrls.length, 1);
});

test('v2.62: caller not in activeSenders → defensive empty return', () => {
  // Sara is selected in the UI but no sheet row has Sara as Sender.
  // Defense: sara's bulk-check returns empty updates.
  const rows = [
    rowWithSender('eryca.bilazon@ortus.solutions'),
    rowWithSender('carmella.s@ortus.solutions', {
      'First Name': 'Carm', 'Last Name': 'Row',
      'LinkedIn URL': 'https://linkedin.com/in/carm-row',
    }),
  ];
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { profileName: 'sara@ortus.solutions' }
  );
  assert.equal(updates.length, 0, 'sara isn\'t a campaign sender → no stamps');
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.skippedNotActiveSender, 2, 'defense counted all rows');
});

// ──────────────────────────────────────────────────────────────────────
// Tab-as-Bible — per-entry account attribution (accumulated tab matching)
// ──────────────────────────────────────────────────────────────────────

// A connection carrying an explicit owning account (as stored in the tab).
const connWithAccount = (account, overrides = {}) => ({
  firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe',
  urn: 'ACoAAaaa', memberNumber: '111', account, ...overrides,
});

test('accumulation: lead owned by the row\'s assigned sender → Connected (even when another account is sweeping)', () => {
  // Carmella swept earlier and recorded Jane under her account. Eryca sweeps
  // now; the accumulated tab still carries Jane@carmella. Jane's row is
  // assigned to carmella → must read Connected, NOT cross-sender.
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const accumulated = [connWithAccount('carmella.s@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(jane, 'jane gets stamped');
  assert.equal(jane.cc, 'Connected', 'assigned-sender ownership → Connected');
  // v2.79: eryca is sweeping but jane is connected via CARMELLA — eryca must NOT
  // push the intro (it'd fire from eryca's non-1st-degree browser). The intro
  // fires on carmella's own sweep (sweepingConnected gate).
  assert.ok(!connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'intro not fired from the non-connected sweeping account');
});

test('v2.79 attribution: lead owned ONLY by a different campaign sender → reassign Sender + green Already Connected', () => {
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  // Jane is owned by eryca in the tab, but her row is assigned to carmella.
  const accumulated = [connWithAccount('eryca.bilazon@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(jane);
  assert.equal(jane.stage, 'Already Connected');
  assert.equal(jane.cc, 'Already Connected');
  assert.equal(jane.sender, 'eryca.bilazon@ortus.solutions', 'reassigned to the connected account');
  assert.ok(!connectedUrls.includes('https://linkedin.com/in/jane-doe'), 'intro fires on the reassigned account\'s own sweep, not here');
});

test('attribution: lead owned by BOTH assigned sender and another → Connected wins', () => {
  const rows = [
    rowWithSender('carmella.s@ortus.solutions'),
    rowWithSender('eryca.bilazon@ortus.solutions', {
      'First Name': 'Other', 'Last Name': 'Person',
      'LinkedIn URL': 'https://linkedin.com/in/other-person',
    }),
  ];
  const accumulated = [
    connWithAccount('carmella.s@ortus.solutions'),
    connWithAccount('eryca.bilazon@ortus.solutions'),
  ];
  const { updates } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'eryca.bilazon@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(jane.cc, 'Connected', 'assigned sender owns it → Connected regardless of others');
});

test('v2.86.12: name-only overlap (no slug/urn/numeric-id) does NOT attribute or stamp Connected', () => {
  // The tab entry shares neither publicId nor urn nor numeric Membership ID
  // with the row — ONLY the first+last name matches. v2.86.12 drops NAME as a
  // match key (cross-account false positives), so this must NOT produce a
  // Connected stamp or an intro. The row is still 'Connection Request Sent', so
  // it gets a Still Pending stamp instead (no strong-ID match).
  const rows = [rowWithSender('carmella.s@ortus.solutions', {
    'First Name': 'Jane', 'Last Name': 'Doe',
    'LinkedIn URL': 'https://linkedin.com/in/jane-d-99',
  })];
  const accumulated = [{
    firstName: 'Jane', lastName: 'Doe', publicId: 'someone-else-slug',
    urn: 'ACoAAzzz', memberNumber: '999', account: 'carmella.s@ortus.solutions',
  }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, accumulated, linkedinColumn, stillPendingLabel,
    { profileName: 'carmella.s@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-d-99');
  assert.ok(!connectedUrls.includes('https://linkedin.com/in/jane-d-99'),
    'name-only overlap must NOT be queued for intro');
  assert.notEqual(jane && jane.cc, 'Connected',
    'name-only overlap must NOT stamp Connected (cross-account false positive)');
  // Pending row with no strong-ID match → Still Pending stamp (not Connected).
  assert.equal(jane && jane.cc, stillPendingLabel,
    'no strong-ID match → Still Pending, not Connected');
});

test('live-fallback contract: conn attributed to sweeping profile → assigned-sender row reads Connected', () => {
  // Mirrors bulkCheckConnections' degrade path: when the accumulated tab set
  // is unavailable, the live fetch is attributed to the sweeping profile
  // (account = pName). A row assigned to that same sender must read Connected.
  const rows = [rowWithSender('carmella.s@ortus.solutions')];
  const attributed = [connWithAccount('carmella.s@ortus.solutions')];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, attributed, linkedinColumn, stillPendingLabel,
    { profileName: 'carmella.s@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(jane.cc, 'Connected', 'live-fetch attributed to sweeper → Connected');
  assert.ok(connectedUrls.includes('https://linkedin.com/in/jane-doe'));
});

test('live-fallback contract: account-less conn does NOT mark a sender-scoped row Connected (why attribution is required)', () => {
  // If the fallback forgot to attribute (account = ''), the assigned-sender
  // row would NOT read Connected — documenting why bulkCheckConnections must
  // set account = pName on the degrade path.
  const rows = [rowWithSender('carmella.s@ortus.solutions')];
  const accountLess = [connWithAccount('')]; // account: ''
  const { updates } = computeBulkCheckUpdates(
    rows, accountLess, linkedinColumn, stillPendingLabel,
    { profileName: 'carmella.s@ortus.solutions' }
  );
  const jane = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.notEqual(jane && jane.cc, 'Connected', 'account-less conn must not produce a Connected stamp on a scoped row');
});

// ─────────────────────────────────────────────────────────────────────────
// v2.6x — CC+DM already-DM'd guard (Issue 2). Mirrors the introductionStatus
// guard for CC+IC: when this campaign's phase-2 action is the 1:1 auto-DM
// (opts.dmSentTerminal), a matched row whose DM Status already reads
// 'DM Sent' is terminal and must NOT be re-queued into connectedUrls — else
// every monitoring sweep re-DMs it and the content-dedup overwrites 'DM Sent'
// with 'Skipped — DM already sent'.
// ─────────────────────────────────────────────────────────────────────────

test('dmSentTerminal: matched row already DM Sent is NOT re-queued into connectedUrls', () => {
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'DM Status': 'DM Sent',
  })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, dmSentTerminal: true }
  );
  assert.equal(connectedUrls.length, 0, 'already-DM\'d row must not be re-queued for auto-DM');
});

test('dmSentTerminal OFF (default): DM Sent row is still queued (CC+IC / other modes unaffected)', () => {
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'DM Status': 'DM Sent',
  })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false } // no dmSentTerminal → guard off
  );
  assert.equal(connectedUrls.length, 1, 'with the guard off, behavior is unchanged (mode-safe)');
});

test('dmSentTerminal: a BLANK DM Status row is still queued for the auto-DM', () => {
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'DM Status': '',
  })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, dmSentTerminal: true }
  );
  assert.equal(connectedUrls.length, 1, 'not-yet-DM\'d connections must still be queued');
});

// ─────────────────────────────────────────────────────────────────────────
// v2.6x — heal stale 'Closed - Not Connected' (Issue 1). Operator rule:
// Connection Request Status must never read 'Closed - Not Connected'. The
// stamp was written by an older stop-monitoring build; the invite was never
// withdrawn, so on re-encounter we heal the cell back to 'Connection Request
// Sent' and treat the lead as invited (so a later acceptance reads
// 'Connected', not 'Already connected').
// ─────────────────────────────────────────────────────────────────────────

test('heal: matched Closed-Not-Connected row → connectionStatus rewritten to Connection Request Sent + stamped Connected (wasInvited)', () => {
  const rows = [baseRow({
    'Connection Request Status': 'Closed - Not Connected',
    'Connection Accepted Status': '',
    'Connected Status': '',
  })];
  const conns = [{ firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111', account: 'kenya5@ortus.solutions' }];
  const { updates } = computeBulkCheckUpdates(
    rows, conns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  const heal = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe' && u.connectionStatus);
  assert.ok(heal, 'a heal update rewriting connectionStatus must be present');
  assert.equal(heal.connectionStatus, 'Connection Request Sent');
  const ccStamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe' && u.cc);
  assert.ok(ccStamp, 'a cc stamp must be present');
  assert.equal(ccStamp.cc, 'Connected', 'closed-then-accepted is treated as a normal acceptance (not Already connected)');
});

test('heal: NOT-matched Closed-Not-Connected row → only the connectionStatus heal, no Still Pending churn', () => {
  const rows = [baseRow({
    'Connection Request Status': 'Closed - Not Connected',
    'Connection Accepted Status': '',
    'Connected Status': '',
  })];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, [], linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'not connected → not queued');
  const heal = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(heal, 'closed row gets a heal update even when not matched');
  assert.equal(heal.connectionStatus, 'Connection Request Sent');
  assert.equal(heal.cc, undefined, 'no Still Pending stamp written to the accepted column');
});

test('heal runs BEFORE the DM-Sent guard: a Closed + DM Sent row is healed even though it is skipped from connectedUrls', () => {
  const rows = [baseRow({
    'Connection Request Status': 'Closed - Not Connected',
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'DM Status': 'DM Sent',
  })];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, dmSentTerminal: true }
  );
  assert.equal(connectedUrls.length, 0, 'already-DM\'d → not re-queued');
  const heal = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe' && u.connectionStatus);
  assert.ok(heal, 'closed cell still healed before the DM-Sent short-circuit');
  assert.equal(heal.connectionStatus, 'Connection Request Sent');
});

test('no heal for a normal Connection Request Sent row (no connectionStatus key added)', () => {
  const rows = [baseRow({ 'Connection Request Status': 'Connection Request Sent' })];
  const { updates } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  const withConnStatus = updates.find((u) => u.connectionStatus);
  assert.equal(withConnStatus, undefined, 'normal rows must not get a connectionStatus heal write');
});

// ─────────────────────────────────────────────────────────────────────────
// v2.86.12 — ID-only matching (Issue #2). NAME is no longer a match key:
// name matching caused cross-account false positives (a lead "Vito Mansueto"
// got stamped Connected + introduced off a DIFFERENT account's namesake on an
// unsent row). A lead is "connected" only on a strong identity hit: public
// slug, AC**AA URN-token, or numeric Membership ID owned by an active sender.
// ─────────────────────────────────────────────────────────────────────────

test('name-only match does NOT stamp or introduce (cross-account, unsent)', () => {
  const rows = [{
    'First Name': 'Vito', 'Last Name': 'Mansueto',
    'Linkedin Bio': 'http://www.linkedin.com/in/ACwAAAZLmE8Bl3D54RBLDEXg2MwvxPE4JoIyLX8',
    'Sender': '', 'Connection Request Status': '', 'Linkedin Membership ID': '',
  }];
  // A DIFFERENT account has a connection that only shares the NAME (different token, no slug, no numeric id).
  const conns = [{ account: 'abhinay@x', firstName: 'Vito', lastName: 'Mansueto', urn: 'urn:li:fsd_profile:ACoAAAYLmE8Be4SdifferentXYZ' /* different member number (bytes 4-7): a true namesake */, publicId: '', memberNumber: '' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(rows, conns, 'Linkedin Bio', 'Still Pending', { profileName: 'abhinay@x' });
  assert.equal(connectedUrls.length, 0);
  assert.ok(!updates.some(u => /connected/i.test(String(u.cc || '')) || /connected/i.test(String(u.stage || ''))));
});

test('numeric Membership ID match stamps Connected for the assigned sender', () => {
  const rows = [{
    'First Name': 'Real', 'Last Name': 'Lead',
    'Linkedin Bio': 'http://www.linkedin.com/in/ACwAAReal',
    'Sender': 'rilany@x', 'Connection Request Status': 'Connection Request Sent',
    'Linkedin Membership ID': '105617487', 'LinkedIn URN': '',
  }];
  const conns = [{ account: 'rilany@x', firstName: 'Real', lastName: 'Lead', urn: '', publicId: '', memberNumber: '105617487' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(rows, conns, 'Linkedin Bio', 'Still Pending', { profileName: 'rilany@x' });
  assert.equal(connectedUrls.length, 1);
  assert.ok(updates.some(u => u.cc === 'Connected'));
});

test('G3 — v2.86.10 fingerprint at bulk layer: empty Membership ID + no token + matching name → NO stamp', () => {
  // The v2.86.10 "Already Connected + empty Membership ID" fingerprint must be
  // unmatchable at the bulk layer too: no numeric id, no shared token, only the
  // name overlaps → no Connected/Already-connected write at all.
  const rows = [{
    'First Name': 'Vito', 'Last Name': 'Mansueto',
    'Linkedin Bio': 'http://www.linkedin.com/in/ACwAAAZLmE8Bl3D54RBLDEXg2MwvxPE4JoIyLX8',
    'Sender': '', 'Connection Request Status': '', 'Linkedin Membership ID': '',
  }];
  const conns = [{ account: 'abhinay@x', firstName: 'Vito', lastName: 'Mansueto', urn: 'urn:li:fsd_profile:ACoAAAYLmE8Be4SdifferentXYZ' /* different member number (bytes 4-7): a true namesake */, publicId: '', memberNumber: '' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(rows, conns, 'Linkedin Bio', 'Still Pending', { profileName: 'abhinay@x' });
  assert.equal(connectedUrls.length, 0, 'name-only fingerprint not queued for intro');
  assert.ok(
    !updates.some(u =>
      /connected/i.test(String(u.cc || '')) ||
      /connected/i.test(String(u.stage || '')) ||
      /connected/i.test(String(u.checkStatus || ''))),
    'no Connected/Already-connected stamp written off a name-only match'
  );
});

test('token match still works (regression): URN token + assigned sender → Connected', () => {
  const rows = [{
    'First Name': 'Real', 'Last Name': 'Lead',
    'Linkedin Bio': 'http://www.linkedin.com/in/ACwAAReal',
    'Sender': 'rilany@x', 'Connection Request Status': 'Connection Request Sent',
    'Linkedin Membership ID': '', 'LinkedIn URN': 'ACoAAReal',
  }];
  const conns = [{ account: 'rilany@x', firstName: 'Real', lastName: 'Lead', urn: 'urn:li:fsd_profile:ACoAAReal', publicId: '', memberNumber: '' }];
  const { updates, connectedUrls } = computeBulkCheckUpdates(rows, conns, 'Linkedin Bio', 'Still Pending', { profileName: 'rilany@x' });
  assert.equal(connectedUrls.length, 1);
  assert.ok(updates.some(u => u.cc === 'Connected'));
});

// v2.72.1 — numeric publicId regression. Google Sheets returns an all-digits
// connection slug as a Number when read back from the sidecar tab. The loop
// used to call c.publicId.toLowerCase() directly, which threw
// "c.publicId.toLowerCase is not a function" and aborted the WHOLE account's
// bulk-check. computeBulkCheckUpdates must coerce publicId to a string.
test('v2.72.1: numeric publicId in conns does not throw and still matches by strong ID', () => {
  // The point of this regression guard is the crash: a numeric (Google-Sheets-
  // coerced) publicId must not throw "c.publicId.toLowerCase is not a function".
  // v2.86.12: NAME is no longer a match key, so the row carries a strong ID
  // (AC**AA URN token) that matches the conn's urn — proving the numeric-
  // publicId coercion still doesn't throw AND a real (non-name) match still fires.
  const rows = [baseRow({ 'LinkedIn URN': 'ACoAAaaa' })];
  const numericConns = [
    { firstName: 'Jane', lastName: 'Doe', publicId: 123456789, urn: 'ACoAAaaa', memberNumber: '111', account: 'eryca.bilazon@ortus.solutions' },
  ];
  assert.doesNotThrow(() => {
    const { connectedUrls } = computeBulkCheckUpdates(
      rows, numericConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
    );
    // strong-ID (URN token) match still works even though publicId was numeric
    assert.equal(connectedUrls.length, 1);
    assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  });
});
