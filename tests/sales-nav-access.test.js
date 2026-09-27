import { dailyCountText, batchCountText, dailyResetText } from '../public/js/campaign-counters.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createSalesNavAccessStore, isSalesNavSubscriptionGate, salesNavChannel } from '../src/linkedin/sales-nav-access.js';
const gate = 'https://www.linkedin.com/premium/products/?upsellOrderOrigin=guest_login_sales_nav&utype=sales_ss';

test('only explicit Sales Navigator subscription pages flag a missing licence', () => {
  assert.equal(isSalesNavSubscriptionGate(gate), true);
  for (const url of ['https://www.linkedin.com/login', 'https://www.linkedin.com/checkpoint/challenge', 'https://www.linkedin.com/premium/products/?utype=job', 'https://www.linkedin.com/sales/lead/ACwAA1234567890', 'https://example.com/premium/products/?utype=sales_ss']) assert.equal(isSalesNavSubscriptionGate(url), false, url);
});

test('profile restrictions survive reload, stay isolated, and allow an explicit retry', () => {
  const dir=mkdtempSync(join(tmpdir(),'ortus-access-test-'));
  try {
    const path=join(dir,'access.json');const first=createSalesNavAccessStore(path);
    first.set('one','unavailable');
    const reload=createSalesNavAccessStore(path);
    assert.equal(reload.get('one').status,'unavailable');assert.equal(reload.get('two'),null);
    assert.equal(salesNavChannel('sn_first',reload.get('one')),'ln_only');
    assert.equal(salesNavChannel('ln_first',reload.get('one')),'ln_only');
    assert.equal(salesNavChannel('sn_only',reload.get('one')),'unavailable');
    reload.set('one','retry_pending');assert.equal(salesNavChannel('sn_first',first.get('one')),'sn_first');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

for (const file of ['src/linkedin/outreach.js','engine/campaign-lib/linkedin/outreach.js']) {
  const src=readFileSync(new URL('../'+file,import.meta.url),'utf8');
  const fn=src.slice(src.indexOf('export async function performOutreach')).replace('export async function performOutreach','async function actualOutreach');
  test(`${file}: redirect during DOM settling falls back once and remembers the account`,async () => {
    let current='';let saved=null;let fallbacks=0;
    const ctx={ console:{log(){},warn(){}},
      SALES_NAV_URL_RE:/\/sales\/(people|lead)\//, IN_MEMBER_URN_RE:/\/in\/(AC[A-Za-z0-9_-]{10,})(?:[/?#]|$)/,
      SALES_MEMBER_URN_RE:/\/sales\/(?:lead|people)\/(AC[A-Za-z0-9_-]{10,})(?:[,/?#]|$)/,
      LEGACY_SALES_NAV_RE:/\/sales\/profile\//,
      getSalesNavAccess:()=>saved, setSalesNavAccess:(_id,status)=>{saved={status};},salesNavChannel,
      detectSalesNavSubscriptionGate:async()=>isSalesNavSubscriptionGate(current),
      waitForDomSettle:async()=>{current=gate;throw Error('Execution context was destroyed');},
      performOutreach:async(_page,_url,templates,state)=>{fallbacks++;assert.equal(templates.opChannel,'ln_only');assert.equal(state.skipNavigation,false);return {action:'message_sent',sentVia:'LinkedIn'};},
    };
    vm.createContext(ctx);vm.runInContext(fn,ctx);
    const page={url:()=>current,goto:async url=>{current=url;},cookies:async()=>[{name:'li_at',expires:-1}]};
    const r=await ctx.actualOutreach(page,'https://www.linkedin.com/in/ACwAA1234567890',{opChannel:'sn_first',openProfileBody:'Hello'},{profileId:'one'},'force_open_profile');
    assert.equal(r.sentVia,'LinkedIn');assert.equal(saved.status,'unavailable');assert.equal(fallbacks,1);
    const only=await ctx.actualOutreach(page,'https://www.linkedin.com/in/ACwAA1234567890',{opChannel:'sn_only'},{profileId:'one'},'force_open_profile');
    assert.match(only.error,/SALES_NAV_UNAVAILABLE/);assert.equal(fallbacks,1);
  });
}

test('account drawer offers a Sales Navigator retry without benching LinkedIn', () => {
  const src=readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8');
  const start=src.indexOf('function _stageDrawerHtml(');
  const end=src.indexOf('\n}\n',start)+2;
  const ctx={dailyCountText,batchCountText,dailyResetText,escHtml:String,_acctLabel:a=>a.email};vm.createContext(ctx);vm.runInContext(src.slice(start,end),ctx);
  const account={profileId:'abc',email:'test@example.com',dailyLimit:75,salesNavAccess:{status:'unavailable'}};
  const html=ctx._stageDrawerHtml('local-active',account,false,false,'',false);
  assert.match(html,/No Sales Navigator licence/);assert.match(html,/Retry Sales Navigator/);
  assert.match(html,/retrySalesNavAccess\('abc'/);assert.match(html,/LinkedIn remains available/);
  assert.doesNotMatch(html,/>benched</);
  account.salesNavAccess.status='retry_pending';
  const pending=ctx._stageDrawerHtml('local-active',account,false,false,'',false);
  assert.match(pending,/checked on the next eligible message/);assert.doesNotMatch(pending,/Retry Sales Navigator/);
});
