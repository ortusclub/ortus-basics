import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The installer must choose the product bundle, never an auxiliary Setup app
// that happens to sort first. Basics derives the name from package.json.

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const server = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

test('updater selects the real app by its package product name', () => {
  assert.equal(pkg.productName, 'Ortus Basics');
  assert.match(
    server,
    /SRC="\$MNT\/\$\{pkg\.productName\}\.app"/,
    'the update-install script must pick "Ortus Basics.app" by explicit name',
  );
});

test('any "ls *.app | head -1" is only a last-resort fallback, never the primary selector', () => {
  const idxExplicit = server.indexOf('SRC="$MNT/${pkg.productName}.app"');
  assert.ok(idxExplicit !== -1, 'explicit-name selection must be present');
  const idxHead1 = server.indexOf('*.app 2>/dev/null | head -1)', idxExplicit);
  // head -1 may survive as a guarded fallback, but only AFTER the explicit pick.
  assert.ok(
    idxHead1 === -1 || idxHead1 > idxExplicit,
    'a bare "head -1" .app selector must not precede the explicit-name selection',
  );
});
