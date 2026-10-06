// Basics keeps general SoO write-back disabled, including legacy cloud records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'basics-soo-reconcile-'));
const { reconcileCloudInUse } = await import('../src/cloud-soo-reconcile.js');
const { sooWritebackEnabled } = await import('../src/soo-writer.js');

test('legacy sent accounts are settled without reserving credits or calling SoO', async (t) => {
  t.after(() => rmSync(process.env.ORTUS_DATA_DIR, { recursive: true, force: true }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected write'); });
  assert.equal(sooWritebackEnabled(), false);
  const input = { id: 'legacy', mode: 'connect_only', accountEmails: { p1: 'sender@example.test' },
    leads: [{ id: 'lead1', account: 'p1', status: 'sent', sentAt: new Date().toISOString() }] };
  assert.deepEqual(await reconcileCloudInUse(input), { flipped: 0 });
  assert.deepEqual(await reconcileCloudInUse(input), { flipped: 0 });
  assert.equal(fetch.mock.callCount(), 0);
  const saved = JSON.parse(readFileSync(join(process.env.ORTUS_DATA_DIR, 'cloud-soo-reconcile.json'), 'utf8'));
  assert.deepEqual(saved.campaigns.legacy.flippedAccounts, ['sender@example.test']);
});
