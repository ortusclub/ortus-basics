// tests/primary-session-proxy.test.js
//
// GET /api/primary-session (server.js, mirrors /api/primary-status ~2038) is a
// thin proxy: extract the bare lowercased vanity slug from the primary URL,
// then delegate to getPrimarySession(slug). server.js has no test harness (no
// existing test imports it — every other server-route test here exercises the
// underlying pure helpers instead, e.g. cloud-primary-handshake.test.js), so
// this exercises the two pieces the route composes: slug extraction +
// delegation to the engine's by-slug endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrimarySlug, getPrimarySession } from '../src/campaigns-client.js';

test('extractPrimarySlug pulls the bare lowercased vanity slug', () => {
  assert.equal(extractPrimarySlug('https://www.linkedin.com/in/Jane-Doe/'), 'jane-doe');
  assert.equal(extractPrimarySlug('https://linkedin.com/in/John123?x=1'), 'john123');
  assert.equal(extractPrimarySlug('linkedin.com/in/sam-adcock#section'), 'sam-adcock');
});

test('extractPrimarySlug returns empty for missing/malformed input — proxy must answer {state:"none"}, not 400', () => {
  assert.equal(extractPrimarySlug(''), '');
  assert.equal(extractPrimarySlug(undefined), '');
  assert.equal(extractPrimarySlug('not a url'), '');
});

test('extractPrimarySlug returns empty for an encoded member token (no vanity slug to resolve)', () => {
  assert.equal(extractPrimarySlug('https://www.linkedin.com/in/ACwAAAB1UsBwj3RaMock/'), '');
  assert.equal(extractPrimarySlug('https://www.linkedin.com/in/ACoAAB1UsBwj3RaMock/'), '');
});

test('Basics rejects cloud primary session reads without using the network', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  assert.deepEqual(await getPrimarySession('jane-doe'), { error: 'Cloud campaigns are discontinued in this version' });
  assert.equal(fetch.mock.callCount(), 0);
});
