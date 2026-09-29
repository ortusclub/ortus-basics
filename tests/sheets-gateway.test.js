import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {workspaceKey, signRequest, verifyRequest} from '../src/sheets-gateway-protocol.mjs';
import {createApp} from '../services/sheets-gateway/app.mjs';
const key=workspaceKey('test-workspace-token');
test('signature binds body, timestamp, approved key and nonce',()=>{
 const body='{"action":"listTabs"}';const now=Date.now();const h=signRequest(key,body,now);
 assert.ok(verifyRequest([key],h,body,now));
 assert.equal(verifyRequest([key],h,body+' ',now),null);
 assert.equal(verifyRequest([],h,body,now),null);
 assert.equal(verifyRequest([key],h,body,now+121000),null);
 assert.equal(verifyRequest([key],{...h,'x-ortus-nonce':'bad'},body,now),null);
 assert.notEqual(key.secret,'test-workspace-token');
 assert.equal(readFileSync(new URL('../services/sheets-gateway/protocol.mjs',import.meta.url),'utf8'),readFileSync(new URL('../src/sheets-gateway-protocol.mjs',import.meta.url),'utf8'));
});
test('gateway rejects unsigned, unsupported and replayed requests; forwards valid requests without leaking keys',async t=>{
 const used=new Set();let calls=0;let fail=false;
 const server=createApp({keys:[key],bridgeUrl:'https://script.google.com/macros/s/test/exec?key=PRIVATE',claimNonce:async ({nonce})=>{if(used.has(nonce))return false;used.add(nonce);return true;},forward:async (url,opts)=>{calls++;assert.equal(url.searchParams.get('key'),'PRIVATE');assert.equal(JSON.parse(opts.body).action,'updateRow');return {ok:true,json:async()=>fail?{error:'secret=PRIVATE',stack:'PRIVATE'}:{ok:true,sentVia:'LinkedIn'}};}}).listen(0,'127.0.0.1');
 await once(server,'listening');t.after(()=>server.close());const url=`http://127.0.0.1:${server.address().port}/bridge`;
 const body=JSON.stringify({action:'updateRow',sheetId:'test',sentVia:'LinkedIn'});
 const headers={'Content-Type':'application/json',...signRequest(key,body)};
 assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);assert.equal(calls,0);
 let r=await fetch(url,{method:'POST',headers,body});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,sentVia:'LinkedIn'});
 assert.equal((await fetch(url,{method:'POST',headers,body})).status,409);assert.equal(calls,1);
 const forbidden=JSON.stringify({action:'selfTestBridge'});assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...signRequest(key,forbidden)},body:forbidden})).status,400);
 fail=true;r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...signRequest(key,body)},body});assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/PRIVATE/);
});
test('nonce storage failure never forwards writes',async t=>{
 let called=false;const server=createApp({keys:[key],bridgeUrl:'https://script.google.com/macros/s/test/exec',claimNonce:async()=>{throw Error('down')},forward:async()=>{called=true;}}).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const body='{"action":"listTabs"}';const r=await fetch(`http://127.0.0.1:${server.address().port}/bridge`,{method:'POST',headers:{'Content-Type':'application/json',...signRequest(key,body)},body});assert.equal(r.status,503);assert.equal(called,false);
});
test('desktop Sheets requests do not need or send Google or GoLogin credentials',async t=>{
 const {sheetsFetch}=await import('../src/sheets-gateway-client.js');
 const {SHEETS_GATEWAY_URL}=await import('../src/sheets-webapp-url.js');
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 let calls=0;
 globalThis.fetch=async(url,options)=>{
   calls++;assert.equal(url,SHEETS_GATEWAY_URL);assert.equal(options.redirect,'error');
   assert.equal(options.headers.Authorization,undefined);
   assert.equal(options.headers['x-ortus-signature'],undefined);
   return {status:200};
 };
 assert.equal((await sheetsFetch(SHEETS_GATEWAY_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);
 assert.equal(calls,1);
 await assert.rejects(sheetsFetch(SHEETS_GATEWAY_URL,{method:'POST',body:{}}),/serialized JSON/);
});
test('public access accepts unsigned and stale-auth requests but retains action and upstream checks',async t=>{
 let calls=0,fail=false;
 const server=createApp({publicAccess:true,bridgeUrl:'https://script.google.com/macros/s/test/exec?key=PRIVATE',
 verifyGoogle:async()=>{throw Error('Must not depend on Google');},claimNonce:async()=>{throw Error('Must not depend on GoLogin');},
 forward:async(_url,options)=>{calls++;assert.equal(options.headers.Authorization,undefined);return {ok:true,json:async()=>fail?{error:'PRIVATE',stack:'PRIVATE'}:{ok:true}};}
 }).listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const extra of [{},{Authorization:'Bearer expired'},...['bad'].map(v=>({'x-ortus-signature':v}))]) {
  assert.equal((await fetch(base+'/bridge',{method:'POST',headers:{'Content-Type':'application/json',...extra},body:'{"action":"updateRow"}'})).status,200);
 }
 assert.equal(calls,3);
 assert.equal((await fetch(base+'/auth/me')).status,401);
 for(const body of ['{"action":"selfTestBridge"}','not json']) assert.equal((await fetch(base+'/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,400);
 assert.equal(calls,3);fail=true;
 const r=await fetch(base+'/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"updateRow"}'});
 assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/PRIVATE/);
});

test('a different valid GoLogin token is not implicitly approved by the Sheets gateway', () => {
  const body = JSON.stringify({ action: 'listTabs', sheetId: 'test' });
  const approved = workspaceKey('approved-workspace');
  const other = workspaceKey('another-valid-gologin-token');
  assert.equal(verifyRequest([approved], signRequest(other, body), body), null);
  assert.ok(verifyRequest([approved], signRequest(approved, body), body));
});

test('a computer clock more than two minutes off rejects even an approved token', () => {
  const now = Date.now();
  const body = '{}';
  const approved = workspaceKey('approved-workspace');
  assert.equal(verifyRequest([approved], signRequest(approved, body, now - 121000), body, now), null);
});
