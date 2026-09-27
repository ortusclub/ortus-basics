import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignTitle } from '../public/js/campaign-title.mjs';
test('loaded unnamed campaigns get a real label, including stopped and running cards', () => {
  for (const running of [true,false]) assert.equal(campaignTitle({mode:'open_profile_only',name:'',running}),'Message campaign');
  assert.equal(campaignTitle({name:'My event',_loadingIdentity:true}),'My event');
  assert.equal(campaignTitle({_loadingIdentity:true}),'Loading campaign…');
});
