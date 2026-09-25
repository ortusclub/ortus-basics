// v1.7.48: a LinkedIn-channel Open Profile message that went out but whose
// post-send DOM check failed must not be reported as "not Open Profile".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPostSendFailure } from '../src/linkedin/outreach.js';
import { normalizeSkipReason } from '../src/campaign.js';

test('post-send verification failures are distinguished from pre-send ones', () => {
  assert.equal(isPostSendFailure('MESSAGE_SEND_FAILED: send not confirmed (composer not found and message not in thread)'), true);
  assert.equal(isPostSendFailure('NOT_FREE_MESSAGE: compose is not a confirmed free message'), false);
  assert.equal(isPostSendFailure('MESSAGE_SEND_FAILED: compose textbox did not appear'), false);
  assert.equal(isPostSendFailure('MESSAGE_SEND_FAILED: could not type message'), false);
  assert.equal(isPostSendFailure(''), false);
});

test('unconfirmed message send gets its own sheet wording, not the OP-credit one', () => {
  const s = normalizeSkipReason('MESSAGE_SEND_UNCONFIRMED: MESSAGE_SEND_FAILED: send not confirmed (composer not found and message not in thread)');
  assert.match(s, /^Skipped: Message send not confirmed/);
  assert.doesNotMatch(s, /Open Profile/);
  // pre-send failure still maps to the OP wording
  assert.match(normalizeSkipReason('NOT_OPEN_PROFILE: lead is not Open Profile'), /not Open Profile/);
});
