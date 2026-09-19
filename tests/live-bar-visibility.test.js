import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sameCampaign } from '../public/js/campaign-lifecycle.mjs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = app.indexOf('window.updateEditingBanner = function() {');
const source = app.slice(start, app.indexOf('\n};\n', start) + 4);

function harness({ hash, running, openedId, typedName = '', draftId = null }) {
  const els = {};
  const el = id => (els[id] ||= { id, style: {}, hidden: false, textContent: '', value: '', classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {} });
  el('campaign-mode').value = 'open_profile_only';
  el('campaign-name-input').value = typedName;
  const context = vm.createContext({
    window: {}, location: { hash }, sameCampaign, _openedCampaignId: openedId,
    document: { getElementById: el, body: { classList: { add() {}, remove() {} } } },
    getActiveDraftId: () => draftId, _closeLaunchMenu() {}, updateSavePip() {}, dashboardModeLabel: m => m,
    __cockpit: { running, paused: false, state: running ? 'running' : 'idle', mode: 'open_profile_only', name: 'OPFinal', campaignId: 'run-1' },
  });
  vm.runInContext(source, context);
  context.window.updateEditingBanner();
  return { rail: els['wiz-launch-rail'], controls: els['wiz-launch-controls'] };
}

test('the running campaign\'s bar never shows on the dashboard', () => {
  const { rail } = harness({ hash: '#/', running: true, openedId: 'run-1', typedName: 'OPFinal' });
  assert.equal(rail.style.display, 'none');
});

test('the bar shows Pause/Stop while the running campaign is open in the editor', () => {
  const { rail, controls } = harness({ hash: '#/new', running: true, openedId: 'run-1', typedName: 'OPFinal' });
  assert.equal(rail.style.display, 'flex');
  assert.equal(controls.hidden, false);
});

test('editing a different campaign shows that campaign\'s own launch pill, not the running one\'s controls', () => {
  const other = harness({ hash: '#/new', running: true, openedId: 'other-2', typedName: 'CCIV', draftId: 'd2' });
  assert.equal(other.controls.hidden, true);
  const noDraft = harness({ hash: '#/new', running: true, openedId: 'other-2', typedName: 'CCIV' });
  assert.equal(noDraft.rail.style.display, 'none');
});
