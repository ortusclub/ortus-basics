// Scenario catalog. Generic across modes: each scenario is built from the mode's
// profile (modes.mjs), so changing a campaign's behaviour never means editing a
// scenario — only the invariants in checks.mjs judge the outcome.
import { profileFor } from './modes.mjs';

const slugs = ['alice-smith', 'bob-jones', 'carol-white', 'dave-brown', 'erin-green', 'frank-black'];
const acct = (n, extra = {}) => ({ id: `acct-${n}`, name: `sim.${n}@example.com`, ...extra });

const cap = (w) => w[0].toUpperCase() + w.slice(1);
function leadRow(slug, kind, senderName) {
  const [first, last] = slug.split('-');
  const row = { 'First Name': cap(first), 'Last Name': cap(last || ''), 'LinkedIn URL': `https://www.linkedin.com/in/${slug}/`, Stage: '' };
  if (kind === 'connected') { row['Intro Status'] = ''; row['Introduction Status'] = ''; row.Sender = senderName; }
  return row;
}
const baseScript = (kind) =>
  kind === 'connected' ? { state: 'connected' } : kind === 'open_profile' ? { state: 'connectable', openProfile: true } : {};

export function buildScenarios(mode) {
  const p = profileFor(mode);
  const mk = (id, desc, o = {}) => {
    const n = o.leads ?? 3;
    const leadSlugs = slugs.slice(0, n);
    const leadScript = {};
    for (const s of leadSlugs) leadScript[s] = { ...baseScript(p.leadKind), ...(o.script?.[s] || {}) };
    return {
      id: `${mode}/${id}`, mode, desc,
      accounts: o.accounts || [acct(1)],
      leads: leadSlugs.map((s, i) => leadRow(s, p.leadKind, (o.accounts || [acct(1)])[i % (o.accounts || [acct(1)]).length].name)),
      people: [...leadSlugs.filter(s => (o.script?.[s] || {}).state !== 'not_found').map(s => ({ slug: s, name: s.split('-').map(cap).join(' '), degree: p.leadKind === 'connected' ? '1st' : '2nd' })),
               { slug: 'pat-primary', name: 'Pat Primary', degree: '1st' }],
      leadScript,
      templates: p.templates,
      startOpts: { dailyLimit: 10, ...p.startOpts, ...(p.leadKind === 'connected' ? { senderColumn: 'Sender' } : {}), ...(o.startOpts || {}) },
      expect: o.expect || {},
      phase2: o.phase2 || null,
      timeoutMs: o.timeoutMs || 420000,
    };
  };

  const scenarios = [
    // Not an engine run: the real app screen is driven up to "Preview sheet" (see run-screen.mjs).
    { ...mk('setup-screen', 'set the campaign up on screen — new campaign, pick the type, preview the sheet — and every control the operator needs must be there'),
      kind: 'screen', screenControls: [{ id: 'linkedin-col-select', label: 'LinkedIn URL column picker', columns: true }, { id: 'campaign-name-input', label: 'Campaign name field' }, ...(p.screenControls || [])], timeoutMs: 100000 },
    // Not an engine run either: "press Start" is sent to the real server (see run-gates.mjs).
    { ...mk('start-gates', 'press Start — a good setup is accepted, a setup that cannot run is refused with a readable reason'),
      kind: 'gates', derivesAccounts: !!p.derivesAccounts, primaryChecked: !!p.primaryChecked, senderGate: !!p.senderGate, timeoutMs: 100000 },
    mk('happy', 'one healthy account, three eligible leads — all must be processed'),
    mk('two-accounts', 'two healthy accounts share four leads', { leads: 4, accounts: [acct(1), acct(2)] }),
    mk('daily-limit', 'daily limit 2 with 4 leads — an account must never exceed its limit', { leads: 4, startOpts: { dailyLimit: 2 }, expect: { limitedTo: 2 } }),
    mk('throttled-account', 'account 1 is throttled (HTTP 429) — it must park while account 2 carries on', {
      leads: 4, accounts: [acct(1), acct(2)],
      script: { 'alice-smith': { throttle: true } },
      expect: { degradedAccount: 'acct-1', healthyAccount: 'acct-2' },
    }),
    mk('logged-out-account', 'account 1 has no LinkedIn session — it must park while account 2 carries on', {
      leads: 3, accounts: [acct(1, { loggedOut: true }), acct(2)],
      expect: { degradedAccount: 'acct-1', healthyAccount: 'acct-2' },
    }),
    mk('launch-fails', 'account 1 browser fails to launch — account 2 must still run', {
      leads: 3, accounts: [acct(1, { launchFails: true }), acct(2)],
      expect: { degradedAccount: 'acct-1', healthyAccount: 'acct-2' },
    }),
    mk('bad-leads', 'one lead 404s, one is already pending / cannot be messaged — each must still get a recorded outcome', {
      leads: 3, script: { 'alice-smith': { state: 'not_found' }, 'bob-jones': p.leadKind === 'cold' ? { state: 'pending' } : { messageFail: true } },
      expect: { allowUnsent: ['alice-smith', 'bob-jones'] },
    }),
    ...(p.followUp ? [mk('acceptance-followup', 'two of three invites are accepted — the acceptance sweep must follow up with exactly those two, once, even if it runs twice', {
      leads: 3, expect: { acceptance: true }, phase2: { accept: ['alice-smith', 'bob-jones'], sweeps: 2 }, timeoutMs: 900000,
    })] : []),
  ];
  // Scenarios that cannot apply to a mode are dropped here (and explained in modes.mjs).
  return scenarios.filter(sc => {
    const name = sc.id.split('/')[1];
    if (name === 'daily-limit' && p.noDailyLimit) return false;
    if (name === 'throttled-account' && p.sends !== 'invite') return false;   // 429s come from the invite endpoint
    return true;
  });
}
