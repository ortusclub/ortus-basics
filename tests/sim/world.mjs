// The fake outside world: Google Sheets CSV export + the Apps Script bridge.
// Installed by replacing globalThis.fetch. Every request is recorded so the
// invariant checks (and bug notes) can read exactly what the app sent.
import { loadGasTables } from './gas.mjs';

const normUrl = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

export function createWorld({ headers, leads }) {
  const gas = loadGasTables();
  const world = {
    headers,
    rows: leads.map(l => ({ ...l })),
    writes: [],          // every Apps Script POST body, in order
    auditLog: [],        // what the Apps Script would append to the Audit Log tab
    unhandled: [],       // requests to hosts/actions the world doesn't model
    linkedinHits: [],    // filled by the fake launcher
  };

  const csvEscape = v => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
  world.csv = () => [headers.join(','), ...world.rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');

  // ── Apps Script behaviour (driven by the real tables in google-apps-script.js) ──
  const addColumn = (name) => { if (!world.headers.includes(name)) { world.headers.push(name); for (const r of world.rows) r[name] = r[name] ?? ''; } };
  world.prepareSheet = (mode) => {
    const cols = gas.MODE_COLUMNS_V2[mode];
    if (!cols) return { error: 'Unknown mode for prepareSheet: ' + mode, errorCode: 'BAD_MODE' };
    const before = new Set(world.headers);
    for (const c of [...gas.ALWAYS_PROVISIONED_V2, ...cols]) addColumn(c);
    return { success: true, added: world.headers.filter(h => !before.has(h)), hidden: [], shown: [] };
  };
  const urlHeader = () => gas.URL_COLUMN_NAMES.find(n => world.headers.includes(n)) || world.headers.find(h => /url|linkedin/i.test(h));
  world.writeFields = (item) => {
    const col = urlHeader();
    const targets = world.rows.filter(r => normUrl(r[col]) === normUrl(item.linkedinUrl));
    if (!targets.length) return { error: 'Row not found for: ' + item.linkedinUrl };
    for (const row of targets) {
      for (const [field, header0] of Object.entries(gas.FIELD_MAP)) {
        const v = item[field];
        if (v === undefined || v === null || v === '') continue;
        let header = header0;
        if (!world.headers.includes(header) && field === 'status' && world.headers.includes('Last Action')) header = 'Last Action';
        if (!world.headers.includes(header)) header = (gas.COL_ALIASES[header0] || []).find(a => world.headers.includes(a)) || header;
        if (!world.headers.includes(header)) continue;       // the real script silently skips missing columns
        row[header] = String(v);
      }
    }
    if (item.accountUsed) world.auditLog.push({ date: item.dateLastAction || new Date().toISOString(), linkedinUrl: item.linkedinUrl, action: item.auditAction || item.status || '', account: item.accountUsed });
    return { ok: true, rows: targets.length };
  };

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/^https?:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/export/.test(url)) {
      return new Response(world.csv(), { status: 200, headers: { 'content-type': 'text/csv' } });
    }
    if (/^https:\/\/script\.google\.com\//.test(url)) {
      let body = {};
      try { body = JSON.parse(init.body || '{}'); } catch { /* */ }
      world.writes.push(body);
      switch (body.action) {
        case 'listTabs': return json({ ok: true, tabs: [{ gid: '0', name: 'Sheet1' }] });
        case 'prepareSheet': return json(world.prepareSheet(body.mode));
        case 'ensureColumns': return json({ success: true, added: [], hidden: [], shown: [] });
        case 'updateRows': return json({ success: true, results: (body.rows || []).map(r => world.writeFields(r)) });
        case 'batchUpdate': return json({ success: true, results: (body.updates || []).map(u => u.linkedinUrl ? world.writeFields(u) : { ok: true }) });
        case 'updateRow': { const r = world.writeFields(body); return json(r.error ? r : { success: true }); }
        default:
          world.unhandled.push({ kind: 'apps-script-action', action: body.action });
          return json({ success: true });
      }
    }
    // Anything else (soo, log bridges, gologin API, telemetry…) is offline.
    world.unhandled.push({ kind: 'fetch', url: String(url).slice(0, 120) });
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  world.restore = () => { globalThis.fetch = realFetch; };
  return world;
}
