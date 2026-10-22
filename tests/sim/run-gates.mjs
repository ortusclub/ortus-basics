// Child process: "press Start" against the REAL server. Sends the same requests the app screen sends when an operator
// presses Start (and the sender-column check the screen runs first) with generated good and bad setups, and records
// what came back. The rules are generic — a good setup must be accepted; a setup that cannot run must be refused with a
// readable reason — so they keep holding however the campaigns change. Judged in checks.mjs.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './compat.mjs';
import { bootServer } from './startup/server.mjs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'sim-gates-data-'));
const t0 = Date.now();
const result = { id: spec.id, mode: spec.mode, desc: spec.desc, kind: 'gates', cases: [], failed: null, elapsedMs: 0,
  hung: false, threw: null, crashes: [], campaign: { running: false }, rowWrites: [], batchWrites: [], actions: [], invites: [], messages: [], unhandled: [], auditLog: [], logs: [] };
let server;
const finish = () => {
  result.elapsedMs = Date.now() - t0;
  result.logs = result.cases.map(c => `${c.ok === false ? '✗' : '·'} ${c.name}: HTTP ${c.status} ${JSON.stringify(c.reply).slice(0, 160)}`);
  console.log(result.logs.join('\n'));
  try { server?.stop(); } catch { /* */ }
  writeFileSync(process.argv[3], JSON.stringify(result));
  process.exit(0);
};
const overall = setTimeout(() => { result.failed = 'the Start checks did not finish within 100s'; finish(); }, 100000);
process.on('unhandledRejection', (e) => { result.failed = String(e?.message || e); clearTimeout(overall); finish(); });

try {
  const headers = [...new Set(spec.leads.flatMap(l => Object.keys(l)))];
  const sheet = { headers, leads: spec.leads, accounts: spec.accounts };
  server = await bootServer(sheet);
  const call = async (path, body) => {
    const r = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'ortus_session=' + server.cookie }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    let reply = null; try { reply = await r.json(); } catch { /* */ }
    return { status: r.status, reply };
  };
  const SHEET = 'https://docs.google.com/spreadsheets/d/SIMSHEET/edit#gid=0';
  const good = { profileIds: spec.accounts.map(a => a.id), sheetUrl: SHEET, templates: spec.templates, mode: spec.mode, dailyLimit: 10,
    delayMin: 1, delayMax: 2, linkedinColumn: 'LinkedIn URL', name: 'start check', ...spec.startOpts };
  const refuse = async (name, body, setup) => {
    if (setup) server.setSheet(setup);
    const r = await call('/api/campaign/start', body);
    server.setSheet(sheet);
    result.cases.push({ name, expect: 'refused', ...r });
    // A refusal that actually started something must not leak into the next case.
    if (r.status >= 200 && r.status < 300) { await call('/api/campaign/stop', { full: true, immediate: true }).catch(() => {}); await new Promise(res => setTimeout(res, 2500)); }
  };

  // Bad setups first (none of them may start anything).
  await refuse('no-sheet-link', { ...good, sheetUrl: '' });
  await refuse('daily-limit-zero', { ...good, dailyLimit: 0 });
  await refuse('workbook-with-several-tabs-but-none-chosen', { ...good, sheetUrl: 'https://docs.google.com/spreadsheets/d/SIMSHEET/edit', multiTab: true });
  await refuse('sheet-has-no-leads', good, { headers, leads: [], accounts: spec.accounts });
  await refuse('no-linkedin-urls-in-sheet', good, { headers, leads: spec.leads.map(l => ({ ...l, 'LinkedIn URL': '' })), accounts: spec.accounts });
  if (!spec.derivesAccounts) await refuse('no-accounts-chosen', { ...good, profileIds: [] });
  if (spec.primaryChecked) await refuse('primary-person-link-is-not-a-linkedin-profile', { ...good, templates: { ...good.templates, primaryUrl: 'not a link' } });
  if (spec.senderGate) {
    // The screen asks the server first whether the sender column resolves to a real account (the check you hit).
    const blank = { headers, leads: spec.leads.map(l => ({ ...l, Sender: '' })), accounts: spec.accounts };
    server.setSheet(blank);
    const r = await call('/api/campaign/preflight-ic-senders', { sheetUrl: SHEET, senderColumn: 'Sender' });
    server.setSheet(sheet);
    result.cases.push({ name: 'sender-column-blank', expect: 'sender-check-says-no', ...r });
    const ok = await call('/api/campaign/preflight-ic-senders', { sheetUrl: SHEET, senderColumn: 'Sender' });
    result.cases.push({ name: 'sender-column-filled', expect: 'sender-check-says-yes', ...ok });
  }
  // A good setup last: it really starts (against the fake LinkedIn), then is stopped.
  const started = await call('/api/campaign/start', good);
  result.cases.push({ name: 'good-setup', expect: 'accepted', ...started });
  await call('/api/campaign/stop', { full: true, immediate: true }).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
} catch (e) {
  result.failed = String(e?.message || e).split('\n')[0];
}
clearTimeout(overall);
finish();
