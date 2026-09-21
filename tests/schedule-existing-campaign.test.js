import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('an opened existing campaign can be scheduled locally — the old clone guard is gone from that path', () => {
  const fn = app.slice(app.indexOf('window.launchScheduleIt = async function'), app.indexOf('// Save as draft — autosave already persisted everything'));
  assert.ok(!/_existingCampaignBlocksNewDispatch\(\)\) return;/.test(fn));
  assert.match(fn, /startCampaign\(\{ queueOnly: true, scheduleCron: result\.cron, scheduleName: result\.name \}\)/);
});

test('a schedule carries the FULL launch and the campaign\'s permanent id', () => {
  const submit = app.slice(app.indexOf('async function submitStartCampaign('), app.indexOf("const url = opts.queueOnly ? '/api/campaign/queue-only'"));
  assert.match(submit, /if \(opts\.scheduleCron\)/);
  assert.match(submit, /campaignId: body\.campaignId/);
  assert.match(submit, /launchBody: body/);
  assert.match(server, /launchBody: \(req\.body\.launchBody && typeof req\.body\.launchBody === 'object'\)/);
});

test('when it fires, a schedule runs that full launch under the same campaign id', () => {
  assert.match(server, /if \(schedule\.launchBody\) \{\s+const fullConfig = buildCampaignConfig\(\{ \.\.\.schedule\.launchBody, campaignId: schedule\.campaignId, name: schedule\.name \}\);/);
});

test('the cron next-run helper handles one-off dates, weekly runs and rubbish', async () => {
  const vm = await import('node:vm');
  const src = app.slice(app.indexOf('function _cronNextRun('), app.indexOf('let _localSchedules = [];'));
  const ctx = vm.createContext({});
  vm.runInContext(src + '\nthis.next = _cronNextRun;', ctx);
  const from = new Date(2026, 8, 21, 12, 0, 0);                    // Mon 21 Sept 2026, 12:00 local
  const at = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].join('-');
  assert.equal(at(ctx.next('0 13 14 10 *', from)), '2026-10-14-13-0');   // one-off date
  assert.equal(at(ctx.next('0 6 * * 6', from)), '2026-9-26-6-0');        // every Saturday 06:00
  assert.equal(at(ctx.next('30 12 * * *', from)), '2026-9-21-12-30');    // later today
  assert.equal(at(ctx.next('0 9 * * 1-5', from)), '2026-9-22-9-0');      // weekdays, tomorrow
  assert.equal(ctx.next('nonsense', from), null);
});

test('the Live Status card says Scheduled (with when) for the campaign open in the editor', () => {
  assert.match(app, /v3SetText\('activeEyebrow', `Scheduled · starts \$\{_when\}/);
  assert.match(app, /v3SetText\('sendingLbl', 'Scheduled'\);/);
});

test('a schedule that comes due while a campaign is running joins the queue instead of failing', () => {
  const fire = server.slice(server.indexOf('// Main fire'), server.indexOf('const status = getCampaignStatus();', server.indexOf('// Main fire')));
  const busy = fire.indexOf('if (campaign.running) {');
  assert.ok(busy > -1 && busy < fire.indexOf('await startCampaign(fullConfig);'), 'the busy check must come before any start');
  assert.match(fire, /await addToQueue\(queuedConfig, schedule\.createdBy \|\| null\);/);
  assert.match(fire, /if \(!campaign\.running\) notify\(\{\s+title: 'Campaign started'/);
});

test('the dashboard has a Scheduled rail, and a scheduled campaign is not repeated under Saved', () => {
  assert.match(app, /Scheduled <span class="sn-railcount">/);
  assert.match(app, /x\.bucket === 'saved' && !\(opts\.scheduledCampaignIds && opts\.scheduledCampaignIds\.has\(x\.campaignId\)\)/);
  assert.match(app, /function renderScheduledStrip\(sch, next, openId\)/);
  assert.match(app, /fetch\('\/api\/schedules\/' \+ encodeURIComponent\(id\), \{ method: 'DELETE' \}\)/);
});
