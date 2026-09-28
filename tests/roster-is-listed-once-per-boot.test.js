import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProfiles, clearProfileCache } from '../src/gologin-launcher.js';

// The profile cache only ever held a FINISHED list, so two callers that arrived
// while a workspace was still paging both missed it and both paged the whole
// thing. Sam's boot log (1 Sep) shows two interleaved 17-page sweeps of the same
// 489 profiles: 34 GoLogin calls where 17 would do, at the exact moment the app
// is loading everything else.

const ORTUS = 'tok-ortus';

// GoLogin's paged /browser/v2, slow enough that a second caller lands mid-page.
function mockSlowGologin(pages, delayMs) {
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests += 1;
    await new Promise((r) => setTimeout(r, delayMs));
    const page = Number(new URL(url).searchParams.get('page') || 1);
    const profiles = page <= pages ? [{ id: `p${page}`, name: `profile-${page}` }] : [];
    return { ok: true, status: 200, json: async () => ({ allProfilesCount: pages, profiles }) };
  };
  return () => requests;
}

function withOrtus(fn) {
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.GOLOGIN_API_TOKEN;
  const savedLv = process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY;
  const savedMk = process.env.GOLOGIN_API_TOKEN_MARKETING;
  process.env.GOLOGIN_API_TOKEN = ORTUS;
  delete process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY;
  delete process.env.GOLOGIN_API_TOKEN_MARKETING;
  clearProfileCache();
  return (async () => {
    try { return await fn(); }
    finally {
      globalThis.fetch = savedFetch;
      clearProfileCache();
      if (savedToken === undefined) delete process.env.GOLOGIN_API_TOKEN;
      else process.env.GOLOGIN_API_TOKEN = savedToken;
      if (savedLv !== undefined) process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY = savedLv;
      if (savedMk !== undefined) process.env.GOLOGIN_API_TOKEN_MARKETING = savedMk;
    }
  })();
}

test('two callers during one boot share a single listing instead of paging twice', async () => {
  await withOrtus(async () => {
    const requests = mockSlowGologin(3, 20);
    const [a, b] = await Promise.all([getProfiles(), getProfiles()]);
    // The walk stops once it has the advertised count, so 3 pages = one sweep.
    // Two callers each doing their own sweep is 6, which is the bug.
    assert.equal(requests(), 3, 'the workspace must be paged once, not once per caller');
    assert.deepEqual(a.map((p) => p.id), ['p1', 'p2', 'p3']);
    assert.deepEqual(b.map((p) => p.id), ['p1', 'p2', 'p3'], 'both callers get the same roster');
  });
});

test('a failed listing is not cached, so the next caller retries', async () => {
  await withOrtus(async () => {
    let attempt = 0;
    globalThis.fetch = async (url) => {
      attempt += 1;
      if (attempt === 1) throw new Error('network down');
      const page = Number(new URL(url).searchParams.get('page') || 1);
      return {
        ok: true,
        status: 200,
        json: async () => ({ allProfilesCount: 1, profiles: page === 1 ? [{ id: 'p1', name: 'one' }] : [] }),
      };
    };
    // Caching the rejected promise would make one network blip at boot poison
    // the roster for the whole 5-minute TTL.
    await assert.rejects(getProfiles(), /Could not load any workspace/);
    const list = await getProfiles();
    assert.deepEqual(list.map((p) => p.id), ['p1']);
  });
});
