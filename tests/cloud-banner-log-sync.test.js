import { appFunction } from './helpers/app-source.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('legacy cloud refresh binds local status without remote lead requests', async () => {
  const ids = [];
  const refresh = new Function('_bindLiveStatusToCampaign', 'return async ' + appFunction('_refreshCloudActiveStatus'))((id) => ids.push(id));
  await refresh('campaign-a');
  assert.deepEqual(ids, ['campaign-a']);
});

test('a completed monitoring sweep returns to the idle monitoring banner', () => {
  assert.match(app, /const sweepDisposition = monitorSweepDisposition\(status \|\| \{\}\);/);
  assert.match(app, /phase === 'monitoring' && sweepDisposition === 'idle'/);
  assert.match(app, /label: 'Waiting for the next acceptance check'/);
  assert.match(app, /who: ca\.label, l1: ca\.label/);
  assert.match(app, /let logEvent = latestBannerEvent\(status && status\.logs, \{ phase \}\)/);
  assert.match(app, /phase = bannerEventPhase\(logEvent, phase\)/);
  assert.doesNotMatch(app, /canonicalOwned \? null : latestBannerEvent/);
  assert.match(app, /status\.state === 'monitoring' \|\| status\.monitoring \|\| status\.monitoringPhase/);
  assert.match(app, /\|\| \(monitoringIdle \? 'monitoring' : ''\)\s*\|\| \(la && la\.phase\)/);
  assert.match(app, /campaignRow\.monitor_check_status \|\| campaignRow\.monitorCheckStatus/);
  assert.match(app, /const durableSweepCompleted = durableSweepStatus === 'completed';/);
  assert.match(app, /const lp = durableSweepCompleted \? null : \(d && d\.liveProgress\);/);
});
