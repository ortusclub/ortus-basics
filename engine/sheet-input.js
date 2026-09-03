/**
 * Read Sales Nav SEARCH URLs out of a public Google Sheet — the engine-side
 * port of the Ortus app's "From a Sheet" input. Lets the standalone web UI
 * (scraper.ortusclub.com) load search URLs from a sheet and pick which ROWS to
 * scrape, exactly like the app. Mirrors app/src/sheets.js + scraper-client.js.
 *
 * The sheet must be "Anyone with the link can view". We export it as CSV and
 * keep each URL's TRUE 1-based sheet row number (header = row 1) so the UI can
 * offer a "scrape rows 2–10" picker that matches what's on screen.
 */

const SALES_NAV_SEARCH_RE = /linkedin\.com\/sales\/search\//i;

function extractSheetId(url) {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]+$/.test(url.trim())) return url.trim();
  throw new Error(`Cannot extract Google Sheet ID from URL: ${url}`);
}

function extractSheetGid(url) {
  if (!url || typeof url !== "string") return null;
  const match = url.match(/[#&?]gid=(\d+)/);
  return match ? match[1] : null;
}

/** Split CSV into raw line strings, honoring quoted newlines. */
function splitCsvIntoLines(csv) {
  const lines = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') { current += '""'; i++; }
      else { inQuotes = !inQuotes; current += ch; }
    } else if (ch === "\n" && !inQuotes) { lines.push(current); current = ""; }
    else if (ch === "\r" && !inQuotes) { /* skip */ }
    else { current += ch; }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

function splitCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

/**
 * Parse CSV into rows tagged with their 1-based sheet row number. Blank rows
 * are skipped but still advance the counter, so numbers stay aligned with the
 * actual spreadsheet.
 * @returns {{ rowNumber: number, row: Record<string,string> }[]}
 */
function parseCSVWithRowNumbers(csv) {
  const lines = splitCsvIntoLines(csv);
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]);
    if (values.every((v) => !v.trim())) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] || "").trim();
    }
    out.push({ rowNumber: i + 1, row }); // line index i → sheet row i+1
  }
  return out;
}

/** First Sales Nav search URL per sheet row, tagged with the row number. */
function extractSalesNavUrlsWithRows(rowsWithNumbers) {
  if (!Array.isArray(rowsWithNumbers)) return [];
  const out = [];
  for (const entry of rowsWithNumbers) {
    if (!entry || typeof entry !== "object" || !entry.row) continue;
    for (const value of Object.values(entry.row)) {
      const v = (value == null ? "" : String(value)).trim();
      if (!v || !SALES_NAV_SEARCH_RE.test(v)) continue;
      out.push({ row: entry.rowNumber, url: v });
      break; // one search per row
    }
  }
  return out;
}

async function fetchSheetCsv(sheetUrl) {
  const sheetId = extractSheetId(sheetUrl);
  const gid = extractSheetGid(sheetUrl);
  const csvUrl = gid
    ? `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`
    : `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

  async function tryFetch(timeoutMs) {
    return fetch(csvUrl, { signal: AbortSignal.timeout(timeoutMs) });
  }
  let response;
  try {
    response = await tryFetch(30000);
  } catch (err) {
    response = await tryFetch(30000); // one retry on timeout/blip
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Google Sheet (HTTP ${response.status}). Is the sheet publicly viewable?`
    );
  }
  return response.text();
}

/**
 * Read a public Google Sheet and return its Sales Nav search URLs with sheet
 * row numbers: [{ row, url }]. Throws if the sheet can't be read.
 */
async function extractSearchUrlsFromSheet(sheetUrl) {
  const rows = parseCSVWithRowNumbers(await fetchSheetCsv(sheetUrl));
  return extractSalesNavUrlsWithRows(rows);
}

module.exports = {
  extractSearchUrlsFromSheet,
  // exported for unit testing
  extractSalesNavUrlsWithRows,
  parseCSVWithRowNumbers,
};
