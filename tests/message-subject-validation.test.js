import {test} from 'node:test';
import assert from 'node:assert/strict';
import {messageSubjectError} from '../public/js/message-subject-validation.mjs';
for(const opChannel of [undefined,'sn_only','sn_first','ln_first']) {
  test(`Sales Navigator route ${opChannel} requires subject`,()=>{
    for(const subject of [undefined,'','  ']) assert.match(messageSubjectError({mode:'open_profile_only',templates:{opChannel,openProfileSubject:subject}}),/subject/);
    assert.equal(messageSubjectError({mode:'open_profile_only',templates:{opChannel,openProfileSubject:'Invitation'}}),'');
  });
}
test('LinkedIn only and unrelated campaigns do not require OP subject',()=>{
  assert.equal(messageSubjectError({mode:'open_profile_only',templates:{opChannel:'ln_only'}}),'');
  for(const mode of ['introduce_back','connect_and_introduce','connect_only','message_only']) assert.equal(messageSubjectError({mode}),'');
});
test('connection campaign OP Sales Nav fallback also requires subject',()=>assert.match(messageSubjectError({mode:'connect_only',messageOpenProfiles:true}),/subject/));
// Exercise the actual entry guards without launching a browser or reading a sheet.
import fs from 'node:fs';
import vm from 'node:vm';
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
for(const marker of ['async function handleStartCloud(req, res) {', "app.post('/api/campaign/start', async (req, res) => {", "app.post('/api/campaign/queue-only', async (req, res) => {"]) {
 test(`${marker}: rejects missing subject before any campaign work`,async()=>{
   const start=server.indexOf(marker)+marker.length;
   const end=server.indexOf('launchRejected:true});',start)+'launchRejected:true});'.length;
   const guard=vm.runInNewContext(`(async (req,res)=>{${server.slice(start,end)} } catch(e){throw e;} })`,{messageSubjectError});
   let status,payload;
   await guard({body:{mode:'open_profile_only',templates:{}}},{status(n){status=n;return this;},json(value){payload=value;}});
   assert.equal(status,400);assert.equal(payload.launchRejected,true);assert.match(payload.error,/subject/);
 });
}
