import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcLaunchFailureUpdates, canRetryIntroStatus } from '../src/campaign.js';

const row = { Sender: 'benz', 'LinkedIn Bio': 'https://linkedin.com/in/test' };
const build = (rows, error = new Error('Browser launch timed out')) =>
  buildIcLaunchFailureUpdates(rows, ' BENZ ', '', 'LinkedIn Bio', error);

test('launch failures stamp both IC columns with a terminal reason, without a false login flag', () => {
  const [update] = build([row]);
  assert.deepEqual(update, {
    linkedinUrl: row['LinkedIn Bio'],
    stage: 'Not sent — browser failed to open: Browser launch timed out',
    introStatus: 'Not sent — browser failed to open: Browser launch timed out',
  });
  assert.equal(canRetryIntroStatus(update.introStatus), false);
  assert.deepEqual(build([{ ...row, 'Intro Status': update.introStatus }]), []);
  const [next] = build([{ ...row, 'Intro Status': '' }], new Error('Disk space too low'));
  assert.match(next.stage, /Disk space too low/);
});

test('launch failure stamps protect completed rows, operator notes and other accounts', () => {
  for (const extra of [
    { Sender: 'other' }, { 'LinkedIn Bio': '' }, { 'Intro Status': 'IC Sent' },
    { 'Introduction Status': 'Do not contact' }, { Stage: 'Replied' },
    { Stage: 'IC Sent' }, { Stage: 'Done' }, { Stage: 'Introduction Made' },
  ]) assert.deepEqual(build([{ ...row, ...extra }]), []);
});

test('launch failure uses the configured sender and handles errors without messages', () => {
  const updates = buildIcLaunchFailureUpdates([{ ...row, Sender: 'other', Owner: 'benz' }],
    'benz', 'Owner', 'LinkedIn Bio', { code: 'ENOSPC' });
  assert.equal(updates.length, 1);
  assert.match(updates[0].introStatus, /ENOSPC/);
});
