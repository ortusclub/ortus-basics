import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A Stop pressed while nothing was running arms campaign._abort, and only a
// campaign start clears it. The manual sweep loop reads that flag, so the next
// check used to halt with "Stop detected" before opening a browser.
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = server.indexOf("app.post('/api/bulk-check-now'");
const route = server.slice(start, server.indexOf("app.post('/api/bulk-check/stop'", start));
const guard = /if \(!campaign\.running && campaign\.state !== 'monitoring'\) campaign\._abort = false;/g;

test('a manual sweep clears a stale campaign abort before its loop reads it', () => {
  const armed = route.indexOf('_manualSweepAbort = false;');
  const loop = route.indexOf("campaignLog('■ Stop detected — halting bulk check sweep.')");
  const clear = route.search(guard);
  assert.ok(armed > -1 && clear > armed && clear < loop, 'stale abort must be cleared after the route accepts the click and before the sweep loop');
});

test('the sweep also clears the abort as it unwinds, but never for a live campaign', () => {
  const finallyAt = route.lastIndexOf('} finally {');
  const clears = route.slice(finallyAt).match(guard) || [];
  assert.equal(clears.length, 1);
  assert.match(route, /!campaign\.running && campaign\.state !== 'monitoring'/, 'guard must leave a running or monitoring campaign untouched');
});
