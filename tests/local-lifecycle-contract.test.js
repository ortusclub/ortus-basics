import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignLifecycle, withCampaignLifecycle, sameCampaign, campaignActionSpecs } from '../public/js/campaign-lifecycle.mjs';
import { vjCardControlsFor } from '../public/js/vjcard.mjs';
const scenarios = [
  [{ state: 'draft' }, 'draft', ['start','queue','duplicate','delete','open']],
  [{ running: true }, 'running', ['pause','stop','duplicate','open']],
  [{ running: true, paused: true }, 'paused', ['resume','stop','duplicate','open']],
  [{ bucket: 'running', paused: true }, 'paused', ['resume','stop','duplicate','open']],
  [{ state: 'interrupted', paused: true, stopReason: 'campaign-stop-timeout' }, 'stopped', ['resume','restart','duplicate','delete','open']],
  [{ running: false, fullStop: true, monitoring: true }, 'stopped', ['resume','restart','duplicate','delete','open']],
  [{ state: 'monitoring', paused: true }, 'monitoring', ['check','stop','duplicate','open']],
  [{ state: 'waiting_daily_reset', running: true }, 'waiting', ['stop','duplicate','open']],
  [{ running: true, _abort: true }, 'stopping', ['open']],
  [{ bucket: 'queued', scheduledAt: '2030-01-01' }, 'scheduled', ['cancel','duplicate','open']],
  [{ state: 'done' }, 'completed', ['duplicate','delete','open']],
];
for (const [input, expected, actions] of scenarios) {
  test(`${expected}: dashboard and detail share status and permitted actions (${JSON.stringify(input)})`, () => {
    const status = { ...input, campaignId: 'permanent-id', id: 'local-active' };
    assert.equal(campaignLifecycle(status).status, expected);
    assert.equal(campaignLifecycle(withCampaignLifecycle(status)).status, expected, 'projection is stable');
    assert.deepEqual(campaignActionSpecs(status).map(a => a.action), actions);
    const controls = vjCardControlsFor(status);
    const handlers = Object.entries(controls).filter(([k,v]) => k !== 'extra' && v?.onclick).map(([,v]) => v.onclick).concat(controls.extra.map(v => v.onclick));
    for (const action of campaignActionSpecs(status)) assert.ok(handlers.includes(action.onclick), action.action);
  });
}
test('IDs isolate identical names and survive renames; name fallback is legacy-only', () => {
  assert.equal(sameCampaign({ campaignId: 'a', name: 'Sam' }, { campaignId: 'b', name: 'Sam' }), false);
  assert.equal(sameCampaign({ campaignId: 'a', name: 'Sam' }, { campaignId: 'a', name: 'Renamed' }), true);
  assert.equal(sameCampaign({ campaignId: 'a', name: 'Sam' }, { name: 'Sam' }), false);
  assert.equal(sameCampaign({ name: ' Sam ' }, { name: 'SAM' }), true);
});
