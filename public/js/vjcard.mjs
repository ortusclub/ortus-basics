import { terminalPresentation } from './campaign-terminal.mjs';
import { normalizeLifecycle, campaignLifecycle, withCampaignLifecycle, campaignActionSpecs } from './campaign-lifecycle.mjs';

// Pure helpers for rendering card #2 (the .vj-card live-status card) inside an
// EXPANDED dashboard strip — browser-safe (no DOM), so app.js imports them and
// node --test unit-tests them. The DOM parts (vjCardSkeleton clone + fillVjCard)
// live in app.js. See docs/superpowers/specs/2026-07-11-expanded-strip-card2-parity-design.md
//
// The look comes entirely from the shared .vj-* CSS; these helpers only compute
// the field values + the control-button matrix so an expanded strip is identical
// to the campaign-tab card, driven per-campaign.

/** Map a board item (renderUnifiedStrip `it`) → the status shape fillVjCard/
 *  renderActiveCard consume. Mirrors _buildCloudActiveStatus's shape. */
export function statusFromItem(it = {}) {
  const lifecycle = normalizeLifecycle(it);
  const ownedLocal = String(it.runsOn || '') === 'local';
  const cloud = it.where === 'cloud' && !ownedLocal;
  // Monitoring is a campaign phase, not a VM-only location and not a synonym
  // for Pause. The same durable phase must select the same card on either side
  // of a handover.
  const monitoring = !!it.monitoring || !!it.monitoringPhase;
  const stopping = !!it.stopping;
  const state = (it.interrupted || it.waitingForLocal) ? 'interrupted'
    : stopping ? 'stopping'
    : it.dailyWait ? 'waiting_daily_reset'
    : it.needsReview ? 'needs_review'
    : monitoring ? 'monitoring'
    : it.bucket === 'done' ? 'done'
    : it.bucket === 'queued' ? 'queued'
    : undefined;
  return {
    lifecycle,
    campaignId: it.campaignId,
    executionId: lifecycle.executionId,
    needsReview: lifecycle.needsReview,
    reviewAction: lifecycle.reviewAction,
    _cloud: cloud,
    id: it.id,
    rawId: it.rawId,
    // A released VM row can remain status='running' while ownership is local.
    // When the local singleton is not actually active that word is only the
    // engine's frozen handover record, not proof that work is happening here.
    running: it.bucket === 'running' && !monitoring && !it.waitingForLocal && !it.dailyWait && !it.needsReview,
    state,
    name: it.name,
    mode: it.mode,
    isFG: !!it.isFG,
    totalTargets: Number(it.total) || 0,
    totalProcessed: Number(it.sent) || 0,
    pending: Number(it.pending) || 0,
    pendingCount: it.pending == null ? undefined : Math.max(0, Number(it.pending) || 0),
    endNotice: it.endNotice || (it.hist && it.hist.endNotice) || null,
    endReason: it.endReason || (it.hist && it.hist.endReason)
      || (it.bad ? 'stopped' : (it.bucket === 'done' ? 'completed' : '')),
    stopReason: it.stopReason || (it.hist && it.hist.stopReason) || '',
    dailyWait: !!it.dailyWait,
    needsReview: !!it.needsReview,
    engineStatus: it.engineStatus || '',
    resumeAt: it.resumeAt || null,
    accountsCount: Number(it.accounts) || 0,
    // The live stage counts accounts from these, not from accountsCount — a
    // board strip that only carried the number showed "0 accounts" beside a
    // stats line reading "3 accounts".
    profileIds: Array.isArray(it.profileIds) ? it.profileIds : [],
    participatingProfileIds: (Array.isArray(it.participatingProfileIds) && it.participatingProfileIds.length)
      ? it.participatingProfileIds
      : (Array.isArray(it.profileIds) ? it.profileIds : []),
    sheetUrl: it.sheetUrl || it.sheet_url || '',
    acceptedCount: (it.acceptedCount == null ? undefined : it.acceptedCount),
    paused: (!!it.paused && !monitoring) || !!it.interrupted || !!it.waitingForLocal,
    monitoringPhase: !!it.monitoringPhase || (!!it.monitoring && ownedLocal),
    // Live-browser flag + the engine's per-person phase tick. The strip's card
    // is a clone of #active-card, so it renders the same live stage — without
    // these it can only fall back to the one-line "Working…".
    live: !!it.live,
    liveAccount: it.liveAccount || '',
    currentAction: it.currentAction || null,
    logs: Array.isArray(it.logs) ? it.logs : [],
    nextCheckAt: it.nextCheckAt,
    monitoringUntil: it.monitoringUntil,
    followUp: it.followUp,
    autoChecksEnabled: it.autoChecksEnabled,
    checkIntervalMinutes: Number(it.checkIntervalMinutes) || 60,
    // The adaptive check cadence. checkSlowdown() is `effective > base`, nothing
    // else — so BOTH numbers have to survive this whitelist or the board's card
    // says "checks every 4h · nothing running right now" and presents a
    // temporary slowdown as the operator's own setting.
    //
    // Base falls back to the effective interval, NOT to 60: a local campaign set
    // to 2h carries no base at all, and defaulting it to 60 would report a
    // slowdown that isn't happening. Equal ⇒ not slowed, which is the truth.
    checkIntervalBaseMinutes: Number(it.checkIntervalBaseMinutes) || Number(it.checkIntervalMinutes) || 60,
    emptyCheckStreak: Number(it.emptyCheckStreak) || 0,
    // Which side owns the campaign + when it last changed hands, for the card's
    // RUNNING ON control. Whitelisted here so a board item that carries them
    // reaches the card. Every campaign that existed before this feature was
    // cloud-dispatched, so an absent value must read as the VM, never as ''
    // (which _whSide would otherwise have to re-guess from `_cloud`, and a
    // board item builder that forgets to set runsOn on a LOCAL item would then
    // silently show the control in the wrong position).
    // monitorHeroState reads these three to decide CHECKING vs waking vs a plain
    // countdown. statusFromItem is a whitelist, so leaving them out meant a board
    // strip could never show a sweep in progress: it said "nothing running right
    // now" with a browser open. Same trap that dropped the cadence fields.
    monitoringCheckInProgress: !!it.monitoringCheckInProgress,
    // The stop flag and the banner's counters. Same whitelist trap: every one of
    // these is invisible on the board's card unless it is named here.
    checkStopping: !!it.checkStopping,
    // Absent stays absent, never 0: a sweep on its third account would read
    // "1 of 3" and the operator has no way to know the number is a placeholder.
    accountsDone: it.accountsDone == null ? null : Number(it.accountsDone) || 0,
    accountsTotal: Number(it.accountsTotal) || Number(it.accounts) || 0,
    batchDone: it.batchDone == null ? null : Number(it.batchDone) || 0,
    batchSize: Number(it.batchSize) || 8,
    sentToday: Number(it.sentToday) || 0,
    dailyLimit: Number(it.dailyLimit) || 0,
    elapsedSec: it.elapsedSec == null ? null : Number(it.elapsedSec),
    // The per-account panel. Absent from this whitelist it never reaches the
    // board's card and the panel is dashboard-only for no visible reason.
    accountPanel: Array.isArray(it.accountPanel) ? it.accountPanel : [],
    monitorTaskStatus: it.monitorTaskStatus || null,
    monitorTaskDueAt: it.monitorTaskDueAt || null,
    monitorTaskError: it.monitorTaskError || '',
    // Durable sweep lifecycle. These fields come from the engine and must cross
    // this whitelist intact: they decide whether a historical lead event is
    // still active work or merely the result of the check that just ended.
    monitorCheckStatus: it.monitorCheckStatus || '',
    monitorCheckExpected: Number(it.monitorCheckExpected) || 0,
    monitorCheckAccountsChecked: Number(it.monitorCheckAccountsChecked) || 0,
    monitorCheckError: it.monitorCheckError || '',
    monitorCheckId: it.monitorCheckId || '',
    monitorCheckCurrentAccount: it.monitorCheckCurrentAccount || '',
    monitorCheckHeartbeatAt: it.monitorCheckHeartbeatAt || null,
    monitorCheckStartedAt: it.monitorCheckStartedAt || null,
    monitorCheckCompletedAt: it.monitorCheckCompletedAt || null,
    runsOn: it.runsOn || 'vm',
    handoverAt: it.handoverAt || null,
    waitingForLocal: !!it.waitingForLocal,
    interrupted: !!it.interrupted || !!it.waitingForLocal,
    interruption: it.interruption || (it.waitingForLocal ? {
      title: 'Stopped because this Mac became unavailable',
      detail: 'Nothing is running on this Mac. The remaining leads are safe. Choose where to continue.',
      reason: 'local-runtime-missing',
    } : null),
    // The finished-FG reason line reads all three of these. Leaving them out of
    // this whitelist is why a done FG card on the board never explained itself:
    // _fgFinishedNote returns null the moment `bucket` is undefined, so the
    // "ran out of invite credits" note was dead everywhere it mattered.
    bucket: it.bucket,
    benchAccounts: it.benchAccounts || null,
    dupes: Number(it.dupes) || 0,
    bad: !!it.bad,
    badLabel: it.badLabel,
    histIdx: it.histIdx,
    hist: it.hist,
  };
}

// Log events that describe the SEND phase. Each one draws a hero that says the
// campaign is sending: "Campaign running", "Next account selecting".
// Work-in-progress events: something was OPENING, SENDING, READING or FINISHING
// at the moment the line was written. Between checks none of that is happening,
// so the newest such line describes the past, however recent.
const WORK_LOG_KINDS = new Set([
  // sending
  'sender-browser-opening', 'sender-batch-starting', 'profile-loading',
  'sending-progress', 'saving-result', 'connection-confirmed',
  'introduction-confirmed', 'sender-browser-closed', 'sender-unavailable',
  'sender-backoff', 'sending-resumed',
  // acceptance checking. 'check-error' is deliberately NOT here: an incomplete
  // check is something the operator still has to act on, so it keeps the card
  // until the next check clears it.
  'local-browser-starting', 'account-browser-opening', 'account-checking',
  'account-checked', 'account-skipped', 'check-queued', 'check-complete',
]);

/**
 * May the newest log line drive the card's headline, phase and step strip?
 *
 * Normally yes: the hero follows the log so it can never lag behind what the
 * operator is reading. But a campaign that stopped sending and kept checking
 * has, as its newest line, the last thing sending did — possibly days ago. The
 * card then drew "SENDER BROWSER CLOSED · Campaign sending · Next account
 * selecting" over a campaign parked waiting for its next acceptance check.
 * Reported 2026-08-28.
 *
 * Takes monitoringIdle, not the rendered phase: the event REWRITES the phase
 * (that is how a stale send event turned a monitoring card into a sending one),
 * so asking the rewritten phase whether to trust the event is circular. Idle
 * means the durable state says monitoring and no sweep is in progress — for a
 * local run and a VM run alike.
 *
 * A sweep in progress keeps the log in charge: those events are happening now.
 *
 * The same rule holds for a FINISHED check. "Check complete — 0 Connected, 110
 * Still Pending" rewrote the phase to 'checking' and pinned the card to
 * FINISHED CHECKING ALL AVAILABLE ACCOUNTS, with the next-check countdown
 * replaced by a check-progress panel, for the whole hour until the next sweep.
 * Reported 2026-08-28. The card falls back to the durable monitoring state,
 * which knows when the next check is; the log still renders in full underneath.
 */
export function heroFollowsLog(kind, monitoringIdle) {
  if (!monitoringIdle) return true;
  return !WORK_LOG_KINDS.has(String(kind || ''));
}

/** Authoritative presentation state for a monitoring sweep. */
export function monitorSweepDisposition(status = {}) {
  const value = String(status.monitorCheckStatus || '').trim().toLowerCase();
  if (value === 'running') return 'running';
  if (value === 'failed' || value === 'incomplete') return 'error';
  if (value === 'completed' || value === 'cancelled') return 'idle';
  return status.monitoringCheckInProgress ? 'running' : 'unknown';
}

/** Computed field values for the card body (no time-based countdown here — that
 *  is filled live by the ticker). Pure + testable. */
export function vjCardFields(status = {}) {
  if (status.campaignId && !status._cloud) status = withCampaignLifecycle(status);
  const s = status || {};
  const isMonitor = s.state === 'monitoring';
  const isDone = s.state === 'done';
  const isQueued = s.state === 'queued';
  const isInterrupted = s.state === 'interrupted' || !!s.interrupted;
  const isStopping = s.state === 'stopping';
  const done = Number(s.totalProcessed) || 0;
  const total = Number(s.totalTargets) || 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const accountsCount = (s.accountsCount != null)
    ? Number(s.accountsCount) || 0
    : (((isMonitor ? s.participatingProfileIds : s.profileIds) || s.profileIds || []).length);
  const accepted = (s.acceptedCount == null) ? '—' : String(s.acceptedCount);
  const terminal = isDone ? terminalPresentation(s) : null;
  // Asleep on the engine's blocked_until. The DB status stays 'running' so the
  // acceptance sweep keeps running, so EVERY status word here would otherwise
  // fall through to 'Running'/'Sending' — printed directly above a card that
  // says every account is capped. The strip chip already reads this; the card
  // eyebrow is a SEPARATE renderer and was still echoing the raw status.
  const isWaiting = !isMonitor && !isDone && !isQueued && !s.bad
    && !!(s.currentAction && s.currentAction.phase === 'waiting');
  const eyebrow = s._loadingIdentity ? 'Loading campaign…' : isInterrupted ? 'Stopped · This Mac unavailable'
    : isStopping ? 'Stopping…'
    : s.bad ? (s.badLabel || 'Stopped')
    : isMonitor ? 'Monitoring'
    : isQueued ? 'Queued'
    : isDone ? terminal.label
    : isWaiting ? 'Waiting'
    : (s.paused ? 'Paused' : 'Running');
  const sendingLbl = isInterrupted ? 'Stopped safely'
    : isStopping ? 'Finishing the current lead'
    : isMonitor ? (s.monitoringCheckInProgress ? 'Checking now' : 'Waiting between checks')
    : isDone ? terminal.activity
    : isQueued ? 'Queued'
    : isWaiting ? 'Waiting'
    : (s.paused ? 'Paused' : 'Sending');
  return {
    isMonitor, isDone, isQueued, isWaiting, isInterrupted,
    name: s.name || 'Loading campaign…',
    eyebrow: s.campaignId && !s._cloud ? campaignLifecycle(s).label : eyebrow, pct, done, total, accountsCount, accepted, sendingLbl,
  };
}

/** The control-button matrix for one strip's card, routed to THAT campaign by id
 *  (local vs cloud, per state). Pure — returns a spec; fillVjCard renders it.
 *  onclick strings reference the same global fns renderUnifiedStrip's footer uses. */
// Escape a campaign id for safe embedding in `onclick="fn('<here>')"` — a
// double-quoted HTML attribute holding a single-quoted JS string. A local done
// strip's id is `h-<campaign name>`, so it can carry quotes / angle brackets.
function _esc(v) {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function hasLocalCampaignRun(s = {}) {
  if (s.state === 'draft' || s.hasRun === false) return false;
  return !!(s.hist || s.startedAt || s.running || s.interrupted
    || s.state === 'monitoring' || s.endNotice || Number(s.totalProcessed) > 0
    || Number(s.totalTargets) > 0);
}

export function vjCardControlsFor(status = {}) {
  if (status.campaignId && !status._cloud) {
    const c = { open: null, sheet: { onclick: 'window.openVjCardSheet(this)' }, pause: null, stop: null, restart: null, copy: null, extra: [] };
    for (const spec of campaignActionSpecs(status)) {
      const control = { tip: spec.label, kind: spec.kind, onclick: spec.onclick };
      if (spec.action === 'open') c.open = control;
      else if (spec.action === 'pause' || (spec.action === 'resume' && campaignLifecycle(status).status === 'paused')) c.pause = control;
      else if (spec.action === 'stop') c.stop = control;
      else if (spec.action === 'check') c.bulk = control;
      else c.extra.push(control);
    }
    if (status.monitoringCheckInProgress) c.stop = { tip: 'Stop check', onclick: 'stopSoloCheck(this)' };
    return c;
  }
  const s = status || {};
  const cloud = !!s._cloud;
  const id = _esc(String(s.id || ''));
  const rawId = _esc(String(s.rawId || String(s.id || '')));
  const monitor = s.state === 'monitoring';
  // The Dashboard adapter supplies state:'done'. The Campaign card receives
  // the engine's direct status shape instead, where a stopped run is expressed
  // as running:false + engineStatus. Normalize that distinction here so sharing
  // the renderer does not accidentally give a cancelled campaign live controls.
  const terminalEngine = ['completed', 'cancelled', 'error', 'failed', 'stopped'].includes(String(s.engineStatus || '').toLowerCase());
  const localStopped = !cloud && s.running === false && !monitor
    && !['queued', 'interrupted', 'waiting_daily_reset', 'needs_review', 'stopping'].includes(s.state)
    && !!(s.sheetUrl || s.endNotice || Number(s.totalTargets) > 0);
  const done = s.state === 'done' || (!s.running && terminalEngine) || localStopped;
  const queued = s.state === 'queued';
  const interrupted = s.state === 'interrupted' || !!s.interrupted;
  const dailyWait = s.state === 'waiting_daily_reset';
  const needsReview = s.state === 'needs_review';
  const running = !monitor && !done && !queued && !interrupted && !dailyWait && !needsReview;

  // Running cloud → read-only wizard WITH the campaign's Live Status card #2
  // bound and open; STOPPED/cancelled cloud → the setup wizard prefilled + fully
  // editable (edit & re-launch); cleanly-done cloud → the live cockpit. Both
  // editors fall back to openCloudLive when no launch config was snapshotted
  // (pre-2.133 campaigns).
  //
  // v2.160.134: running cloud used to call openRunningCampaignEditor, which is
  // the pre-2.160.46 path — it prefills the wizard but never binds the live card
  // (_bindLiveStatusToCampaign) or flips the run target to Cloud VM. So OPEN from
  // an EXPANDED strip landed on a "Runs on this Mac" wizard with NO Live Status
  // section, while OPEN from the COLLAPSED strip footer (which already called
  // openRunningCampaignReadOnly) showed it. Same button, two paths. One now.
  const openOnclick = cloud
    ? (queued ? `viewCloudCampaign('${id}')`
      : (running || monitor) ? `openRunningCampaignReadOnly('${id}')`
        : s.bad ? `openCampaignForEdit('${id}')`
          : `openCloudLive('${id}')`)
    : (queued ? `window.editQueuedCampaign && window.editQueuedCampaign('${rawId}')` : 'viewRunningCampaign()');

  const c = {
    open: { onclick: openOnclick },
    sheet: { onclick: 'window.openVjCardSheet && window.openVjCardSheet(this)' },
    pause: null, stop: null, restart: null, copy: null,
    resumeSending: null, deleteForever: null, bulk: null, monAuto: null, extra: [],
  };

  if (!cloud && !queued && !s.running && !s.monitoringCheckInProgress && !hasLocalCampaignRun(s)) {
    c.extra.push({ tip: 'Start campaign', kind: 'play',
      onclick: 'window.showCampaignStart()' });
    return c;
  }

  if (localStopped && s.monitoringCheckInProgress) {
    c.stop = { tip: 'Stop check', onclick: 'stopSoloCheck(this)' };
    return c;
  }

  if (localStopped && (!id || id === 'local-active' || id === 'legacy-singleton')) {
    c.extra.push({ tip: 'Resume campaign', kind: 'play', once: true,
      onclick: "window.openCampaignResumeDecision('local-active','sending','local',this)" });
    return c;
  }

  if (interrupted) {
    const interruptedPhase = s.interruption?.phase || (s.monitoringPhase ? 'monitoring' : 'sending');
    c.pause = { once: true, onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','${interruptedPhase}','local',this)` };
    if (interruptedPhase === 'monitoring' && Number(s.pending) > 0) {
      c.resumeSending = { once: true, onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','sending','local',this)` };
    }
    c.stop = { tip: 'End campaign', onclick: 'window.dashStopActive && window.dashStopActive()' };
    if (!cloud && (!id || id === 'local-active')) {
      c.deleteForever = { onclick: `deleteBoardCampaign('${id || 'local-active'}', this)` };
    }
    // This is still a durable cloud campaign even though ownership was handed
    // to a local runtime that has since disappeared. Open the durable record,
    // never the now-empty local singleton.
    if (id && id !== 'local-active') c.open = { onclick: `openRunningCampaignReadOnly('${id}')` };
    return c;
  }

  if (dailyWait || needsReview) {
    c.open = { onclick: cloud ? `openRunningCampaignReadOnly('${id}')` : 'viewRunningCampaign()' };
    c.stop = { tip: 'Stop permanently', onclick: cloud ? `stopCloudCampaignUI('${id}')` : 'window.dashStopActive && window.dashStopActive()' };
    return c;
  }

  if (running && !cloud) {
    c.pause = { onclick: s.paused
      ? `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','sending','local',this)`
      : 'window.dashPauseActive && window.dashPauseActive()' };
    c.stop = { tip: 'Stop', onclick: 'window.dashStopActive && window.dashStopActive()' };
    c.restart = { onclick: 'window.dashRestartActive && window.dashRestartActive()' };
    c.copy = { onclick: 'window.dashCopyActiveToQueue && window.dashCopyActiveToQueue()' };
    c.bulk = { label: 'Run check now', onclick: 'window.dashRunCheck && window.dashRunCheck()' };
  } else if (running && cloud) {
    // Cloud pause/resume has shipped. Keep this matrix identical to Campaign
    // Builder instead of preserving the old read-only cloud dock.
    c.pause = { onclick: s.paused
      ? `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id}','sending','vm',this)`
      : `pauseCloudCampaignUI('${id}', false)` };
    c.stop = { tip: 'Stop', onclick: `stopCloudCampaignUI('${id}')` };
    // A connection check needs an explicit scope choice. Both the Dashboard
    // card and Campaign card render this same command, so one surface cannot
    // silently start a different kind of check from the other.
    c.bulk = { label: 'Run check now', onclick: `window.promptCloudCheckScope && window.promptCloudCheckScope('${id}',this)` };
    c.copy = { onclick: `duplicateCampaign('${id}')` };
    c.extra.push({ tip: 'Show', kind: 'show', onclick: `openCloudCampaignView('${id}','${id}')` });
  } else if (monitor && !cloud) {
    c.pause = { once: true, onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','monitoring','local',this)` };
    c.stop = { tip: 'Stop', onclick: 'window.dashStopActive && window.dashStopActive()' };
    c.bulk = { label: 'Run check now', onclick: 'window.dashRunCheck && window.dashRunCheck()' };
    const remaining = Number(s.pending) > 0
      || Number(s.totalTargets) > Number(s.totalProcessed);
    if (remaining) {
      c.extra.push({ tip: 'Choose what resumes', kind: 'play', once: true,
        onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id || 'local-active'}','sending-from-monitoring','local',this)` });
    }
  } else if (monitor && cloud) {
    c.stop = s.monitoringCheckInProgress
      ? { tip: 'Stop check', onclick: `stopCloudCheckUI('${id}',this)` }
      : { tip: 'Stop monitoring', onclick: `stopCloudCampaignUI('${id}')` };
    c.bulk = { label: 'Run check now', onclick: `window.promptCloudCheckScope && window.promptCloudCheckScope('${id}',this)` };
    c.monAuto = { checked: s.autoChecksEnabled !== false, onclick: `setCloudAutoChecks('${id}',this.checked,this)` };
    // A campaign that switched to monitoring because nothing could send still has
    // leads waiting. The engine already accepts a restart in this state (it only
    // short-circuits when nothing is pending); the app just never offered it, so
    // the only way back was to wait for the scheduled resume. Continue-where-it-
    // left-off only: re-sending to leads already connected is not one click away.
    const remaining = Number(s.pending) > 0
      || Number(s.totalTargets) > Number(s.totalProcessed);
    if (remaining) {
      c.extra.push({ tip: 'Choose what resumes', kind: 'play', once: true,
        onclick: `window.openCampaignResumeDecision && window.openCampaignResumeDecision('${id}','sending-from-monitoring','vm',this)` });
    }
  } else if (done) {
    // Restart controls — only for a STOPPED/CANCELLED/ERRORED campaign (never a
    // cleanly-completed one). ▶ Continue where it left off · ⟲ from the beginning.
    // An ERRORED campaign gets its restart as the card's big labelled button
    // instead (failedStartRetry). Leaving the glyphs here too would offer the
    // same action twice, one of them tipped "restart from the beginning" —
    // which on a campaign that sent 31 invites re-sends to all 31.
    if ((s.bad || terminalPresentation(s).pending > 0) && !failedStartRetry(s)) {
      c.extra.push({ tip: 'Continue where it left off', kind: 'play', onclick: cloud ? `restartCloudCampaignUI('${id}', false)` : `restartLocalFromItem('${id}', false)` });
      c.extra.push({ tip: 'Restart from the beginning', kind: 'restart', onclick: cloud ? `restartCloudCampaignUI('${id}', true)` : `restartLocalFromItem('${id}', true)` });
    }
    c.extra.push({ tip: 'Duplicate', kind: 'dup', onclick: `duplicateCampaign('${id}')` });
    if (!cloud && s.hist) c.extra.push({ tip: 'Debrief', kind: 'debrief', onclick: `window.openDebrief('${id}')` });
    c.extra.push({ tip: 'Delete', kind: 'delete', onclick: `deleteBoardCampaign('${id}', this)` });
  } else if (queued) {
    c.extra.push({ tip: 'Cancel', kind: 'cancel', onclick: cloud ? `stopCloudCampaignUI('${id}')` : `window.cancelQueuedCampaign && window.cancelQueuedCampaign('${rawId}')` });
  }
  return c;
}

/** The number on an account pill.
 *
 *  It used to be that account's share of THIS batch (sent / leads assigned),
 *  which is why an operator saw "12/13" on Thursday and "12/7" on Friday for
 *  the same account, matching nothing else on screen and reading like an
 *  account that was nearly finished. Both halves are now the same daily
 *  measure the drawer prints one line below: sent today, out of what this
 *  account is allowed today.
 *
 *  With no daily limit known we say what was sent rather than invent a
 *  denominator — "12/0" is worse than no denominator at all.
 */
/** "4 of 8 in its last batch" — the turn, which is what an operator means by a
 *  batch: what one account was handed the last time its browser opened, and how
 *  many of them it sent. Deliberately not the day (the row already says that)
 *  and not the account's share of the campaign's leads, which is a split that
 *  grows when another account is removed (operator, 2026-09-02: "why is it
 *  sometimes out of 4 and sometimes out of 8").
 *
 *  liveTurn wins when the account's browser is open right now: it has no
 *  finished turn worth reporting, and the one in progress is the news.
 *  Empty string when nothing is known, so the caller renders no tooltip at all
 *  rather than one that says nothing.
 */
export function acctBatchTip(lastTurn = null, liveTurn = null) {
  const lv = liveTurn || null;
  if (lv && Number(lv.total) > 0) return `${Number(lv.done) || 0} of ${Number(lv.total)} in this batch`;
  const lt = lastTurn || null;
  if (!lt || !(Number(lt.planned) > 0)) return '';
  return `${Number(lt.done) || 0} of ${Number(lt.planned)} in its last batch`;
}

/** One account's state, reduced to the three things the row shows.
 *
 *  dot: red = it is not sending and it wants you (bench, logged out, proxy,
 *  throttle, daily cap); amber = it IS sending but is not connected to the
 *  primary, so it can send invitations and never introduce anyone; green =
 *  sending, and able to introduce.
 *
 *  pills: only what is wrong. A healthy account earns no pill at all — the
 *  panel used to hang six badges of equal weight on every row, including green
 *  ones saying nothing was wrong, and the result was unreadable (operator,
 *  2026-09-02: "this is very very very ugly").
 */
export function acctRowState(a = {}, { isCCIC = false, nextMonday = 'Monday' } = {}) {
  const weekly = !!(a.weeklyCap || a.parkReason === 'weekly');
  const capped = (a.dailyLimit || 0) > 0 && (a.dailyCount || 0) >= a.dailyLimit;
  const pills = [];
  let blocked = true;
  let status;
  if (a.needsLogin) { pills.push(['bad', 'Logged out']); status = 'Logged out — open the account and sign in to LinkedIn'; }
  // Parked by 3 consecutive proxy 407s: the VM cannot open this profile's
  // browser at all. Distinct from a throttle, because waiting will not fix it.
  else if (a.parkReason === 'proxy') { pills.push(['bad', 'Proxy refused']); status = 'The VM cannot open this profile — fix its proxy in GoLogin, then try again'; }
  else if (weekly && a.weeklySuspected) {
    pills.push(['bad', 'Suspected weekly limit']);
    status = `Stopped — suspected weekly invitation limit (LinkedIn refused its invite). If it is the limit, it resets ${nextMonday}`;
  }
  else if (weekly) {
    // The pill gets the date, the drawer gets the countdown. "Stopped until
    // Monday 7 Sept (in 5 days)" is a sentence, and a sentence in a pill is
    // the wall of text this redesign exists to remove.
    pills.push(['bad', `Stopped until ${String(nextMonday).replace(/\s*\(.*\)\s*$/, '')}`]);
    status = `Stopped — LinkedIn's weekly invitation limit, resets ${nextMonday}`;
  }
  else if (a.parkReason === 'throttle' || a.parkReason === 'throttle_paused') { pills.push(['bad', 'Throttled']); status = 'Throttled — pausing between sends, it comes back on its own'; }
  else if (a.parkReason === 'unconfirmed_streak') { pills.push(['bad', '5 unconfirmed']); status = 'Five leads in a row could not be confirmed — open the account, then try again'; }
  else if (a.parkReason === 'op_credit_limit') { pills.push(['bad', 'Suspected OP credits limit reached']); status = 'Benched — five contacts in a row were not Open Profile, so its monthly OP credits are probably used up. Retry to unbench'; }
  else if (a.parked) {
    const reason = String(a.parkReason || 'stopped').replace(/[_-]+/g, ' ');
    pills.push(['bad', 'Stopped']); status = `Stopped — ${reason}`;
  } else if (capped) { pills.push(['bad', 'Daily limit reached']); status = 'It has sent everything it is allowed today'; }
  else { blocked = false; status = 'Sending'; }

  // Restricted in the SoO — out of rotation regardless of anything above.
  if (a.identityRestricted) { pills.push(['bad', a.restrictionLabel || 'Identity restricted']); blocked = true; }

  // The primary. null is NEVER CHECKED, which is not the same as not connected:
  // the engine connects a sender to the primary lazily, inside the intro sweep,
  // the first time one of that account's leads is accepted.
  //
  // Three outcomes, not two. An invitation that has been SENT and is waiting to
  // be accepted is not a failure, and calling it "not connected" gave the
  // operator nothing to do about a state whose next move is somebody accepting
  // (operator, 2026-09-02: "it's not true they are indeed connected"). The
  // engine has always stored it as `pending`; the accounts payload used to
  // flatten it away. primaryConnected is the older boolean and is only read
  // when an engine too old to send primaryState is answering.
  let primary = '';
  if (isCCIC) {
    const raw = a.primaryState == null
      ? (a.primaryConnected === true ? 'connected' : a.primaryConnected === false ? 'pending' : '')
      : String(a.primaryState || '');
    if (raw === 'connected') primary = 'connected';
    else if (raw === 'pending') { primary = 'pending'; pills.push(['warn', 'Primary invite pending']); }
    else if (raw === 'not_connected') { primary = 'not_connected'; pills.push(['warn', 'Primary not connected']); }
    else if (raw) { primary = 'unverified'; pills.push(['warn', 'Primary unconfirmed']); }
    else { primary = 'never'; pills.push(['warn', 'Primary not checked']); }
  }
  // Sending bare: LinkedIn's free personalised-invite allowance is spent. Not a
  // blocker, so it never turns the dot red, but it is worth a word.
  if (a.noteExhausted) pills.push(['warn', 'No note left']);

  const dot = blocked ? 'bad' : (isCCIC && primary !== 'connected' ? 'warn' : 'ok');
  return { dot, pills, status, primary, weekly, blocked };
}

export function acctPillCount(account = {}, tally = null) {
  const limit = Number(account.dailyLimit) || 0;
  const sent = Number.isFinite(Number(account.dailyCount)) ? Number(account.dailyCount)
    : (tally ? Number(tally.sent) || 0 : 0);
  return limit > 0 ? `${sent}/${limit}` : `${sent} sent`;
}

/** A campaign that ERRORED, and the one action worth a big button.
 *
 *  Today the way back is two unlabelled dock glyphs, the first of which is
 *  tipped "continue where it left off" — on a campaign that never left
 *  anywhere. Which restart is safe depends entirely on whether anything was
 *  sent, so that decision is made here rather than by the operator guessing
 *  between two triangles.
 *
 *  Only genuine errors. A campaign the operator stopped on purpose is not a
 *  failure and keeps its ordinary dock.
 */
export function failedStartRetry(status = {}) {
  const s = status || {};
  if (!s.bad) return null;
  const isError = String(s.badLabel || '') === 'Error';
  // A campaign stopped with leads still queued needs the same big way back in
  // as one that errored — the operator's own stop is the commonest way to end
  // up here, and it was getting the small icon row instead (operator,
  // 2026-08-28 14:34: "Stopped before completion, 4 remaining, no restart/retry
  // button"). Only a genuinely finished campaign has nothing to offer.
  if (!s.launchFailed && !isError && terminalPresentation(s).pending === 0) return null;
  const id = _esc(String(s.id || ''));
  const sent = Number(s.totalProcessed) || 0;
  const total = Number(s.totalTargets) || 0;
  const reason = String(s.endNotice || s.stopReason || '').trim();
  // A launch that the server refused never created a campaign, so there is
  // nothing to restart — the operator has to go back and change something. The
  // strip used to tear itself down the moment the native alert was dismissed,
  // leaving no trace of why (operator, 2026-08-28 14:09: "the strip, after I
  // pressed OK, just closed itself").
  if (s.launchFailed) {
    return {
      headline: 'The campaign was not started',
      detail: [reason, 'Nothing was sent and no lead was used, so nothing has to be undone.'].filter(Boolean).join(' '),
      label: 'Back to launch settings',
      onclick: 'dismissCloudLaunch()',
    };
  }
  // Continue-where-it-left-off in both cases: with nothing sent it covers every
  // lead anyway, and it can never re-invite someone who was already contacted.
  const onclick = s._cloud ? `restartCloudCampaignUI('${id}', false)` : `restartLocalFromItem('${id}', false)`;
  if (sent > 0) {
    const left = Math.max(0, total - sent);
    return {
      headline: `Stopped after ${sent} of ${total}`,
      detail: [reason, left ? `${left} lead${left === 1 ? '' : 's'} ${left === 1 ? 'is' : 'are'} still queued.` : ''].filter(Boolean).join(' '),
      label: `Carry on from lead ${sent + 1}`,
      onclick,
    };
  }
  return {
    headline: isError ? 'This campaign never started' : 'Stopped before anything was sent',
    detail: [reason, total ? `Nothing was sent, so all ${total} leads are still queued.` : 'Nothing was sent.'].filter(Boolean).join(' '),
    label: isError ? 'Try again' : 'Start from the first lead',
    onclick,
  };
}
