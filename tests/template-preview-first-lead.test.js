import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {personalizeTemplate,findUnresolvedPlaceholders} from '../src/linkedin/helpers.js';
import {withGid} from '../src/utils.js';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf("app.post('/api/templates/preview'");
const route=source.slice(start,source.indexOf('\n});',start)+4);
async function preview(body,rows) {
 let handler,result,fetched;
 vm.runInNewContext(route,{app:{post:(_p,h)=>handler=h},console,personalizeTemplate,findUnresolvedPlaceholders,withGid,fetchSheet:async url=>{fetched=url;return rows;},fetchSoOData:async()=>({accounts:[{email:'sender@example.com',firstName:'Sam'}]}),extractLinkedInUrl:row=>row.URL||''});
 await handler({body},{status(){return this;},json(value){result=value;}});
 return {result,fetched};
}
const rows=[{URL:'https://linkedin.com/in/alice',firstName:'Alice',Sender:'sender@example.com','Priority (Company)':'High'},{URL:'https://linkedin.com/in/bob',firstName:'Bob'}];
for(const [mode,templates,previewFields,expected] of [
 ['open_profile_only',{openProfileSubject:'Hi {firstName}',openProfileBody:'Priority: {priority(Company)}'},['opProfileSubject','opProfileBody'],['Hi Alice','Priority: High']],
 ['connect_and_introduce',{primaryName:'Alex Smith',primaryIntroBody:'Hi {firstName}, meet {primaryFullName}'},['primaryIntroBody'],['Hi Alice, meet Alex Smith']],
 ['introduce_back',{primaryIntroBody:'Hi {firstName}, from {senderFirstName}'},['primaryIntroBody'],['Hi Alice, from Sam']],
 ['connect_only',{connectionNote:'Hi {firstName}'},['connectionNote'],['Hi Alice']],
 ['message_only',{followUp1:'Hi {firstName}'},['followUpMessage'],['Hi Alice']],
 ['inmail_only',{inmailSubject:'Hello {firstName}',inmailBody:'Hi'},['inmailSubject','inmailBody'],['Hello Alice','Hi']],
 ['connect_and_message',{ccDmBody:'Hi {firstName}'},['ccDmBody'],['Hi Alice']],
 ['connect_and_introduce',{followUpBody:'Following up, {firstName}'},['followUpBody'],['Following up, Alice']],
]) test(`${mode}: first-lead preview resolves selected templates`,async()=>{
 const {result,fetched}=await preview({mode,templates:{...templates,inmailBody:templates.inmailBody||'Hidden {missing}'},previewFields,previewLimit:1,sheetUrl:'https://docs.google.com/spreadsheets/d/test/edit#gid=1',sheetGid:'42'},rows);
 assert.equal(result.previews.length,1);assert.match(fetched,/gid=42/);
 assert.deepEqual(previewFields.map(key=>result.previews[0].rendered[key]),expected);
 assert.equal(result.previews[0].warnings.length,0);
});
test('missing variables are visible, empty sheets and fetch failures are readable',async()=>{
 const body={templates:{openProfileBody:'Hello {unknown}'},previewLimit:1,sheetUrl:'https://docs.google.com/spreadsheets/d/test/edit'};
 const {result}=await preview(body,rows);assert.match(result.previews[0].warnings[0],/unknown/);
 assert.equal((await preview(body,[])).result.previews.length,0);
});
