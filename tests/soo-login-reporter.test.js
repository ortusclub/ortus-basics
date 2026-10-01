import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSoOLoginReporter } from '../src/soo-login-reporter.js';
import { markAccountNeedsLoginSoO, clearAccountNeedsLoginSoO, flipAccountInUse, bumpConnectionsThisWeek } from '../src/soo-writer.js';

const source = fs.readFileSync(new URL('../google-apps-script.js',import.meta.url),'utf8');
function board(flag='',headers=['Email','Needs Login','CC (Credits)']) {
  const grid=[headers,['a@example.com',flag,'Available'],['b@example.com','','In Use']];
  let writes=0, locked=false;
  const sheet={getLastRow:()=>grid.length,getLastColumn:()=>headers.length,getRange(r,c,n=1,m=1){return {
    getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>grid[r+i-1][c+j-1])),
    getValue:()=>grid[r-1][c-1],setValue(value){assert.equal(locked,true);grid[r-1][c-1]=value;writes++;}
  };}};
  const ctx=vm.createContext({LockService:{getScriptLock:()=>({waitLock(){locked=true;},releaseLock(){locked=false;}})}});
  vm.runInContext(source,ctx);ctx.jsonResponse=value=>value;
  return {grid,get writes(){return writes;},handle:data=>ctx.handleSetSoO(sheet,data)};
}
const noWait={maxAttempts:2,baseDelayMs:0,sleep:async()=>{}};
for (const mode of ['connect_and_introduce','open_profile_only','introduce_back']) {
  test(`${mode}: logout writes only Needs Login; repeated reports and existing Y do not rewrite`,async t=>{
    const b=board(),payloads=[];
    t.mock.method(globalThis,'fetch',async(_url,opts)=>{const payload=JSON.parse(opts.body);payloads.push(payload);return {ok:true,status:200,json:async()=>b.handle(payload)};});
    const report=createSoOLoginReporter({mode});
    const result=await report(' A@EXAMPLE.COM ');
    assert.equal(result.ok,true);assert.equal(b.writes,1);assert.equal(b.grid[1][1],'Y');
    assert.deepEqual(payloads[0].fields,{'Needs Login':'Y'});
    assert.equal(b.grid[1][2],'Available');assert.equal(b.grid[2][1],'');
    await report('a@example.com');assert.equal(payloads.length,1);
    const nextRun=createSoOLoginReporter({mode});
    assert.equal((await nextRun('a@example.com')).alreadySet,true);
    assert.equal(payloads.length,2);assert.equal(b.writes,1);
  });
}
test('sheet skips trimmed/case-insensitive Y and changes other flags to Y',()=>{
  for(const flag of ['Y',' y ','','N']){
    const b=board(flag);const result=b.handle({email:'A@EXAMPLE.COM',fields:{'Needs Login':'Y'}});
    assert.equal(result.matched,true);assert.equal(b.writes,flag.trim().toUpperCase()==='Y'?0:1);
  }
});
test('missing row or header is reported, not silently marked successful',async t=>{
  const b=board('', ['Email','Other','CC (Credits)']);
  t.mock.method(globalThis,'fetch',async(_url,opts)=>({ok:true,status:200,json:async()=>b.handle(JSON.parse(opts.body))}));
  assert.equal((await markAccountNeedsLoginSoO({email:'missing@example.com'})).ok,false);
  assert.equal((await markAccountNeedsLoginSoO({email:'a@example.com'})).ok,false);
  assert.equal(b.writes,0);
});
test('failed reports remain retryable and concurrent reports share one write',async()=>{
  let calls=0;let finish;const logs=[];
  const report=createSoOLoginReporter({mode:'introduce_back',log:s=>logs.push(s),write:async()=>{calls++;if(calls===1)return {ok:false,error:'offline'};return new Promise(resolve=>{finish=resolve;});}});
  await report('a@example.com');assert.match(logs[0],/offline/);
  const first=report('a@example.com'),second=report('A@EXAMPLE.COM');
  await new Promise(setImmediate);assert.equal(calls,2);finish({ok:true,matched:true,alreadySet:true});await Promise.all([first,second]);
  await report('a@example.com');assert.equal(calls,2);assert.equal(logs.length,1);
});
test('network failures retry login flags but all unrelated SoO writes remain disabled',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('HTTP 503');});
  const result=await markAccountNeedsLoginSoO({email:'a@example.com'},noWait);assert.equal(result.ok,false);assert.equal(calls,2);
  await flipAccountInUse({email:'a@example.com',creditHeader:'CC (Credits)',userHeader:'CC User'});
  await bumpConnectionsThisWeek({email:'a@example.com'});assert.equal(calls,2);
});
test('unsupported modes and blank accounts do not write',async()=>{
  let calls=0;const write=async()=>{calls++;};
  await createSoOLoginReporter({mode:'sales_nav_scrape',write})('a@example.com');
  await createSoOLoginReporter({mode:'open_profile_only',write})('');assert.equal(calls,0);
});
for (const mode of ['connect_and_introduce','open_profile_only','introduce_back']) {
  test(`${mode}: confirmed login clears existing Y and subsequent logout restores it`,async t=>{
    const b=board('Y');
    t.mock.method(globalThis,'fetch',async(_url,opts)=>({ok:true,status:200,json:async()=>b.handle(JSON.parse(opts.body))}));
    const report=createSoOLoginReporter({mode,verify:async()=>true});
    assert.equal((await report.confirmLoggedIn('a@example.com',{})).ok,true);
    assert.equal(b.grid[1][1],'');assert.equal(b.writes,1);
    await report.confirmLoggedIn('a@example.com',{});assert.equal(b.writes,1);
    await report('a@example.com');assert.equal(b.grid[1][1],'Y');assert.equal(b.writes,2);
    await report.confirmLoggedIn('a@example.com',{});assert.equal(b.writes,3);
    assert.equal(b.grid[1][2],'Available');assert.equal(b.grid[2][2],'In Use');
  });
}
test('clearing preserves blank, N and manual notes, but clears trimmed Y',async t=>{
  for (const flag of ['','N','Contact team',' y ']) {
    const b=board(flag);
    const mock=t.mock.method(globalThis,'fetch',async(_url,opts)=>{
      const payload=JSON.parse(opts.body);assert.equal(payload.clearNeedsLoginIfY,true);
      assert.deepEqual(payload.fields,{'Needs Login':''});
      return {ok:true,status:200,json:async()=>b.handle(payload)};
    });
    const result=await clearAccountNeedsLoginSoO({email:'a@example.com'});
    assert.equal(result.ok,true);assert.equal(b.grid[1][1],flag.trim().toUpperCase()==='Y'?'':flag);
    assert.equal(b.writes,flag.trim().toUpperCase()==='Y'?1:0);mock.mock.restore();
  }
});
test('unverified login cannot clear a flag; failed clears can retry',async()=>{
  let calls=0,verified=false;
  const report=createSoOLoginReporter({mode:'introduce_back',verify:async()=>verified,clear:async()=>({ok:++calls>1,matched:true})});
  await report.confirmLoggedIn('a@example.com',{});assert.equal(calls,0);
  verified=true;await report.confirmLoggedIn('a@example.com',{});await report.confirmLoggedIn('a@example.com',{});
  assert.equal(calls,2);
});
test('pending logout, login and logout are written in order',async()=>{
  const events=[];let release;
  const report=createSoOLoginReporter({mode:'open_profile_only',write:async()=>{events.push('Y');if(events.length===1)await new Promise(r=>release=r);return {ok:true,matched:true};},clear:async()=>{events.push('clear');return {ok:true,matched:true};}});
  const a=report('a@example.com'),b=report('a@example.com',false),c=report('a@example.com');
  await new Promise(setImmediate);assert.deepEqual(events,['Y']);release();await Promise.all([a,b,c]);
  assert.deepEqual(events,['Y','clear','Y']);
});
