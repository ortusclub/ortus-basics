import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GL_ACCOUNTS,
  DEFAULT_ACCOUNT_ID,
  POST_AMPLIFICATION_MODE,
  accountById,
  accountLabel,
  tokenForAccount,
  configuredAccounts,
  accountForEmail,
  canOperatorUseProfile,
  accountModes,
  accountAllowsMode,
  profileUsableFor,
} from '../src/gologin-accounts.js';

// Linked Velocity is a second GoLogin plan whose profiles cannot be shared into
// the Ortus workspace (checked 2026-08-07). So the app lists two workspaces and
// decides access from the operator's login domain. These pin the access rule —
// the picker's greying, the /api/profiles `available` flag and the launch guard
// all resolve through the functions below, so a change here changes all three.

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the roster holds all three workspaces, Ortus first and default', () => {
  assert.equal(DEFAULT_ACCOUNT_ID, 'ortus');
  assert.deepEqual(GL_ACCOUNTS.map((a) => a.id), ['ortus', 'linkedvelocity', 'marketing']);
  assert.equal(accountLabel('linkedvelocity'), 'Linked Velocity');
  assert.equal(accountLabel('marketing'), 'Marketing');
  assert.equal(accountById('nope'), null);
});

test('an operator gets the workspace their email domain belongs to', () => {
  assert.equal(accountForEmail('antonio@ortusclub.com'), 'ortus');
  assert.equal(accountForEmail('jigar.chaudhary@ortus.solutions'), 'ortus');
  assert.equal(accountForEmail('milee@linkedvelocity.com'), 'linkedvelocity');
  // Case and whitespace are noise — the operator types this into a modal.
  assert.equal(accountForEmail('  Milee@LinkedVelocity.COM '), 'linkedvelocity');
});

test('an unknown or missing email falls back to Ortus, never to the new workspace', () => {
  // This is the compatibility guarantee: every login that worked before the
  // second account existed keeps resolving to exactly the account it had.
  for (const e of ['', null, undefined, 'someone@gmail.com', 'not-an-email']) {
    assert.equal(accountForEmail(e), 'ortus', `${e} must fall back to Ortus`);
  }
});

test('access is symmetric — neither workspace can drive the other', () => {
  assert.ok(canOperatorUseProfile('antonio@ortusclub.com', 'ortus'));
  assert.ok(canOperatorUseProfile('milee@linkedvelocity.com', 'linkedvelocity'));
  assert.equal(canOperatorUseProfile('antonio@ortusclub.com', 'linkedvelocity'), false);
  assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', 'ortus'), false);
});

test('a profile with no recorded account counts as Ortus', () => {
  // getProfiles tags everything it lists, but a resumed campaign can carry an id
  // the cache has never seen. Untagged must mean "the account it has always
  // been" — anything else would lock existing operators out of their own runs.
  assert.ok(canOperatorUseProfile('antonio@ortusclub.com', null));
  assert.ok(canOperatorUseProfile('antonio@ortusclub.com', undefined));
  assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', null), false);
});

test('tokens are read from the environment at call time, per account', () => {
  withEnv({ GOLOGIN_API_TOKEN: 'tok-ortus', GOLOGIN_API_TOKEN_LINKEDVELOCITY: 'tok-lv' }, () => {
    assert.equal(tokenForAccount('ortus'), 'tok-ortus');
    assert.equal(tokenForAccount('linkedvelocity'), 'tok-lv');
    assert.equal(tokenForAccount('nope'), '');
    assert.deepEqual(configuredAccounts().map((a) => a.id), ['ortus', 'linkedvelocity']);
  });
});

test('an unconfigured second account simply is not there', () => {
  // A build shipped before the Linked Velocity token is set must behave exactly
  // like the old single-account app: one account listed, no failing API call per
  // refresh, and the launch guard (which no-ops below two accounts) inert.
  withEnv({ GOLOGIN_API_TOKEN: 'tok-ortus', GOLOGIN_API_TOKEN_LINKEDVELOCITY: undefined }, () => {
    assert.deepEqual(configuredAccounts().map((a) => a.id), ['ortus']);
    assert.equal(tokenForAccount('linkedvelocity'), '');
  });
});


// ── Marketing workspace (2026-08-07) ────────────────────────────────────────
// Marketing is a shared pool reserved for Introduction Campaign.

test('marketing accounts run Introduction Campaign only', () => {
  assert.deepEqual(accountModes('marketing'), ['introduce_back']);
  assert.ok(accountAllowsMode('marketing', 'introduce_back'));
  for (const m of ['connect_only', 'connect_and_introduce', 'connect_and_message',
    'follower_growth', POST_AMPLIFICATION_MODE, 'open_profile_only', 'message_only',
    'inmail_only', 'check_status', 'unknown']) {
    assert.equal(accountAllowsMode('marketing', m), false, `marketing must refuse ${m}`);
  }
});

test('the other workspaces stay unrestricted', () => {
  for (const id of ['ortus', 'linkedvelocity']) {
    assert.equal(accountModes(id), null, `${id} must have no mode whitelist`);
    for (const m of ['connect_and_introduce', 'follower_growth', POST_AMPLIFICATION_MODE]) {
      assert.ok(accountAllowsMode(id, m));
    }
  }
});

test('a blank mode never makes an account look unusable', () => {
  // The account list and status polls have no mode in hand. Answering false
  // there would grey every marketing tile permanently, including in the
  // Introduction Campaign picker where they are allowed.
  for (const m of [undefined, null, '']) assert.ok(accountAllowsMode('marketing', m));
});

test('marketing accounts are open to every operator', () => {
  // Operator decision: not a team's private workspace but a shared pool. The
  // mode whitelist is the only thing protecting it, so the domain gate is off
  // for everyone — Ortus and Linked Velocity alike.
  const marketing = accountById('marketing');
  assert.equal(marketing.openToAll, true);
  assert.ok(canOperatorUseProfile('antonio@ortusclub.com', 'marketing'));
  assert.ok(canOperatorUseProfile('milee@linkedvelocity.com', 'marketing'));
  assert.ok(canOperatorUseProfile('', 'marketing'));
});

test('marketing claims no domain, so nobody resolves into it', () => {
  // Open-to-all must not become a hole in the OTHER direction: if a marketing
  // email resolved to the marketing workspace, that operator would be locked
  // out of Ortus and Linked Velocity accounts. With no domains it can only ever
  // be an extra pool on top of whatever workspace the operator already has.
  assert.deepEqual(accountById('marketing').domains, []);
  assert.equal(accountForEmail('someone@marketing.example'), 'ortus');
});

test('the mode gate holds even though the domain gate is open', () => {
  // The whole protection now rests on one axis, so this is the load-bearing
  // test: an operator who passes the (absent) workspace check must still be
  // refused every mode outside the whitelist.
  assert.equal(profileUsableFor('antonio@ortusclub.com', 'marketing', 'connect_and_introduce'), false);
  assert.equal(profileUsableFor('milee@linkedvelocity.com', 'marketing', 'connect_only'), false);
  assert.ok(profileUsableFor('antonio@ortusclub.com', 'marketing', 'introduce_back'));
  assert.ok(profileUsableFor('milee@linkedvelocity.com', 'marketing', 'introduce_back'));
  assert.equal(profileUsableFor('milee@linkedvelocity.com', 'marketing', POST_AMPLIFICATION_MODE), false);
  // The other workspaces keep their domain gate untouched.
  assert.equal(profileUsableFor('antonio@ortusclub.com', 'linkedvelocity', 'follower_growth'), false);
  assert.ok(profileUsableFor('antonio@ortusclub.com', 'ortus', POST_AMPLIFICATION_MODE));
});
