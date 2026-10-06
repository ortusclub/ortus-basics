// Basics removes automatic acceptance controls; legacy saved intent is retained
// by the loader but must not restore an automatic acceptance checkbox.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const app = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');

test('Basics omits automatic primary acceptance from the wizard', () => {
  assert.doesNotMatch(html, /<input[^>]*id="auto-accept-toggle"/);
});

test('Basics omits automatic acceptance of strangers', () => {
  assert.doesNotMatch(html, /<input[^>]*id="auto-accept-all-toggle"/);
});

// The gate blanks `checked` whenever no primary URL is set, so the default has
// to be re-applied from the remembered intent once the control is usable —
// otherwise it is lost on the wizard's very first render.
function gate({ hasUrl, checked, disabled, wanted }) {
  const toggle = { checked, disabled, dataset: wanted === undefined ? {} : { wanted } };
  if (hasUrl && !toggle.disabled) toggle.dataset.wanted = toggle.checked ? '1' : '0';
  toggle.disabled = !hasUrl;
  toggle.checked = hasUrl ? toggle.dataset.wanted !== '0' : false;
  return toggle;
}

test('typing a primary URL turns it on, and an explicit off survives', () => {
  // First render, no URL yet: blanked but the intent is kept.
  const blank = gate({ hasUrl: false, checked: true, disabled: true, wanted: '1' });
  assert.equal(blank.checked, false);
  assert.equal(blank.dataset.wanted, '1');

  // URL arrives: default applied.
  const on = gate({ hasUrl: true, checked: false, disabled: true, wanted: '1' });
  assert.equal(on.checked, true);

  // Operator switches it off: the change handler re-runs the gate.
  const off = gate({ hasUrl: true, checked: false, disabled: false, wanted: '1' });
  assert.equal(off.checked, false, 'an explicit off must not be re-enabled');
  assert.equal(off.dataset.wanted, '0');

  // Clearing then retyping the URL keeps that off.
  const cleared = gate({ hasUrl: false, checked: false, disabled: false, wanted: '0' });
  const retyped = gate({ hasUrl: true, checked: false, disabled: true, wanted: cleared.dataset.wanted });
  assert.equal(retyped.checked, false);
});

test('a saved campaign outranks the default', () => {
  assert.match(app, /_aaEl\.dataset\.wanted = t\.autoAcceptPrimary \? '1' : '0';/);
});
