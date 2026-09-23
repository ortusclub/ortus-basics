// The live log is the operator-visible event stream. The stage must never tell
// a second, independently reconstructed story. Pick its newest operational
// line and remove only renderer metadata (level/time), leaving the engine's
// actual words intact.
function relativeSchedule(raw, now = new Date()) {
  // "Fri, 28 Aug, 17:12" carries no year, and JS then parses it as 2001 — which
  // rendered a check scheduled for later today as "mar 28 ago at 17:12". Lend
  // it the current year when it has none of its own.
  const text = String(raw).trim();
  const dated = /\d{4}/.test(text) ? text : `${text} ${now.getFullYear()}`;
  const parsed = new Date(dated.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+UTC$/i, '$1T$2:00Z'));
  if (Number.isNaN(parsed.getTime())) return String(raw).trim();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const days = Math.round((target - today) / 86400000);
  const time = parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  return `${parsed.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${time}`;
}

function relativeDay(raw, now = new Date()) {
  const parsed = new Date(String(raw).trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+UTC$/i, '$1T$2:00Z'));
  if (Number.isNaN(parsed.getTime())) return String(raw).trim().toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const days = Math.round((target - today) / 86400000);
  if (days <= 0) return 'later today';
  if (days === 1) return 'tomorrow';
  return parsed.toLocaleDateString([], { weekday: 'long' });
}

// Renderer metadata the banner must never repeat: an account address, a date
// or a clock. In this log they always arrive as their own "·" segment
// (`· via matt@ortus.com`, `· 14:56`, `· 2026-08-27`) or as a bracketed
// prefix, so they are dropped at SEGMENT level. Deleting them mid-sentence
// would leave stumps like "parked until (30 min)".
// Mirrors _WAIT_FRESH_MS in app.js: how long one "No account free right now"
// line stays relevant.
const WAIT_HEARTBEAT_GRACE_MS = 15 * 60 * 1000;

const BANNER_META = /^\[?\s*(?:via\s+|at\s+|on\s+|from\s+)?(?:[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}|\d{4}-\d{2}-\d{2}(?:T\S+)?|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?)\s*\]?$/i;

function actionOnlyHeadline(raw) {
  return String(raw || '')
    .replace(/^\[\s*[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\s*\]\s*/i, '')
    .replace(/^[\u{1F4E1}\u{1F5A5}\u23F8\u23F9\u23F3\u{1F319}\u26D4\u{1F6AB}\uFE0F\s·•—–:-]+/u, '')
    .split(/\s*[·•]\s*/)
    .map((seg) => seg
      // "cindy.siapno@ortus.solutions invited Susan Mena" must headline as
      // "invited Susan Mena": the address sits mid-sentence, so a whole-segment
      // rule cannot reach it. Take any leading "via"/"from"/"by" with it.
      .replace(/\b(?:via|from|by)\s+[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/gi, '')
      .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,;:—–]+|[\s,;:—–]+$/g, ''))
    .filter((seg) => seg && !BANNER_META.test(seg))
    .join(' · ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function readablePresentation(line, phase = '', now = new Date()) {
  const clean = line.replace(/^[◷↻⟳⏱]\s*/u, '').trim();
  let m;
  if ((m = clean.match(/^Check finished with an error\s*[—–-]\s*(?:Action required:\s*)?(.+)$/i))) {
    return {
      kind: 'check-error', eyebrow: 'Check incomplete',
      headline: 'Not every account could be checked',
      detail: m[1].trim(),
      explanation: 'Monitoring remains active. Fix the named account before the next check.',
    };
  }
  // Older engine rows included a raw UTC timestamp and repeated the entire
  // explanation. Keep those forensic rows intact in the log, but present the
  // same state in the compact human language used by current engine rows.
  if ((m = clean.match(/^🌙?\s*No account can send until\s+(.+?)\s+[—–]\s+sending stops here and acceptance checks carry on\.\s*(\d+)\s+leads?\s+left/iu))) {
    const when = relativeDay(m[1], now);
    return {
      kind: 'sending-paused-monitoring', eyebrow: 'Monitoring is active',
      headline: `Sending pauses until ${when}`,
      detail: `${m[2]} leads remain · acceptance checks continue · resumes automatically ${when}`,
      explanation: 'Nothing needs to be done.',
    };
  }
  if ((m = clean.match(/^🌙?\s*Sending pauses until\s+([^—–]+?)\s+[—–]\s+acceptance checks continue\.\s*(\d+)\s+leads?\s+remain/iu))) {
    const when = m[1].trim().toLowerCase();
    return {
      kind: 'sending-paused-monitoring', eyebrow: 'Monitoring is active',
      headline: `Sending pauses until ${when}`,
      detail: `${m[2]} leads remain · acceptance checks continue · resumes automatically ${when}`,
      explanation: 'Nothing needs to be done.',
    };
  }
  if ((m = clean.match(/^📡?\s*\[([^\]]+)\]\s*Check now\s+[—–]\s+bulk check pass starting/iu))) {
    return {
      kind: 'local-browser-starting', account: m[1], eyebrow: 'Starting this Mac',
      headline: 'Starting the local browser',
      detail: `${m[1]} · Browser not open yet`,
      explanation: 'The check begins when the browser reports that it is open.',
    };
  }
  if ((m = clean.match(/^📡?\s*\[([^\]]+)\]\s*Launching browser/iu))) return {
    kind: 'account-browser-opening', account: m[1], eyebrow: 'Starting account check',
    headline: 'Opening the sender browser', detail: m[1], explanation: '',
  };
  if ((m = clean.match(/^(?:🖥️)?\s*Opening\s+([^'\s]+)'s browser on the VM\s*[—–]\s*(\d+)\s*\/\s*(\d+)\s*sent today/iu))) return {
    kind: 'sender-browser-opening', account: m[1], eyebrow: 'Opening sender account',
    headline: 'Opening the sender browser',
    detail: `${m[1]} · ${m[2]} of ${m[3]} sent today`, explanation: '',
  };
  if ((m = clean.match(/^(.+?)\s+is taking up to\s+(\d+)\s+people this turn/i))) return {
    kind: 'sender-batch-starting', account: m[1], eyebrow: 'Sending is active',
    headline: `Taking up to ${m[2]} leads this turn`, detail: m[1], explanation: '',
  };
  if ((m = clean.match(/^(.+?)\s+[—–]\s+browser closed\s*[·•]\s*(.+)$/i))) return {
    kind: 'sender-browser-closed', account: m[1], eyebrow: 'Sender turn complete',
    headline: 'Sender browser closed', detail: m[2], explanation: '',
  };
  if ((m = clean.match(/^(.+?)\s+[—–]\s+(?:logged out of LinkedIn|needs re-login)(.*)$/i))) return {
    kind: 'sender-unavailable', account: m[1], eyebrow: 'Sender needs attention',
    headline: 'LinkedIn login required', detail: `${m[1]}${m[2] || ''}`, explanation: '',
  };
  if ((m = clean.match(/^(.+?)\s+[—–]\s+backing off\s+(.+)$/i))) return {
    kind: 'sender-backoff', account: m[1], eyebrow: 'Sender cooling down',
    headline: 'Waiting before the next attempt', detail: m[2], explanation: '',
  };
  // "⏳ No account free right now — 1 resting between batches · 1 parked (…) ·
  // retrying automatically". The engine repeats this every 10 minutes while it
  // has nothing it can send from. It is a heartbeat, not something that
  // happened, and latestBannerEvent below refuses to let a fresh one bury the
  // event it interrupted.
  if ((m = clean.match(/^[\u23F3\u231B]?\s*No account free right now\s*(?:[—–-]\s*(.*))?$/i))) return {
    kind: 'waiting-for-account', eyebrow: 'Waiting for a free account',
    headline: 'No account free right now',
    detail: String(m[1] || '').replace(/\s*·\s*retrying automatically\s*$/i, '').trim(),
    explanation: 'It retries by itself as soon as an account frees up.',
  };
  if ((m = clean.match(/^Resumed sending\s*[—–]\s*(.+)$/i))) return {
    kind: 'sending-resumed', eyebrow: 'Sending is active',
    headline: 'Sending resumed', detail: m[1], explanation: '',
  };
  if (/^Started\s*\(continuing where it left off\)/i.test(clean)) return {
    kind: 'sending-resumed', eyebrow: 'Sending is active',
    headline: 'Continuing where it left off', detail: '', explanation: '',
  };
  // Its twin. Only the "continuing" wording was matched, so a restart from the
  // beginning left the card sitting in the monitoring view with the acceptance
  // countdown still running.
  if (/^Started\s*\(from the beginning\)/i.test(clean)) return {
    kind: 'sending-resumed', eyebrow: 'Sending is active',
    headline: 'Started from the beginning', detail: '', explanation: '',
  };
  if ((m = clean.match(/^📡?\s*\[([^\]]+)\]\s*Sweeping recent connections/iu))) return {
    kind: 'account-checking', account: m[1], eyebrow: 'Checking acceptances',
    headline: 'Checking recent connections', detail: m[1], explanation: '',
  };
  if ((m = clean.match(/^Nobody has accepted\s+([^'\s]+)'s\s+(\d+)\s+outstanding invitations yet\.\s*(\d+)\s+rows refreshed/i))) return {
    kind: 'account-checked', account: m[1], eyebrow: 'Account checked',
    headline: 'Account check finished', detail: `${m[1]} · 0 newly accepted · ${m[3]} rows refreshed`, explanation: '',
  };
  if ((m = clean.match(/^📡?\s*\[([^\]]+)\]\s*Bulk check:\s*(\d+)\s+marked Connected/iu))) return {
    kind: 'account-checked', account: m[1], eyebrow: 'Account checked',
    headline: 'Account check finished', detail: `${m[1]} · ${m[2]} newly accepted`, explanation: '',
  };
  if (/^📡?\s*Manual bulk check complete/iu.test(clean)) return {
    kind: 'check-complete', eyebrow: 'Acceptance check complete',
    headline: 'Finished checking all available accounts',
    detail: clean.replace(/^📡?\s*Manual bulk check complete\s*[—–]?\s*/iu, ''), explanation: '',
  };
  if (/^Check now\b/i.test(clean)) return {
    kind: 'check-queued', eyebrow: 'Waiting for the VM worker',
    headline: 'Acceptance check queued',
    explanation: 'The VM is waking and has not selected an account yet. A cold start normally takes about two minutes.',
  };
  // The engine has used both "nothing happens until then" and "monitoring
  // stays active" over time. The schedule is the state; trailing narration is
  // log detail and must never become a giant permanent headline.
  if ((m = clean.match(/^Next check\s+(.+?)\s*[·•](?:\s|$)/i))) {
    return {
      kind: 'check-waiting', eyebrow: 'Monitoring is active',
      headline: 'Waiting for the next acceptance check',
      detail: relativeSchedule(m[1], now),
      explanation: 'Nothing needs to be done now.',
    };
  }
  // The engine says the same thing in several voices: "Monitoring resumed ·
  // next check at 17:08" after an app restart, "Monitoring moved to this Mac ·
  // next check Fri, 28 Aug, 17:12 (every 60 min) · monitoring ends …" after a
  // handover. Both are the schedule, and neither matched, so they fell through
  // to the generic event mapper and one card read MONITORING RESUMED · NEXT
  // CHECK AT 17:08 beside two others reading WAITING FOR THE NEXT ACCEPTANCE
  // CHECK. Same state, three sentences. Reported 2026-08-28.
  if ((m = clean.match(/^Monitoring\s+(?:resumed|moved\s+to\s+[^·•]+?)\s*[·•]\s*next check\s+(?:at\s+)?([^·•(]+)/i))) {
    const raw = m[1].trim().replace(/[.\s]+$/, '');
    return {
      kind: 'check-waiting', eyebrow: 'Monitoring is active',
      headline: 'Waiting for the next acceptance check',
      detail: /^\d{1,2}:\d{2}$/.test(raw) ? `Today at ${raw}` : relativeSchedule(raw, now),
      explanation: 'Nothing needs to be done now.',
    };
  }
  if ((m = clean.match(/^Monitoring active\s*[·•]\s*next check at\s+(\d{1,2}:\d{2})/i))) {
    return {
      kind: 'check-waiting', eyebrow: 'Monitoring is active',
      headline: 'Waiting for the next acceptance check',
      detail: `Today at ${m[1]}`,
      explanation: 'Nothing needs to be done now.',
    };
  }
  // Sending progress is deliberately verbose in the forensic log. Its prefix
  // can repeat the sender twice, followed by lead, step, detail and batch turn.
  // The banner shows each fact once and translates internal verbs into plain
  // operator language without weakening the underlying log.
  if ((m = clean.match(/^(.*?)\s+[—–]\s+([^·•]+)(?:\s*[·•]\s*(.*))?$/i))
      && /@/.test(m[1]) && /sending batch|Profile opened|Stamping the result/i.test(clean)) {
    const context = m[1].split(/\s*[·•]\s*/).map((s) => s.trim()).filter(Boolean);
    const account = context.find((s) => /@/.test(s)) || '';
    const lead = [...context].reverse().find((s) => !/@/.test(s)) || 'this lead';
    const step = m[2].trim();
    const tail = (m[3] || '').trim();
    const turn = clean.match(/(\d+)\s+of\s+(\d+)\s+(?:this\s+)?sending batch/i);
    let headline = `${step} — ${lead}`;
    let action = tail.split(/\s*[·•]\s*/)[0] || '';
    let kind = 'sending-progress';
    if (/Profile opened\s+[—–]\s+preparing the page/i.test(step)) {
      kind = 'profile-loading';
      headline = `Opening ${lead} on LinkedIn`;
      action = 'Waiting for the profile page';
    } else if (/Stamping the result to the sheet/i.test(step)) {
      kind = 'saving-result';
      headline = `Saving ${lead}’s result`;
      action = 'Writing to the campaign sheet';
    } else if (/Profile ready/i.test(step)) {
      headline = `${lead}’s profile is ready`;
      action = 'Checking available actions';
    }
    return {
      kind, account,
      eyebrow: kind === 'saving-result' ? 'Recording the result' : 'Working on the next lead',
      headline,
      detail: [account, action, turn ? `Lead ${turn[1]} of ${turn[2]}` : ''].filter(Boolean).join(' · '),
      explanation: '',
    };
  }
  // The tail belongs in `detail`, like every sibling presentation. Putting the
  // raw line in `explanation` instead left `detail` to the `|| line` fallback,
  // and the card composes its sub-line as `detail · explanation` — so the whole
  // sentence printed twice (screenshot, 2026-08-27).
  if (/check complete/i.test(clean)) return {
    kind: 'check-complete', eyebrow: 'Acceptance check complete',
    headline: 'Every available account has finished this check',
    detail: clean.replace(/^[\u2713\u2714]?\s*Check complete\s*[\u2014\u2013\u00b7-]?\s*/i, '').trim(), explanation: '',
  };
  if ((m = clean.match(/^Checking\s+(.+?)(?:\.{3}|\s*[·•]|$)/i))) return { kind: 'account-checking', account: m[1], eyebrow: 'Checking acceptances', headline: 'Checking recent connections', detail: m[1], explanation: 'The app is reading this account’s recent LinkedIn connections now.' };
  if (/identity restricted/i.test(clean)) {
    const who = clean.split(/\s+[—–]\s+/)[0];
    return { kind: 'account-skipped', account: who, eyebrow: 'Account unavailable', headline: 'Account skipped safely', detail: `${who} · Identity Restricted`, explanation: 'Other available accounts continue.' };
  }
  if ((m = clean.match(/^(.+?)\s+[—–]\s+(\d+) newly accepted/i))) return { kind: 'account-checked', account: m[1], eyebrow: 'Account checked', headline: 'Account check finished', detail: clean, explanation: '' };
  if (/browser (?:opened|opening)|opening .+browser/i.test(clean)) return { eyebrow: phase === 'checking' ? 'Starting acceptance check' : 'Opening sender account', headline: clean, explanation: 'The browser is opening. The next verified action will appear here and in the log.' };
  if (/\b(?:CC|connection request) sent\b/i.test(clean)) return { kind: 'connection-confirmed', eyebrow: 'Connection request confirmed', headline: clean, explanation: 'The result was confirmed and recorded before moving to the next lead.' };
  if (/introduc(?:ed|tion)|message sent/i.test(clean)) return { kind: 'introduction-confirmed', eyebrow: 'Introduction confirmed', headline: clean, explanation: 'The message result was confirmed and recorded in the campaign sheet.' };
  if (/check stopped|stop requested|stopping/i.test(clean)) return { kind: 'check-stopping', eyebrow: 'Stopping check', headline: 'Closing the current browser now', explanation: 'Unconfirmed work will be checked again next time. Monitoring remains active.' };
  return { eyebrow: phase === 'monitoring' ? 'Monitoring update' : phase === 'checking' ? 'Acceptance-check update' : 'Campaign update', headline: clean, explanation: 'This is the newest verified campaign event.' };
}

// The event shown in the banner also owns the card's activity mode. Without
// this mapping a fresh sending row could be painted inside a stale canonical
// "starting" or "monitoring" shell, producing contradictory facts and the
// wrong right-hand panel.
export function bannerEventPhase(event, fallback = '') {
  if (!event) return fallback;
  const kind = String(event.kind || '');
  if (kind === 'check-waiting' || kind === 'sending-paused-monitoring') return 'monitoring';
  // A finished check is a record, not an activity. Mapping it to 'checking'
  // kept the stage spinning with "Selecting account" and an elapsed clock on a
  // STOPPED card, long after the sweep had ended (Sam, 2026-09-23 20:45).
  if (kind === 'check-complete') return fallback === 'monitoring' ? 'monitoring' : 'checked';
  if (kind.startsWith('check-') || kind.startsWith('account-') || kind === 'local-browser-starting') return 'checking';
  if ([
    'sender-browser-opening', 'sender-batch-starting', 'sender-browser-closed',
    'sender-unavailable', 'sender-backoff', 'sending-resumed', 'sending-progress',
    'profile-loading', 'saving-result', 'connection-confirmed', 'introduction-confirmed',
  ].includes(kind)) return 'sending';
  return fallback;
}

export function latestBannerEvent(logs = [], { phase = '', now = new Date() } = {}) {
  if (!Array.isArray(logs)) return null;
  const candidates = [];
  for (let i = 0; i < logs.length; i += 1) {
    const rawEvent = logs[i];
    let line = String(rawEvent && rawEvent.line != null ? rawEvent.line : rawEvent || '').trim();
    if (!line) continue;
    const envelope = line.match(/^\[([^\]]+)\]/);
    const objectTime = rawEvent && typeof rawEvent === 'object'
      ? Number(rawEvent.t || rawEvent.at || new Date(rawEvent.ts || rawEvent.timestamp || 0))
      : 0;
    const envelopeTime = envelope ? Number(new Date(envelope[1])) : 0;
    const clock = line.match(/\s+[·•]\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/);
    const clockTime = clock
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(clock[1]), Number(clock[2]), Number(clock[3] || 0)).getTime()
      : 0;
    // Totals and divider rows are pinned to the bottom of merged logs, so they
    // are not chronological activity and must not permanently own the banner.
    if (/^(?:SUM\b|Σ\s*Total\b|[-—–_─━═]{3,})/iu.test(line)) continue;
    line = line
      // Local engine rows can arrive with their original ISO envelope inside
      // the API log row. Strip transport timestamps before interpreting the
      // human event; they must never become part of an account name/headline.
      .replace(/^(?:\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*)+/, '')
      .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+(?:OK|LOG|INFO|WARN|ERR(?:OR)?)\s+/i, '')
      .replace(/^(?:OK|LOG|INFO|WARN|ERR(?:OR)?)\s+/i, '')
      .replace(/\s+[·•]\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/i, '')
      // Status glyphs are decoration, never content. This used to be a
      // hand-maintained emoji list, which is always one glyph behind the log:
      // U+FE0F (the variation selector trailing ▶️) survived it, and 🔲 was
      // never in it at all — so those lines missed their presentation, fell back
      // to the generic "newest verified campaign event", and printed the leftover
      // glyph in the card (screenshots, 2026-08-27). Match the CLASS instead.
      .replace(/^[\p{Extended_Pictographic}\p{So}\uFE0E\uFE0F\s]+/u, '')
      .trim();
    // A row made only from glyphs/rules is presentation, not an event. Unicode
    // letter/number detection also keeps names in every supported locale.
    if (!line || !/[\p{L}\p{N}]/u.test(line)) continue;
    const parts = line.split(/\s+[—–]\s+/, 2);
    const first = parts[0].trim();
    if (!/[\p{L}\p{N}]/u.test(first)) continue;
    const presentation = readablePresentation(line, phase, now);
    candidates.push({
      line,
      headline: actionOnlyHeadline(presentation.headline || first),
      eyebrow: presentation.eyebrow,
      kind: presentation.kind || 'event',
      account: presentation.account || '',
      explanation: presentation.explanation,
      detail: presentation.detail || line,
      at: objectTime || envelopeTime || clockTime || 0,
      order: i,
    });
  }
  if (!candidates.length) return null;
  // `logs` arrives in exactly the order the operator reads it. Both producers
  // guarantee that: the cloud merge sorts every source by its real timestamp
  // and pins the Σ footer last, and a local campaign's log is append-only. So
  // the banner is simply the log's last operational row.
  //
  // Re-ranking rows here by a "· HH:MM" parsed back out of the text is what
  // broke it. That suffix is a DISPLAY stamp: it carries no date, and a row
  // derived from a sheet lead is re-stamped when the sheet syncs, not when the
  // work happened. A months-old introduction could therefore outscore the send
  // that just finished, which is how the card announced "JOSE A. · INTRODUCED"
  // while the log's last line was a connection request being written
  // (operator screenshot, 2026-08-27 15:18). Ordering is the merge's job; the
  // banner's job is to agree with what is on screen.
  const newest = candidates[candidates.length - 1];
  // The engine emits "No account free right now" the moment a sender closes its
  // browser, so it lands seconds after the turn that just finished and made a
  // normal three-minute rest between batches read as a stall. While the event it
  // interrupted is still fresh, that event is the honest headline. Once the wait
  // has really gone on, this row IS the state and must own the banner: a
  // ten-hour cap with a green RUNNING dot over it is the exact failure this line
  // was added to make visible. Same 15-minute window app.js already uses to
  // decide whether one of these lines is still current (_WAIT_FRESH_MS).
  if (newest.kind === 'waiting-for-account') {
    const event = [...candidates].reverse().find((e) => e.kind !== 'waiting-for-account');
    if (event && newest.at && event.at && newest.at - event.at <= WAIT_HEARTBEAT_GRACE_MS) return event;
  }
  // Scheduling the next sweep is bookkeeping, not resolution. Keep a fresh
  // incomplete result visible even though the engine writes "Next check"
  // immediately after it. A later successful sweep produces a newer terminal
  // result and naturally clears this warning.
  if (newest.kind === 'check-waiting') {
    const error = [...candidates].reverse().find((event) => event.kind === 'check-error');
    if (error && (!newest.at || !error.at || newest.at - error.at <= 5 * 60 * 1000)) return error;
  }
  return newest;
}

// An idle monitoring snapshot may arrive one poll behind a freshly resumed
// sender. Hide only historical acceptance-check steps in that situation. The
// previous blanket `durableSweepIdle` guard also hid real sending events such
// as "Opening riccardo's browser on the VM", leaving the banner frozen on the
// next-check countdown while the campaign was visibly sending in the log.
export function bannerEventOwnsIdleMonitoring(event, durableSweepIdle = false) {
  if (!event) return false;
  if (!durableSweepIdle) return true;
  return ![
    'local-browser-starting',
    'account-browser-opening',
    'account-checking',
    'account-checked',
    'account-skipped',
    'check-complete',
    'check-waiting',
  ].includes(event.kind);
}
