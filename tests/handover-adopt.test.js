// The case the whole handover spec was asked for: a campaign that has SENT
// everything and is only being checked for acceptances, moved onto the
// operator's Mac. Routing that through startCampaign does not work — 0 targets,
// nobody sent, transitionToMonitoring drops it to 'done' — so it must be adopted
// straight into local monitoring instead.
//
// ORTUS_DATA_DIR is redirected before campaign.js is imported so
// writeMonitoringState writes into a temp dir, never the repo's tracked
// data/monitoring-campaign.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoverTarget, handoverTargetForCampaign } from '../src/handover.js';

process.env.ORTUS_DATA_DIR = await mkdtemp(join(tmpdir(), 'ortus-handover-'));
const { adoptMonitoring, getCampaignStatus, stopMonitoringWatcher } = await import('../src/campaign.js');

test('a send-complete campaign routes to the adopt path, never to startCampaign', () => {
  // Fails the moment someone routes on the status string, or bypasses the adopt
  // path and lets a send-complete campaign fall through to startCampaign.
  assert.equal(handoverTarget([
    { leadUrl: 'https://a', status: 'sent' },
    { leadUrl: 'https://b', status: 'failed' },
  ]), 'monitor');
});

test('a campaign moved mid-send still sends here', () => {
  assert.equal(handoverTarget([
    { leadUrl: 'https://a', status: 'sent' },
    { leadUrl: 'https://b', status: 'pending' },
  ]), 'send');
  assert.equal(handoverTarget([{ leadUrl: 'https://c', status: 'in_progress' }]), 'send',
    'the in-flight lead is retried here, so it is still work to do');
});

test('a monitoring campaign never restarts sending just because pending leads remain', () => {
  assert.equal(handoverTargetForCampaign('monitoring', [
    { leadUrl: 'https://a', status: 'sent' },
    { leadUrl: 'https://b', status: 'pending' },
  ]), 'monitor');
  assert.equal(handoverTargetForCampaign('running', [
    { leadUrl: 'https://b', status: 'pending' },
  ]), 'send');
});

test('adopting a send-complete campaign lands it in local monitoring, not done', async (t) => {
  t.after(() => stopMonitoringWatcher());
  const until = new Date(Date.now() + 3 * 86400000).toISOString();
  const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const timersBefore = timers();
  const r = await adoptMonitoring({
    id: 'cloud-1',
    name: 'moved campaign',
    mode: 'connect_and_introduce',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit',
    linkedinColumn: 'LinkedIn URL',
    profileIds: ['p1'],
    profileNames: ['Anna'],
    participatingProfileIds: ['p1'],
    monitoringUntil: until,
    templates: { primaryName: 'Sam' },
    checkIntervalMinutes: 120,
    totalTargets: 199,
    totalProcessed: 23,
    emptyCheckStreak: 5,           // the VM's backoff must NOT come along
  });
  assert.equal(r.ok, true);
  // Basics preserves the monitoring snapshot for manual checks without starting
  // the legacy automatic watcher.
  assert.equal(timers(), timersBefore, 'Basics must not arm an automatic monitoring watcher');

  const s = getCampaignStatus();
  assert.equal(s.state, 'monitoring', 'a moved check-only campaign must monitor here, never land on done');
  assert.equal(s.emptyCheckStreak, 0, 'the adaptive backoff re-earns itself on every switch');
  assert.equal(s.checkIntervalBaseMinutes, 120, "the operator's own interval survives the move");
  assert.equal(s.checkIntervalMinutes, 120, 'streak 0 means the effective cadence is the base one');
  assert.equal(s.monitoringUntil, until, 'the 7-day window belongs to the campaign, not to the side running it');
  assert.equal(s.totalTargets, 199, 'the VM lead ledger survives the move');
  assert.equal(s.totalProcessed, 23, 'the paused card keeps its real progress');
  const adoptionLog = s.logs.find((line) => line.includes('Monitoring moved to this Mac')) || '';
  assert.match(adoptionLog, /checks every 120 min · monitoring ends /);
  assert.doesNotMatch(adoptionLog, /adopted on this Mac|ends 20\d\d-\d\d-\d\dT/,
    'the operator log must use readable local dates, never backend ISO wording');
  // The event says what happened; the schedule follows in the one sentence
  // every writer on both machines uses, so the newest line is always the same
  // shape and one banner rule understands it (operator, 2026-08-28: three cards
  // in the identical state read three different headlines).
  const scheduleLog = s.logs[s.logs.length - 1] || '';
  assert.match(scheduleLog, /⏱ Next check \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · nothing happens until then, the campaign stays running\.$/,
    'the schedule line closes the handover, in the shared wording');
  const nextIn = (Date.parse(s.nextCheckAt) - Date.now()) / 60000;
  assert.ok(nextIn > 115 && nextIn <= 121, `next check is one base interval from now, got ${nextIn} min`);

  // The watcher can only tick off the persisted slice after a restart, so the
  // adopt has to leave one behind.
  const slice = JSON.parse(await readFile(join(process.env.ORTUS_DATA_DIR, 'monitoring-campaign.json'), 'utf8'));
  assert.equal(slice.state, 'monitoring');
  assert.equal(slice.emptyCheckStreak, 0);
  assert.equal(slice.participatingProfileIds[0], 'p1');
});
