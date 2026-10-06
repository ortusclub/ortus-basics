import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('VM launch never shows the local singleton monitoring warning', () => {
  const start = app.indexOf('async function startCampaign(opts = {})');
  const end = app.indexOf('const _modeForValidation', start);
  const guard = app.slice(start, end);

  assert.match(guard, /if \(!opts\.queueOnly && !isCloudRunOn\(\)[\s\S]*?__cockpit\.state === 'monitoring'\)/);
  assert.match(guard, /Starting a new campaign will end that monitoring/);
});

test('cloud dispatch and the monitoring guard use the same VM-target predicate', () => {
  assert.match(app, /const _cloudOn = isCloudRunOn\(\);/);
  assert.doesNotMatch(app, /const _cloudModeNow = new Set/);
});
