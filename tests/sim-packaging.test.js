import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).build.files;

// The installed app must carry everything the in-app campaign test reads, or the button works only from a repo checkout.
test('the installed app ships the campaign simulator and the Apps Script it reads, but not its reports', () => {
  assert.ok(files.includes('tests/sim/**/*'));
  assert.ok(files.includes('google-apps-script.js'));
  assert.ok(files.includes('!tests/sim/reports/**'));
  // electron-builder applies patterns in order: the re-include must come AFTER the blanket tests exclusion.
  assert.ok(files.indexOf('tests/sim/**/*') > files.indexOf('!**/tests/**/*'));
  assert.ok(files.indexOf('!tests/sim/reports/**') > files.indexOf('tests/sim/**/*'));
});

test('every file the simulator imports from outside tests/sim is inside the packaged folders', () => {
  const packaged = (rel) => ['src/', 'public/', 'tests/sim/'].some(d => rel.startsWith(d)) || files.includes(rel);
  const dir = join(ROOT, 'tests', 'sim');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'reports' ? [] : walk(join(d, e.name))) : [join(d, e.name)]);
  const missing = [];
  for (const f of walk(dir).filter(x => x.endsWith('.mjs'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/['"`]((?:\.\.\/)+[^'"`\s]+\.(?:m?js|json))['"`]/g)) {
      const rel = resolve(dirname(f), m[1]).slice(ROOT.length + 1);
      if (!packaged(rel)) missing.push(`${f.slice(ROOT.length + 1)} → ${rel}`);
    }
  }
  assert.deepEqual(missing, []);
});
