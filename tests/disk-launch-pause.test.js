import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDiskSpaceError } from '../src/disk-check.js';
import { campaign, pauseForDiskSpaceError, resumeCampaign } from '../src/campaign.js';

test('recognises low disk failures without confusing login or network errors', () => {
  assert.equal(isDiskSpaceError(new Error('Disk space too low (363 MB free, 1.1 GB required)')), true);
  assert.equal(isDiskSpaceError({ code: 'ENOSPC' }), true);
  assert.equal(isDiskSpaceError(new Error('no space left on device')), true);
  assert.equal(isDiskSpaceError(new Error('GoLogin API 401')), false);
  assert.equal(isDiskSpaceError(new Error('Network timeout')), false);
});

test('low disk pauses once, leaves account outcomes alone, and allows explicit resume', () => {
  const keys = ['running', '_paused', '_pauseRequested', '_pauseSnapshot', 'logs'];
  const saved = Object.fromEntries(keys.map(k => [k, campaign[k]]));
  try {
    campaign.running = true;
    campaign._paused = false;
    campaign._pauseRequested = false;
    campaign.logs = [];
    assert.equal(pauseForDiskSpaceError(new Error('GoLogin API 401')), false);
    assert.equal(campaign._pauseRequested, false);
    const error = new Error('Disk space too low (363 MB free, 1.1 GB required)');
    assert.equal(pauseForDiskSpaceError(error), true);
    assert.equal(campaign._pauseRequested, true);
    const count = campaign.logs.length;
    pauseForDiskSpaceError(error);
    assert.equal(campaign.logs.length, count);
    assert.ok(campaign.logs.some(line => String(line).includes('CAMPAIGN PAUSED')));
    resumeCampaign();
    assert.equal(campaign._pauseRequested, false);
    assert.equal(campaign._paused, false);
  } finally { Object.assign(campaign, saved); }
});
