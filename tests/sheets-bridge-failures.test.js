import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchUpdateSheet, writeRecentConnectionsTab } from '../src/sheets-writer.js';

const sheet = 'https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0';
const updates = [{ linkedinUrl: 'https://linkedin.com/in/test-person', cc: 'Connected' }];
function respond(t, status, body) {
  t.mock.method(globalThis, 'fetch', async () => ({status, headers: {get: () => null}, text: async () => body}));
}
test('Google 403 is a visible failure, not a successful sweep', async (t) => {
  respond(t, 403, '<html>Access Denied</html>');
  await assert.rejects(batchUpdateSheet(sheet, updates, {requireConfirmation: true}), /access denied \(HTTP 403\)/);
});
test('unconfirmed JSON is not treated as a saved batch', async (t) => {
  respond(t, 200, JSON.stringify({status: 'ok'}));
  await assert.rejects(batchUpdateSheet(sheet, updates, {requireConfirmation: true}), /no success flag/);
});
test('successful confirmed batch retains normal result', async (t) => {
  respond(t, 200, JSON.stringify({success: true, processed: 1}));
  assert.equal(await batchUpdateSheet(sheet, updates, {requireConfirmation: true}), true);
});
test('a successful envelope cannot hide a failed individual row', async (t) => {
  respond(t, 200, JSON.stringify({success: true, processed: 1, results: [{error: 'not found'}]}));
  await assert.rejects(batchUpdateSheet(sheet, updates, {requireConfirmation: true}), /1 row\(s\) failed: not found/);
});
test('an old sidecar response without accumulated rows falls back to live connections', async (t) => {
  respond(t, 200, JSON.stringify({ok: true, rows: 1, tab: 'Recent Connections'}));
  assert.equal(await writeRecentConnectionsTab(sheet, 'test', []), null);
});
test('an actual empty accumulated list remains valid', async (t) => {
  respond(t, 200, JSON.stringify({ok: true, rows: 0, tab: 'Recent Connections', accumulated: []}));
  assert.deepEqual(await writeRecentConnectionsTab(sheet, 'test', []), []);
});
