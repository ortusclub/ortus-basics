import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INTRO_HELD_PRIMARY_NOT_CONNECTED, isIntroSlotOpen } from '../src/linkedin/intro-constants.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const engine = read('src/campaign.js'), intro = read('src/linkedin/auto-intro.js');

test('the note says what happened and how to retry', () => {
  assert.match(INTRO_HELD_PRIMARY_NOT_CONNECTED, /primary not connected to sender/);
  assert.match(INTRO_HELD_PRIMARY_NOT_CONNECTED, /delete this text and run the check again/);
  assert.equal(isIntroSlotOpen(INTRO_HELD_PRIMARY_NOT_CONNECTED), false, 'terminal until the operator clears it, as the text says');
});

test('every in-campaign intro point notes held leads when the sender is pending with the primary', () => {
  assert.match(engine, /import \{ INTRO_HELD_PRIMARY_NOT_CONNECTED \} from '\.\/linkedin\/intro-constants\.js';/);
  assert.match(engine, /async function _stampIntroHeldPrimary\(sheetUrl, urls, senderName\)/);
  const calls = engine.match(/await _stampIntroHeldPrimary\(sheetUrl, r\.connectedUrls, (pName|profileName)\);/g) || [];
  assert.equal(calls.length, 3);
  const guards = engine.match(/!campaign\.skipIntroductions && !willAutoIntro\n\s+&& campaign\._primaryConn && campaign\._primaryConn\.get\(profileId\) === 'pending'/g) || [];
  assert.equal(guards.length, 3, 'only when the hold is the primary connection, never for the connections-only toggle');
});

test('the manual check\'s intro pass writes the same note instead of leaving the cell blank', () => {
  const at = intro.indexOf('if (_shouldHoldIntros(_res)) {');
  const block = intro.slice(at, intro.indexOf('return result;', at));
  assert.match(block, /introductionStatus: INTRO_HELD_PRIMARY_NOT_CONNECTED/);
  assert.match(block, /batchUpdateSheet\(sheetUrl, connectedUrls\.map/);
});
