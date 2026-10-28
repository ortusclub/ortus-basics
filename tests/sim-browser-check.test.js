import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBrowser } from './sim/browser.mjs';

// The Campaign Test opens the browser once before running. A first start can take 20s+ on a busy Mac, so a slow try is
// repeated once instead of failing the whole test.
process.env.SIM_CHROME = process.execPath;   // any file that exists: the fake below never runs it

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fakePuppeteer(startDelays) {
  const log = { launches: 0, closed: 0, opened: 0 };
  return {
    log,
    launch: async () => {
      const delay = startDelays[Math.min(log.launches++, startDelays.length - 1)];
      if (delay === 'reject') throw new Error('Failed to launch the browser process');
      await sleep(delay);
      log.opened++;
      return { newPage: async () => ({ goto: async () => {} }), close: async () => { log.closed++; } };
    },
  };
}

test('a normal start passes on the first try', async () => {
  const p = fakePuppeteer([5]);
  const r = await checkBrowser(p, 200);
  assert.equal(r.ok, true);
  assert.equal(p.log.launches, 1);
  assert.equal(p.log.closed, 1);
});

test('a slow first start is retried and passes', async () => {
  const p = fakePuppeteer([150, 5]);
  const r = await checkBrowser(p, 60);
  assert.equal(r.ok, true);
  assert.equal(p.log.launches, 2);
  await sleep(200);
  assert.equal(p.log.closed, p.log.opened, 'the browser that was too slow is closed, not left running');
});

test('a browser that never starts in time fails with a clear message after two tries', async () => {
  const p = fakePuppeteer([150]);
  const r = await checkBrowser(p, 40);
  assert.equal(r.ok, false);
  assert.match(r.message, /did not start within/);
  assert.match(r.message, /Tried 2 times/);
  await sleep(250);
  assert.equal(p.log.closed, p.log.opened, 'nothing is left running');
});

test('a browser that cannot launch at all reports why', async () => {
  const p = fakePuppeteer(['reject']);
  const r = await checkBrowser(p, 200, 1);
  assert.equal(r.ok, false);
  assert.match(r.message, /would not start/);
  assert.match(r.message, /Failed to launch the browser process/);
});
