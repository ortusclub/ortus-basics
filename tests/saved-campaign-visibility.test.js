import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function unlistedSavedCampaigns(');
const ctx = vm.createContext({});
vm.runInContext(source.slice(start, source.indexOf('function latestLocalCampaignHistory', start)), ctx);
test('saved campaign remains discoverable after leaving the queue, without duplicating visible entries', () => {
  const saved = [{name:'Sam'}, {name:'Sam II'}, {name:'Sam III'}, {name:'Draft'}];
  const visible = [{name:' SAM ',bucket:'running'}, {name:'Sam II',bucket:'queued'}];
  const result = ctx.unlistedSavedCampaigns(saved,visible,[{name:'draft'}]);
  assert.equal(result.length,1);
  assert.equal(result[0].name,'Sam III');
  const afterQueue = ctx.unlistedSavedCampaigns(saved,visible.slice(0,1),[{name:'draft'}]);
  assert.equal(afterQueue.length,2);
  assert.equal(afterQueue[0].name,'Sam II');
});
