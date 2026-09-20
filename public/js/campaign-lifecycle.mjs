/** Single local campaign lifecycle and action contract, shared by Node and UI.
 * Monitoring/checking is activity; it must never be presented as a pause.
 */
export function campaignLifecycle(s = {}) {
  const raw = String(s.state || s.engineStatus || s.status || s.bucket || '').toLowerCase();
  const reason = s.stopReason || s.endReason || '';
  let status;
  if (s.stopping || (s.running && s._abort) || ['stopping','pausing'].includes(raw)) status = 'stopping';
  else if ((raw === 'monitoring' || s.monitoring || s.monitoringPhase) && !s.fullStop && !s._skipCleanup) status = 'monitoring';
  else if (s.interrupted || raw === 'interrupted' || (!s.running && (s.fullStop || reason === 'operator-stopped' || reason === 'stopped' || reason === 'campaign-stop-timeout' || reason === 'weekly-reset-cutoff'))) status = 'stopped';
  else if (raw === 'waiting_daily_reset' || s.dailyWait) status = 'waiting';
  else if (raw === 'paused' || ((s.running || s.bucket === 'running') && (s.paused || s._paused || s.pauseRequested))) status = 'paused';
  else if (s.running || raw === 'running') status = 'running';
  else if (s.queued || raw === 'queued' || raw === 'pending' || raw === 'scheduled' || s.bucket === 'queued') status = s.scheduledAt || raw === 'scheduled' ? 'scheduled' : 'queued';
  else if (['error','failed','needs_review'].includes(raw)) status = 'failed';
  else if (s.bad || ['stopped','cancelled'].includes(raw)) status = 'stopped';
  else if (['done','completed'].includes(raw) || s.endNotice || s.hist) status = 'completed';
  else status = 'draft';
  const labels = {draft:'Not started',queued:'Queued',scheduled:'Scheduled',running:'Running',paused:'Paused',stopping:'Stopping…',stopped:'Stopped',completed:'Completed',monitoring:'Monitoring',waiting:'Waiting for daily reset',failed:'Failed'};
  const actions = {
    draft:['start','queue','duplicate','delete','open'], queued:['cancel','duplicate','open'],scheduled:['cancel','duplicate','open'],
    running:['pause','stop','duplicate','open'],paused:['resume','stop','duplicate','open'],stopping:['open'],
    stopped:['resume','restart','duplicate','delete','open'],completed:['duplicate','delete','open'],
    monitoring:['check','stop','duplicate','open'],waiting:['stop','duplicate','open'],failed:['resume','restart','duplicate','delete','open'],
  };
  if (status === 'monitoring' && (Number(s.pending) > 0 || Number(s.totalTargets ?? s.total) > Number(s.totalProcessed ?? s.sent))) actions.monitoring.unshift('resume');
  if (s.hist && ['stopped','completed','failed'].includes(status)) actions[status].splice(-1, 0, 'report');
  return { status, label: labels[status], actions: actions[status],
    bucket: ['queued','scheduled'].includes(status) ? 'queued' : ['running','paused','stopping','monitoring','waiting'].includes(status) ? 'running' : status === 'draft' ? 'saved' : 'done' };
}
export function sameCampaign(a, b) {
  if (a?.campaignId || b?.campaignId) return !!a?.campaignId && a.campaignId === b?.campaignId;
  const name = s => String(s?.name || '').trim().toLowerCase();
  return !!name(a) && name(a) === name(b);
}
const TERMINAL = new Set(['done', 'cancelled', 'error']);

// Canonical lifecycle projection shared by local and VM presentation code.
// Unknown states remain visible as `needsReview` instead of being silently
// rendered as finished; the suggested action tells the operator what to do.
export function normalizeLifecycle(value = {}) {
  const raw = String(value.state || value.status || value.bucket || '').toLowerCase();
  const state = value.stopping ? 'stopping'
    : value.monitoring || value.monitoringPhase ? 'monitoring'
    : raw || 'unknown';
  const known = ['draft', 'queued', 'running', 'pausing', 'paused', 'stopping', 'monitoring', 'interrupted', 'done', 'cancelled', 'error'].includes(state);
  return {
    id: value.id || null,
    executionId: value.executionId || value.runId || null,
    revision: Number(value.revision || 0),
    state,
    terminal: TERMINAL.has(state),
    needsReview: !known || state === 'interrupted' || state === 'error',
    reviewAction: !known ? 'Refresh status; if it remains unknown, use Resolve.'
      : state === 'interrupted' ? 'Choose Resume here or Stop here.'
      : state === 'error' ? 'Open the run log, fix the named issue, then Retry.'
      : '',
  };
}

/** Existing renderers consume these legacy flags; lifecycle remains authoritative. */
export function withCampaignLifecycle(s = {}) {
  if (s._cloud || s.where === 'cloud') return s;
  const lifecycle = campaignLifecycle(s);
  const state = { draft: 'draft', queued: 'queued', scheduled: 'queued', stopped: s.interrupted ? 'interrupted' : 'done', completed: 'done', failed: 'error', waiting: 'waiting_daily_reset' }[lifecycle.status] || lifecycle.status;
  return { ...s, lifecycle, state,
    endReason: lifecycle.status === 'stopped' ? (s.endReason || 'stopped') : s.endReason,
    running: lifecycle.status === 'running' || lifecycle.status === 'paused' || lifecycle.status === 'stopping',
    paused: lifecycle.status === 'paused',
    monitoring: lifecycle.status === 'monitoring',
    monitoringPhase: lifecycle.status === 'monitoring',
  };
}

export function campaignActionSpecs(s = {}) {
  const lifecycle = campaignLifecycle(s);
  const id = s.id || 'local-active';
  const localRuntime = ['local-active','legacy-singleton'].includes(id);
  const escapeAttr = value => value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll("'",'&#39;').replaceAll('<','&lt;');
  const call = (fn, ...args) => escapeAttr(`${fn}(${args.map(arg => JSON.stringify(arg)).join(',')})`);
  const actions = {
    start: { label: 'Start campaign', kind: 'play', onclick: call('openSavedCampaignStart', id) },
    queue: { label: 'Queue campaign', kind: 'queue', onclick: call('openSavedCampaignStart', id, 'queue') },
    resume: { label: lifecycle.status === 'paused' ? 'Resume' : lifecycle.status === 'monitoring' ? 'Choose what resumes' : 'Continue where it left off', kind: 'play', onclick: lifecycle.status === 'paused' ? 'window.dashPauseActive()' : localRuntime ? call('window.openCampaignResumeDecision', 'local-active',lifecycle.status === 'monitoring' ? 'sending-from-monitoring' : 'sending','local') : call('restartLocalFromItem',id,false) },
    restart: { label: 'Restart from the beginning', kind: 'restart', onclick: call('restartLocalFromItem', id, true) },
    report: { label: 'Debrief', kind: 'debrief', onclick: call('window.openDebrief', id) },
    pause: { label: 'Pause', kind: 'pause', onclick: 'window.dashPauseActive()' },
    stop: { label: lifecycle.status === 'monitoring' ? 'Stop monitoring' : 'Stop campaign', kind: 'stop', onclick: 'window.dashStopActive()' },
    check: { label: 'Check connections', kind: 'check', onclick: 'window.dashRunCheck()' },
    cancel: { label: 'Cancel queued campaign', kind: 'delete', onclick: call('window.cancelQueuedCampaign', s.rawId || id) },
    duplicate: { label: 'Duplicate', kind: 'dup', onclick: call('duplicateCampaign',id) },
    delete: { label: 'Delete', kind: 'delete', onclick: call('deleteBoardCampaign',id) },
    open: { label: 'Open', kind: 'open', onclick: lifecycle.bucket === 'queued' ? call('window.editQueuedCampaign',s.rawId || id) : call('openCampaignForEdit',id) },
  };
  return lifecycle.actions.map(action => ({ action, ...actions[action] }));
}
