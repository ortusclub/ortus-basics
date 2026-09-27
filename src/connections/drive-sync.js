import { sheetsFetch } from '../sheets-gateway-client.js';
// Drive folder sync for Team Connections. Pulls the team's <email>.csv network
// exports from the Q2 2026 Drive folder into data/connections/ via the central
// Apps Script web app (action: listConnections / getConnection), then refreshes
// the HubSpot cache for any newly-added slugs. Manifest-diff: only new/changed
// files are downloaded. This is the "no Claude in the data path" pipeline — once
// the Apps Script is deployed, adding networks is a button click, zero tokens.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHEETS_WEBAPP_URL } from '../sheets-webapp-url.js';
import { buildCache } from './cache-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '../..');
const DEFAULT_DIR = path.join(REPO, 'data/connections');
const MANIFEST_PATH = path.join(REPO, 'data/connections-manifest.json');

// Q2 2026 team-connections folder (a Shared Drive folder).
export const CONNECTIONS_FOLDER_ID = '1NnDfoeQv4-VKJqzYza4k_TFCkzNwZ7oG';

// Mirror src/sheets-writer.js _postOnce: Apps Script answers POST with a 302 that
// Node's fetch would turn into a GET (hitting doGet); follow the redirect by hand.
async function postWebApp(payload, { timeoutMs = 30000 } = {}) {
  if (!SHEETS_WEBAPP_URL) return { error: 'SHEETS_WEBAPP_URL not configured' };
  const body = JSON.stringify(payload);
  try {
    // Apps Script's 302 points at a ONE-TIME URL. Fetching it ourselves spends
    // it outside its redirect and Google answers 404 — see the note in
    // magellan-sheet.js for the measurement. fetch follows it correctly.
    const res = await sheetsFetch(SHEETS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      if (text.includes('accounts.google.com') || text.includes('Sign in')) {
        return { error: 'Apps Script returned a login page — redeploy it (and enable the Drive service)' };
      }
      return { error: `Apps Script answered ${res.status} with ${text.length} bytes that are not JSON` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// Normalize a Drive filename to the canonical <email>.csv the ingest keys on.
export function cleanConnectionFilename(title) {
  let n = String(title).replace(/\.csv$/i, '');
  n = n.replace(/\s*\(\d+\)\s*$/, '');        // " (1)" / " (2)"
  n = n.replace(/\s*-\s*connections\s*$/i, ''); // " - connections"
  n = n.replace(/[\s,]+$/, '');                 // trailing comma/space
  return `${n}.csv`;
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { return {}; }
}
function saveManifest(m) {
  fs.writeFileSync(`${MANIFEST_PATH}.tmp`, JSON.stringify(m, null, 2));
  fs.renameSync(`${MANIFEST_PATH}.tmp`, MANIFEST_PATH);
}

export async function listRemote(folderId = CONNECTIONS_FOLDER_ID) {
  const r = await postWebApp({ action: 'listConnections', folderId }, { timeoutMs: 60000 });
  if (r?.error) throw new Error(r.error);
  if (!Array.isArray(r?.files)) throw new Error('listConnections returned no files array');
  return r.files; // [{ id, name, modifiedTime, size }]
}

export async function fetchRemote(id) {
  const r = await postWebApp({ action: 'getConnection', id }, { timeoutMs: 120000 });
  if (r?.error) throw new Error(r.error);
  if (!r?.base64) throw new Error('getConnection returned no content');
  return Buffer.from(r.base64, 'base64');
}

// Write a warm-reach lead list to a brand-new Google Sheet via the central Apps
// Script (action: createLeadTab) and return its URL+gid. Used by the campaign
// "Build & attach a warm list" flow. Needs the Apps Script redeployed with the
// createLeadTab handler — until then it surfaces the script's error.
export async function createWorkbookTab({ name, header, rows }) {
  const r = await postWebApp({ action: 'createLeadTab', name, header, rows }, { timeoutMs: 90000 });
  if (r?.error) throw new Error(r.error);
  if (!r?.url) throw new Error('createLeadTab returned no url — redeploy the Apps Script with the createLeadTab handler');
  return r; // { url, gid, tabName, spreadsheetId, count }
}

// Download only new/changed files. Returns { added[], updated[], unchanged, errors[], remoteCount }.
export async function syncFromDrive({ folderId = CONNECTIONS_FOLDER_ID, dir = DEFAULT_DIR, onProgress } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const remote = await listRemote(folderId);

  // Dedupe by cleaned filename, keeping the newest modifiedTime (mirrors the bulk-load dedupe).
  const wanted = new Map();
  for (const f of remote) {
    if (!/\.csv$/i.test(f.name || '')) continue;
    const cleaned = cleanConnectionFilename(f.name);
    const prev = wanted.get(cleaned);
    const mt = f.modifiedTime || '';
    if (!prev || mt > prev.modifiedTime) wanted.set(cleaned, { id: f.id, modifiedTime: mt });
  }

  const manifest = loadManifest();
  const result = { added: [], updated: [], unchanged: 0, errors: [], remoteCount: wanted.size };
  let i = 0;
  for (const [cleaned, f] of wanted) {
    i += 1;
    const filePath = path.join(dir, cleaned);
    const exists = fs.existsSync(filePath);
    const known = manifest[cleaned];
    if (known && known.modifiedTime === f.modifiedTime && exists) { result.unchanged += 1; continue; }
    try {
      const bytes = await fetchRemote(f.id);
      const head = bytes.subarray(0, 200).toString('utf8');
      if (!head.includes('Notes:') && !head.includes('First Name,Last Name,URL')) {
        throw new Error('does not look like a LinkedIn connections export');
      }
      fs.writeFileSync(filePath, bytes);
      manifest[cleaned] = { id: f.id, modifiedTime: f.modifiedTime };
      (exists ? result.updated : result.added).push(cleaned);
      saveManifest(manifest);
      onProgress?.({ done: i, total: wanted.size, file: cleaned });
    } catch (err) {
      result.errors.push({ file: cleaned, error: err.message });
    }
  }
  return result;
}

// ── Background orchestration (the UI polls getSyncState via /api/connections/stats) ──
let _sync = { running: false, phase: 'idle', startedAt: null, finishedAt: null, downloaded: 0, total: 0, lastResult: null, error: null };
export function getSyncState() { return { ..._sync }; }

export function startSync({ folderId = CONNECTIONS_FOLDER_ID, dir = DEFAULT_DIR } = {}) {
  if (_sync.running) return { started: false, reason: 'A sync is already running' };
  _sync = { running: true, phase: 'listing', startedAt: new Date().toISOString(), finishedAt: null, downloaded: 0, total: 0, lastResult: null, error: null };
  (async () => {
    try {
      const r = await syncFromDrive({
        folderId,
        dir,
        onProgress: ({ done, total }) => { _sync.phase = 'downloading'; _sync.downloaded = done; _sync.total = total; },
      });
      _sync.lastResult = r;
      // Refresh the HubSpot cache for any newly-added slugs (incremental — only new ones).
      if (r.added.length || r.updated.length) {
        _sync.phase = 'caching';
        await buildCache({ dir });
      }
      _sync.phase = 'done';
    } catch (err) {
      _sync.error = err.message;
      _sync.phase = 'error';
    } finally {
      _sync.running = false;
      _sync.finishedAt = new Date().toISOString();
    }
  })();
  return { started: true };
}
