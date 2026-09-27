import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { buildSheetDataForAction } from '../src/campaign.js';
import { cloudLeadToLocalSheetData } from '../src/cloud-sheet-reconcile.js';
const require = createRequire(import.meta.url);
const { buildTracking } = require('../engine/campaign-sheet-writer.js');
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

for (const path of ['src/linkedin/outreach.js', 'engine/campaign-lib/linkedin/outreach.js']) {
  const src = read(path);
  const block = src.slice(src.indexOf('const trySalesNav = async () => {'), src.indexOf('      let result;', src.indexOf('const trySalesNav = async () => {')));
  test(`${path}: native message retains subject and leaves subjectless body unchanged`, () => {
    const declaration = src.match(/const linkedInBody = ([^;]+);/)[1];
    const format = (opSubject, opBody) => vm.runInNewContext(declaration, { opSubject, opBody });
    assert.equal(format('  Invitation for Alex  ', 'Hello Alex'), 'Invitation for Alex\n\nHello Alex');
    assert.equal(format('', 'Hello Alex'), 'Hello Alex');
    assert.equal(format('   ', 'Hello Alex'), 'Hello Alex');
  });
  async function run({ nativeFails = false, spendInMail = false, salesFails = false } = {}) {
    const calls = [];
    const ctx = { state: { profileId: 'test' }, getSalesNavAccess: () => null, setSalesNavAccess: () => {}, detectSalesNavSubscriptionGate: async () => false, linkedInBody: 'Hi\n\nHello', console: { log() {}, warn() {} }, _origPublicId: 'test-person', opBody: 'Hello', opSubject: 'Hi', spendInMail,
      SALES_NAV_URL_RE: /\/sales\/(people|lead)\//, SALES_MEMBER_URN_RE: /impossible/,
      page: { url: () => 'https://www.linkedin.com/sales/lead/test', goto: async () => {} },
      sendMessage: async (_page, body) => { calls.push({ nativeBody: body }); if (nativeFails) throw Error('No free compose'); },
      sendInMail: async (_page, subject, body) => { calls.push({ subject, body }); },
      sendViaSalesNav: async (_page, options) => { calls.push({ subject: options.opSubject, body: options.opBody }); return salesFails ? { ok: false, reason: 'no_credits' } : { ok: true, kind: 'op_message_sent' }; },
      isPostSendFailure: () => false, setTimeout: fn => fn() };
    vm.createContext(ctx);
    const results = await vm.runInContext(`(async () => { ${block}; return { native: await tryLinkedIn(), sales: await trySalesNav() }; })()`, ctx);
    assert.equal(calls[0].nativeBody, 'Hi\n\nHello');
    assert.ok(calls.some(c => c.subject === 'Hi' && c.body === 'Hello'));
    return results;
  }
  test(`${path}: actual route survives OP and credit fallback`, async () => {
    const r = await run();
    assert.equal(r.native.action.sentVia, 'LinkedIn');
    assert.equal(r.sales.action.sentVia, 'Sales Navigator');
    const fallback = await run({ nativeFails: true, spendInMail: true });
    assert.equal(fallback.native.action.sentVia, 'Sales Navigator');
    const failed = await run({ nativeFails: true, salesFails: true });
    assert.equal(failed.native.ok, false);
    assert.equal(failed.sales.ok, false);
    assert.equal(failed.native.action, undefined);
  });
}

test('local and cloud writeback retain actual route; unknown and skipped sends stay blank', () => {
  for (const sentVia of ['LinkedIn', 'Sales Navigator']) {
    const data = buildSheetDataForAction({ action: 'op_message_sent', mode: 'open_profile_only', sentVia });
    assert.equal(data.sentVia, sentVia);
    assert.equal(cloudLeadToLocalSheetData('open_profile_only', { status: 'sent', stage: 'OP Msg', sentVia }).sentVia, sentVia);
    assert.equal(buildTracking({ stage: 'OP Msg', sent_via: sentVia }, {}, 'open_profile_only').sentVia, sentVia);
  }
  for (const action of ['already_processed', 'connection_sent', 'skipped']) {
    assert.equal(buildSheetDataForAction({ action, mode: 'open_profile_only', sentVia: 'LinkedIn' }).sentVia, undefined);
  }
  assert.equal(buildSheetDataForAction({ action: 'op_message_sent', mode: 'open_profile_only' }).sentVia, undefined);
});

test('bridge appends Sent via once, preserves historical cells, and stamps the correct row', () => {
  const ctx = { console }; vm.createContext(ctx); vm.runInContext(read('google-apps-script.js'), ctx);
  const headers = ['Name']; const grid = [headers.slice(), ['Old lead'], ['New lead']];
  const sheet = { getMaxColumns: () => 5, getRange(row,col) { return {
    setValue(v) { grid[row-1][col-1]=v; return this; }, setFontWeight() { return this; }
  }; }};
  ctx.writeFields(sheet, headers, 3, { sentVia: 'Sales Navigator' }, true);
  assert.deepEqual(grid, [['Name','Sent via'],['Old lead'],['New lead','Sales Navigator']]);
  ctx.writeFields(sheet, headers, 3, { sentVia: 'Sales Navigator' }, true);
  assert.equal(headers.length, 2);
  ctx.writeFields(sheet, headers, 2, {}, true);
  assert.equal(grid[1][1], undefined);
  for (const mode of ['message_only','open_profile_only','inmail_only']) {
    assert.ok(ctx.MODE_COLUMNS_V2[mode].includes('Sent via'));
    assert.ok(ctx.MODE_TRACKING_COLUMNS[mode].includes('Sent via'));
  }
});
