// v1.7.54: the Open Profile "Sending method" must survive autosave / re-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('the sending method and InMail tickbox are saved, restored and autosave-tracked', () => {
  const collect = app.slice(app.indexOf('function collectCurrentConfig()'), app.indexOf('function collectCurrentConfig()') + 6000);
  assert.match(collect, /opChannel: getV\('tpl-op-channel'\) \|\| 'sn_first',/);
  assert.match(collect, /opSpendInMail: !!document\.getElementById\('tpl-op-spend-inmail'\)\?\.checked,/);
  assert.match(app, /setV\('tpl-op-subject', t\.openProfileSubject \|\| ''\);\n  \{ const _oc = document\.getElementById\('tpl-op-channel'\); if \(_oc\) _oc\.value = t\.opChannel \|\| 'sn_first';/);
  const wired = app.slice(app.indexOf('function initWizardDirtyTracking()'), app.indexOf('function initWizardDirtyTracking()') + 1200);
  assert.match(wired, /'tpl-op-channel', 'tpl-op-spend-inmail'/);
  // never in the new-campaign clear list (value = '' would blank the select)
  const clear = app.slice(app.indexOf('const _clearIds = ['), app.indexOf('const _clearIds = [') + 600);
  assert.doesNotMatch(clear, /tpl-op-channel/);
});
