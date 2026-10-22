// Child process: sets a campaign up on the REAL app screen the way an operator does — open the app, "+ New campaign",
// click the campaign type's card, paste a sheet link, press "Preview sheet" — then checks that every control the
// operator needs for this campaign type is actually there and usable, and that the screen threw no script errors.
// Everything is found by the visible text the operator sees, so renaming internals does not break it.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import './compat.mjs';
import { bootServer } from './startup/server.mjs';
import { findBrowser } from './browser.mjs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'sim-screen-data-'));
const t0 = Date.now();
const result = { id: spec.id, mode: spec.mode, desc: spec.desc, kind: 'screen', steps: [], controls: [], errors: [], failedStep: null, elapsedMs: 0,
  // what the report/summary code reads from every scenario (none of it applies to a screen run)
  hung: false, threw: null, crashes: [], campaign: { running: false }, rowWrites: [], batchWrites: [], actions: [], invites: [], messages: [], unhandled: [], auditLog: [], logs: [] };
const step = (name, ok, detail = '') => { result.steps.push({ name, ok: !!ok, detail }); if (!ok && !result.failedStep) result.failedStep = { name, detail }; return !!ok; };

let server, browser;
const finish = () => {
  result.elapsedMs = Date.now() - t0;
  result.logs = [...result.steps.map(x => `${x.ok ? '✓' : '✗'} ${x.name}${x.detail ? ' — ' + x.detail : ''}`),
    ...result.controls.map(c => `${c.ok ? '✓' : '✗'} control: ${c.label}${c.detail ? ' — ' + c.detail : ''}`),
    ...result.errors.map(e => 'screen error: ' + e), '--- app server log (tail) ---', ...String(server?.log?.() || '').split('\n').slice(-12)];
  console.log(result.logs.join('\n'));   // lands in the scenario's log file
  try { server?.stop(); } catch { /* */ }
  const done = () => { writeFileSync(process.argv[3], JSON.stringify(result)); process.exit(0); };
  if (browser) browser.close().then(done, done); else done();
};
const overall = setTimeout(() => { step('finishes-in-time', false, 'the screen test did not finish within 100s'); finish(); }, 100000);
process.on('unhandledRejection', (e) => { step('runner', false, String(e?.message || e)); clearTimeout(overall); finish(); });

try {
  const headers = [...new Set(spec.leads.flatMap(l => Object.keys(l)))];
  server = await bootServer({ headers, leads: spec.leads, accounts: spec.accounts });
  const puppeteer = createRequire(join(import.meta.dirname, '../../package.json'))('puppeteer-core');
  const exe = findBrowser();
  const launch = (headless) => puppeteer.launch({ executablePath: exe, headless, args: ['--no-sandbox', '--disable-gpu', '--window-size=1400,1000'], defaultViewport: { width: 1400, height: 1000 } });
  try { browser = await launch(true); } catch { browser = await launch('shell'); }
  const page = await browser.newPage();
  await page.setCookie({ name: 'ortus_session', value: server.cookie, url: server.url });
  page.on('pageerror', (e) => result.errors.push(String(e.message || e).split('\n')[0].slice(0, 200)));
  page.on('dialog', (d) => { result.errors.push('the screen opened an alert: ' + d.message().slice(0, 160)); d.dismiss().catch(() => {}); });
  const settle = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, arg, ms = 20000) => { try { await page.waitForFunction(fn, { timeout: ms, polling: 250 }, arg); return true; } catch { return false; } };

  await page.goto(server.url + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!step('app-opens', await waitFor(() => document.querySelectorAll('.mode-card').length > 0), 'the app opened but no campaign-type cards appeared')) throw 0;

  // "+ New campaign" (the operator's usual start). Found by its text.
  const clickedNew = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^\s*\+?\s*new campaign\s*$/i.test(x.textContent) && x.offsetParent !== null);
    if (!b) return false; b.click(); return true;
  });
  step('new-campaign-button', clickedNew, 'no visible "+ New campaign" button');
  await settle(800);

  const picked = await page.evaluate((name) => {
    const c = [...document.querySelectorAll('.mode-card')].find(x => x.querySelector('.mode-card-title')?.textContent.trim() === name);
    if (!c) return 'no card named "' + name + '"';
    if (/coming-soon/.test(c.className)) return 'the "' + name + '" card is greyed out';
    c.click(); return 'ok';
  }, spec.modeName);
  if (!step('campaign-type-card', picked === 'ok', picked)) throw 0;
  await settle(800);
  const selected = await page.evaluate(() => document.getElementById('campaign-mode')?.value);
  step('card-selects-the-type', selected === spec.mode, `clicked the card but the screen is on "${selected}"`);

  // The sheet section starts collapsed: open it the way an operator does, by clicking its heading.
  const opened = await page.evaluate(() => {
    const el = document.getElementById('sheet-url') || document.querySelector('input[placeholder*="docs.google.com"]');
    if (!el) return 'no sheet link field';
    for (let e = el.parentElement; e; e = e.parentElement) {
      if (e.classList?.contains('collapsed')) { const h = e.querySelector(':scope > .section-toggle, :scope > h2'); if (!h) return 'a closed section has no heading to click'; h.click(); }
    }
    return 'ok';
  });
  step('open-sheet-section', opened === 'ok', opened);
  await settle(400);
  const filled = await page.evaluate((url) => {
    const el = document.getElementById('sheet-url') || document.querySelector('input[placeholder*="docs.google.com"]');
    if (!el) return false; el.value = url; el.dispatchEvent(new Event('input', { bubbles: true })); return true;
  }, 'https://docs.google.com/spreadsheets/d/SIMSHEET/edit#gid=0');
  if (!step('sheet-link-field', filled, 'no field for the Google Sheet link')) throw 0;

  const previewed = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /preview sheet/i.test(x.textContent));
    if (!b) return false; b.click(); return true;
  });
  if (!step('preview-sheet-button', previewed, 'no "Preview sheet" button')) throw 0;
  const loaded = await waitFor(() => { const p = document.getElementById('sheet-preview'); return p && (p.querySelector('table') || /error/i.test(p.textContent)); });
  const previewErr = await page.evaluate(() => { const p = document.getElementById('sheet-preview'); return p && !p.querySelector('table') ? p.textContent.trim().slice(0, 160) : ''; });
  if (!step('sheet-preview-loads', loaded && !previewErr, previewErr || 'the sheet preview did not load')) throw 0;
  await settle(500);

  // Every control the operator needs, found by what the app itself reads when it builds the campaign.
  // Open every other closed section too (an operator scrolling down opens them), so a control inside one is judged on what it looks like open.
  await page.evaluate(() => { for (const e of document.querySelectorAll('.section.collapsible.collapsed')) { const h = e.querySelector(':scope > .section-toggle, :scope > h2'); if (h) h.click(); } });
  await settle(500);
  const wanted = [...(spec.screenControls || []), ...String(process.env.SIM_SCREEN_EXTRA || '').split(',').filter(Boolean).map(id => ({ id, label: id }))];
  result.controls = await page.evaluate((wanted, headers) => wanted.map(({ id, label, columns }) => {
    const el = document.getElementById(id);
    if (!el) return { id, label, ok: false, detail: 'the control is not on the screen at all' };
    const r = el.getBoundingClientRect();
    let hidden = '';
    for (let e = el; e && !hidden; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none') hidden = `hidden (${e.id || e.className || e.tagName} has display:none)`;
      else if (cs.visibility === 'hidden') hidden = 'hidden (visibility)';
    }
    if (hidden) return { id, label, ok: false, detail: hidden };
    if (r.width < 5 || r.height < 5) return { id, label, ok: false, detail: `squashed to ${Math.round(r.width)}×${Math.round(r.height)} px` };
    const opts = el.tagName === 'SELECT' ? [...el.options].map(o => o.value).filter(Boolean) : null;
    if (columns && opts && headers.some(h => !opts.includes(h))) return { id, label, ok: false, detail: 'it is there but does not list all of the sheet\'s columns' };
    return { id, label, ok: true, detail: '' };
  }), wanted, headers);
} catch (e) {
  if (e) step('runner', false, String(e?.message || e).split('\n')[0]);
}
clearTimeout(overall);
finish();
