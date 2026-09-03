// Pure builders for the live banner and the per-account panel. No DOM, so
// node --test can drive them. The DOM render lives in app.js beside the other
// card fillers, matching how vjcard.mjs already splits.

// Deliberately imports nothing. Browser modules here load over HTTP from /js/,
// while node --test loads this file from disk, and no single specifier is valid
// for both. The one rule this file borrows from live-activity.mjs (a monitor
// task that is 'pending' and already due means the worker is booting) is
// restated in isWaking below rather than imported.
const mmss = (s) => {
  const n = Math.max(0, Math.floor(Number(s) || 0));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
};

/**
 * The cloud worker is scale-to-zero: a check that is due but that no worker has
 * claimed yet means a machine is booting. Mirrors monitorHeroState()'s 'waking'
 * branch in live-activity.mjs.
 */
function isWaking(s, now = Date.now()) {
  if (s.monitorTaskStatus !== 'pending') return false;
  const due = Date.parse(s.monitorTaskDueAt || '');
  return Number.isFinite(due) && now >= due;
}

/** Where the work is happening, in the operator's words. */
export function whereLabel(runsOn) {
  return String(runsOn || 'vm') === 'local' ? 'on this Mac' : 'on the Cloud VM';
}

/**
 * The banner shown while something is genuinely in flight, or null.
 *
 * Monitoring between checks returns null ON PURPOSE: nothing is running, and a
 * banner that is always up is a banner nobody reads.
 */
export function bannerFor(status) {
  const s = status || {};
  const action = s.currentAction || {};

  // A stop in progress outranks everything: the operator just pressed it and
  // needs to see that it landed, or they press it three more times.
  if (s.checkStopping) {
    return {
      tone: 'stopping',
      l1: 'Stopping the check',
      l2: 'Closing the browsers now. Monitoring carries on, the next check is still scheduled.',
      big: '', cap: '',
    };
  }

  // An acceptance sweep can transition into introductions without clearing the
  // outer "check in progress" flag. The concrete browser action must win, or
  // the banner says "Checking" while the stage and log say "Introducing".
  if (action.phase === 'introducing') {
    const done = Number(action.done) || 0;
    const total = Number(action.total) || 0;
    const pos = total ? `${Math.min(done, total)} of ${total}` : '';
    return {
      tone: 'intro',
      l1: action.stepLabel || 'Sending an introduction',
      l2: `${action.lead || 'the accepted connection'} · from ${action.account || s.liveAccount || 'an account'} · ${whereLabel(s.runsOn)}`,
      big: pos,
      cap: pos ? 'introductions' : '',
    };
  }

  if (s.monitoringCheckInProgress || action.phase === 'checking') {
    // The local status payload carries none of these counters. An absent number
    // prints nothing rather than a confident 1 of 3 while the sweep is on its
    // third account.
    const done = Number(s.accountsDone) || 0;
    const total = Number(s.accountsTotal) || 0;
    // accountsDone is a completed/current count on both engines, not a zero-
    // based index. Adding one made the first VM account read "2 of 3".
    const pos = (s.accountsDone != null && total) ? `${Math.min(Math.max(done, 1), total)} of ${total}` : '';
    const el = s.elapsedSec != null ? ` · ${mmss(s.elapsedSec)} elapsed` : '';
    return {
      tone: 'check',
      l1: 'Checking right now',
      l2: `${s.liveAccount || 'an account'} · reading its sent invitations · ${whereLabel(s.runsOn)}`,
      big: pos,
      cap: pos ? `accounts${el}` : '',
    };
  }

  // The cloud worker powers down between checks, so a due check waits ~2 minutes
  // for a machine. This used to drop out of the banner entirely and read as the
  // run having stopped. Same family, same blue: it is monitoring, not an error.
  if (s.state === 'monitoring' && isWaking(s)) {
    return {
      tone: 'wake',
      l1: 'Starting the cloud machine',
      l2: 'It powers down between checks and takes about two minutes to start up. Nothing is lost, the check runs the moment it is ready.',
      big: '', cap: '',
    };
  }

  if (s.running && s.live) {
    const a = s.currentAction || {};
    const done = Number(s.batchDone) || 0;
    const size = Number(s.batchSize) || 8;
    // The person first. The operator is watching a human being get contacted,
    // not an account do work.
    const who = [a.leadName, a.company].filter(Boolean).join(' · ');
    const el = s.elapsedSec != null ? ` · ${mmss(s.elapsedSec)} elapsed` : '';
    return {
      tone: 'send',
      l1: 'Sending right now',
      l2: `${who || 'the next person'} · from ${s.liveAccount || 'an account'} · ${whereLabel(s.runsOn)}`,
      big: s.batchDone != null ? `${Math.min(done + 1, size)} of ${size}` : '',
      // BATCH_SIZE is the turn, never the day. Naming it here is what stops the
      // "8" being read as the daily cap.
      cap: `this batch${el}`,
    };
  }

  return null;
}

// Copy is verbatim from the approved interactive sketch
// public/sketches/2026-08-21-handover-banner.html. It names BOTH ends every
// time: the shipped banner said only "Handover", which told the operator
// neither direction nor what to do.
const HANDOVER = {
  cloud: {
    tone: 'to-cloud',
    l1: 'Moving to the Cloud VM',
    l2: (n) => `Taking ${n} off this Mac and handing it to the VM, so it keeps going after you close the app.`,
    right: ['Leave it open', 'This takes a moment. Nothing is lost if you wait.'],
    doneL1: 'Now running on the VM',
    doneL2: (n) => `${n} is on the Cloud VM. An acceptance check starts there automatically. You can close the app.`,
    doneRight: ['Done', 'Safe to close the app now.'],
  },
  local: {
    tone: 'to-local',
    l1: 'Coming back to this Mac',
    l2: (n) => `Taking ${n} off the Cloud VM so it runs here, in your own browsers.`,
    right: ['Leave it open', 'This takes a moment. Closing now stops the run.'],
    doneL1: 'Now running on this Mac',
    doneL2: (n) => `${n} is running here. An acceptance check starts automatically. Keep the app open.`,
    doneRight: ['Done', 'Keep the app open to keep it running.'],
  },
};

/**
 * The banner for a campaign that is moving between this Mac and the Cloud VM.
 * `to` is 'cloud' or 'local'. `landed` swaps it to the confirmation beat.
 */
export function handoverBanner({ to, name, landed = false }) {
  const k = HANDOVER[to === 'local' ? 'local' : 'cloud'];
  const n = name || 'this campaign';
  return {
    tone: k.tone,
    l1: landed ? k.doneL1 : k.l1,
    l2: (landed ? k.doneL2 : k.l2)(n),
    right: landed ? k.doneRight : k.right,
    landed,
  };
}

/**
 * Which column the rail scrolls to. The account that is working sits in the
 * CENTRE, so the previous one is visible to its left and the next to its right.
 * The first account is the exception: it sits flush left, because there is no
 * previous one to show.
 */
export function railIndex(cols) {
  const i = (cols || []).findIndex((c) => c && c.live);
  return i > 0 ? i : 0;
}

/** One mark per lead in the turn: done, the one going out now, or still to come. */
export function batchPips(done, size, live) {
  const d = Math.max(0, Number(done) || 0);
  const n = Math.max(0, Number(size) || 0);
  return Array.from({ length: n }, (_, k) => (k < d ? 'on' : (live && k === d ? 'now' : '')));
}

/**
 * One column per account.
 *
 * Steps are dropped from every column except the one that is working. An idle
 * account showing a frozen checklist reads as if it were live, which is the
 * same lie the frozen card told.
 */
export function accountColumns(status) {
  const rows = (status && Array.isArray(status.accountPanel)) ? status.accountPanel : [];
  return rows.map((a) => ({
    email: a.email || '',
    state: a.state || '',
    live: !!a.live,
    // Explicit, from the engine. The card used to infer both by regexing this
    // row's prose, which missed the weekly line entirely — that inference stays
    // as the fallback so a page loaded against an engine that predates the
    // flags is no worse off than it was.
    weeklyCap: a.weeklyCap != null
      ? !!a.weeklyCap
      : /weekly/.test(`${a.state || ''} ${a.sub || ''}`.toLowerCase()),
    needsLogin: a.needsLogin != null
      ? !!a.needsLogin
      : (/needs-login|logged-out|stopped/.test(String(a.state || '').toLowerCase())
        && /login|logged/.test(`${a.state || ''} ${a.sub || ''}`.toLowerCase())),
    // Two numbers that must never be read as one. batchDone/batchSize is this
    // account's position in ONE turn; sentToday/dailyLimit is its whole day.
    batchDone: Number(a.batchDone) || 0,
    // A mode that drains every row in one go has no turn size at all, so an
    // absent size stays absent instead of borrowing the eight.
    batchSize: a.batchSize == null ? null : Number(a.batchSize) || 0,
    sentToday: Number(a.sentToday) || 0,
    dailyLimit: Number(a.dailyLimit) || 0,
    sub: a.sub || '',
    reached: Array.isArray(a.reached) ? a.reached : [],
    missed: Array.isArray(a.missed) ? a.missed : [],
    steps: a.live && Array.isArray(a.steps) ? a.steps : [],
    result: a.result || '',
  }));
}
