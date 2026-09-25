import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INTRO_HELD_PRIMARY_NOT_CONNECTED, INTRO_HELD_NO_PRIMARY, isIntroSlotOpen } from '../src/linkedin/intro-constants.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const engine = read('src/campaign.js'), intro = read('src/linkedin/auto-intro.js');

test('the note says what happened and how to retry', () => {
  assert.match(INTRO_HELD_PRIMARY_NOT_CONNECTED, /primary not connected to sender/);
  assert.match(INTRO_HELD_PRIMARY_NOT_CONNECTED, /delete this text and run the check again/);
  assert.equal(isIntroSlotOpen(INTRO_HELD_PRIMARY_NOT_CONNECTED), false, 'terminal until the operator clears it, as the text says');
});

test('every in-campaign intro point notes held leads when the sender is pending with the primary', () => {
  assert.match(engine, /import \{ INTRO_HELD_PRIMARY_NOT_CONNECTED, INTRO_HELD_NO_PRIMARY \} from '\.\/linkedin\/intro-constants\.js';/);
  assert.match(engine, /async function _stampIntroHeldPrimary\(sheetUrl, urls, senderName, why = 'not_connected'\)/);
    const guards = engine.match(/!campaign\.skipIntroductions && !willAutoIntro\n\s+&& Array\.isArray\(r\.connectedUrls\)/g) || [];
  assert.equal(guards.length, 3, 'never for the connections-only toggle');
  const pending = engine.match(/else if \(campaign\._primaryConn && campaign\._primaryConn\.get\(profileId\) === 'pending'\) await _stampIntroHeldPrimary\(sheetUrl, r\.connectedUrls, (pName|profileName)\);/g) || [];
  assert.equal(pending.length, 3, 'not-connected note only when the sender is pending with the primary');
  const noPrimary = engine.match(/if \(!_tplOk\) await _stampIntroHeldPrimary\(sheetUrl, r\.connectedUrls, (pName|profileName), 'no_primary'\);/g) || [];
  assert.equal(noPrimary.length, 3, 'no-primary note when the campaign has no primary name or intro message');
});

test('the manual check\'s intro pass writes the same note instead of leaving the cell blank', () => {
  const at = intro.indexOf('if (_shouldHoldIntros(_res)) {');
  const block = intro.slice(at, intro.indexOf('return result;', at));
  assert.match(block, /introductionStatus: INTRO_HELD_PRIMARY_NOT_CONNECTED/);
  assert.match(block, /batchUpdateSheet\(sheetUrl, connectedUrls\.map/);
});

test('a CC+IB campaign with no primary person gets its own note, from the manual check too', () => {
  assert.match(INTRO_HELD_NO_PRIMARY, /no primary person set/);
  assert.match(INTRO_HELD_NO_PRIMARY, /delete this text and run the check again/);
  assert.equal(isIntroSlotOpen(INTRO_HELD_NO_PRIMARY), false);
  const server = read('server.js');
  const at = server.indexOf("app.post('/api/bulk-check-now'");
  const route = server.slice(at, server.indexOf("app.post('/api/bulk-check/stop'", at));
  assert.match(route, /else if \(_phaseMode === 'connect_and_introduce' && Array\.isArray\(r\.connectedUrls\) && r\.connectedUrls\.length > 0\) \{/);
  assert.match(route, /introductionStatus: INTRO_HELD_NO_PRIMARY/);
});
