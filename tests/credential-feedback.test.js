import test from 'node:test';
import assert from 'node:assert/strict';
import { completeCredentialUpdate } from '../public/js/credential-feedback.mjs';
function run(overrides={}) {
  const messages=[];
  const options={save:async()=>({}),verify:async()=>[{label:'Test workspace',ok:true,profileCount:12}],refresh:async()=>({ok:true,count:12}),show:(text,bad)=>messages.push({text,bad}),...overrides};
  return completeCredentialUpdate(options).then(result=>({result,messages,last:messages.at(-1)}));
}
test('successful save ends with confirmed account count and Done',async()=>{
  const {result,last}=await run();assert.equal(result.refreshed,true);assert.equal(last.bad,false);assert.match(last.text,/12 accounts.*Done/);
});
test('rejected token is saved but clearly marked as not verified',async()=>{
  const {result,last}=await run({verify:async()=>[{label:'Test workspace',ok:false,error:'GoLogin rejected this token (401).'}],refresh:async()=>{throw Error('must not refresh');}});
  assert.equal(result.saved,true);assert.equal(result.verified,false);assert.equal(last.bad,true);assert.match(last.text,/Saved.*rejected.*401/);
});
test('a slow or failed roster never leaves a successful-token message stuck on loading',async()=>{
  const {result,last}=await run({refresh:async()=>({ok:false,error:'Timed out after 20 seconds.'})});
  assert.equal(result.verified,true);assert.equal(result.refreshed,false);assert.equal(last.bad,true);assert.match(last.text,/verified.*did not finish.*Timed out/);
});
test('save failure and verification timeout are distinct outcomes',async()=>{
  const failed=await run({save:async()=>{throw Error('Disk full');}});assert.equal(failed.result.saved,false);assert.match(failed.last.text,/Could not save: Disk full/);
  const timed=await run({verify:async()=>{throw Error('Request timed out');}});assert.equal(timed.result.saved,true);assert.equal(timed.result.verified,false);assert.match(timed.last.text,/Saved.*Could not verify.*timed out/);
});
test('partial workspace failure names the failure and the connections that worked',async()=>{
  const {last}=await run({verify:async()=>[{label:'Good workspace',ok:true,profileCount:3},{label:'Bad workspace',ok:false,error:'Token rejected'}]});
  assert.equal(last.bad,true);assert.match(last.text,/Bad workspace.*Token rejected.*Working: Good workspace: 3 accounts/);
});

test('a bad old workspace does not negate a newly verified working token',async()=>{
 const {result,last}=await run({refresh:async()=>({ok:true,count:535,warnings:[{label:'Ortus',error:'Token rejected (401)'}]})});
 assert.equal(result.refreshed,true);assert.match(last.text,/refreshed \(535 accounts\).*Done.*Other workspaces.*Ortus/);
 assert.doesNotMatch(last.text,/did not finish/);
});
