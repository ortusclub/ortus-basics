import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSkipReason, parkSentence, prettyParkReason, missReason } from '../src/campaign.js';

const OP_SKIP = 'Skipped: contact is either not Open Profile or the sending account has reached its monthly OP credit limit';

test('a not-Open-Profile skip tells the sheet it may be the sender out of OP credits', () => {
  assert.equal(normalizeSkipReason('Not Open Profile'), OP_SKIP);
  assert.equal(normalizeSkipReason('NOT_OPEN_PROFILE: lead is not Open Profile (tick "Spend an InMail credit" to message anyway)'), OP_SKIP);
  assert.equal(normalizeSkipReason(OP_SKIP), OP_SKIP);
  assert.match(missReason('', OP_SKIP), /Open Profile credits/);
});

test('the bench reason reads as a suspected OP credits limit everywhere', () => {
  assert.equal(prettyParkReason('op_credit_limit'), 'suspected OP credits limit reached');
  assert.match(parkSentence('Suspected OP credits limit reached'), /^Suspected OP credits limit reached/);
});

test('five not-Open-Profile skips in a row bench the sender; anything else breaks the streak', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.match(src, /const NOT_OP_BENCH_THRESHOLD = 5;/);
  assert.match(src, /if \(!errorMsg\.includes\('NOT_OPEN_PROFILE'\) && !errorMsg\.includes\(SN_UNRESOLVABLE\)\) consecutiveNotOp\.delete\(profileId\);/);
  const branch = src.slice(src.indexOf("} else if (errorMsg.includes('NOT_OPEN_PROFILE')) {"), src.indexOf("} else if (errorMsg.includes('rate_limited')) {"));
  assert.match(branch, /_notOp >= NOT_OP_BENCH_THRESHOLD && !weeklyLimited\.has\(profileId\)/);
  assert.match(branch, /weeklyLimited\.add\(profileId\)/);
  assert.match(branch, /reason: 'op_credit_limit'/);
  // Retry (unbench) must reset the streak, or the account re-benches on its first skip.
  const unpark = src.slice(src.indexOf('campaign._unparkProfile = (profileId) => {'), src.indexOf('campaign._unparkProfile = (profileId) => {') + 500);
  assert.match(unpark, /consecutiveNotOp\.delete\(profileId\)/);
});

test('a 429 on an account that has reached nobody this run parks it as weekly-capped at once', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.match(src, /\(c429 >= HTTP_429_PARK_THRESHOLD \|\| _reachedSoFar === 0\) && !weeklyLimited\.has\(profileId\)/);
  assert.equal(normalizeSkipReason('VOYAGER_REJECTED: HTTP 429 — too many'), 'Skipped: Likely weekly invitation limit reached (HTTP 429) — confirming…');
});

test('an account paused on an HTTP 429 reads as a SUSPECTED weekly limit, not a bare "Stopped"', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.match(src, /_is429 \? 'Suspected weekly invitation limit \(HTTP 429\)' : 'Paused — LinkedIn throttling/);
  assert.match(src, /reason: _is429 \? 'suspected_weekly_limit' : 'throttle_paused'/);
  assert.match(parkSentence('Suspected weekly invitation limit (HTTP 429)'), /^Suspected weekly invitation limit/);
  assert.match(parkSentence('Weekly invitation limit reached (2× HTTP 429)'), /^Suspected weekly invitation limit/);
  // LinkedIn's own "weekly limit" message is certain, not suspected.
  assert.equal(parkSentence('Weekly invitation limit hit (~100/week)'), 'This account has used up its invitations for the week.');
  assert.equal(prettyParkReason('suspected_weekly_limit'), 'suspected weekly invitation limit (HTTP 429)');
});

test('six "no Sales Navigator route" skips in a row bench the sender as a suspected OP credits limit', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.match(src, /const SN_UNRESOLVABLE = 'Could not resolve Sales Navigator link';/);
  assert.match(src, /const SN_UNRESOLVABLE_BENCH_THRESHOLD = 6;/);
  const branch = src.slice(src.indexOf('} else if (errorMsg.includes(SN_UNRESOLVABLE)) {'), src.indexOf("} else if (errorMsg.includes('rate_limited')) {"));
  assert.match(branch, /consecutiveNotOp\.set\(profileId, _notOp\)/);
  assert.match(branch, /_notOp >= SN_UNRESOLVABLE_BENCH_THRESHOLD && !weeklyLimited\.has\(profileId\)/);
  assert.match(branch, /reason: 'op_credit_limit'/);
  // the lead itself stays retryable — only the sender is benched
  assert.match(branch, /delete state\.processed\[url\]/);
});
