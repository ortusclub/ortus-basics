import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('window.launchStartNow = async function()');
const code = source.slice(start, source.indexOf('// Queue it', start));
for (const success of [true, false]) {
  test(`existing campaign Start uses local resume and navigates only on success (${success})`, async () => {
    const calls = [];
    const ctx = vm.createContext({
      window: { location: { hash: '#/new' } }, _editingCampaignId: 'sam-id',
      _boardItemsById: new Map(), _snItemsById: new Map(),
      _readOnlyBlocksLaunch: () => false, _closeLaunchMenu() {},
      restartLocalFromItem: async (...args) => { calls.push(args); return success; },
      restartCloudCampaignUI() { throw new Error('Must never start in cloud'); },
      startCampaign() { throw new Error('Must not create another campaign'); },
    });
    vm.runInContext(code, ctx);
    await ctx.window.launchStartNow();
    assert.deepEqual(calls, [['sam-id', false]]);
    assert.equal(ctx.window.location.hash, success ? '#/' : '#/new');
  });
}
