import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const autosave = app.slice(app.indexOf('const AUTOSAVE_DEBOUNCE_MS'), app.indexOf('function updateSavePip()'));

function harness({ bound, typed }) {
  const requests = [];
  const context = vm.createContext({
    getActiveDraftId: () => 'd1', clearActiveDraft() { context.detached = true; },
    boundWizardKey: () => bound, _campaignKey: n => String(n || '').trim().toLowerCase(),
    _currentWizardName: () => typed, collectCurrentConfig: () => ({ mode: 'connect_and_introduce' }),
    document: { getElementById: () => ({ value: typed }) },
    fetch: async (url, opts) => { requests.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; },
    updateSavePip() {}, window: {}, console, setTimeout, clearTimeout, _wizardBoundKey: bound,
  });
  vm.runInContext(autosave, context);
  return { context, requests };
}

test('autosave after renaming in the box still addresses the draft by the name it was opened as', async () => {
  const h = harness({ bound: 'opiv', typed: 'CCIV' });
  await h.context.flushAutosaveImmediate();
  assert.equal(h.requests[0].expectKey, 'opiv');
  assert.equal(h.requests[0].name, 'CCIV');
  assert.equal(h.requests[0].config.mode, 'connect_and_introduce');
});

test('an unbound wizard falls back to the typed name', async () => {
  const h = harness({ bound: '', typed: 'Fresh' });
  await h.context.flushAutosaveImmediate();
  assert.equal(h.requests[0].expectKey, 'fresh');
});

test('picking a campaign type card autosaves, and Save flushes the draft first', () => {
  const pick = app.slice(app.indexOf("select.value = mode.value;\n  onModeChange();"), app.indexOf('function updateOpenProfileVisibility'));
  assert.match(pick, /wizardDirtyOnInput\(\)/);
  const save = app.slice(app.indexOf('window.launchSaveAsDraft = '), app.indexOf('window.launchSaveChanges = '));
  assert.ok(save.indexOf('await flushAutosaveImmediate()') < save.indexOf("showCampaignToast('Saved')"));
});
