import { sameCampaign } from '../public/js/campaign-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('const _localRestartsPending ='), source.indexOf('window.restartLocalFromItem ='));
function harness({ item = { name: 'Sam II', hist: { totalProcessed: 7 } }, saved, status = 200, selected = null, live = null } = {}) {
  const requests = [], messages = [];
  const ctx = vm.createContext({ sameCampaign,
    _boardItemsById: new Map(item ? [['past-1', item]] : []), _snItemsById: new Map(),
    window: {}, _viewingLocalCampaign: selected, _localLive: live, _pfState: null,
    runPreflight: async () => ({ findings: { blockers: [], warnings: [] }, ack: "clean-ack" }),
    renderPreflight() {},
    showCampaignToast: m => messages.push(m), startPolling() {}, renderCampaignsBoard() {},
    async fetch(url, options) {
      requests.push({ url, options });
      if (options?.method === 'POST') return { ok: true };
      return { ok: status === 200, status, json: async () => ({ config: saved }) };
    },
  });
  vm.runInContext(code, ctx);
  return { ctx, requests, messages, payload: () => JSON.parse(requests.find(r => r.options)?.options.body || 'null') };
}
const config = { mode: 'connect_and_introduce', profileIds: ['a'], sheetUrl: 'sheet', dailyLimit: 75, sheetGid: '123', senderColumn: 'Sender', pauseOnThrottle: false, autoChecksEnabled: false, templates: { primaryIntroBody: 'Hello', primaryCheckTiming: 'after_connections' } };
test('resume loads named settings even when dashboard has no settings snapshot', async () => {
  const h = harness({ saved: config });
  await h.ctx.restartLocalFromItem('past-1', false);
  assert.equal(h.requests[0].url, '/api/campaign-configs/Sam%20II');
  const p = h.payload();
  assert.equal(p.name, 'Sam II');
  assert.equal(p.sheetGid, '123');
  assert.equal(p.pauseOnThrottle, false);
  assert.equal(p.autoChecksEnabled, false);
  assert.equal(p.primaryCheckTiming, 'after_connections');
  assert.equal(p.resumeContext.totalProcessed, 7);
});
test('saved settings override stale cache; live zero does not use old history counts', async () => {
  const h = harness({ saved: config, item: { name: 'Sam II', srcSettings: { dailyLimit: 10 }, hist: { totalProcessed: 7 } }, live: { name: 'Sam II', totalProcessed: 0 } });
  await h.ctx.restartLocalFromItem('past-1', false);
  assert.equal(h.payload().dailyLimit, 75);
  assert.equal(h.payload().resumeContext.totalProcessed, 0);
});
test('resume still resolves selected campaign after board cache disappears', async () => {
  const h = harness({ item: null, saved: config, selected: { id: 'past-1', name: 'Sam II', status: { totalProcessed: 9 } } });
  await h.ctx.restartLocalFromItem('past-1', false);
  assert.equal(h.payload().resumeContext.totalProcessed, 9);
});
test('missing named configuration falls back to historical settings', async () => {
  const h = harness({ status: 404, item: { name: 'Sam II', srcSettings: config } });
  await h.ctx.restartLocalFromItem('past-1', false);
  assert.equal(h.payload().dailyLimit, 75);
});
test('server errors never launch with stale settings', async () => {
  const h = harness({ status: 500, item: { name: 'Sam II', srcSettings: config } });
  await h.ctx.restartLocalFromItem('past-1', false);
  assert.equal(h.payload(), null);
  assert.match(h.messages[0], /Could not load saved settings/);
});
test('restart clears saved resume context and maps introduction wizard fields', async () => {
  const h = harness({ saved: { ...config, mode: 'introduce_back', resumeContext: { totalProcessed: 99 }, templates: { primaryName: 'Primary', primaryIntroBody: 'Intro' } } });
  await h.ctx.restartLocalFromItem('past-1', true);
  assert.equal(h.payload().resumeContext, undefined);
  assert.equal(h.payload().templates.introName, 'Primary');
  assert.equal(h.payload().templates.followUp1, 'Intro');
});

test('resume findings open review without starting; Continue sends reviewed settings and ack', async () => {
  const h = harness({ saved: config });
  let reviews = 0;
  h.ctx.runPreflight = async () => ({ findings: { blockers: [{ detail: 'Name mismatch' }], warnings: [] }, ack: 'review-ack' });
  h.ctx.renderPreflight = () => { reviews++; };
  assert.equal(await h.ctx.restartLocalFromItem('past-1', false), false);
  assert.equal(reviews, 1);
  assert.equal(h.payload(), null);
  const callbackCode = source.slice(source.indexOf('function _launchWithAck()'), source.indexOf("document.addEventListener('DOMContentLoaded'", source.indexOf('function _launchWithAck()')));
  vm.runInContext(callbackCode, h.ctx);
  assert.equal(await h.ctx._launchWithAck(), true);
  assert.equal(reviews, 1);
  assert.equal(h.payload().preflightAck, 'review-ack');
  assert.equal(h.payload().resumeContext.totalProcessed, 7);
  assert.equal(h.payload().name, 'Sam II');
});
