// These tests mock transport; provide a dummy configured workspace for gateway signing.
process.env.GOLOGIN_API_TOKEN = 'test-only-workspace-credential';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  updateSheetRow,
  updateSheetRowResult,
  batchUpdateSheet,
  flushSheetWrites,
  isTransientWriteError,
} from '../src/sheets-writer.js';

// 2026-08-12: one measured campaign run made 3,293 sheet writes from a single
// laptop — one Apps Script execution per row — and lost 1,772 of them to
// "Troppe chiamate simultanee: Fogli di lavoro", the per-spreadsheet
// simultaneous-invocation limit. These lock down the three things that fixed
// it: rows are coalesced into 100-row `updateRows` executions, only one
// execution is ever in flight, and a load-shedding error is retryable.

const SHEET = 'https://docs.google.com/spreadsheets/d/SHEET_A/edit#gid=0';

// Stand-in for the Apps Script web app. Records every POST body and reports
// how many were in flight at once. `reply(payload, callIndex)` returns the
// parsed JSON the bridge would send back.
function mockWebApp(reply) {
  const posts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    const i = posts.length;
    posts.push(payload);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5)); // a real POST is not instant
    inFlight--;
    const body = JSON.stringify(reply(payload, i));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  };
  return { posts, maxInFlight: () => maxInFlight };
}

function okRows(payload) {
  return { success: true, results: (payload.rows || []).map(() => ({ ok: true })) };
}

async function withMock(reply, fn) {
  const saved = globalThis.fetch;
  const app = mockWebApp(reply);
  try { return await fn(app); }
  finally { await flushSheetWrites().catch(() => {}); globalThis.fetch = saved; }
}

test('250 row writes become 3 bulk executions, not 250', async () => {
  await withMock(okRows, async (app) => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      updateSheetRow(SHEET, `https://linkedin.com/in/lead-${i}`, { stage: 'CC' }, 'linkedin url'));
    const results = await Promise.all(rows);

    assert.equal(app.posts.length, 3, 'one execution per 100 rows');
    assert.deepEqual([...new Set(app.posts.map((p) => p.action))], ['updateRows']);
    assert.deepEqual(app.posts.map((p) => p.rows.length), [100, 100, 50]);
    assert.equal(results.filter(Boolean).length, 250, 'every caller still gets its own true');
  });
});

test('only one Apps Script execution is ever in flight', async () => {
  // The limit that was being blown is per-spreadsheet SIMULTANEOUS invocations,
  // so concurrency — not volume — is what has to be held at one.
  await withMock(okRows, async (app) => {
    await Promise.all(Array.from({ length: 300 }, (_, i) =>
      updateSheetRow(SHEET, `https://linkedin.com/in/lead-${i}`, { stage: 'CC' }, 'linkedin url')));
    assert.equal(app.maxInFlight(), 1);
  });
});

test('a per-row failure fails only that caller', async () => {
  await withMock((payload) => ({
    success: true,
    results: (payload.rows || []).map((r) =>
      (r.linkedinUrl.endsWith('gone') ? { error: 'Row not found for: gone' } : { ok: true })),
  }), async () => {
    const [a, missing, b] = await Promise.all([
      updateSheetRow(SHEET, 'https://linkedin.com/in/a', { stage: 'CC' }, 'linkedin url'),
      updateSheetRow(SHEET, 'https://linkedin.com/in/gone', { stage: 'CC' }, 'linkedin url'),
      updateSheetRow(SHEET, 'https://linkedin.com/in/b', { stage: 'CC' }, 'linkedin url'),
    ]);
    assert.equal(a, true);
    assert.equal(missing, false, 'the missing row reports its own failure');
    assert.equal(b, true, 'and does not take its neighbours down with it');
  });
});

test('rows for different tabs or URL columns never share an execution', async () => {
  // The buffer key is (sheetId, gid, urlColumnName) — the three things that
  // decide which cells a row resolves to. Merging across them would stamp the
  // right values into the wrong sheet.
  await withMock(okRows, async (app) => {
    await Promise.all([
      updateSheetRow(SHEET, 'https://linkedin.com/in/a', { stage: 'CC' }, 'linkedin url'),
      updateSheetRow('https://docs.google.com/spreadsheets/d/SHEET_A/edit#gid=99',
        'https://linkedin.com/in/b', { stage: 'CC' }, 'linkedin url'),
      updateSheetRow(SHEET, 'https://linkedin.com/in/c', { stage: 'CC' }, 'Profile URL'),
    ]);
    assert.equal(app.posts.length, 3);
    assert.deepEqual(app.posts.map((p) => `${p.gid}|${p.urlColumnName}`).sort(),
      ['0|Profile URL', '0|linkedin url', '99|linkedin url']);
  });
});

test('an Apps Script with no updateRows action falls back to per-row writes', async () => {
  // An old deployment routes updateRows to its `default:` branch — handleUpdateRow
  // — which answers "linkedinUrl is required". Losing the rows over that would be
  // worse than the storm we are fixing.
  await withMock((payload) => (payload.action === 'updateRows'
    ? { error: 'linkedinUrl is required' }
    : { success: true, row: 7 }), async (app) => {
    const results = await Promise.all([
      updateSheetRow(SHEET, 'https://linkedin.com/in/a', { stage: 'CC' }, 'linkedin url'),
      updateSheetRow(SHEET, 'https://linkedin.com/in/b', { stage: 'CC' }, 'linkedin url'),
    ]);
    assert.deepEqual(results, [true, true], 'rows still land on an old deployment');
    assert.deepEqual(app.posts.map((p) => p.action), ['updateRows', 'updateRow', 'updateRow']);
  });
});

test('batchUpdateSheet chunks instead of posting the whole array', async () => {
  // The Needs Login flag builds one update per row assigned to an account —
  // thousands on a big sheet, previously one payload that had to finish inside
  // a single execution or lose the lot.
  await withMock(() => ({ success: true, processed: 100 }), async (app) => {
    const updates = Array.from({ length: 220 }, (_, i) => ({ linkedinUrl: `u${i}`, needsLogin: 'Y' }));
    const ok = await batchUpdateSheet(SHEET, updates);
    assert.equal(ok, true);
    assert.deepEqual(app.posts.map((p) => p.updates.length), [100, 100, 20]);
  });
});

test('"too many simultaneous invocations" is retryable, in either language', () => {
  // It was classified permanent, so all 270 of those rows were dropped without
  // one retry. Google shedding load is the most retryable error there is.
  assert.equal(isTransientWriteError('Troppe chiamate simultanee: Fogli di lavoro'), true);
  assert.equal(isTransientWriteError('Too many simultaneous invocations: Spreadsheets'), true);
  // Still permanent — retrying these only adds load.
  assert.equal(isTransientWriteError('Row not found for: https://linkedin.com/in/x'), false);
  assert.equal(isTransientWriteError('Authentication error — redeploy the Apps Script'), false);
});

test('flushSheetWrites lands rows that are still buffered', async () => {
  // The last rows of a run sit in the buffer for up to COALESCE_MS. Without the
  // flush in campaign.js's finally block they would die with the process.
  await withMock(okRows, async (app) => {
    const pending = updateSheetRow(SHEET, 'https://linkedin.com/in/last', { stage: 'CC' }, 'linkedin url');
    await flushSheetWrites();
    assert.equal(app.posts.length, 1, 'flush does not wait out the coalescing window');
    assert.equal(await pending, true);
  });
});


test('detailed row results preserve failures while the legacy caller still receives a boolean', async () => {
  await withMock(payload => ({ success: true, results: payload.rows.map(row =>
    row.linkedinUrl.endsWith('missing') ? { error: 'Row not found in selected tab' } : { ok: true }) }), async () => {
    const results = await Promise.all([
      updateSheetRowResult(SHEET, 'https://linkedin.com/in/missing', { stage: 'DM Sent' }),
      updateSheetRowResult(SHEET, 'https://linkedin.com/in/found', { stage: 'DM Sent' }),
      updateSheetRow(SHEET, 'https://linkedin.com/in/missing', { stage: 'DM Sent' }),
    ]);
    assert.deepEqual(results, [{ ok: false, error: 'Row not found in selected tab' }, { ok: true }, false]);
  });
});

test('unconfirmed batch writes report an actionable failure to every caller', async () => {
  await withMock(() => ({ error: 'No LinkedIn URL column found in the sheet' }), async () => {
    const result = await updateSheetRowResult(SHEET, 'lead', { stage: 'DM Sent' });
    assert.deepEqual(result, { ok: false, error: 'No LinkedIn URL column found in the sheet' });
  });
});
