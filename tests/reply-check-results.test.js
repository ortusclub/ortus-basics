import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { replyCheckResultsForRows, hasSalesNavChannel } from '../src/linkedin/inbox-sweep.js';

const linkedin = { 'Linkedin URL': 'https://www.linkedin.com/in/a', 'Sent via': 'LinkedIn', Stage: 'OP Sent' };
const salesnav = { 'Linkedin URL': 'https://www.linkedin.com/in/b', 'Sent via': 'Sales Navigator' };
const when = '2026-09-29T12:00:00.000Z';

test('recorded Sent via overrides OP inference; legacy InM Sent is recognised', () => {
  assert.equal(hasSalesNavChannel([linkedin]), false);
  assert.equal(hasSalesNavChannel([salesnav]), true);
  assert.equal(hasSalesNavChannel([{ Stage: 'InM Sent' }]), true);
});

test('failed Sales Navigator check cannot become no-reply for its leads', () => {
  const results = replyCheckResultsForRows([linkedin, salesnav], 'Linkedin URL', {
    channelChecks: { linkedin: 'Done', salesnav: 'Failed' }, campaignReplies: [],
  }, when);
  assert.equal(results[0].status, 'Done');
  assert.equal(results[0].result, 'No reply found in scanned messages');
  assert.equal(results[1].status, 'Failed');
  assert.equal(results[1].result, 'Unknown — check not completed');
  assert.equal(results[1].checkedAt, when);
});

test('partial scan preserves found replies without declaring completion', () => {
  const [result] = replyCheckResultsForRows([salesnav], 'Linkedin URL', {
    channelChecks: { salesnav: 'Incomplete' }, campaignReplies: [{ row: salesnav }],
  }, when);
  assert.equal(result.status, 'Incomplete');
  assert.equal(result.result, 'Reply found');
});

test('stopped and failed checks record unknown, never a negative reply result', () => {
  const [stopped] = replyCheckResultsForRows([linkedin], '', {}, when, true);
  const [failed] = replyCheckResultsForRows([linkedin], '', { error: 'Login expired' }, when);
  assert.equal(stopped.status, 'Stopped');
  assert.equal(failed.status, 'Failed');
  assert.equal(stopped.result, failed.result);
});

test('bridge adds status columns once, updates repeated checks, and preserves outreach fields', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../google-apps-script.js', import.meta.url), 'utf8'), ctx);
  const grid = [
    ['Linkedin URL', 'Stage', 'Date of Last Action', 'Sent via'],
    [linkedin['Linkedin URL'], 'OP Sent', '2026-09-25', 'LinkedIn'],
  ];
  ctx.getHeaders = () => grid[0].slice();
  ctx.findRowsByUrl = (_sheet, _col, url) => url === linkedin['Linkedin URL'] ? [2] : [];
  ctx.jsonResponse = (data) => data;
  const sheet = { getLastRow: () => grid.length, getRange(row, col) {
    return { getValues: () => [[linkedin['Linkedin URL']]], setValue(value) { grid[row - 1][col - 1] = value; return this; }, setFontWeight() { return this; } };
  } };
  const request = { urlColumnName: 'Linkedin URL', rows: [{
    linkedinUrl: linkedin['Linkedin URL'], status: 'Done', checkedAt: when, result: 'Reply found',
  }] };
  assert.equal(ctx.handleReplyCheckResults(sheet, request).success, true);
  request.rows[0].checkedAt = '2026-09-30T12:00:00.000Z';
  ctx.handleReplyCheckResults(sheet, request);
  assert.deepEqual(grid[0].slice(4), ['Reply Check Status', 'Reply Last Checked At', 'Reply Check Result']);
  assert.deepEqual(grid[1].slice(0, 4), [linkedin['Linkedin URL'], 'OP Sent', '2026-09-25', 'LinkedIn']);
  assert.deepEqual(grid[1].slice(4), ['Done', request.rows[0].checkedAt, 'Reply found']);
});
