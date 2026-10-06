import { appFunction } from './helpers/app-source.js';
// Screen recording 2026-08-27 17:18: pressing Open on the stopped VM campaign
// "CC+IC TOAST TEST" showed TEST_24/08_CC+IC_A's live status card instead —
// the campaign that had been handed to this Mac and was monitoring. pollStatus
// repaints the shared #active-card every 2s on every route with the LOCAL
// status and never asked which campaign the operator was viewing.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(fileURLToPath(new URL('../public/js/app.js', import.meta.url)), 'utf8');
function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in app.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
const accepts = new Function(`${lift('activeCardAcceptsStatus')}; return activeCardAcceptsStatus;`)();

test('a poller carrying another campaign cannot repaint the viewed card', () => {
  assert.equal(accepts('cmp_toast', 'cmp_24_08'), false);
});

test('the viewed campaign still paints its own status', () => {
  assert.equal(accepts('cmp_toast', 'cmp_toast'), true);
});

test('a campaign adopted by this Mac keeps painting under its cloud id', () => {
  // src/campaign.js:6428 reports the adopted cloud id, not the local singleton.
  assert.equal(accepts('cmp_adopted', 'cmp_adopted'), true);
});

test('nothing is blocked when either side is unidentified', () => {
  assert.equal(accepts('', 'cmp_24_08'), true, 'no campaign is being viewed');
  assert.equal(accepts('cmp_toast', ''), true, 'clearing the card still works');
  assert.equal(accepts(null, null), true);
});

test('legacy Open delegates to the local campaign editor', async () => {
  const open = new Function('openCampaignForEdit', 'return async ' + appFunction('openRunningCampaignReadOnly'))((id) => ({ opened: id }));
  assert.deepEqual(await open('campaign-a'), { opened: 'campaign-a' });
});

test('binding paints the selected local snapshot before polling', () => {
  const bind = appFunction('_bindLiveStatusToCampaign');
  const renderAt = bind.indexOf('renderActiveCard(_viewingLocalCampaign.status)');
  const fetchAt = bind.indexOf('pollStatus()');
  assert.ok(renderAt >= 0 && fetchAt > renderAt);
  assert.ok(bind.includes('_cloud: false'));
  assert.ok(!bind.includes('_refreshCloudActiveStatus('));
});
