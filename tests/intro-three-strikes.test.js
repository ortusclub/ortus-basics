import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INTRO_ASSUMED_PRIMARY_NOT_CONNECTED, isIntroSlotOpen } from '../src/linkedin/intro-constants.js';
const intro = readFileSync(new URL('../src/linkedin/auto-intro.js', import.meta.url), 'utf8');

test('the note names the rule and the retry', () => {
  assert.match(INTRO_ASSUMED_PRIMARY_NOT_CONNECTED, /Assumed primary not connected to sender/);
  assert.match(INTRO_ASSUMED_PRIMARY_NOT_CONNECTED, /3 introductions in a row failed/);
  assert.match(INTRO_ASSUMED_PRIMARY_NOT_CONNECTED, /delete this text and run the check again/);
  assert.equal(isIntroSlotOpen(INTRO_ASSUMED_PRIMARY_NOT_CONNECTED), false);
});

test('three consecutive failures hold the sender, note the rest, and stop the pass', () => {
  assert.match(intro, /const INTRO_STRIKES = 3;/);
  const at = intro.indexOf('_consecutiveFailures++;');
  const block = intro.slice(at, intro.indexOf('if (ok || alreadyMade) _consecutiveFailures = 0;', at));
  assert.match(block, /campaign\._primaryConn\.set\(profileId, 'pending'\)/);
  assert.match(block, /introductionStatus: INTRO_ASSUMED_PRIMARY_NOT_CONNECTED/);
  assert.match(block, /result\.skipped \+= rest\.length;/);
  assert.match(block, /\n\s+break;\n/);
  assert.ok(intro.includes('if (ok || alreadyMade) _consecutiveFailures = 0;'), 'a success resets the count');
});
