/**
 * Fetches rows from a publicly shared Google Sheet by converting it to CSV.
 * The sheet must be set to "Anyone with the link can view".
 */

import { extractSheetId, extractSheetGid, spreadsheetIdFromUrl } from './utils.js';
import { SHEETS_WEBAPP_URL } from './sheets-webapp-url.js';

/**
 * Parses a CSV string into an array of objects using the first row as headers.
 * Handles quoted fields with commas and newlines.
 * @param {string} csv
 * @returns {Record<string, string>[]}
 */
function parseCSV(csv) {
  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      // parseCSV only splits lines; preserve quote characters verbatim so
      // splitCSVLine can use them to delimit fields. Without this, a field
      // like "url,with,commas" lost its quotes here and splitCSVLine then
      // treated every comma as a field separator.
      if (inQuotes && csv[i + 1] === '"') {
        current += '""'; // preserve the escaped-quote pair
        i++;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else if (ch === '\r' && !inQuotes) {
      // skip \r
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    if (values.every(v => !v.trim())) continue; // skip empty rows

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || '').trim();
    }
    rows.push(row);
  }

  return rows;
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Like parseCSV, but tags each non-empty data row with the 1-based sheet row
 * number the operator sees in Google Sheets (header = row 1, first data row =
 * row 2). Blank sheet rows are skipped but still advance the counter, so the
 * numbers stay aligned with the actual spreadsheet — this is what lets the UI
 * offer a "scrape rows 2–10" picker that matches what's on screen.
 * @param {string} csv
 * @returns {{ rowNumber: number, row: Record<string, string> }[]}
 */
function parseCSVWithRowNumbers(csv) {
  // Reuse parseCSV's line splitter via a throwaway: re-run the same char loop
  // here so the two stay byte-identical. (parseCSV builds `lines` then objects;
  // we need the line index, so we redo the split but keep position.)
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') { current += '""'; i++; }
      else { inQuotes = !inQuotes; current += ch; }
    } else if (ch === '\n' && !inQuotes) { lines.push(current); current = ''; }
    else if (ch === '\r' && !inQuotes) { /* skip */ }
    else { current += ch; }
  }
  if (current.trim()) lines.push(current);

  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    if (values.every((v) => !v.trim())) continue; // skip blank rows (counter still advances)
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || '').trim();
    }
    out.push({ rowNumber: i + 1, row }); // line index i → sheet row i+1 (header is line 0 / row 1)
  }
  return out;
}

/**
 * Fetches the raw CSV text for a public Google Sheet (URL build + timeout +
 * one retry). Shared by fetchSheet and fetchSheetWithRows.
 * @param {string} sheetUrl
 * @returns {Promise<string>}
 */
async function fetchSheetCsv(sheetUrl) {
  const sheetId = extractSheetId(sheetUrl);
  // Honor the tab the operator pasted. Google's CSV export defaults to the
  // first sheet when no gid is given, which silently pulls the wrong data
  // for any spreadsheet with multiple tabs.
  const gid = extractSheetGid(sheetUrl);
  if (!gid) {
    console.warn('[sheets] no gid in sheet URL — reading first tab; multi-tab guard runs at campaign start');
  }
  const csvUrl = gid
    ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`
    : `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

  console.log(`[sheets] Fetching CSV from: ${csvUrl}`);

  // P-05 fix (2.8.18): timeout to prevent indefinite stalls on Google
  // Sheets / network outages. Bumped 15s → 30s and added one retry —
  // CSV exports occasionally take 15-25s on bigger sheets and the original
  // single-shot fetch failed the bulk-check on every slow sweep.
  async function tryFetch(timeoutMs) {
    return fetch(csvUrl, { signal: AbortSignal.timeout(timeoutMs) });
  }
  let response;
  try {
    response = await tryFetch(30000);
  } catch (err) {
    // Timeout (AbortError) or network blip — give it one more shot before
    // surfacing as a sweep failure. Bulk-check is gated by a 6h cooldown,
    // so spending a few extra seconds here is cheap insurance.
    console.warn(`[sheets] First CSV fetch failed (${err.message}); retrying once…`);
    // Wait before retrying. The first attempt failing with UND_ERR_CONNECT_TIMEOUT
    // means undici could not establish the connection AT ALL, and an immediate
    // second attempt just meets the same dead network (2026-08-27: a VM CC+IC
    // launch died on the pre-flight gate with both attempts timing out on
    // connect, while the same URL answered in ~1.4s a minute later). A short
    // pause is what makes the retry an independent attempt rather than a
    // formality; the gate is already a multi-second step, so nobody notices it.
    await new Promise((r) => setTimeout(r, 2500));
    try {
      response = await tryFetch(30000);
    } catch (err2) {
      // undici collapses DNS failures, refused connections, socket exhaustion
      // and TLS interception into a bare "fetch failed" — the reason only ever
      // lives on .cause, and without it the operator's screen is a dead end
      // (RJ, 17 Aug: wizard said "Error: fetch failed", his shell reached
      // Google fine six minutes later, and nothing told us which layer broke).
      const why = err2.cause?.code || err2.cause?.message || err2.name;
      console.error(`[sheets] CSV fetch failed twice: ${err2.message}${why ? ` (${why})` : ''}`);
      throw new Error(
        `Could not reach Google Sheets — ${err2.message}${why ? ` (${why})` : ''}. `
        + (/CONNECT_TIMEOUT|ENOTFOUND|EAI_AGAIN/i.test(String(why))
          ? 'The connection could not be opened at all, twice. If this machine was online '
            + 'a minute ago it was probably a brief network drop, so try again first. If it '
            + 'keeps happening it is '
          : 'The sheet itself is fine; this is the network on this machine — ')
        + 'DNS, '
        + 'firewall, VPN, or an antivirus/corporate TLS proxy the browser trusts '
        + 'but the app does not.',
      );
    }
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch Google Sheet (HTTP ${response.status}). Is the sheet publicly viewable?`);
  }
  return response.text();
}

/**
 * Fetches all rows from a public Google Sheet.
 * @param {string} sheetUrl - The Google Sheet URL
 * @returns {Promise<Record<string, string>[]>}
 */
export async function fetchSheet(sheetUrl) {
  const rows = parseCSV(await fetchSheetCsv(sheetUrl));
  console.log(`[sheets] Parsed ${rows.length} row(s). Columns: ${rows.length > 0 ? Object.keys(rows[0]).join(', ') : '(none)'}`);
  return rows;
}

/**
 * Fetches all rows AND their 1-based sheet row numbers from a public Google
 * Sheet. Used by the Sales Nav Scrape "From a Sheet" row-range picker.
 * @param {string} sheetUrl - The Google Sheet URL
 * @returns {Promise<{ rowNumber: number, row: Record<string, string> }[]>}
 */
export async function fetchSheetWithRows(sheetUrl) {
  const rows = parseCSVWithRowNumbers(await fetchSheetCsv(sheetUrl));
  console.log(`[sheets] Parsed ${rows.length} non-empty row(s) with row numbers.`);
  return rows;
}

// ---------------------------------------------------------------------------
// Tab-guard helpers (pure, exported for unit tests and campaign run-guard)
// ---------------------------------------------------------------------------

const _SYSTEM_TAB_NAMES = new Set([
  'recent connections',
  'recent messages',
  'savedsearch/batches',
  'savedsearch',
  'batches',
  'soo',
  'linkedin accounts',
  'ops log',
  'events',
  'config',
]);

/**
 * Returns true when the tab name matches a known system/sidecar tab that is
 * never a lead list. Check is case-insensitive and trims whitespace.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSystemTabName(name) {
  return _SYSTEM_TAB_NAMES.has(String(name || '').trim().toLowerCase());
}

/**
 * Returns true when `rows` looks like a lead list: non-empty, has a
 * recognizable First-Name header AND a column whose header or first-row value
 * indicates a LinkedIn URL.
 *
 * Inline URL detection mirrors extractLinkedInUrl's fallback scan so this
 * module stays free of a campaign.js import (which would create a cycle).
 *
 * @param {Record<string, string>[]} rows
 * @returns {boolean}
 */
export function looksLikeLeadRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const keys = Object.keys(rows[0]);

  // Require a recognizable First Name column
  const hasFirstName = keys.some((k) => /^first ?name$/i.test(k.trim()) || /^first_name$/i.test(k.trim()));
  if (!hasFirstName) return false;

  // Require a column whose header suggests LinkedIn/URL OR whose first value
  // contains a LinkedIn URL (handles columns named "Profile", "Slug", etc.)
  const hasLinkedIn = keys.some((k) => {
    if (/linkedin|url|profile|slug/i.test(k)) return true;
    const v = rows[0][k] || '';
    return /linkedin\.com\/(in|sales\/lead)\//i.test(v) || /\/in\//.test(v);
  });

  return hasLinkedIn;
}

/**
 * Enumerates the tabs of a Google Sheet workbook by calling the Apps Script
 * `listTabs` action (same transport as sheets-writer.js).
 *
 * @param {string} sheetUrl - Any Google Sheets URL; the spreadsheet ID is extracted.
 * @returns {Promise<Array<{ name: string, gid: string, rowCount: number, header: string[] }>>}
 */
export async function listSheetTabs(sheetUrl) {
  const webAppUrl = SHEETS_WEBAPP_URL;
  if (!webAppUrl) {
    throw new Error('listSheetTabs: SHEETS_WEBAPP_URL is not configured');
  }

  const sheetId = spreadsheetIdFromUrl(sheetUrl);
  if (!sheetId) {
    throw new Error(`listSheetTabs: could not extract spreadsheet ID from URL: ${sheetUrl}`);
  }

  const body = JSON.stringify({ action: 'listTabs', sheetId });

  // Mirror the redirect-aware POST pattern from sheets-writer.js
  let res;
  try {
    const initial = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
    });
    if (initial.status >= 300 && initial.status < 400) {
      const location = initial.headers.get('location');
      res = await fetch(location, { signal: AbortSignal.timeout(60000) });
    } else {
      res = initial;
    }
  } catch (err) {
    throw new Error(`listSheetTabs: network error — ${err.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`listSheetTabs: non-JSON response from Apps Script — redeploy may be needed`);
  }

  if (!data.ok || !Array.isArray(data.tabs)) {
    throw new Error(`listSheetTabs: Apps Script returned error — ${data.error || JSON.stringify(data)}`);
  }

  return data.tabs;
}
