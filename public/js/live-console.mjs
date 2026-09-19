// Floating live console — pure helpers.
// Imported by public/js/app.js for DOM glue and by tests/live-console.test.js
// for unit verification. Keep this module DOM-free: no document/window access.

const MODE_LABELS = {
  connect_only: 'CC',
  connect_and_introduce: 'CC+IC',
  message_only: 'DM',
  inmail_only: 'IM',
  open_profile_only: 'OP-DM',
  check_status: 'CHK',
  check_dms: 'DMS',
  post_amplification: 'AMP',
};

export function computePillState(s) {
  if (!s || typeof s !== 'object') {
    return _emptyState();
  }

  const name = (s.name || '').trim() || '—';
  const modeShort = MODE_LABELS[s.mode] || (s.mode || '').toUpperCase() || '—';
  const errCount = Array.isArray(s.errors) ? s.errors.length : 0;
  const parkedCount = Array.isArray(s.parked) ? s.parked.length : 0;
  const throttleActive = !!(s.throttle && s.throttle.active);
  const isChecking = !!s.monitoringCheckInProgress;
  const isPaused = !!s.paused;
  const isMonitoring = s.state === 'monitoring';

  // Precedence: paused > throttle > parked > errors > healthy.
  let dot = 'gray';
  let pulse = false;
  let labelSuffix = modeShort;

  if (isChecking) {
    dot = 'green';
    pulse = true;
    labelSuffix = 'checking';
  } else if (isPaused) {
    dot = 'gray';
    pulse = false;
    labelSuffix = 'paused';
  } else if (throttleActive) {
    dot = 'amber';
    pulse = false;
  } else if (parkedCount > 0) {
    dot = 'amber';
    pulse = false;
  } else if (s.running || isMonitoring) {
    dot = 'green';
    pulse = true;
    if (isMonitoring) labelSuffix = 'monitoring';
  }

  // Footer/state label. The server sends raw campaign.state, which is null
  // (→ 'idle') during ACTIVE sending — only flipping to 'monitoring'/'done'
  // later. Derive a truthful display state so the console never reads
  // "STATE · IDLE" while a campaign is actually running.
  const displayState = isChecking ? 'checking'
    : isPaused ? 'paused'
    : isMonitoring ? 'monitoring'
    : s.running ? 'running'
    : (s.state || 'idle');

  // Selected GoLogin account roster for this run. Sent by the server as
  // profileNames (campaign.js:1755) and present before/during/after a run —
  // this is "who we selected", distinct from currentProfile (who's acting now).
  const current = s.currentProfile || '';
  const accounts = (Array.isArray(s.profileNames) ? s.profileNames : [])
    .filter((n) => typeof n === 'string' && n.length)
    .map((n) => ({ name: n, active: !!current && n === current }));

  return {
    dot,
    pulse,
    label: `${name} · ${labelSuffix}`,
    name,
    mode: modeShort,
    processed: Number(s.processedToday) || 0,
    total: Number(s.totalTargets) || 0,
    lead: (s.currentAction && s.currentAction.lead) || '—',
    account: s.currentProfile || '—',
    accounts,
    action: (s.currentAction && s.currentAction.label) || '—',
    state: displayState,
    logs: Array.isArray(s.logs) ? s.logs.slice(-8) : [],
    errSegment: errCount > 0 ? `· ${errCount} err` : null,
    parkedSegment: parkedCount > 0 ? `· ${parkedCount} parked` : null,
    throttleReason: throttleActive ? (s.throttle.reason || null) : null,
  };
}

function _emptyState() {
  return {
    dot: 'gray', pulse: false, label: '—', name: '—', mode: '—',
    processed: 0, total: 0, lead: '—', account: '—', accounts: [], action: '—',
    state: 'idle', logs: [],
    errSegment: null, parkedSegment: null, throttleReason: null,
  };
}

// Persistent visibility. The console is a first-class monitor, NOT a
// dashboard-only-when-away widget: it stays available whenever there is
// campaign context to show — running, paused, monitoring, or just a selected
// account roster staged before a run / left over after one ends. Route is
// irrelevant (the old logic hid it on the dashboard, which is exactly where
// the operator watches a run — hence "console showed nothing while running").
// `hash` is accepted but ignored for back-compat with existing callers.
export function shouldShowConsole(/* { running, paused, state, hasRoster } = {} */) {
  // v2.72: the operator wants the log ALWAYS available — on the dashboard, while
  // building a new campaign, idle, running, or monitoring. Always show the
  // console (it collapses to the right-edge "Console" lip when not expanded).
  return true;
}
