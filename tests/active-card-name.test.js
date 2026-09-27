import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { campaignTitle } from '../public/js/campaign-title.mjs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function _activeCardName(status) {');
const source = app.slice(start, app.indexOf('function bindWizardTo', start));

function harness(typed) {
  const ctx = vm.createContext({ campaignTitle, document: { getElementById: () => ({ value: typed }) } });
  vm.runInContext(source, ctx);
  return ctx;
}

test('the engine name wins when it has one', () => {
  assert.equal(harness('CCIV')._activeCardName({ name: 'OPFinal' }), 'OPFinal');
});

test('a stopped or solo-check card shows the campaign open in the editor, not "Loading campaign…"', () => {
  assert.equal(harness('  CCIV ')._activeCardName({ name: '' }), 'CCIV');
  assert.equal(harness('CCIV')._activeCardName(null), 'CCIV');
});

test('an unnamed loaded campaign has a stable fallback title', () => {
  assert.equal(harness('')._activeCardName({}), 'Campaign');
});

test('every live-status title render goes through the helper', () => {
  assert.equal((app.match(/v3SetText\('activeName', _activeCardName\(status\)\)/g) || []).length, 4);
  assert.equal((app.match(/v3SetText\('activeName', status\.name \|\| 'Loading campaign…'\)/g) || []).length, 0);
});
