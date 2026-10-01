import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {verifyLinkedInLogin} from '../src/linkedin/login-session.js';
function page({url='https://www.linkedin.com/feed/',cookie='JSESSIONID="ajax:test"',ok=true,redirected=false,data={miniProfile:{entityUrn:'urn:li:fs_miniProfile:abc'}},throws=false}={}) {
  return {url:()=>url,evaluate:fn=>vm.runInNewContext(`(${fn.toString()})()`,{document:{cookie},AbortSignal,fetch:async(_url,opts)=>{assert.equal(opts.cache,'no-store');assert.equal(opts.credentials,'include');if(throws)throw Error('offline');return {ok,redirected,json:async()=>data};}})};
}
test('fresh authenticated LinkedIn identity confirms login',async()=>assert.equal(await verifyLinkedInLogin(page()),true));
for(const opts of [{ok:false},{redirected:true},{data:{}},{cookie:''},{throws:true},{url:'https://www.linkedin.com/checkpoint/challenge'},{url:'https://linkedin.com.evil.test/feed/'},{url:'https://www.linkedin.com/login'}]) {
  test(`does not confirm login from ${JSON.stringify(opts)}`,async()=>assert.equal(await verifyLinkedInLogin(page(opts)),false));
}
