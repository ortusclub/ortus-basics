import { campaignLifecycle } from '../public/js/campaign-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/js/app.js',import.meta.url),'utf8');
const start=source.indexOf('function localDashboardLifecycle(');
const ctx=vm.createContext({ campaignLifecycle,});
vm.runInContext(source.slice(start,source.indexOf('function unlistedSavedCampaigns',start)),ctx);
test('stop-timeout interruption is stopped, not paused; a genuine pause remains active',()=>{
 const row=ctx.localDashboardLifecycle({state:'interrupted',paused:true,interruption:{reason:'campaign-stop-timeout'}});
 assert.equal(row.bucket,'done');assert.equal(row.badLabel,'Stopped');assert.equal(row.paused,false);
 assert.equal(ctx.localDashboardLifecycle({running:true,paused:true}).bucket,'running');
});
test('interrupted card has Continue, Delete, Duplicate, Open without the rich live card',()=>{
 const a=source.indexOf("} else if (it.where === 'local' && it.interrupted) {");
 const b=source.indexOf('} else if (running && cloud)',a);
 const code=source.slice(a+2,b).replace(/^else /, '');
 const ctx=vm.createContext({ campaignLifecycle,it:{where:'local',interrupted:true,id:'local-active'},foot:'',
  _dib:(_svg,label)=>label+'|',escHtml:s=>s,V3_SVG_PLAY:'',V3_SVG_TRASH:'',V3_SVG_COPY:''});
 vm.runInContext(code+'}',ctx);
 for(const label of ['Continue where it left off','Delete','Duplicate','Open']) assert.ok(ctx.foot.includes(label));
});
