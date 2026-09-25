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

import { alreadyMessagedNoticeIn } from '../src/linkedin/op-notices.js';

test('already-messaged notice is recognised in LinkedIn / Sales Nav copy', () => {
  assert.ok(alreadyMessagedNoticeIn("Message\nYou've already sent a message to this person. You can send another once they reply.\nSend"));
  assert.ok(alreadyMessagedNoticeIn("You can't send another InMail until Priya responds."));
  assert.ok(alreadyMessagedNoticeIn('Free messages are limited to one per member every 90 days'));
  assert.ok(alreadyMessagedNoticeIn('This member hasn’t responded to your previous message'));
  assert.equal(alreadyMessagedNoticeIn('Free message\nWrite a message…\nSend'), null);
  assert.equal(alreadyMessagedNoticeIn(''), null);
});

test('already-messaged maps to the 90-day sheet wording, not the OP-credit one', () => {
  const s = normalizeSkipReason("OP_ALREADY_MESSAGED: You've already sent a message to this person.");
  assert.equal(s, 'Skipped: Open Profile message already sent in the last 90 days — unable to send another');
});
