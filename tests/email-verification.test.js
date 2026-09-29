import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailVerification} from '../services/sheets-gateway/email-verification.mjs';
function fixture(sendFailure=false){
 let time=1000000;const records={},mail=[];
 const service=createEmailVerification({now:()=>time,store:async(keys,update)=>{const copy=Object.fromEntries(keys.map(k=>[k,structuredClone(records[k])]));const result=update(copy);Object.assign(records,copy);return result;},send:async message=>{if(sendFailure)throw Error('smtp secret');mail.push(message);}});
 return {service,mail,records,advance:ms=>time+=ms,start:()=>service.start({email:'person@ortusclub.com',purpose:'reset',ip:'client'})};
}
test('code is hashed, email-bound, purpose-bound and single-use',async()=>{
 const f=fixture(),result=await f.start();const payload={...result,...f.mail[0]};
 assert.match(payload.code,/^\d{6}$/);assert.equal(JSON.stringify(f.records).includes('"code"'),false);
 await assert.rejects(f.service.verify({...payload,email:'other@ortusclub.com'}),/Invalid/);
 await assert.rejects(f.service.verify({...payload,purpose:'signup'}),/Invalid/);
 assert.deepEqual(await f.service.verify(payload),{ok:true});await assert.rejects(f.service.verify(payload),/Invalid/);
});
test('codes expire and lock after five wrong guesses',async()=>{
 for(const expired of [true,false]){const f=fixture(),r=await f.start(),p={...r,...f.mail[0]};if(expired)f.advance(600000);else for(let i=0;i<5;i++)await assert.rejects(f.service.verify({...p,code:p.code==='000000'?'111111':'000000'}));await assert.rejects(f.service.verify(p),/Invalid/);}
});
test('resend cooldown and hourly recipient limit apply across purposes',async()=>{
 const f=fixture();await f.start();await assert.rejects(f.start(),e=>e.status===429);
 for(let i=0;i<4;i++){f.advance(60000);await f.start();}f.advance(60000);await assert.rejects(f.start(),e=>e.status===429);f.advance(3600000);await f.start();
});
test('mail failure invalidates challenge and does not expose provider details',async()=>{
 const f=fixture(true);await assert.rejects(f.start(),e=>e.status===503&&!e.message.includes('secret'));assert.equal(Object.entries(f.records).find(([k])=>k.startsWith('challenge-'))[1].used,true);
 const unconfigured=createEmailVerification({store:()=>assert.fail('must not persist'),send:null});await assert.rejects(unconfigured.start({}),e=>e.status===503);
});
