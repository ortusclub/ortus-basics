import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function latestLocalCampaignHistory(');
const ctx = vm.createContext({});
vm.runInContext(source.slice(start, source.indexOf('// Fetch local', start)), ctx);
test('repeated runs produce one card per campaign, preserving latest record and original index', () => {
  const hist = [{name:'sam', totalProcessed:1}, {name:'sam II'}, {name:' SAM ',totalProcessed:8}];
  const rows = ctx.latestLocalCampaignHistory(hist);
  assert.equal(rows.length,2);
  assert.equal(rows[0].p, hist[2]);
  assert.equal(rows[0].histIdx,2);
  assert.equal(hist.length,3);
});
test('a current local campaign suppresses its historical card without hiding another campaign', () => {
  const rows = ctx.latestLocalCampaignHistory([{name:'sam'}, {name:'sam II'}], [{where:'local',name:'SAM'}]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].p.name,'sam II');
});
