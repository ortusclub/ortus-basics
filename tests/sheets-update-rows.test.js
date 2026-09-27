// These tests mock transport; provide a dummy configured workspace for gateway signing.
process.env.GOLOGIN_API_TOKEN = 'test-only-workspace-credential';
// updateSheetRows — the batched ledger write-back.
//
// The FG list reconcile re-emits EVERY actioned lead on every 30s tick (it is
// not a delta), and the Apps Script holds a script lock for the whole request,
// shared with every live connection campaign on the same deployment. One POST
// per row therefore turned a 700-row run into 700 locked POSTs every half
// minute. These tests pin the batching, the chunking (the POST aborts at 15s,
// so one giant request would lose everything), and — because the retire
// decision depends on it — the per-row success/failure accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateSheetRows } from '../src/sheets-writer.js';

const SHEET = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0';

/** Swap global fetch for a stub that records each POST body and replies with
 *  whatever `reply(body)` returns (an Apps Script JSON payload). */
function stubFetch(reply) {
  const posts = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    posts.push(body);
    const payload = reply(body);
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
  };
  return { posts, restore: () => { globalThis.fetch = real; } };
}

const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ linkedinUrl: `https://www.linkedin.com/in/p${i}`, fgStatus: 'Invited' }));
const allOk = (b) => ({ success: true, results: b.rows.map((_, i) => ({ ok: true, row: i + 2 })) });

test('250 rows go out as 3 chunked POSTs, not 250', async () => {
  const f = stubFetch(allOk);
  try {
    const res = await updateSheetRows(SHEET, rowsOf(250), '');
    assert.equal(f.posts.length, 3, 'chunked at 100 — one 250-row POST would blow the 15s abort');
    assert.deepEqual(f.posts.map((p) => p.rows.length), [100, 100, 50]);
    assert.equal(f.posts[0].action, 'updateRows', 'uses the batched Apps Script action');
    assert.equal(res.ok, 250);
    assert.equal(res.total, 250);
    assert.deepEqual(res.failures, []);
  } finally { f.restore(); }
});

test('a row the sheet does not contain is reported, and does not sink the batch', async () => {
  const f = stubFetch((b) => ({
    success: true,
    results: b.rows.map((r, i) => (i === 1 ? { error: 'Row not found for: ' + r.linkedinUrl } : { ok: true, row: i + 2 })),
  }));
  try {
    const res = await updateSheetRows(SHEET, rowsOf(3), '');
    assert.equal(res.ok, 2);
    assert.equal(res.total, 3);
    assert.equal(res.failures.length, 1);
    // Which row failed, and why — the operator needs the URL, not just a count.
    assert.equal(res.failures[0].linkedinUrl, 'https://www.linkedin.com/in/p1');
    assert.match(res.failures[0].error, /Row not found/);
  } finally { f.restore(); }
});

test('a whole-chunk failure marks every row in THAT chunk unstamped, and only that chunk', async () => {
  let n = 0;
  const f = stubFetch((b) => (n++ === 0 ? { error: 'No LinkedIn URL column found in the sheet' } : allOk(b)));
  try {
    const res = await updateSheetRows(SHEET, rowsOf(150), '');
    assert.equal(res.ok, 50, 'the second chunk still landed');
    assert.equal(res.total, 150);
    assert.equal(res.failures.length, 100);
    assert.match(res.failures[0].error, /No LinkedIn URL column/);
  } finally { f.restore(); }
});

test('ok < total whenever anything failed — the signal listRunShouldRetire gates on', async () => {
  const f = stubFetch((b) => ({ success: true, results: b.rows.map(() => ({ error: 'boom' })) }));
  try {
    const res = await updateSheetRows(SHEET, rowsOf(4), '');
    assert.equal(res.ok, 0);
    assert.equal(res.total, 4);
    assert.notEqual(res.ok, res.total, 'a run whose stamping did not land must not retire');
  } finally { f.restore(); }
});

test('nothing to stamp posts nothing and retires cleanly (ok === total === 0)', async () => {
  const f = stubFetch(allOk);
  try {
    const res = await updateSheetRows(SHEET, [], '');
    assert.equal(f.posts.length, 0);
    assert.deepEqual(res, { ok: 0, total: 0, failures: [] });
  } finally { f.restore(); }
});
