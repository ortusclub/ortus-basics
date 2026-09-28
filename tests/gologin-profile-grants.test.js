/**
 * Per-profile grants. The domain gate stays the rule; a grant is the named
 * exception for a profile two workspaces genuinely share.
 */
import test from 'node:test';
import assert from 'node:assert';
import { canOperatorUseProfile, profileUsableFor, grantsForProfile } from '../src/gologin-accounts.js';

const MILEE = '686696205c3c6094e10f461c'; // milee.mel@ortus.solutions, owned by Ortus
const MATT = '686698b83d9568f25c44b0fe';  // matt.adcock@ortus.solutions, owned by Ortus
const OTHER = '69ea1e80447186275e79e3ee'; // robert.junio, deliberately NOT granted

const GRANT = `linkedvelocity:${MILEE},linkedvelocity:${MATT}`;

function withGrants(value, fn) {
  const before = process.env.GOLOGIN_PROFILE_GRANTS;
  if (value === undefined) delete process.env.GOLOGIN_PROFILE_GRANTS;
  else process.env.GOLOGIN_PROFILE_GRANTS = value;
  try { fn(); } finally {
    if (before === undefined) delete process.env.GOLOGIN_PROFILE_GRANTS;
    else process.env.GOLOGIN_PROFILE_GRANTS = before;
  }
}

test('without a grant the domain gate is unchanged', () => {
  // OTHER, not MILEE: milee.mel is now in the committed SHARED_INVENTORY_GRANTS
  // (2026-09-02), so it is never ungranted any more.
  withGrants(undefined, () => {
    assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', 'ortus', OTHER), false);
    assert.equal(canOperatorUseProfile('ortus@ortusclub.com', 'ortus', OTHER), true);
  });
});

test('a grant lets the named workspace drive that one profile', () => {
  withGrants(GRANT, () => {
    assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', 'ortus', MILEE), true);
    assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', 'ortus', MATT), true);
  });
});

test('a grant is per profile — it does not widen the workspace', () => {
  withGrants(GRANT, () => {
    assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', 'ortus', OTHER), false);
  });
});

test('a grant names ONE workspace, not everybody', () => {
  withGrants(GRANT, () => {
    assert.deepEqual(grantsForProfile(MILEE), ['linkedvelocity']);
    assert.deepEqual(grantsForProfile(OTHER), []);
  });
});

test('the owning workspace still owns it — mode rules and token are unchanged', () => {
  withGrants(`marketing:${MILEE}`, () => {
    // Granting INTO marketing must not import marketing's mode restriction:
    // the profile is still an Ortus profile, which runs every mode.
    assert.equal(profileUsableFor('ortus@ortusclub.com', 'ortus', 'connect_and_introduce', MILEE), true);
  });
});

test('a granted profile still obeys its owner mode rules', () => {
  withGrants(`linkedvelocity:m1`, () => {
    // m1 lives in marketing, which refuses everything but Introduction Campaign. The
    // grant opens WHO, never WHAT.
    assert.equal(profileUsableFor('milee@linkedvelocity.com', 'marketing', 'connect_and_introduce', 'm1'), false);
    assert.equal(profileUsableFor('milee@linkedvelocity.com', 'marketing', 'introduce_back', 'm1'), true);
  });
});

test('malformed entries are ignored, not crashed on', () => {
  withGrants(`  , :, nonsense, linkedvelocity:, :${MILEE}, linkedvelocity:${MILEE}  `, () => {
    assert.deepEqual(grantsForProfile(MILEE), ['linkedvelocity']);
  });
});

test('a blank profile id never matches a grant', () => {
  withGrants(GRANT, () => {
    assert.deepEqual(grantsForProfile(''), []);
    assert.deepEqual(grantsForProfile(undefined), []);
    assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', 'ortus'), false);
  });
});
