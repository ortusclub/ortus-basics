// Unit coverage for updateQueueEntry — async helper that patches a
// queued campaign entry by id. Matches the existing async/cache pattern
// in src/campaign-queue.js (load → mutate → persist atomically via
// .tmp + rename).
//
// Uses ORTUS_DATA_DIR (read at paths.js module load) to redirect writes
// to a per-run temp directory so the real data/queued-campaigns.json
// is never touched.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'ortus-dashboard-v3-tests');
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.ORTUS_DATA_DIR = TEST_DATA_DIR;

// Reset the queue file so each run starts clean.
const QUEUE_FILE = path.join(TEST_DATA_DIR, 'queued-campaigns.json');
try { fs.unlinkSync(QUEUE_FILE); } catch { /* fine if missing */ }

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Dynamic import: a static one is hoisted above the ORTUS_DATA_DIR assignment.
const {
  addToQueue,
  updateQueueEntry,
  removeFromQueue,
  popNextReady,
} = await import('../src/campaign-queue.js');

test('updateQueueEntry — patches name field', async () => {
  const entry = await addToQueue({ name: 'Original', mode: 'C+I' });
  const updated = await updateQueueEntry(entry.id, { name: 'Renamed' });
  assert.equal(updated.name, 'Renamed');
  // Other config fields preserved
  assert.equal(updated.config.mode, 'C+I');
  await removeFromQueue(entry.id);
});

test('updateQueueEntry — patches scheduledAt field', async () => {
  const entry = await addToQueue({ name: 'x', mode: 'CC' });
  const updated = await updateQueueEntry(entry.id, { scheduledAt: '2026-05-28T10:00:00Z' });
  assert.equal(updated.scheduledAt, '2026-05-28T10:00:00Z');
  await removeFromQueue(entry.id);
});

test('updateQueueEntry — unknown id returns null', async () => {
  const r = await updateQueueEntry('nonexistent', { name: 'x' });
  assert.equal(r, null);
});

test('updateQueueEntry — rejects unknown keys', async () => {
  const entry = await addToQueue({ name: 'x', mode: 'CC' });
  await assert.rejects(
    () => updateQueueEntry(entry.id, { ownerSecret: 'hax' }),
    /unknown key/i,
  );
  await removeFromQueue(entry.id);
});

test('a future scheduled continuation does not block a ready campaign behind it', async () => {
  const future = await addToQueue({ name: 'Tomorrow', mode: 'CC' }, null, { scheduledAt: '2099-01-01T00:02:00Z' });
  const ready = await addToQueue({ name: 'Now', mode: 'CC' });
  const popped = await popNextReady(Date.parse('2026-08-26T12:00:00Z'));
  assert.equal(popped.id, ready.id);
  await removeFromQueue(future.id);
});
