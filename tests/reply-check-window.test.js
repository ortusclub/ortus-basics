import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyWatermarkForRows, detectLinkedinColumn, DEFAULT_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS } from '../src/reply-check-window.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 29, 12);

test('watermark: earliest send date minus a day', () => {
  const rows = [
    { 'Date of Last Action': '2026-09-18' },
    { 'Date of Last Action': '2026-09-16' },
    { 'Date of Last Action': '' },
  ];
  assert.equal(replyWatermarkForRows(rows, NOW), Date.UTC(2026, 8, 15));
});

test('watermark: no readable dates → default lookback', () => {
  assert.equal(replyWatermarkForRows([{ Stage: 'OP Sent' }], NOW), NOW - DEFAULT_LOOKBACK_DAYS * DAY);
  assert.equal(replyWatermarkForRows([], NOW), NOW - DEFAULT_LOOKBACK_DAYS * DAY);
});

test('watermark: never reaches back further than the cap', () => {
  assert.equal(replyWatermarkForRows([{ Date: '2025-01-01' }], NOW), NOW - MAX_LOOKBACK_DAYS * DAY);
});

test('column: keeps the requested column when it holds links', () => {
  const rows = [{ 'Linkedin URL': 'https://www.linkedin.com/in/a', Other: 'https://www.linkedin.com/in/b' }];
  assert.equal(detectLinkedinColumn(rows, 'Linkedin URL'), 'Linkedin URL');
});

test('column: finds the link column when the requested one is missing (OPI "Linkedin Bio")', () => {
  const rows = [
    { 'Linkedin Bio': 'http://www.linkedin.com/in/ACwAAAY6ECgB', Stage: 'OP Sent' },
    { 'Linkedin Bio': 'http://www.linkedin.com/in/scottroen', Stage: 'OP Sent' },
  ];
  assert.equal(detectLinkedinColumn(rows, 'Linkedin URL'), 'Linkedin Bio');
  assert.equal(detectLinkedinColumn(rows, ''), 'Linkedin Bio');
});

test('column: falls back to the requested name when no links exist', () => {
  assert.equal(detectLinkedinColumn([{ a: 'x' }], 'Profile'), 'Profile');
  assert.equal(detectLinkedinColumn([], ''), 'Linkedin URL');
});
