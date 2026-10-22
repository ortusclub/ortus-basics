// Child process: runs ONE scenario against the real engine in the fake world and
// prints a single `SIMRESULT:<json>` line. One process per scenario because
// campaign.js keeps module-level state (a singleton campaign, counters, caches).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'sim-data-'));

const crashes = [];
process.on('unhandledRejection', (e) => crashes.push('unhandledRejection: ' + (e?.stack || e)));
process.on('uncaughtException', (e) => crashes.push('uncaughtException: ' + (e?.stack || e)));

const { createWorld } = await import('./world.mjs');
const headers = [...new Set(spec.leads.flatMap(l => Object.keys(l)))];
const world = createWorld({ headers, leads: spec.leads });
globalThis.__SIM__ = {
  accounts: spec.accounts, leadScript: spec.leadScript,
  accepted: {}, linkedinHits: world.linkedinHits, invitesSent: [], messagesSent: [], people: spec.people || [], primarySlug: 'pat-primary',
};

const { startCampaign, campaign, runMonitoringCheckAll } = await import('../../src/campaign.js');
const t0 = Date.now();
let threw = null;
const started = startCampaign({
  profileIds: spec.accounts.map(a => a.id),
  sheetUrl: 'https://docs.google.com/spreadsheets/d/SIMSHEET/edit#gid=0',
  templates: spec.templates, mode: spec.mode, delayMin: 1, delayMax: 2,
  linkedinColumn: 'LinkedIn URL', concurrency: 1, name: `sim ${spec.id}`, createdBy: 'sim@example.com',
  ...spec.startOpts,
}).catch(e => { threw = String(e?.stack || e); });

let hung = false;
const deadline = t0 + spec.timeoutMs;
await Promise.race([started, new Promise(r => setTimeout(r, spec.timeoutMs))]);
while (campaign.running && Date.now() < deadline) await new Promise(r => setTimeout(r, 1000));
if (campaign.running) { hung = true; try { (await import('../../src/campaign.js')).stopCampaign({ full: true, reason: 'sim-timeout' }); } catch { /* */ } }

// ── Phase 2 (modes that follow up after acceptance): accept some invites, then run the real
//    acceptance sweep — the same function the "Run check now" button calls — and sweep again.
const sim = globalThis.__SIM__;
const phase2 = { ran: false, stateAfterSend: campaign.state, sweeps: [] };
if (spec.phase2 && !hung && !threw) {
  phase2.ran = true;
  for (const slug of spec.phase2.accept) {
    const acct = sim.invitesSent.find(i => i.slug === slug)?.account;
    if (!acct) continue;
    (sim.accepted[acct] ||= []).push(slug);
    sim.leadScript[slug] = { ...(sim.leadScript[slug] || {}), state: 'connected' };
  }
  const sweepsWanted = spec.phase2.sweeps || 2;
  for (let i = 0; i < sweepsWanted; i++) {
    const t = Date.now();
    try {
      const out = await Promise.race([runMonitoringCheckAll(), new Promise((_, rej) => setTimeout(() => rej(new Error('sweep timed out after 240s')), 240000))]);
      phase2.sweeps.push({ ok: true, ms: Date.now() - t, out: JSON.parse(JSON.stringify(out ?? null, (k, v) => (typeof v === 'object' && v && v.length > 50 ? undefined : v))) });
    } catch (e) { phase2.sweeps.push({ ok: false, ms: Date.now() - t, error: String(e?.message || e) }); }
  }
}
const result = {
  id: spec.id, mode: spec.mode, desc: spec.desc,
  phase2, hung, threw, crashes, elapsedMs: Date.now() - t0,
  campaign: { running: campaign.running, state: campaign.state, totalProcessed: campaign.totalProcessed, stopReason: campaign.stopReason, parkedProfiles: campaign.parkedProfiles || [] },
  logs: (campaign.logs || []).map(l => typeof l === 'string' ? l : (l.msg || l.message || JSON.stringify(l))),
  sheetFinal: { headers: world.headers, rows: world.rows },
  auditLog: world.auditLog,
  rowWrites: [
    ...world.writes.filter(w => w.action === 'updateRows').flatMap(w => w.rows || []),
    ...world.writes.filter(w => w.action === 'batchUpdate').flatMap(w => w.updates || []).filter(u => u && u.linkedinUrl),
  ],
  batchWrites: [],
  actions: world.writes.map(w => w.action),
  invites: sim.invitesSent, messages: sim.messagesSent,
  unhandled: world.unhandled,
};
// The result goes through a FILE: a long line on a pipe can be cut off when the process exits on macOS
// (measured: the operator's Mac lost every result and the runner crashed on the truncated JSON).
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result));
else console.log('SIMRESULT:' + JSON.stringify(result));
process.exit(0);
