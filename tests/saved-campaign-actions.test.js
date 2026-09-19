import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../public/js/app.js', import.meta.url),'utf8');
test('saved campaigns offer Start, Delete, Duplicate and Open without resume or run-report actions', () => {
  const start=app.indexOf('function renderSavedCampaignStrip(');
  const ctx=vm.createContext({escHtml:s=>s,V3_SVG_PLAY:'play',V3_SVG_TRASH:'trash',V3_SVG_COPY:'copy'});
  vm.runInContext(app.slice(start,app.indexOf('window.openSavedCampaignStart',start)),ctx);
  const html=ctx.renderSavedCampaignStrip({id:'saved-Sam',name:'Sam'});
  for(const label of ['Start campaign','Delete','Duplicate']) assert.ok(html.includes(`aria-label="${label}"`));
  assert.match(html,/openCampaignForEdit/);
  assert.doesNotMatch(html,/resume|Debrief|Continue where/);
});
test('saved campaign deletion waits for server confirmation before removing the card', async () => {
  const start=app.indexOf('async function deleteBoardCampaign(');
  const events=[];
  const ctx=vm.createContext({
    _boardItemsById:new Map([['saved-Sam',{bucket:'saved',name:'Sam'}]]), _snItemsById:new Map(),
    confirm:()=>true, alert:m=>events.push(m),
    fetch:async(url,opts)=> {events.push([url,opts.method]);return {ok:false,json:async()=>({error:'Still queued'})};},
    refreshKnownCampaignNames:async()=>events.push('refresh'),renderCampaignsBoard:()=>events.push('render'),
  });
  vm.runInContext(app.slice(start,app.indexOf('window.deleteBoardCampaign',start)),ctx);
  await ctx.deleteBoardCampaign('saved-Sam',{closest:()=>({remove:()=>events.push('remove')})});
  assert.deepEqual(events,[['/api/campaign-configs/Sam','DELETE'],'Could not delete: Still queued']);
});
