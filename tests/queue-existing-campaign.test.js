import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
test('Queue accepts an existing campaign and preserves its identity through the normal preflight path', async () => {
  let opts;
  const ctx = vm.createContext({ window: {}, _editingCampaignId: 'saved-sam',
    _boardItemsById: new Map([['saved-sam', {name:'Sam'}]]), _snItemsById: new Map(),
    _readOnlyBlocksLaunch: () => false, _existingCampaignBlocksNewDispatch: () => { throw new Error('Obsolete restriction'); },
    _closeLaunchMenu() {}, flushAutosaveImmediate: async () => {},
    startCampaign: async o => { opts = o; },
  });
  const a = source.indexOf('async function addToQueueCampaign()');
  const b = source.indexOf('window.launchQueueIt = async function()');
  vm.runInContext(source.slice(a,source.indexOf('async function startCampaign(',a)) + source.slice(b,source.indexOf('// v2.61: Schedule modal',b)), ctx);
  await ctx.window.launchQueueIt();
  assert.equal(opts.queueOnly,true);
  assert.equal(opts.existingCampaignName,'Sam');
  assert.equal(opts._skipPreflight,undefined);
});
