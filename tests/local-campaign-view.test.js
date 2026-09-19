import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function _bindLiveStatusToCampaign(');
const code = source.slice(start, source.indexOf('// v2.160.46: OPEN on an ACTIVE', start));

test('opening a stopped local campaign binds local status without any cloud request', () => {
  const painted = [];
  const local = { name: 'Sam', running: false, state: null, totalTargets: 5551, totalProcessed: 4, logs: ['Campaign ended'] };
  const context = vm.createContext({
    _viewingLocalCampaign: null, _localLive: local,
    _boardItemsById: new Map([['local-active', { name: 'Sam', where: 'local' }]]), _snItemsById: new Map(),
    document: { getElementById: () => ({ value: 'Sam' }) }, location: { hash: '#/new' },
    stopViewingCloudCampaign() {}, renderActiveCard: s => painted.push(s), syncLiveStatusVisibility() {}, startPolling() {}, pollStatus() {},
    fetch() { throw new Error('Must not fetch cloud data'); },
  });
  vm.runInContext(code + ";_bindLiveStatusToCampaign('local-active');", context);
  assert.equal(painted[0]._cloud, false);
  assert.equal(painted[0].running, false);
  assert.equal(painted[0].state, 'done');
  assert.deepEqual(painted[0].logs, ['Campaign ended']);
  const unrelated = context.localCampaignViewStatus({ name: 'Different campaign', running: true, logs: ['Unrelated'] });
  assert.equal(unrelated.name, 'Sam');
  assert.deepEqual(unrelated.logs, ['Campaign ended']);
  const refreshed = context.localCampaignViewStatus({ ...local, logs: ['Check complete'] });
  assert.deepEqual(refreshed.logs, ['Check complete']);
  context.location.hash = '#/';
  const dashboard = context.localCampaignViewStatus({ name: 'Different campaign' });
  assert.equal(dashboard.name, 'Different campaign');
});

test('all dashboard Open entry points reopen saved local settings and never request cloud data', async () => {
  const fn = (startText, endText) => source.slice(source.indexOf(startText), source.indexOf(endText, source.indexOf(startText)));
  const openCode = fn('async function openCampaignForEdit(id)', 'window.openCampaignForEdit =');
  const aliases = fn('async function openCloudLive(id)', 'window.openCloudLive =')
    + fn('async function openRunningCampaignReadOnly(id)', 'window.openRunningCampaignReadOnly =');
  const status = { name: 'Sam', running: false, state: null, totalTargets: 50, totalProcessed: 5, logs: ['Campaign ended'] };
  for (const entry of ['openCampaignForEdit', 'openCloudLive', 'openRunningCampaignReadOnly']) {
    const painted = [];
    const nameInput = { value: '' };
    const context = vm.createContext({
      window: {}, location: { hash: '#/' },
      _localLive: status, _viewingLocalCampaign: null,
      _boardItemsById: new Map([['past-1', { name: 'Sam', where: 'local', mode: 'connect_and_introduce' }]]),
      _snItemsById: new Map(), document: { getElementById: () => nameInput },
      localStorage: { setItem() {} },
      loadCampaignConfigByName: async name => { assert.equal(name, 'Sam'); return true; },
      clearCloudEditMode() {}, clearActiveDraft() {}, lockCampaignType() {}, _updateSaveButtonLabel() {},
      goCreateCampaign: () => { context.location.hash = '#/new'; },
      stopViewingCloudCampaign() {}, renderActiveCard: s => painted.push(s),
      syncLiveStatusVisibility() {}, startPolling() {}, pollStatus() {},
      fetch() { throw new Error('Unexpected network request'); },
    });
    vm.runInContext(code + openCode + aliases, context);
    await context[entry]('past-1');
    assert.equal(nameInput.value, 'Sam', entry);
    assert.equal(context.location.hash, '#/new', entry);
    assert.equal(painted.at(-1).name, 'Sam', entry);
    assert.equal(painted.at(-1).state, 'done', entry);
    assert.equal(painted.at(-1)._cloud, false, entry);
    // Repeat after returning to the dashboard, the exact reported regression.
    context.location.hash = '#/';
    await context[entry]('past-1');
    assert.deepEqual(painted.at(-1).logs, ['Campaign ended'], entry);
  }
});
