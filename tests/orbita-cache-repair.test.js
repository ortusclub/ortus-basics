import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { repairOrbitaCache } from '../src/orbita-cache-repair.js';

function fixture(t, outcome = { exit: 0 }) {
  const root = mkdtempSync(join(tmpdir(), 'orbita-repair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const browserDir = join(root, 'browser');
  const dir = join(browserDir, 'orbita-browser-100.0');
  const bin = join(dir, 'Orbita-Browser.app', 'Contents', 'MacOS', 'Orbita');
  mkdirSync(join(bin, '..'), { recursive: true });
  writeFileSync(bin, 'fixture');
  let calls = 0;
  const options = { platform: 'darwin', browserDir, flagFile: join(root, 'flag.json'), timeoutMs: 10,
    spawnProcess() {
      calls++;
      if (outcome.throw) throw outcome.throw;
      const child = new EventEmitter();
      child.kill = () => child.emit('exit', null, 'SIGKILL');
      queueMicrotask(() => {
        if (outcome.error) child.emit('error', outcome.error);
        else if ('exit' in outcome) child.emit('exit', outcome.exit);
      });
      return child;
    },
  };
  return { root, dir, bin, options, calls: () => calls };
}

for (const platform of ['linux', 'win32']) test(`${platform} cache is never inspected or marked`, async (t) => {
  const f = fixture(t);
  await repairOrbitaCache({ ...f.options, platform });
  assert.equal(f.calls(), 0);
  assert.ok(existsSync(f.bin));
  assert.ok(!existsSync(f.options.flagFile));
});

test('healthy cache is preserved and a completed sweep runs only once', async (t) => {
  const f = fixture(t);
  await repairOrbitaCache(f.options);
  await repairOrbitaCache(f.options);
  assert.equal(f.calls(), 1);
  assert.ok(existsSync(f.bin));
  assert.ok(existsSync(f.options.flagFile));
});

for (const outcome of [
  { error: { errno: -86 } }, { error: { code: 'ENOEXEC' } }, { throw: { code: 'EBADARCH' } },
]) test(`loader failure ${JSON.stringify(outcome)} quarantines without deleting`, async (t) => {
  const f = fixture(t, outcome);
  await repairOrbitaCache(f.options);
  assert.ok(!existsSync(f.dir));
  const names = readdirSync(f.options.browserDir);
  assert.equal(names.length, 1);
  assert.match(names[0], /\.quarantine-/);
  assert.ok(existsSync(join(f.options.browserDir, names[0], 'Orbita-Browser.app/Contents/MacOS/Orbita')));
});

test('incomplete cache with a missing binary is quarantined', async (t) => {
  const f = fixture(t);
  rmSync(f.bin);
  await repairOrbitaCache(f.options);
  assert.equal(f.calls(), 0);
  assert.ok(!existsSync(f.dir));
  assert.equal(readdirSync(f.options.browserDir).length, 1);
});

for (const outcome of [
  { exit: 1 }, { exit: null }, {}, { error: { code: 'EACCES' } },
  { error: { code: 'EMFILE' } }, { throw: { code: 'EAGAIN' } },
]) test(`uncertain probe ${JSON.stringify(outcome)} preserves cache and retries later`, async (t) => {
  const f = fixture(t, outcome);
  await repairOrbitaCache(f.options);
  assert.ok(existsSync(f.bin));
  assert.ok(!existsSync(f.options.flagFile));
  await repairOrbitaCache(f.options);
  assert.equal(f.calls(), 2);
});

test('archives, quarantine directories and symlinks are not swept', async (t) => {
  const f = fixture(t);
  symlinkSync(f.dir, join(f.options.browserDir, 'orbita-browser-101'));
  mkdirSync(join(f.options.browserDir, 'orbita-browser-102.quarantine-1'));
  writeFileSync(join(f.options.browserDir, 'orbita-browser-103.tar.gz'), 'archive');
  await repairOrbitaCache(f.options);
  assert.equal(f.calls(), 1);
  assert.equal(readdirSync(f.options.browserDir).length, 4);
});

test('a symlink inside a bundle is preserved without executing its target', async (t) => {
  const f = fixture(t);
  rmSync(f.bin);
  symlinkSync('/bin/sh', f.bin);
  await repairOrbitaCache(f.options);
  assert.equal(f.calls(), 0);
  assert.ok(existsSync(f.dir));
  assert.ok(!existsSync(f.options.flagFile));
});

test('absent cache does not prevent a future sweep', async (t) => {
  const f = fixture(t);
  await repairOrbitaCache({ ...f.options, browserDir: join(f.root, 'absent') });
  assert.ok(!existsSync(f.options.flagFile));
  await repairOrbitaCache(f.options);
  assert.equal(f.calls(), 1);
});

test('repair finishes before the HTTP server accepts launch requests', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('await repairOrbitaCache();') < source.indexOf("app.listen(PORT"));
});
