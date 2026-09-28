import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkspaceCredential, getWorkspaceVerification } from '../src/gologin-credential-check.js';
process.env.GOLOGIN_API_TOKEN='synthetic-test-token';
test('valid token, including empty workspace, reports count without returning tokens',async()=>{
  for(const count of [0,23]) {
    const r=await checkWorkspaceCredential('ortus',{fetchImpl:async(_url,options)=>{
      assert.equal(options.headers.Authorization,'Bearer synthetic-test-token');
      return {ok:true,status:200,json:async()=>({profiles:[],allProfilesCount:count})};
    }});
    assert.equal(r.ok,true);assert.equal(r.profileCount,count);assert.ok(!JSON.stringify(r).includes('synthetic-test-token'));
  }
});
test('rejected token, throttling, malformed response, and timeout report explicit failure',async()=>{
  for(const [status,pattern] of [[401,/rejected/],[403,/rejected/],[429,/rate limiting/],[500,/HTTP 500/]]) {
    const r=await checkWorkspaceCredential('ortus',{fetchImpl:async()=>({ok:false,status})});assert.equal(r.ok,false);assert.match(r.error,pattern);
  }
  const malformed=await checkWorkspaceCredential('ortus',{fetchImpl:async()=>({ok:true,json:async()=>({})})});assert.equal(malformed.ok,false);
  const timeout=await checkWorkspaceCredential('ortus',{fetchImpl:async()=>{throw Object.assign(Error('sensitive upstream data'),{name:'TimeoutError'});}});assert.match(timeout.error,/12 seconds/);assert.ok(!timeout.error.includes('sensitive'));
});

test('a displayed verdict never survives replacing the token with a different one',async()=>{
 process.env.GOLOGIN_API_TOKEN='synthetic-verdict-one';
 await checkWorkspaceCredential('ortus',{fetchImpl:async()=>({ok:false,status:401})});
 assert.equal(getWorkspaceVerification('ortus').ok,false);
 process.env.GOLOGIN_API_TOKEN='synthetic-verdict-two';
 assert.equal(getWorkspaceVerification('ortus'),null);
});
