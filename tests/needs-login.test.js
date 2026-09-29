import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNeedsLoginUpdates } from '../src/campaign.js';

const rows = () => [
  { 'First Name': 'Jane', 'LinkedIn URL': 'https://linkedin.com/in/jane', 'Sender': 'kenya5@ortus.solutions' },
  { 'First Name': 'Bob',  'LinkedIn URL': 'https://linkedin.com/in/bob',  'Sender': 'kenya5@ortus.solutions' },
  { 'First Name': 'Sue',  'LinkedIn URL': 'https://linkedin.com/in/sue',  'Sender': 'someone-else@ortus.solutions' },
  { 'First Name': 'NoUrl','LinkedIn URL': '',                              'Sender': 'kenya5@ortus.solutions' },
];

test('flags every row owned by the account with Y', () => {
  const updates = buildNeedsLoginUpdates(rows(), 'kenya5@ortus.solutions', '', 'LinkedIn URL', 'Y');
  assert.equal(updates.length, 2, 'two rows have a sender match AND a URL');
  assert.deepEqual(updates.map(u => u.linkedinUrl).sort(), [
    'https://linkedin.com/in/bob', 'https://linkedin.com/in/jane',
  ]);
  assert.ok(updates.every(u => u.needsLogin === 'Y'));
});

test('clear builds the same rows with an empty value', () => {
  const updates = buildNeedsLoginUpdates(rows(), 'kenya5@ortus.solutions', '', 'LinkedIn URL', '');
  assert.equal(updates.length, 2);
  assert.ok(updates.every(u => u.needsLogin === ''));
});

test('rows assigned to a different account are excluded', () => {
  const updates = buildNeedsLoginUpdates(rows(), 'kenya5@ortus.solutions', '', 'LinkedIn URL', 'Y');
  assert.ok(!updates.some(u => u.linkedinUrl === 'https://linkedin.com/in/sue'));
});

test('account match is case-insensitive and trimmed', () => {
  const updates = buildNeedsLoginUpdates(rows(), '  KENYA5@ortus.solutions ', '', 'LinkedIn URL', 'Y');
  assert.equal(updates.length, 2);
});

test('empty account name yields no updates', () => {
  assert.deepEqual(buildNeedsLoginUpdates(rows(), '', '', 'LinkedIn URL', 'Y'), []);
  assert.deepEqual(buildNeedsLoginUpdates(rows(), null, '', 'LinkedIn URL', 'Y'), []);
});

test('senderColumn override is honored when provided', () => {
  const r = [
    { 'LinkedIn URL': 'https://linkedin.com/in/x', 'Sender': 'wrong', 'Account Used': 'kenya5' },
    { 'LinkedIn URL': 'https://linkedin.com/in/y', 'Sender': 'kenya5', 'Account Used': 'other' },
  ];
  const updates = buildNeedsLoginUpdates(r, 'kenya5', 'Account Used', 'LinkedIn URL', 'Y');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].linkedinUrl, 'https://linkedin.com/in/x');
});

test('IC logout is visible in Stage and Intro Status for pending assigned leads', () => {
  const updates = buildNeedsLoginUpdates(rows(), 'kenya5@ortus.solutions', '', 'LinkedIn URL', 'Y', 'introduce_back');
  assert.equal(updates.length, 2);
  assert.ok(updates.every(u => u.stage === 'Needs login — account logged out' && u.introStatus === u.stage));
});

test('IC logout preserves completed introductions and operator status notes', () => {
  for (const extra of [{ 'Intro Status': 'IC Sent' }, { 'Introduction Status': 'Introduction Made' }, { Stage: 'Replied' }, { 'Intro Status': 'Do not contact' }]) {
    const updates = buildNeedsLoginUpdates([{ ...rows()[0], ...extra }], 'kenya5@ortus.solutions', '', 'LinkedIn URL', 'Y', 'introduce_back');
    assert.equal(updates[0].stage, undefined);
    assert.equal(updates[0].introStatus, undefined);
  }
});

test('clearing login flag does not overwrite IC outcome columns', () => {
  const updates = buildNeedsLoginUpdates(rows(), 'kenya5@ortus.solutions', '', 'LinkedIn URL', '', 'introduce_back');
  assert.ok(updates.every(u => u.stage === undefined && u.introStatus === undefined));
});

test('only blank or the specific login warning is retryable for IC', async () => {
  const { canRetryIntroStatus, IC_NEEDS_LOGIN_STATUS } = await import('../src/campaign.js');
  assert.equal(canRetryIntroStatus(''), true);
  assert.equal(canRetryIntroStatus(IC_NEEDS_LOGIN_STATUS), true);
  for (const s of ['IC Sent', 'Introduction Made', 'Skipped: unavailable', 'Do not contact']) assert.equal(canRetryIntroStatus(s), false);
});

test('IC missing GoLogin account is written in both visible status columns', async () => {
  const { buildUnavailableIcUpdates, IC_NO_GOLOGIN_STATUS } = await import('../src/campaign.js');
  const updates = buildUnavailableIcUpdates(rows(), { 'someone-else@ortus.solutions': 'available' }, '', 'LinkedIn URL');
  assert.equal(updates.length, 2);
  assert.ok(updates.every(u => u.stage === IC_NO_GOLOGIN_STATUS && u.introStatus === IC_NO_GOLOGIN_STATUS));
});

test('IC account matching ignores case, respects the sender column, and supports local browser', async () => {
  const { buildUnavailableIcUpdates } = await import('../src/campaign.js');
  const data = [
    { ...rows()[0], Sender: 'wrong', Owner: ' KENYA5@ORTUS.SOLUTIONS ' },
    { ...rows()[1], Sender: 'Local Browser' },
  ];
  assert.deepEqual(buildUnavailableIcUpdates(data, { 'kenya5@ortus.solutions': 'p1', 'local browser': 'local-browser' }, 'Owner', 'LinkedIn URL'), []);
});

test('IC profile-list outages and missing senders do not falsely claim an account is absent', async () => {
  const { buildUnavailableIcUpdates, IC_GOLOGIN_UNVERIFIED_STATUS, IC_MISSING_SENDER_STATUS } = await import('../src/campaign.js');
  const [outage] = buildUnavailableIcUpdates([rows()[0]], {}, '', 'LinkedIn URL', true);
  assert.equal(outage.stage, IC_GOLOGIN_UNVERIFIED_STATUS);
  const [blank] = buildUnavailableIcUpdates([{ ...rows()[0], Sender: '' }], {}, '', 'LinkedIn URL');
  assert.equal(blank.stage, IC_MISSING_SENDER_STATUS);
});

test('GoLogin access warnings are retryable, without overwriting completed IC rows', async () => {
  const { buildUnavailableIcUpdates, canRetryIntroStatus, IC_NO_GOLOGIN_STATUS, IC_GOLOGIN_UNVERIFIED_STATUS } = await import('../src/campaign.js');
  assert.equal(canRetryIntroStatus(IC_NO_GOLOGIN_STATUS), true);
  assert.equal(canRetryIntroStatus(IC_GOLOGIN_UNVERIFIED_STATUS), true);
  for (const extra of [{ 'Intro Status': 'IC Sent' }, { 'Introduction Status': 'Do not contact' }, { Stage: 'Replied' }]) {
    assert.deepEqual(buildUnavailableIcUpdates([{ ...rows()[0], ...extra }], {}, '', 'LinkedIn URL'), []);
  }
});
