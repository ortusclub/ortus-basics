import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dailyQuotaCount, hasDailySendLimit, utcDayKey, nextDailyResetAt } from '../src/campaign-limits.js';
import { dailyCountText, batchCountText, dailyResetText } from '../public/js/campaign-counters.mjs';

test('message campaigns use confirmed messages for the daily cap', () => {
  assert.equal(dailyQuotaCount('open_profile_only', 2, 75), 75);
  assert.equal(dailyQuotaCount('connect_only', 2, 75), 2);
  assert.equal(hasDailySendLimit('open_profile_only'), true);
  assert.equal(hasDailySendLimit('check_status'), false);
});
test('daily boundary is UTC even across daylight saving changes', () => {
  assert.equal(nextDailyResetAt('2026-10-25T23:59:00Z'), '2026-10-26T00:00:00.000Z');
  assert.equal(utcDayKey('2026-09-27T02:00:00+02:00'), '2026-09-27');
});
test('actual campaign counters increment per confirmation, isolate accounts, and roll over', () => {
  const source = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const campaignCounts ='), source.indexOf('// 2.9.8: normalize'));
  assert.ok(code.length > 100);
  let day = '2026-09-27';
  const context = vm.createContext({ campaign: {mode:'open_profile_only'}, utcDayKey: () => day, dailyQuotaCount });
  vm.runInContext(code, context);
  vm.runInContext("bumpCampaignMessageCount('a')", context);
  assert.equal(vm.runInContext("getCampaignQuotaCount('a')", context), 1);
  assert.equal(vm.runInContext("getCampaignQuotaCount('b')", context), 0);
  vm.runInContext("bumpCampaignSendCount('a')", context);
  assert.equal(vm.runInContext("getCampaignQuotaCount('a')", context), 1);
  day='2026-09-28';
  assert.equal(vm.runInContext("getCampaignQuotaCount('a')", context), 0);
  vm.runInContext("bumpCampaignMessageCount('a')", context);
  assert.equal(vm.runInContext("getCampaignQuotaCount('a')", context), 1);
});
test('daily and batch displays distinguish successful sends from checked leads', () => {
  const a={dailyCount:12,dailyLimit:75,batchSent:2,batchDone:5,batchSize:8,dailyResetAt:'2026-09-28T00:00:00Z'};
  assert.equal(dailyCountText(a),'12/75 sent today');
  assert.equal(batchCountText(a),'Batch: 2 sent · 5/8 checked');
  assert.match(dailyResetText(a),/00:00 UTC/);
  assert.equal(batchCountText({}), '');
  assert.equal(dailyResetText({...a,dailyLimit:0}), '');
  assert.equal(dailyCountText({...a,dailyLimit:0}), '12 sent today');
});
