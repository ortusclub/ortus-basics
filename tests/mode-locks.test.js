import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Password-locked campaign types. app.js is a browser bundle with no exports,
// so these are source assertions — the same approach retired-modes.test.js uses.
// They exist because the lock went from one mode to two on 2026-08-07, and the
// single-flag design silently grants the wrong mode once there are two.

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('both locked modes have their own password', () => {
  assert.match(APP, /const MODE_PASSWORDS = \{/);
  assert.match(APP, /follower_growth: 'OP_FUNNEL_ORTUS\.APP'/);
  assert.match(APP, /post_amplification: 'Ortus_PostAMP'/);
});

test('the unlock flag is per mode, not global', () => {
  // The bug this prevents: with one shared `fg_unlocked` flag, typing the
  // Follower Growth password would also unlock Post Amplification — a mode
  // whose password the operator never entered.
  assert.match(APP, /const modeUnlockKey = \(value\) => `mode_unlocked:\$\{value\}`/);
  assert.match(APP, /function modeIsLocked\(m\) \{\s*return !!\(m && m\.lock\) && !modeUnlocked\(m\.value\);/);
  // The old global helpers must be gone, not merely unused — a leftover
  // fgUnlocked() call site would reintroduce exactly the shared-flag bug.
  assert.equal(APP.includes('function fgUnlocked('), false, 'global unlock helper still present');
  assert.equal(APP.includes('setFgUnlocked('), false, 'global unlock setter still present');
  assert.equal(APP.includes('const FG_PASSWORD'), false, 'single-password constant still present');
});

test('the entered password is checked against the mode being unlocked', () => {
  // Not against any password in the map — that would let the FG password open
  // Post Amp and vice versa.
  assert.match(APP, /if \(entry !== MODE_PASSWORDS\[mode\.value\]\) \{/);
  assert.match(APP, /setModeUnlocked\(mode\.value\);/);
});

test('an existing Follower Growth unlock survives the storage change', () => {
  // Operators who already typed the FG password must not be re-prompted just
  // because the key scheme changed — but the legacy key grants FG only.
  assert.match(APP, /LEGACY_FG_UNLOCK_KEY = 'fg_unlocked'/);
  assert.match(APP, /value === 'follower_growth' && localStorage\.getItem\(LEGACY_FG_UNLOCK_KEY\)/);
});

test('post_amplification is not offered by Basics', () => {
  const start = APP.indexOf('const MODE_LIST = [');
  const modes = APP.slice(start, APP.indexOf('\n];', start));
  assert.ok(start > 0);
  assert.ok(!modes.includes("value: 'post_amplification'"));
  assert.ok(modes.includes("value: 'open_profile_only'"));
});

test('follower_growth is not offered by Basics', () => {
  const start = APP.indexOf('const MODE_LIST = [');
  const modes = APP.slice(start, APP.indexOf('\n];', start));
  assert.ok(start > 0);
  assert.ok(!modes.includes("value: 'follower_growth'"));
  assert.ok(modes.includes("value: 'open_profile_only'"));
});
