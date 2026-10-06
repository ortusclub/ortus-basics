// Unit test for the one-time Orbita cache repair.
//
// Covers the CI-safe paths: a browser whose binary can't execute is removed, a
// browser whose binary is missing is removed, the sweep is one-time (flag), and a
// healthy/complete browser is left alone. (The "real healthy Orbita is kept" path
// needs an actual Orbita binary and is verified manually, not in CI.)
//
// BROWSER_DIR is derived from homedir() at import time, so HOME + ORTUS_DATA_DIR
// are set BEFORE the dynamic import to point the module at a throwaway sandbox.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SBX = mkdtempSync(join(tmpdir(), 'orbita-repair-'));
process.env.HOME = SBX;
process.env.ORTUS_DATA_DIR = join(SBX, 'data');
mkdirSync(process.env.ORTUS_DATA_DIR, { recursive: true });

const browser = join(SBX, '.gologin', 'browser');
function makeBrowser(version, { binary } = {}) {
  const macos = join(browser, `orbita-browser-${version}`, 'Orbita-Browser.app', 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  if (binary !== undefined) { writeFileSync(join(macos, 'Orbita'), binary); chmodSync(join(macos, 'Orbita'), 0o755); }
}
// A healthy stand-in: a tiny shell script that prints a version and exits 0 — it
// genuinely executes, so the probe must KEEP it.
makeBrowser('100', { binary: '#!/bin/sh\necho "Orbita-Browser 100.0.0.0"\n' });
// Corrupt: a non-executable-format file → exec fails → must be removed.
makeBrowser('101', { binary: 'this is not a runnable binary' });
// Incomplete: directory present but no Orbita binary at all → must be removed.
makeBrowser('102');

const { repairOrbitaCache } = await import('../src/orbita-cache-repair.js');
const dirOf = (v) => join(browser, `orbita-browser-${v}`);

test('first run keeps the launchable browser and removes the un-launchable ones', async () => {
  await repairOrbitaCache();
  assert.ok(existsSync(dirOf('100')), 'a browser that executes is kept');
  assert.ok(!existsSync(dirOf('101')), 'a corrupt binary is removed');
  assert.ok(!existsSync(dirOf('102')), 'a missing binary is removed');
});

test('it records a one-time flag listing what it removed', () => {
  const flag = JSON.parse(readFileSync(join(process.env.ORTUS_DATA_DIR, 'orbita-cache-repair.json'), 'utf8'));
  assert.equal(typeof flag.token, 'string');
  assert.deepEqual([...flag.removed].sort(), ['orbita-browser-101', 'orbita-browser-102']);
});

test('a second run is a no-op (does not touch the cache again)', async () => {
  // Re-create a corrupt browser; because the flag is already written, the sweep
  // must NOT run again and must leave it in place.
  makeBrowser('103', { binary: 'still not a binary' });
  await repairOrbitaCache();
  assert.ok(existsSync(dirOf('103')), 'already-done flag prevents a second sweep');
});
