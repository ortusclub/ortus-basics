import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getProfiles,
  getProfileLoadWarnings,
  clearProfileCache,
  accountOfProfile,
  tokenForProfile,
} from '../src/gologin-launcher.js';

// getProfiles used to take a token and return an untagged list. It now walks
// every configured GoLogin account and tags each profile with its owner — which
// is what lets launchProfile pick the right token without any of its ~15 callers
// knowing there is more than one account. These cover that walk.

const ORTUS = 'tok-ortus';
const LV = 'tok-lv';

// Minimal stand-in for GoLogin's paged /browser/v2. One page per account is
// enough: paging is unchanged from the single-account version.
function mockGologin(byToken) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const token = String(init?.headers?.Authorization || '').replace('Bearer ', '');
    calls.push(token);
    const entry = byToken[token];
    if (!entry) return { ok: false, status: 401 };
    if (entry.throws) throw new Error(entry.throws);
    const page = Number(new URL(url).searchParams.get('page') || 1);
    const profiles = page === 1 ? entry.profiles : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ allProfilesCount: entry.profiles.length, profiles }),
    };
  };
  return calls;
}

const ENV_OF = {
  ortus: 'GOLOGIN_API_TOKEN',
  lv: 'GOLOGIN_API_TOKEN_LINKEDVELOCITY',
  mk: 'GOLOGIN_API_TOKEN_MARKETING',
};

function withAccounts(tokens, fn) {
  const savedFetch = globalThis.fetch;
  const saved = {};
  for (const [key, envName] of Object.entries(ENV_OF)) {
    saved[key] = process.env[envName];
    if (tokens[key] === undefined) delete process.env[envName];
    else process.env[envName] = tokens[key];
  }
  clearProfileCache();
  return (async () => {
    try { return await fn(); }
    finally {
      globalThis.fetch = savedFetch;
      clearProfileCache();
      for (const [key, envName] of Object.entries(ENV_OF)) {
        if (saved[key] === undefined) delete process.env[envName];
        else process.env[envName] = saved[key];
      }
    }
  })();
}

test('profiles from both workspaces come back in one list, each tagged', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] },
      [LV]: { profiles: [{ id: 'v1', name: 'lv-one' }, { id: 'v2', name: 'lv-two' }] },
    });

    const list = await getProfiles();
    assert.deepEqual(list.map((p) => [p.id, p.account]), [
      ['o1', 'ortus'], ['v1', 'linkedvelocity'], ['v2', 'linkedvelocity'],
    ]);
  });
});

test('the token that launches a profile is its own account\'s', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] },
      [LV]: { profiles: [{ id: 'v1', name: 'lv-one' }] },
    });

    // Cold: nothing listed yet. tokenForProfile must list rather than guess —
    // guessing is what would 404 every Linked Velocity launch after a restart.
    assert.equal(accountOfProfile('v1'), null);
    assert.equal(await tokenForProfile('v1'), LV);
    assert.equal(await tokenForProfile('o1'), ORTUS);
  });
});

test('an unknown profile falls back to the default account\'s token', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({ [ORTUS]: { profiles: [] }, [LV]: { profiles: [] } });
    assert.equal(await tokenForProfile('never-seen'), ORTUS);
  });
});

test('a Linked Velocity outage does not blank the Ortus roster', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] },
      [LV]: { throws: 'ECONNRESET' },
    });

    const list = await getProfiles();
    assert.deepEqual(list.map((p) => p.id), ['o1']);
  });
});

test('an Ortus outage does not hide a working Linked Velocity workspace', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    mockGologin({ [ORTUS]: { throws: 'ECONNRESET' }, [LV]: { profiles: [{ id: 'v1', name: 'lv' }] } });
    const list = await getProfiles();
    assert.deepEqual(list.map(p => p.id), ['v1']);
    assert.equal(getProfileLoadWarnings()[0].id, 'ortus');
    assert.equal(await tokenForProfile('v1'), LV);
  });
});

test('with only one token configured nothing extra is fetched', async () => {
  await withAccounts({ ortus: ORTUS, lv: undefined }, async () => {
    const calls = mockGologin({ [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] } });
    const list = await getProfiles();
    assert.deepEqual(list.map((p) => p.account), ['ortus']);
    assert.deepEqual([...new Set(calls)], [ORTUS], 'no call made for an unconfigured account');
  });
});

test('the cache is per account — a second call re-fetches neither', async () => {
  await withAccounts({ ortus: ORTUS, lv: LV }, async () => {
    const calls = mockGologin({
      [ORTUS]: { profiles: [{ id: 'o1', name: 'ortus-one' }] },
      [LV]: { profiles: [{ id: 'v1', name: 'lv-one' }] },
    });
    await getProfiles();
    const after = calls.length;
    await getProfiles();
    assert.equal(calls.length, after, 'second call served from cache');
  });
});

// 2026-08-11: GoLogin lets one workspace share a profile into another, so the
// SAME profile id comes back from two tokens. 43 real profiles were in that
// state — rj@ and marigona@ among them, shared from Ortus into marketing. The
// tag loop was last-write-wins and marketing lists last, so those profiles were
// re-stamped `marketing`, inherited its Follower-Growth-only rule, and every
// connect campaign launch was refused with "1 selected account(s) are Marketing
// accounts". First-wins fixes it; these lock it down.

const MK = 'tok-mk';

test('a profile shared into a second workspace stays owned by the first', async () => {
  await withAccounts({ ortus: ORTUS, mk: MK }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'rj', name: 'rj@ortusclub.com' }] },
      [MK]: { profiles: [{ id: 'rj', name: 'rj@ortusclub.com' }, { id: 'm1', name: 'Adri' }] },
    });

    await getProfiles();
    assert.equal(accountOfProfile('rj'), 'ortus', 'shared profile must not inherit the marketing mode rule');
    assert.equal(accountOfProfile('m1'), 'marketing', 'a marketing-only profile is still marketing');
  });
});

test('a shared profile appears once in the picker, not twice', async () => {
  await withAccounts({ ortus: ORTUS, mk: MK }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'rj', name: 'rj@ortusclub.com' }] },
      [MK]: { profiles: [{ id: 'rj', name: 'rj@ortusclub.com' }, { id: 'm1', name: 'Adri' }] },
    });

    const list = await getProfiles();
    assert.deepEqual(list.map((p) => [p.id, p.account]), [['rj', 'ortus'], ['m1', 'marketing']]);
  });
});

test('a shared profile launches with its owning workspace\'s token', async () => {
  await withAccounts({ ortus: ORTUS, mk: MK }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'rj', name: 'rj@ortusclub.com' }] },
      [MK]: { profiles: [{ id: 'rj', name: 'rj@ortusclub.com' }] },
    });

    assert.equal(await tokenForProfile('rj'), ORTUS, 'the marketing token would 404 this launch');
  });
});

test('a whitespace-padded GoLogin name is trimmed at the source', async () => {
  // Real profile, 2026-08-12: "nabungaires@gmail.com " in the Linked Velocity
  // workspace. The SoO matchers normalise, but the raw name is written verbatim
  // into the sheet's "Account Used" column and is what {sender first name}
  // email-splits from — so it gets cleaned once, on the way in.
  await withAccounts({ ortus: ORTUS }, async () => {
    mockGologin({ [ORTUS]: { profiles: [{ id: 'n1', name: 'nabungaires@gmail.com ' }] } });
    const list = await getProfiles();
    assert.equal(list[0].name, 'nabungaires@gmail.com');
  });
});

test('a missing GoLogin name does not become the string "undefined"', async () => {
  await withAccounts({ ortus: ORTUS }, async () => {
    mockGologin({ [ORTUS]: { profiles: [{ id: 'n2' }] } });
    const list = await getProfiles();
    assert.equal(list[0].name, '');
  });
});

test('a profile that genuinely moves workspaces re-tags on the next list', async () => {
  // First-wins must not freeze the first answer forever: ownership is decided
  // fresh per run, so a profile removed from Ortus lands on marketing.
  await withAccounts({ ortus: ORTUS, mk: MK }, async () => {
    mockGologin({
      [ORTUS]: { profiles: [{ id: 'p1', name: 'moving' }] },
      [MK]: { profiles: [{ id: 'p1', name: 'moving' }] },
    });
    await getProfiles();
    assert.equal(accountOfProfile('p1'), 'ortus');

    clearProfileCache();
    mockGologin({
      [ORTUS]: { profiles: [] },
      [MK]: { profiles: [{ id: 'p1', name: 'moving' }] },
    });
    await getProfiles();
    assert.equal(accountOfProfile('p1'), 'marketing');
  });
});

 test('all rejected workspaces fail clearly; an authenticated empty workspace is still a success', async () => {
  await withAccounts({ortus:ORTUS,lv:LV},async()=>{
    mockGologin({[ORTUS]:{throws:'rejected'},[LV]:{throws:'rejected'}});
    await assert.rejects(()=>getProfiles(),/Could not load any workspace/);
    clearProfileCache();
    mockGologin({[ORTUS]:{throws:'rejected'},[LV]:{profiles:[]}});
    assert.deepEqual(await getProfiles(),[]);
    assert.equal(getProfileLoadWarnings().length,1);
  });
});
