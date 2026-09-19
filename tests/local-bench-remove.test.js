import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.ORTUS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ortus-bench-remove-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { campaign, setProfileSkip, removeProfileFromCampaign, getCampaignStatus } = await import('../src/campaign.js');
const { saveConfig, getConfigById } = await import('../src/campaign-configs.js');

function seed() {
  const saved = saveConfig('Bench Test', { profileIds: ['a', 'b', 'c'], mode: 'connect_only' });
  Object.assign(campaign, { campaignId: saved.campaignId, profileIds: ['a', 'b', 'c'], profileNames: ['a@x', 'b@x', 'c@x'],
    parkedProfiles: [], profileEndReasons: [], running: false });
  campaign._skippedProfiles = new Set();
  campaign._removedProfiles = new Set();
  return saved.campaignId;
}

test('an account can be benched mid-campaign and brought back', () => {
  seed();
  assert.deepEqual(setProfileSkip('b', true).skipped, ['b']);
  assert.deepEqual(setProfileSkip('b', false).skipped, []);
});

test('removing an account drops it from the panel and from the saved campaign settings', () => {
  const id = seed();
  const r = removeProfileFromCampaign('b');
  assert.equal(r.ok, true);
  assert.equal(r.profileName, 'b@x');
  assert.ok(campaign._skippedProfiles.has('b'));
  assert.deepEqual(getConfigById(id).config.profileIds, ['a', 'c']);
  const panel = getCampaignStatus().accountPanel || [];
  assert.ok(!panel.some((a) => a.email === 'b@x'));
});

test('the last sending account cannot be removed', () => {
  seed();
  setProfileSkip('a', true);
  assert.equal(removeProfileFromCampaign('b').ok, true);
  const last = removeProfileFromCampaign('c');
  assert.equal(last.ok, false);
  assert.match(last.reason, /last sending account/);
});
