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
test('desktop signs only the exact gateway, tries approved credentials only on 401, and never sends raw tokens',async t=>{
 const {sheetsFetch}=await import('../src/sheets-gateway-client.js');
 const {SHEETS_GATEWAY_URL}=await import('../src/sheets-webapp-url.js');
 const original=globalThis.fetch;const old=process.env.GOLOGIN_API_TOKEN;const oldLV=process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY;
 t.after(()=>{globalThis.fetch=original;if(old===undefined)delete process.env.GOLOGIN_API_TOKEN;else process.env.GOLOGIN_API_TOKEN=old;if(oldLV===undefined)delete process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY;else process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY=oldLV;});
 process.env.GOLOGIN_API_TOKEN='first-test-token';process.env.GOLOGIN_API_TOKEN_LINKEDVELOCITY='second-test-token';
 let calls=0;const body='{"action":"listTabs"}';
 globalThis.fetch=async(url,opts)=>{calls++;assert.equal(String(url),SHEETS_GATEWAY_URL);assert.equal(opts.redirect,'error');assert.doesNotMatch(JSON.stringify(opts),/first-test-token|second-test-token/);const token=calls===1?'first-test-token':'second-test-token';assert.ok(verifyRequest([workspaceKey(token)],opts.headers,body));return {status:calls===1?401:200};};
 assert.equal((await sheetsFetch(SHEETS_GATEWAY_URL,{method:'POST',body})).status,200);assert.equal(calls,2);
 calls=0;globalThis.fetch=async()=>{calls++;return {status:502}};await sheetsFetch(SHEETS_GATEWAY_URL,{method:'POST',body});assert.equal(calls,1);
 globalThis.fetch=async(url,opts)=>{assert.equal(opts.headers,undefined);return {status:200}};await sheetsFetch('https://example.com',{method:'POST',body});
});


test('an approved token saved under Other workspaces can authorize sheet writes', async t => {
  const { sheetsFetch } = await import('../src/sheets-gateway-client.js');
  const { setCustomAccounts, GL_ACCOUNTS } = await import('../src/gologin-accounts.js');
  const { SHEETS_GATEWAY_URL } = await import('../src/sheets-webapp-url.js');
  const originalFetch = globalThis.fetch;
  const envName = 'GOLOGIN_API_TOKEN_OTHER_TEST';
  const saved = new Map([...GL_ACCOUNTS.map(a => a.env), envName].map(name => [name, process.env[name]]));
  t.after(() => {
    globalThis.fetch = originalFetch;
    setCustomAccounts([]);
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  for (const account of GL_ACCOUNTS) delete process.env[account.env];
  process.env[envName] = 'approved-custom-workspace-test';
  setCustomAccounts([{ id: 'other-test', label: 'Team workspace', env: envName }]);
  const approved = workspaceKey(process.env[envName]);
  const body = JSON.stringify({ action: 'updateRows', sheetId: 'test', rows: [] });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert.equal(url, SHEETS_GATEWAY_URL);
    assert.ok(verifyRequest([approved], options.headers, body));
    assert.doesNotMatch(JSON.stringify(options), /approved-custom-workspace-test/);
    return { status: 200 };
  };
  assert.equal((await sheetsFetch(SHEETS_GATEWAY_URL, { method: 'POST', body })).status, 200);
  assert.equal(calls, 1);
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
