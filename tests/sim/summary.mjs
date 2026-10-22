// Plain-language summary placed at the top of every report: which functions were tested per campaign
// type, pass/fail, why each failure happened, and the bugs found.
export const FUNCTIONS = [
  ['start-gates', 'Press Start: a good setup is accepted, a setup that cannot run is refused with a clear reason'],
  ['setup-screen', 'Set the campaign up on screen (new campaign → pick the type → preview the sheet → every picker you need is there)'],
  ['happy', 'Run a campaign start to finish (open browser, read sheet, send, write results back)'],
  ['two-accounts', 'Share the leads between two accounts'],
  ['daily-limit', 'Respect the daily send limit'],
  ['throttled-account', 'Pause a throttled (rate-limited) account while the others carry on'],
  ['logged-out-account', 'Handle an account whose LinkedIn login has expired'],
  ['launch-fails', 'Survive a browser that fails to open'],
  ['bad-leads', 'Handle leads that cannot be contacted (profile 404, already pending, send rejected)'],
  ['acceptance-followup', 'Detect accepted invites and send the follow-up (DM / introduction) exactly once'],
];

export const CHECK_INFO = {
  'start-checks-run': 'The Start checks themselves ran (the app server started and answered).',
  'start-refuses-bad-setups': 'A setup that cannot run (no sheet link, daily limit 0, empty sheet, no accounts, bad primary link, no tab chosen) is refused with a readable reason, and nothing starts.',
  'start-accepts-good-setup': 'A complete, valid setup is accepted when Start is pressed.',
  'sender-check-works': 'The sender-column check flags a sheet where every sender is blank, and passes one where senders are filled in.',
  'screen-setup-completes': 'The real screen lets an operator start a new campaign, pick this type, paste a sheet link and preview it.',
  'screen-controls-available': 'Every picker needed to run this campaign type (for example the 1st Connection column) is visible and lists the sheet\'s columns.',
  'screen-no-script-errors': 'The screen shows no script errors or pop-up alerts while setting the campaign up.',
  'loop-finishes': 'The campaign finishes on its own and does not hang or crash out.',
  'no-crashes': 'No unhandled errors or code exceptions appear in the run.',
  'no-lead-processed-twice': 'No lead is contacted more than once on LinkedIn.',
  'every-lead-gets-a-status': 'Every lead gets a result written back to the sheet.',
  'ordinary-lead-not-left-terminal': 'A normal lead is never written off as "Skipped/Failed" (which is never retried) because of an account problem.',
  'ordinary-leads-get-sent': 'When a healthy account is available, every normal lead is actually contacted.',
  'sends-are-recorded': 'Everything sent on LinkedIn is recorded on the sheet (so it is not re-sent next run).',
  'sheet-never-claims-unsent': 'The sheet never says "sent" for something LinkedIn never received.',
  'mode-columns-stamped-in-sheet': 'The right sheet columns for this campaign type are filled in.',
  'sheet-values-are-clean': 'No code, "undefined", "NaN" or "[object Object]" is written to the sheet or Audit Log.',
  'daily-limit-respected': 'No account sends more than its daily limit.',
  'limit-enforced-exactly': 'Total sends stay within limit × accounts.',
  'limit-leaves-rest-untouched': 'Leads beyond the limit are left untouched for later.',
  'healthy-account-keeps-going': 'A broken account does not stop a healthy one from sending.',
  'broken-account-sends-nothing': 'An unusable account sends nothing.',
  'no-lead-stranded-by-broken-account': 'No lead is stranded because another account broke.',
  'enters-monitoring-after-send': 'After sending, the campaign moves on to watching for acceptances.',
  'acceptance-sweeps-complete': 'The acceptance check runs to completion.',
  'accepted-lead-followed-up-exactly-once': 'Each accepted lead gets exactly one follow-up message, even if the check runs twice.',
  'unaccepted-lead-not-messaged': 'Leads who have not accepted are not messaged.',
  'followup-has-right-recipients': 'The follow-up goes to the right people (1:1 DM, or lead + primary for an introduction).',
  'followup-recorded-on-sheet': 'The follow-up is recorded on the sheet.',
  'acceptance-recorded-on-sheet': 'Accepted leads show as Connected on the sheet.',
  'unaccepted-lead-not-marked-connected': 'Leads who have not accepted are not marked Connected.',
};
const info = (name) => CHECK_INFO[name] || (name.startsWith('bad-lead-') ? 'A lead that cannot be contacted is recorded on the sheet and never sent to.' : name);

// Structured form of the summary — what the in-app panel renders. buildSummary() (markdown) is the same data.
export function summaryData({ results, modes, isKnown, scenarioDropped }) {
  const engine = modes.filter(m => m.engine);
  const status = (mode, fn) => {
    const r = results.find(x => x.spec.id === `${mode}/${fn}`);
    if (!r) return scenarioDropped(mode, fn) ? 'na' : 'notrun';
    const f = r.checks.filter(c => !c.ok);
    return !f.length ? 'pass' : f.every(c => isKnown(r.spec.id, c)) ? 'known' : 'new';
  };
  const bad = results.filter(r => r.checks.some(c => !c.ok));
  const fnLabel = (id) => (FUNCTIONS.find(f => f[0] === id.split('/')[1]) || [, id.split('/')[1]])[1];
  const failures = bad.flatMap(r => r.checks.filter(c => !c.ok).map(c => ({
    mode: r.spec.mode, scenario: r.spec.id, function: fnLabel(r.spec.id), what: info(c.name), why: String(c.detail), known: !!isKnown(r.spec.id, c),
  })));
  const groups = new Map();
  for (const f of failures.filter(x => x.known)) {
    const note = isKnown(f.scenario, { name: (bad.find(r => r.spec.id === f.scenario).checks.find(c => !c.ok && info(c.name) === f.what) || {}).name });
    const g = groups.get(note) || { note, where: new Set() }; g.where.add(f.scenario); groups.set(note, g);
  }
  return {
    counts: { total: results.length, clean: results.length - bad.length, known: bad.filter(r => r.checks.every(c => c.ok || isKnown(r.spec.id, c))).length, new: bad.filter(r => r.checks.some(c => !c.ok && !isKnown(r.spec.id, c))).length },
    modes: engine.map(m => ({ value: m.value, name: m.name })),
    functions: FUNCTIONS.map(([id, label]) => ({ id, label, cells: Object.fromEntries(engine.map(m => [m.value, status(m.value, id)])) })),
    failures,
    bugs: [...groups.values()].map(g => ({ note: g.note, where: [...g.where] })),
    fresh: failures.filter(f => !f.known),
  };
}

export function buildSummary({ results, modes, isKnown, scenarioDropped }) {
  const engine = modes.filter(m => m.engine);
  const L = [];
  const cellOf = (mode, fn) => {
    const r = results.find(x => x.spec.id === `${mode}/${fn}`);
    if (!r) return scenarioDropped(mode, fn) ? '—' : '·';
    const f = r.checks.filter(c => !c.ok);
    if (!f.length) return '✅';
    return f.every(c => isKnown(r.spec.id, c)) ? '🟡' : '❌';
  };
  L.push('## Summary — what was tested', '');
  L.push('✅ passed · 🟡 failed because of a known bug (see "Bugs found") · ❌ failed, new finding · — not applicable to this campaign type · · not run in this pass', '');
  L.push(`| Function tested | ${engine.map(m => m.name).join(' | ')} |`, `|---|${engine.map(() => '---').join('|')}|`);
  for (const [fn, label] of FUNCTIONS) L.push(`| ${label} | ${engine.map(m => cellOf(m.value, fn)).join(' | ')} |`);

  const bad = results.filter(r => r.checks.some(c => !c.ok));
  L.push('', '## Why each failure failed', '');
  if (!bad.length) L.push('Nothing failed.');
  else {
    L.push('| Campaign type | Function | What went wrong | Why |', '|---|---|---|---|');
    for (const r of bad) {
      const fn = (FUNCTIONS.find(f => f[0] === r.spec.id.split('/')[1]) || [, r.spec.id.split('/')[1]])[1];
      for (const c of r.checks.filter(x => !x.ok)) {
        const k = isKnown(r.spec.id, c);
        L.push(`| ${r.spec.mode} | ${fn} | ${info(c.name)} ${k ? '(known bug)' : '**(NEW)**'} | ${String(c.detail).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 260)} |`);
      }
    }
  }

  // Bugs found: group scenarios that share the same acknowledged note.
  const groups = new Map();
  for (const r of bad) for (const c of r.checks.filter(x => !x.ok)) {
    const k = isKnown(r.spec.id, c); if (!k) continue;
    const g = groups.get(k) || { note: k, where: new Set() };
    g.where.add(r.spec.id); groups.set(k, g);
  }
  L.push('', '## Bugs found', '');
  if (!groups.size) L.push('No known bugs reproduced in this run.');
  let n = 1;
  for (const g of groups.values()) {
    L.push(`${n++}. ${g.note}`, `   - Reproduced in: ${[...g.where].join(', ')}`);
  }
  const fresh = bad.flatMap(r => r.checks.filter(c => !c.ok && !isKnown(r.spec.id, c)).map(c => ({ id: r.spec.id, c })));
  L.push('', '## New findings needing triage', '');
  if (!fresh.length) L.push('None.');
  for (const f of fresh) L.push(`- **${f.id}** — ${info(f.c.name)} — ${f.c.detail}`);
  L.push('');
  return L;
}
