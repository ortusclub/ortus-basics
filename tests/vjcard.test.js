import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusFromItem, vjCardFields, vjCardControlsFor, monitorSweepDisposition } from '../public/js/vjcard.mjs';

// ── statusFromItem ──
test('statusFromItem: cloud monitoring item → monitoring state, cloud flag', () => {
  const s = statusFromItem({ where: 'cloud', id: 'c1', bucket: 'running', monitoring: true, sent: 3, total: 4, accounts: 1, nextCheckAt: 'x', checkIntervalMinutes: 30, autoChecksEnabled: false });
  assert.equal(s._cloud, true);
  assert.equal(s.state, 'monitoring');
  assert.equal(s.running, false);
  assert.equal(s.totalProcessed, 3);
  assert.equal(s.totalTargets, 4);
  assert.equal(s.checkIntervalMinutes, 30);
  assert.equal(s.autoChecksEnabled, false);
});
test('real completed sweep payload survives the board adapter and presents idle monitoring', () => {
  const s = statusFromItem({
    where: 'cloud', runsOn: 'vm', id: 'coll-chi', bucket: 'running', monitoring: true,
    monitorCheckStatus: 'completed', monitorCheckExpected: 3, monitorCheckAccountsChecked: 3,
    monitorCheckId: 'check-123', monitorCheckCurrentAccount: '', monitorCheckHeartbeatAt: '2026-08-27T08:16:00Z',
    monitorCheckStartedAt: '2026-08-27T08:14:00Z', monitorCheckCompletedAt: '2026-08-27T08:16:00Z',
    monitoringCheckInProgress: false,
    logs: ['✓ Benjamin Lombardo · introduced', '✓ Check complete — 0 newly accepted across 3 accounts'],
  });
  assert.equal(s.monitorCheckStatus, 'completed');
  assert.equal(s.monitorCheckExpected, 3);
  assert.equal(s.monitorCheckAccountsChecked, 3);
  assert.equal(s.monitorCheckId, 'check-123');
  assert.equal(s.monitorCheckHeartbeatAt, '2026-08-27T08:16:00Z');
  assert.equal(s.monitoringCheckInProgress, false);
  assert.equal(monitorSweepDisposition(s), 'idle');
  assert.equal(s.logs.length, 2, 'historical lead results remain available in the log');
});
test('running, failed, incomplete and cancelled sweep payloads retain their authoritative lifecycle', () => {
  const base = { where: 'cloud', bucket: 'running', monitoring: true, monitorCheckExpected: 3 };
  const running = statusFromItem({ ...base, monitorCheckStatus: 'running', monitorCheckAccountsChecked: 1,
    monitorCheckCurrentAccount: 'sender@example.com', monitoringCheckInProgress: true });
  assert.equal(monitorSweepDisposition(running), 'running');
  assert.equal(running.monitorCheckAccountsChecked, 1);
  assert.equal(running.monitorCheckCurrentAccount, 'sender@example.com');
  for (const value of ['failed', 'incomplete']) {
    const s = statusFromItem({ ...base, monitorCheckStatus: value, monitorCheckAccountsChecked: 2,
      monitorCheckError: 'sender@example.com needs login', monitorTaskError: 'worker failed' });
    assert.equal(monitorSweepDisposition(s), 'error');
    assert.equal(s.monitorCheckStatus, value);
    assert.equal(s.monitorCheckError, 'sender@example.com needs login');
    assert.equal(s.monitorTaskError, 'worker failed');
  }
  const cancelled = statusFromItem({ ...base, monitorCheckStatus: 'cancelled', monitorCheckAccountsChecked: 1 });
  assert.equal(monitorSweepDisposition(cancelled), 'idle');
});
test('statusFromItem preserves participating accounts and per-card sheet URL', () => {
  const s = statusFromItem({ participatingProfileIds: ['p1', 'p2'], sheet_url: 'https://docs.google.com/x' });
  assert.deepEqual(s.participatingProfileIds, ['p1', 'p2']);
  assert.equal(s.sheetUrl, 'https://docs.google.com/x');
  assert.match(vjCardControlsFor(s).sheet.onclick, /openVjCardSheet/);
});
test('statusFromItem: running local item → running, no state', () => {
  const s = statusFromItem({ where: 'local', id: 'local-active', bucket: 'running', sent: 5, total: 10, accounts: 2, paused: true });
  assert.equal(s._cloud, false);
  assert.equal(s.running, true);
  assert.equal(s.state, undefined);
  assert.equal(s.paused, true);
});

test('statusFromItem: released VM row with no local runtime is interrupted, never fake-waiting', () => {
  const s = statusFromItem({
    where: 'cloud', id: 'c-wait', bucket: 'running', runsOn: 'local',
    handoverAt: 123, waitingForLocal: true, logs: ['campaign stopped locally'],
  });
  assert.equal(s.running, false);
  assert.equal(s.waitingForLocal, true);
  assert.equal(s.state, 'interrupted');
  assert.equal(s.interrupted, true);
  assert.match(s.interruption.title, /Mac became unavailable/);
  assert.equal(vjCardFields(s).eyebrow, 'Stopped · This Mac unavailable');
  assert.match(vjCardControlsFor(s).pause.onclick, /openCampaignResumeDecision/);
  assert.equal(s.runsOn, 'local');
  assert.equal(s.handoverAt, 123);
});
test('statusFromItem: restored local monitoring snapshot keeps the monitoring phase', () => {
  const s = statusFromItem({
    where: 'local', id: 'local-active', bucket: 'running',
    monitoringPhase: true, paused: true, sent: 22, total: 198,
    profileIds: ['a', 'b', 'c'],
  });
  assert.equal(s._cloud, false);
  assert.equal(s.running, false);
  assert.equal(s.paused, false);
  assert.equal(s.state, 'monitoring');
  assert.equal(s.monitoringPhase, true);
  assert.equal(vjCardFields(s).eyebrow, 'Monitoring');
  const activity = vjCardControlsFor(s);
  assert.match(activity.bulk.onclick, /dashRunCheck/);
});
test('statusFromItem: a monitoring row owned by This Mac keeps the monitoring layout', () => {
  const s = statusFromItem({
    where: 'cloud', runsOn: 'local', id: 'c1', bucket: 'running',
    monitoring: false, monitoringPhase: true, paused: true,
    sent: 23, total: 199, profileIds: ['a', 'b', 'c'],
    accountPanel: [{ email: 'a@example.com', state: 'paused' }],
  });
  assert.equal(s._cloud, false, 'ownership, not the durable row origin, selects the control/layout path');
  assert.equal(s.state, 'monitoring');
  assert.equal(s.running, false);
  assert.equal(s.paused, false);
  assert.equal(s.state, 'monitoring');
  assert.equal(s.monitoringPhase, true);
  assert.equal(s.totalProcessed, 23);
  assert.equal(s.totalTargets, 199);
  assert.equal(s.accountPanel.length, 1);
  assert.equal(vjCardFields(s).eyebrow, 'Monitoring');
  assert.match(vjCardControlsFor(s).bulk.onclick, /dashRunCheck/);
});
test('statusFromItem: local monitoring is active waiting, not a paused sending campaign', () => {
  const s = statusFromItem({
    where: 'cloud', runsOn: 'local', id: 'c1', bucket: 'running',
    monitoring: true, sent: 22, total: 198,
  });
  assert.equal(s._cloud, false);
  assert.equal(s.running, false);
  assert.equal(s.state, 'monitoring');
  assert.equal(s.paused, false);
  assert.equal(s.monitoringPhase, true);
  assert.equal(vjCardFields(s).eyebrow, 'Monitoring');
});
test('VM and This Mac produce the same monitoring content contract', () => {
  const shared = {
    id: 'c-parity', bucket: 'running', monitoring: true,
    sent: 46, total: 198, acceptedCount: 1,
    profileIds: ['p1', 'p2', 'p3'], participatingProfileIds: ['p1', 'p2', 'p3'],
    monitoringCheckInProgress: true,
    currentAction: {
      phase: 'checking', label: 'Checking acceptances',
      facts: [['Current account', 'sender@example.com']],
      milestones: [['Request', 'queued', 'done'], ['Browser', 'opening', 'active']],
    },
    logs: ['check started'], accountPanel: [{ email: 'sender@example.com', state: 'working' }],
  };
  const vm = statusFromItem({ ...shared, where: 'cloud', runsOn: 'vm' });
  const lm = statusFromItem({ ...shared, where: 'cloud', runsOn: 'local', monitoringPhase: true });
  assert.deepEqual(vjCardFields(vm), vjCardFields(lm));
  for (const key of ['currentAction', 'logs', 'accountPanel', 'profileIds', 'participatingProfileIds']) {
    assert.deepEqual(vm[key], lm[key], `${key} must be location-independent`);
  }
});
// Regression: statusFromItem is a WHITELIST, so a field the card reads but this
// function drops is silently always-undefined. _fgFinishedNote returns null the
// moment `bucket` is missing, which killed the "ran out of invite credits" line
// on every board card; the pills need benchAccounts and the chip needs dupes.
test('statusFromItem: carries the fields the finished-FG note and dupe chip read', () => {
  const accounts = [{ profileId: 'p1', credits: { available: 0, allowance: 30, refill: 'August 31, 2026' } }];
  const s = statusFromItem({ where: 'cloud', bucket: 'done', isFG: true, benchAccounts: accounts, dupes: 2 });
  assert.equal(s.bucket, 'done');
  assert.deepEqual(s.benchAccounts, accounts);
  assert.equal(s.dupes, 2);
});
test('statusFromItem: absent benchAccounts/dupes are null and 0, never undefined', () => {
  const s = statusFromItem({ where: 'cloud', bucket: 'done' });
  assert.equal(s.benchAccounts, null);
  assert.equal(s.dupes, 0);
});
test('statusFromItem: done + queued map their states', () => {
  assert.equal(statusFromItem({ bucket: 'done' }).state, 'done');
  assert.equal(statusFromItem({ bucket: 'queued' }).state, 'queued');
});
test('terminal items preserve the reason and exact remaining count', () => {
  const stopped = statusFromItem({ bucket: 'done', bad: true, pending: 125, sent: 73, total: 198, endReason: 'operator_stopped' });
  const finished = statusFromItem({ bucket: 'done', pending: 0, sent: 148, total: 148, endReason: 'completed' });
  assert.equal(stopped.pendingCount, 125);
  assert.equal(stopped.endReason, 'operator_stopped');
  assert.equal(vjCardFields(stopped).eyebrow, 'Stopped');
  assert.equal(finished.pendingCount, 0);
  assert.equal(vjCardFields(finished).eyebrow, 'Finished');
});
test('daily reset wait remains active-looking but never pretends to be running or finished', () => {
  const s = statusFromItem({ where: 'cloud', id: 'c-wait', bucket: 'running', dailyWait: true, engineStatus: 'waiting_daily_reset', resumeAt: '2026-08-27T00:02:00Z' });
  assert.equal(s.running, false);
  assert.equal(s.state, 'waiting_daily_reset');
  assert.equal(s.resumeAt, '2026-08-27T00:02:00Z');
  const controls = vjCardControlsFor(s);
  assert.ok(controls.stop);
  assert.equal(controls.pause, null);
  assert.equal(controls.bulk, null);
});

// ── vjCardFields ──
test('vjCardFields: pct/accounts/accepted for a running local campaign', () => {
  const f = vjCardFields(statusFromItem({ where: 'local', bucket: 'running', sent: 3, total: 4, accounts: 2 }));
  assert.equal(f.pct, 75);
  assert.equal(f.accountsCount, 2);
  assert.equal(f.accepted, '—'); // board item carries no accepted → dash
  assert.equal(f.eyebrow, 'Running');
  assert.equal(f.isMonitor, false);
});
test('vjCardFields: monitoring eyebrow + zero-total guard', () => {
  const f = vjCardFields(statusFromItem({ where: 'cloud', bucket: 'running', monitoring: true, sent: 0, total: 0 }));
  assert.equal(f.isMonitor, true);
  assert.equal(f.eyebrow, 'Monitoring');
  assert.equal(f.sendingLbl, 'Waiting between checks');
  assert.equal(f.pct, 0); // no divide-by-zero
});
test('vjCardFields: paused running reads Paused', () => {
  const f = vjCardFields(statusFromItem({ where: 'local', bucket: 'running', paused: true, sent: 1, total: 2 }));
  assert.equal(f.eyebrow, 'Paused');
});
test('vjCardFields: done reads Finished', () => {
  assert.equal(vjCardFields(statusFromItem({ bucket: 'done', sent: 9, total: 9 })).eyebrow, 'Finished');
});

// ── vjCardControlsFor: the matrix ──
test('controls: running local → pause/stop/restart/copy + bulk run-check, open=viewRunningCampaign', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'local', id: 'local-active', bucket: 'running', sent: 1, total: 2 }));
  assert.match(c.open.onclick, /viewRunningCampaign/);
  assert.ok(c.pause && c.stop && c.restart && c.copy);
  assert.match(c.bulk.onclick, /dashRunCheck/);
});
// The expanded strip's OPEN must use the SAME handler as the collapsed strip's
// footer (openRunningCampaignReadOnly) — it is the only one that binds card #2's
// Live Status to the campaign and sets the Cloud VM run target.
test('controls: running cloud → Campaign Builder parity for pause/check/stop/copy/Show', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'c1', bucket: 'running' }));
  assert.match(c.open.onclick, /openRunningCampaignReadOnly\('c1'\)/);
  assert.ok(c.pause);
  assert.match(c.pause.onclick, /pauseCloudCampaignUI\('c1', false\)/);
  assert.equal(c.bulk.label, 'Run check now');
  assert.match(c.bulk.onclick, /promptCloudCheckScope\('c1',this\)/);
  assert.match(c.stop.onclick, /stopCloudCampaignUI\('c1'\)/);
  assert.equal(c.restart, null, 'a check is not presented as an ambiguous Restart icon');
  assert.match(c.copy.onclick, /duplicateCampaign\('c1'\)/);
  assert.ok(c.extra.find((e) => e.kind === 'show'));
});

test('controls: paused cloud uses Resume', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'c2', bucket: 'running', paused: true }));
  assert.match(c.pause.onclick, /openCampaignResumeDecision\('c2','sending','vm',this\)/);
  assert.equal(c.bulk.label, 'Run check now');
  assert.match(c.bulk.onclick, /promptCloudCheckScope\('c2',this\)/);
});

test('direct Campaign-card terminal status gets stopped controls, not live Pause', () => {
  const c = vjCardControlsFor({ _cloud: true, id: 'c-stop', running: false,
    engineStatus: 'cancelled', pendingCount: 12, totalTargets: 30, totalProcessed: 18 });
  assert.equal(c.pause, null);
  assert.equal(c.stop, null);
  assert.ok(c.extra.find((e) => e.kind === 'play'), 'continue remains available for pending work');
});

test('interrupted local work uses the canonical stopped card and a resume decision', () => {
  const s = statusFromItem({ id: 'local-active', where: 'local', bucket: 'running',
    interrupted: true, interruption: { title: 'Stopped because the app was closed' },
    name: 'A', total: 20, sent: 4 });
  const f = vjCardFields(s);
  const c = vjCardControlsFor(s);
  assert.equal(s.state, 'interrupted');
  assert.equal(f.eyebrow, 'Stopped · This Mac unavailable');
  assert.match(c.pause.onclick, /openCampaignResumeDecision/);
  assert.match(c.deleteForever.onclick, /deleteBoardCampaign\('local-active'/);
});
test('interrupted monitoring with unsent leads offers checks and sending as separate recovery decisions', () => {
  const s = statusFromItem({ where: 'cloud', runsOn: 'local', id: 'c-monitor', bucket: 'running',
    interrupted: true, monitoringPhase: true, pending: 176,
    interruption: { phase: 'monitoring', title: 'Monitoring interrupted' } });
  const c = vjCardControlsFor(s);
  assert.match(c.pause.onclick, /'monitoring','local'/);
  assert.match(c.resumeSending.onclick, /'sending','local'/);
});
test('controls: monitoring cloud → check-now bulk + auto toggle + stop monitoring', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'c9', bucket: 'running', monitoring: true, autoChecksEnabled: true }));
  // Same OPEN handler as a sending cloud campaign — monitoring is still live, so
  // it must bind card #2, not drop into the cockpit view.
  assert.match(c.open.onclick, /openRunningCampaignReadOnly\('c9'\)/);
  // Both card surfaces open the same explicit campaign/all-accounts scope choice.
  assert.match(c.bulk.onclick, /promptCloudCheckScope\('c9',this\)/);
  assert.ok(c.monAuto && c.monAuto.checked === true);
  assert.match(c.monAuto.onclick, /setCloudAutoChecks\('c9'/);
  assert.match(c.stop.tip, /monitoring/i);
  assert.equal(c.pause, null);
});
test('controls: monitoring local → dashRunCheck bulk + pause + stop', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'local', id: 'local-active', bucket: 'running', monitoring: true, sent: 22, total: 198 }));
  assert.match(c.bulk.onclick, /dashRunCheck/);
  assert.ok(c.pause);
  assert.ok(c.stop);
  assert.equal(c.monAuto, null);
  const resume = c.extra.find((x) => x.kind === 'play');
  assert.ok(resume);
  assert.equal(resume.once, true);
  assert.match(resume.onclick, /openCampaignResumeDecision\('local-active','sending-from-monitoring','local',this\)/);
});
test('controls: done → duplicate + delete, no bulk/stop/pause', () => {
  const cloud = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'cD', bucket: 'done' }));
  assert.equal(cloud.bulk, null);
  assert.equal(cloud.stop, null);
  assert.ok(cloud.extra.find((e) => e.kind === 'dup'));
  assert.ok(cloud.extra.find((e) => e.kind === 'delete' && /deleteBoardCampaign/.test(e.onclick)));
  const local = vjCardControlsFor(statusFromItem({ where: 'local', id: 'h1', bucket: 'done', hist: true }));
  assert.ok(local.extra.find((e) => e.kind === 'debrief'));
});
test('controls: a nasty local done id (quote / angle brackets) is escaped in onclicks', () => {
  const c = vjCardControlsFor(statusFromItem({ where: 'local', id: "h-O'Brien <b>Q3</b>", bucket: 'done', hist: true }));
  const del = c.extra.find((e) => e.kind === 'delete');
  // no raw apostrophe that would terminate the JS string, no raw angle brackets
  assert.ok(!/deleteBoardCampaign\('h-O'Brien/.test(del.onclick), 'apostrophe must be JS-escaped');
  assert.match(del.onclick, /O\\'Brien/);
  assert.ok(!del.onclick.includes('<b>'), 'angle brackets must be HTML-escaped');
  assert.match(del.onclick, /&lt;b&gt;/);
});

test('controls: queued → cancel + open routes to edit/viewCloud', () => {
  const local = vjCardControlsFor(statusFromItem({ where: 'local', id: 'q1', rawId: 'r1', bucket: 'queued' }));
  assert.match(local.open.onclick, /editQueuedCampaign.*r1/);
  assert.ok(local.extra.find((e) => e.kind === 'cancel'));
  const cloud = vjCardControlsFor(statusFromItem({ where: 'cloud', id: 'qc', bucket: 'queued' }));
  assert.match(cloud.open.onclick, /viewCloudCampaign\('qc'\)/);
});

test('a cloud monitoring campaign with unsent leads offers Resume sending', () => {
  const c = vjCardControlsFor({
    _cloud: true, id: 'c1', state: 'monitoring', pending: 793,
  });
  const resume = c.extra.find((x) => x.kind === 'play');
  assert.ok(resume, 'a campaign that stopped sending early must offer a way back');
  assert.equal(resume.once, true);
  assert.match(resume.onclick, /openCampaignResumeDecision\('c1','sending-from-monitoring','vm',this\)/,
    'resume must use the same machine-choice flow as This Mac');
});

test('a cloud monitoring campaign that FINISHED sending offers no Resume', () => {
  const c = vjCardControlsFor({
    _cloud: true, id: 'c1', state: 'monitoring', pending: 0,
  });
  assert.equal(c.extra.find((x) => x.kind === 'play'), undefined,
    'nothing left to send — the button would re-open leads that are already done');
});

test('a local monitoring campaign that FINISHED sending offers no Resume', () => {
  const c = vjCardControlsFor({
    _local: true, id: 'l1', state: 'monitoring', totalTargets: 22, totalProcessed: 22, pending: 0,
  });
  assert.equal(c.extra.find((x) => x.kind === 'play'), undefined);
});

test('Stop monitoring and Run check now survive on the monitoring card', () => {
  const c = vjCardControlsFor({
    _cloud: true, id: 'c1', state: 'monitoring', pending: 793,
  });
  assert.ok(c.stop, 'Stop monitoring must not be displaced');
  assert.ok(c.bulk, 'Run check now must not be displaced');
});

test('an active cloud sweep replaces Stop monitoring with Stop check', () => {
  const c = vjCardControlsFor({
    _cloud: true, id: 'c1', state: 'monitoring', monitoringCheckInProgress: true,
  });
  assert.equal(c.stop.tip, 'Stop check');
  assert.match(c.stop.onclick, /stopCloudCheckUI\('c1',this\)/);
  assert.ok(c.bulk, 'the check control remains visible so the renderer can show it disabled');
});

test('statusFromItem carries pending through to the card', () => {
  const s = statusFromItem({ where: 'cloud', id: 'c1', monitoring: true, pending: 793 });
  assert.equal(s.pending, 793,
    'without this the control matrix cannot tell a stalled campaign from a finished one');
});


test('stopped native campaign offers a labelled local resume, and only stop-check during a sweep', () => {
  const status = { running: false, state: null, sheetUrl: 'https://example.test/sheet', totalTargets: 100, totalProcessed: 2 };
  const stopped = vjCardControlsFor(status);
  assert.equal(stopped.pause, null);
  assert.equal(stopped.stop, null);
  assert.equal(stopped.extra[0].tip, 'Resume campaign');
  assert.match(stopped.extra[0].onclick, /openCampaignResumeDecision/);
  const checking = vjCardControlsFor({ ...status, monitoringCheckInProgress: true });
  assert.equal(checking.stop.tip, 'Stop check');
  assert.equal(checking.extra.length, 0);
});

test('fresh local campaign with saved sheet settings offers Start instead of Resume', () => {
  const controls = vjCardControlsFor({ running: false, sheetUrl: 'saved-sheet', name: 'Sam III', state: 'draft' });
  assert.equal(controls.extra[0].tip, 'Start campaign');
  assert.equal(controls.extra[0].onclick, 'window.showCampaignStart()');
  assert.equal(controls.pause, null);
  assert.equal(controls.stop, null);
});
