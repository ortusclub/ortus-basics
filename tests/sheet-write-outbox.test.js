import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSheetWriteOutbox } from '../src/sheet-write-outbox.js';
const meta = (name = 'lead', stage = 'DM Sent', gid = 42) => ({
  sheetUrl: `https://docs.google.com/spreadsheets/d/original/edit#gid=${gid}`,
  url: `https://www.linkedin.com/in/${name}`, column: 'LinkedIn Bio', leadName: name,
  payload: JSON.stringify({ stage, message: 'confirmed result '.repeat(50) }),
});
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'basics-sheet-outbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'pending.json');
}

test('persists before sending, survives restart, and removes only confirmed writes', async t => {
  const filePath = setup(t);
  const queued = createSheetWriteOutbox({ filePath, write: async () => { throw Error('must not send before restart'); } });
  queued.enqueue(meta());
  const stored = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(stored.length, 1);
  assert.deepEqual(JSON.parse(stored[0].payload), JSON.parse(meta().payload));
  const recovered = createSheetWriteOutbox({ filePath, write: async entry => {
    assert.equal(entry.sheetUrl, meta().sheetUrl);
    assert.equal(entry.column, 'LinkedIn Bio');
    return { ok: true };
  } });
  assert.deepEqual(await recovered.flush(), { retried: 1, stillFailing: 0 });
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), []);
});

test('authorization errors retain results with backoff; restored access syncs without another enqueue', async t => {
  const filePath = setup(t);
  let now = 0, allowed = false, calls = 0;
  const box = createSheetWriteOutbox({ filePath, now: () => now, write: async () => {
    calls++; return allowed ? { ok: true } : { ok: false, error: 'HTTP 401' };
  } });
  box.enqueue(meta());
  await box.flush();
  assert.equal(box.list()[0].errorMessage, 'HTTP 401');
  await box.flush();
  assert.equal(calls, 1);
  now = 30000; allowed = true;
  await box.flush();
  assert.equal(calls, 2);
  assert.equal(box.list().length, 0);
});

test('failed older row updates cannot overwrite newer updates; unrelated tabs keep syncing', async t => {
  const filePath = setup(t);
  let allowed = false;
  const writes = [];
  const box = createSheetWriteOutbox({ filePath, write: async entry => {
    const stage = JSON.parse(entry.payload).stage;
    writes.push(stage);
    return stage === 'old' && !allowed ? { ok: false, error: 'temporary failure' } : { ok: true };
  } });
  box.enqueue(meta('lead', 'old'));
  box.enqueue(meta('lead', 'new'));
  box.enqueue(meta('lead', 'other tab', 99));
  await box.flush();
  assert.deepEqual(writes, ['old', 'other tab']);
  allowed = true;
  await box.flush({ force: true });
  assert.deepEqual(writes, ['old', 'other tab', 'old', 'new']);
  assert.equal(box.list().length, 0);
});

test('concurrent retry requests share one execution, including rows added during a write', async t => {
  const filePath = setup(t);
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const box = createSheetWriteOutbox({ filePath, write: async () => { calls++; await gate; return { ok: true }; } });
  box.enqueue(meta('first'));
  const first = box.flush();
  box.enqueue(meta('second'));
  const second = box.flush({ force: true });
  assert.equal(first, second);
  release();
  await first;
  assert.equal(calls, 2);
  assert.equal(box.list().length, 0);
});

test('unconfirmed responses and thrown errors never remove queued results', async t => {
  const filePath = setup(t);
  const box = createSheetWriteOutbox({ filePath, write: async entry => {
    if (entry.leadName === 'throws') throw Error('Network unavailable');
    return {};
  } });
  box.enqueue(meta('unconfirmed')); box.enqueue(meta('throws'));
  await box.flush();
  assert.equal(box.list().length, 2);
  assert.match(box.list()[1].errorMessage, /Network unavailable/);
});

test('unreadable saved queue is preserved instead of replaced with an empty queue', t => {
  const filePath = setup(t);
  writeFileSync(filePath, '{broken');
  assert.throws(() => createSheetWriteOutbox({ filePath, write: async () => ({ ok: true }) }));
  assert.equal(readFileSync(filePath, 'utf8'), '{broken');
});
