// Invariants. They judge *outcomes* (what reached LinkedIn, what reached the
// sheet), never specific log text or code paths — so they hold however the
// campaigns are changed. A failure is either an engine bug or a gap in the fake
// world; the report says which evidence to look at.
import { profileFor } from './modes.mjs';
import { loadGasTables } from './gas.mjs';

const GAS = loadGasTables();

const slugOf = (url) => (String(url).match(/\/in\/([^/?#]+)/) || [])[1] || String(url);
const matches = (want, got) => want instanceof RegExp ? want.test(String(got ?? '')) : String(got ?? '') === String(want);
const CRASH_RE = /TypeError|ReferenceError|RangeError|Cannot read prop|is not a function|is not defined|unhandled/i;

// Screen scenario (run-screen.mjs): judged on what the operator can see and do, not on engine output.
function screenChecks(spec, r) {
  const out = [];
  const check = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail: ok ? '' : detail });
  const stepDone = r.steps.length && !r.failedStep;
  check('screen-setup-completes', stepDone, r.failedStep ? `${r.failedStep.name}: ${r.failedStep.detail}` : 'the screen test did not run');
  const bad = (r.controls || []).filter(c => !c.ok);
  check('screen-controls-available', !r.failedStep ? !bad.length : true,
    bad.map(c => `${c.label} — ${c.detail}`).join(' | '));
  check('screen-no-script-errors', !(r.errors || []).length, [...new Set(r.errors || [])].slice(0, 3).join(' | '));
  return out;
}

// "Press Start" scenario (run-gates.mjs): a good setup is accepted, a setup that cannot run is refused with a readable reason.
function gateChecks(spec, r) {
  const out = [];
  const check = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail: ok ? '' : detail });
  const readable = (t) => typeof t === 'string' && t.trim().length > 0 && !/undefined|\[object|NaN|^\s*null\s*$/.test(t);
  check('start-checks-run', !r.failed, r.failed || '');
  if (r.failed) return out;
  const byName = (n) => r.cases.find(c => c.name === n);
  const refused = r.cases.filter(c => c.expect === 'refused');
  const wrong = refused.filter(c => !(c.status >= 400 && c.status < 500 && readable(c.reply?.error)));
  check('start-refuses-bad-setups', !wrong.length,
    wrong.map(c => `${c.name}: ${c.status >= 200 && c.status < 300 ? 'it was accepted (' + (c.reply?.message || 'ok') + ')' : 'HTTP ' + c.status + ' ' + JSON.stringify(c.reply?.error ?? c.reply)}`).join(' | '));
  const good = byName('good-setup');
  check('start-accepts-good-setup', good && good.status === 200 && good.reply?.ok === true,
    good ? `HTTP ${good.status} ${JSON.stringify(good.reply?.error ?? good.reply)}` : 'the good setup was never sent');
  const blank = byName('sender-column-blank'), filled = byName('sender-column-filled');
  if (blank && filled) {
    const bad = [];
    if (!(blank.status === 200 && blank.reply?.ok === false)) bad.push(`a sheet with every sender blank was not flagged (HTTP ${blank.status} ${JSON.stringify(blank.reply)})`);
    if (!(filled.status === 200 && filled.reply?.ok === true)) bad.push(`a sheet with senders filled was flagged (HTTP ${filled.status} ${JSON.stringify(filled.reply)})`);
    check('sender-check-works', !bad.length, bad.join(' | '));
  }
  return out;
}

export function runChecks(spec, r) {
  if (spec.kind === 'gates') return gateChecks(spec, r);
  if (spec.kind === 'screen') return screenChecks(spec, r);
  const p = profileFor(spec.mode);
  const out = [];
  const check = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail: ok ? '' : detail });

  const slugs = spec.leads.map(l => slugOf(l['LinkedIn URL']));
  const script = (s) => spec.leadScript[s] || {};
  const rowsBySlug = new Map();
  for (const w of r.rowWrites) {
    const s = slugOf(w.linkedinUrl);
    rowsBySlug.set(s, [...(rowsBySlug.get(s) || []), w]);
  }
  const isSuccess = (w) => Object.entries(p.successStamp).every(([k, v]) => matches(v, w[k]));
  const recordedSuccess = new Set([...rowsBySlug].filter(([, ws]) => ws.some(isSuccess)).map(([s]) => s));
  const sends = p.sends === 'invite' ? r.invites.filter(i => i.status === 200) : r.messages.filter(m => m.ok !== false);
  const sentSlugs = [...new Set(sends.map(s => s.slug))];
  const sendsByAccount = (id) => sends.filter(s => s.account === id).length;

  // 1. The loop finishes.
  check('loop-finishes', !r.hung && !r.threw && !r.campaign.running,
    r.hung ? `still running after ${Math.round(spec.timeoutMs / 1000)}s` : r.threw ? `startCampaign threw: ${String(r.threw).split('\n')[0]}` : 'campaign.running still true');

  // 2. No crashes / unhandled errors.
  const crashLogs = r.logs.filter(l => CRASH_RE.test(l));
  check('no-crashes', !r.crashes.length && !crashLogs.length, [...r.crashes.map(c => c.split('\n')[0]), ...crashLogs.slice(0, 3)].join(' | '));

  // 3. No lead processed twice.
  const dup = sentSlugs.filter(s => sends.filter(x => x.slug === s).length > 1);
  check('no-lead-processed-twice', !dup.length, `sent more than once on LinkedIn: ${dup.join(', ')}`);

  // 4. Every lead gets an outcome written back (unless the run legitimately ran out of capacity).
  const healthy = spec.accounts.filter(a => !a.loggedOut && !a.launchFails);
  // Leads that only their Sender account may work: reachable only if that account is healthy.
  const ownerOf = (sl) => {
    if (!p.ownedBySender) return null;
    const row = spec.leads.find(l => slugOf(l['LinkedIn URL']) === sl);
    return spec.accounts.find(a => a.name === row?.Sender) || null;
  };
  const reachable = (sl) => { const o = ownerOf(sl); return !o || (!o.loggedOut && !o.launchFails); };
  const limit = spec.startOpts.dailyLimit;
  const capacity = p.noDailyLimit ? Infinity : healthy.length * limit;
  const exempt = new Set(slugs.filter(s => script(s).throttle || !reachable(s)));
  const mustStamp = slugs.filter(s => !exempt.has(s));
  const expectLimited = spec.expect.limitedTo != null;
  if (!expectLimited && capacity >= mustStamp.length) {
    const missing = mustStamp.filter(s => !rowsBySlug.has(s));
    check('every-lead-gets-a-status', !missing.length, `no sheet write for: ${missing.join(', ')}`);
  } else if (expectLimited) {
    const stamped = slugs.filter(s => rowsBySlug.has(s));
    check('limit-leaves-rest-untouched', stamped.length <= capacity, `${stamped.length} rows stamped but capacity is ${capacity}`);
  }

  // 4a. An ordinary lead (nothing wrong with it) must never be left in a TERMINAL failure state:
  //     cold-lead modes only pick up blank-Stage rows, so "Skipped…"/"Failed…" means it is never retried.
  const isOrdinary = (sl) => !(spec.expect.allowUnsent || []).includes(sl) && !script(sl).throttle && !script(sl).voyagerFail && !script(sl).messageFail
    && !['not_found', 'pending'].includes(script(sl).state);
  const terminalFail = slugs.filter(isOrdinary).filter(sl => {
    const last = (rowsBySlug.get(sl) || []).at(-1);
    return last && /^(Skipped|Failed)/i.test(String(last.stage || last.status || ''));
  });
  const stampOf = (sl) => { const w = (rowsBySlug.get(sl) || []).at(-1) || {}; return `${sl} → "${w.stage || w.status}"`; };
  if (healthy.length) check('ordinary-lead-not-left-terminal', !terminalFail.length,
    `a healthy lead was written off as terminal (never retried) — ${terminalFail.map(stampOf).join('; ')}`);

  // 4b. Healthy capacity + ordinary leads => they must actually be SENT (guards against vacuous passes).
  const ordinary = (sl) => reachable(sl) && !(spec.expect.allowUnsent || []).includes(sl) && !script(sl).throttle && !script(sl).voyagerFail && !script(sl).messageFail
    && !['not_found', 'pending'].includes(script(sl).state);
  if (!expectLimited && healthy.length && capacity >= slugs.length) {
    const unsent = slugs.filter(ordinary).filter(sl => !sends.some(x => x.slug === sl) && !terminalFail.includes(sl));
    check('ordinary-leads-get-sent', !unsent.length, `healthy account(s) available but nothing reached LinkedIn for: ${unsent.join(', ')}`);
  }

  // 5. Sent on LinkedIn  <=>  recorded as sent on the sheet.
  const unrecorded = sentSlugs.filter(s => !recordedSuccess.has(s));
  // A lead that was ALREADY pending/connected is legitimately stamped as such without a new send.
  const preExisting = new Set(slugs.filter(s => ['pending', 'connected'].includes(script(s).state) && p.leadKind === 'cold'));
  const falseClaims = [...recordedSuccess].filter(s => !sentSlugs.includes(s) && !preExisting.has(s));
  check('sends-are-recorded', !unrecorded.length, `sent on LinkedIn but sheet has no success stamp (would be re-sent next run): ${unrecorded.join(', ')}`);
  check('sheet-never-claims-unsent', !falseClaims.length, `sheet says sent but LinkedIn never received it: ${falseClaims.join(', ')}`);

  // 6. Mode-specific columns: the stamp must actually LAND in the final sheet. The real Apps Script
  //    silently drops a field whose column doesn't exist, so check the sheet itself, not the payload.
  const sheet = r.sheetFinal || { headers: [], rows: [] };
  const sheetRow = (sl) => sheet.rows.find(x => slugOf(x['LinkedIn URL']) === sl);
  const cell = (sl, field) => {
    const row = sheetRow(sl); if (!row) return undefined;
    const h0 = GAS.FIELD_MAP[field]; if (!h0) return undefined;
    const h = sheet.headers.includes(h0) ? h0 : (GAS.COL_ALIASES[h0] || []).find(a => sheet.headers.includes(a));
    return h ? row[h] : undefined;
  };
  if (sentSlugs.length && r.sheetFinal) {
    const bad = [];
    const acceptedSet = new Set(spec.phase2?.accept || []);
    for (const sl of sentSlugs.filter(x => !acceptedSet.has(x))) for (const [k, want] of Object.entries(p.successStamp)) {
      const got = cell(sl, k);
      if (!matches(want, got)) bad.push(`${sl}.${k}=${JSON.stringify(got ?? null)} (column ${GAS.FIELD_MAP[k]})`);
    }
    check('mode-columns-stamped-in-sheet', !bad.length, `final sheet is missing the expected stamp: ${bad.slice(0, 4).join('; ')}`);
  }

  // 6b. Nothing written to the sheet or Audit Log may be garbage (code, undefined, NaN, [object Object]).
  const JUNK = /=>|\bfunction\b|\[object Object\]|\bundefined\b|\bNaN\b/;
  const junk = [];
  for (const row of sheet.rows) for (const [h, v] of Object.entries(row)) if (JUNK.test(String(v)) && !/^=HYPERLINK/.test(String(v))) junk.push(`${slugOf(row['LinkedIn URL'])}/${h}: ${String(v).slice(0, 60)}`);
  const DATE_OK = /^[A-Z][a-z]{2} \d{1,2}(st|nd|rd|th), \d\d:\d\d$|^\d{4}-\d\d-\d\d/;
  for (const a of r.auditLog || []) if (!DATE_OK.test(String(a.date))) junk.push(`Audit Log date for ${slugOf(a.linkedinUrl)}: ${String(a.date).replace(/\s+/g, ' ').slice(0, 70)}`);
  check('sheet-values-are-clean', !junk.length, junk.slice(0, 3).join(' | ') + (junk.length > 3 ? ` (+${junk.length - 3} more)` : ''));

  // 7. Daily limit respected per account.
  const over = p.noDailyLimit ? [] : spec.accounts.filter(a => sendsByAccount(a.id) > limit);
  check('daily-limit-respected', !over.length, over.map(a => `${a.id} sent ${sendsByAccount(a.id)} > ${limit}`).join(', '));
  if (expectLimited) {
    const total = sends.length;
    check('limit-enforced-exactly', total <= spec.expect.limitedTo * spec.accounts.length, `${total} sent; limit ${spec.expect.limitedTo}/account`);
  }

  // 8. A broken account must not stop a healthy one.
  if (spec.expect.healthyAccount) {
    const h = spec.expect.healthyAccount, d = spec.expect.degradedAccount;
    check('healthy-account-keeps-going', sendsByAccount(h) > 0, `${h} sent nothing while ${d} was degraded`);
    const dAcct = spec.accounts.find(a => a.id === d);
    if (dAcct?.loggedOut || dAcct?.launchFails) check('broken-account-sends-nothing', sendsByAccount(d) === 0, `${d} sent ${sendsByAccount(d)} despite being unusable`);
    const stampedHealthy = slugs.filter(s => !exempt.has(s) && reachable(s)).filter(s => !rowsBySlug.has(s));
    check('no-lead-stranded-by-broken-account', !stampedHealthy.length, `never processed (a healthy account was available): ${stampedHealthy.join(', ')}`);
  }

  // 9. Leads that can't be contacted are recorded, not sent.
  for (const s of spec.expect.allowUnsent || []) {
    check(`bad-lead-${s}-recorded-not-sent`, rowsBySlug.has(s) && !sentSlugs.includes(s),
      !rowsBySlug.has(s) ? 'no outcome written to the sheet' : 'a send was made to a lead that cannot be contacted');
  }

  // 10. Acceptance phase (Connect + DM / Connect + Introduce Back): the sweep must follow up with
  //     exactly the accepted leads, exactly once, and record it — even when it runs twice.
  if (spec.expect.acceptance && p.followUp) {
    const accepted = spec.phase2.accept;
    const ph = r.phase2 || {};
    check('enters-monitoring-after-send', ph.stateAfterSend === 'monitoring', `campaign.state after the send loop was "${ph.stateAfterSend}"`);
    check('acceptance-sweeps-complete', ph.ran && (ph.sweeps || []).length > 0 && ph.sweeps.every(x => x.ok),
      (ph.sweeps || []).filter(x => !x.ok).map(x => x.error).join(' | ') || 'sweeps did not run');
    const msgs = r.messages.filter(m => m.ok !== false);
    const to = (sl) => msgs.filter(m => (m.recipients || [m.slug]).includes(sl));
    const notOnce = accepted.filter(sl => to(sl).length !== 1);
    check('accepted-lead-followed-up-exactly-once', !notOnce.length, notOnce.map(sl => `${sl}: ${to(sl).length} message(s)`).join(', '));
    const stray = slugs.filter(sl => !accepted.includes(sl) && to(sl).length);
    check('unaccepted-lead-not-messaged', !stray.length, `follow-up sent to leads that never accepted: ${stray.join(', ')}`);
    const shapeBad = msgs.filter(m => p.followUp.kind === 'dm' ? (m.recipients || []).length !== 1 : !(m.recipients || []).includes(spec.primarySlug || 'pat-primary'));
    check('followup-has-right-recipients', !shapeBad.length, `${p.followUp.kind === 'dm' ? 'DM should be 1:1' : 'intro should include the primary'}: ${shapeBad.map(m => JSON.stringify(m.recipients)).join(' ')}`);
    const unrecorded2 = accepted.filter(sl => to(sl).length && !Object.entries(p.followUp.stamp).every(([k, v]) => matches(v, cell(sl, k))));
    check('followup-recorded-on-sheet', !unrecorded2.length, `follow-up went out but the final sheet has no ${Object.keys(p.followUp.stamp).join('/')} stamp: ${unrecorded2.map(sl => `${sl}=${JSON.stringify(cell(sl, Object.keys(p.followUp.stamp)[0]) ?? null)}`).join(', ')}`);
    const noConn = accepted.filter(sl => !/connected/i.test(String(cell(sl, 'stage') ?? '') + ' ' + String(cell(sl, 'checkStatus') ?? '')));
    check('acceptance-recorded-on-sheet', !noConn.length, `final sheet does not show "Connected" for accepted: ${noConn.map(sl => `${sl} stage=${JSON.stringify(cell(sl, 'stage') ?? null)}`).join(', ')}`);
    const pendingStillPending = slugs.filter(sl => !accepted.includes(sl) && sentSlugs.includes(sl) && /connected/i.test(String(cell(sl, 'stage') ?? '').replace(/pending/i, '')));
    check('unaccepted-lead-not-marked-connected', !pendingStillPending.length, `marked Connected without accepting: ${pendingStillPending.join(', ')}`);
  }
  return out;
}
