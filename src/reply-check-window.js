// Pure helpers for the manual "Check for replies" button: how far back each
// account's inbox must be read, and which sheet column holds the LinkedIn link.
// A finished campaign has no in-memory start time, so both are read off the
// sheet itself.

const DAY_MS = 86400000;
export const DEFAULT_LOOKBACK_DAYS = 30;
export const MAX_LOOKBACK_DAYS = 90;

// Columns the Sheets script stamps with the send date (YYYY-MM-DD).
const DATE_COLUMNS = ['Date of Last Action', 'Date of last action', 'Last Action Date', 'Date'];

function parseDay(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Earliest send date across `rows`, minus a day of slack (time zones, and the
 * date column holds a day, not a time). Falls back to DEFAULT_LOOKBACK_DAYS when
 * no row carries a readable date; never reaches back more than MAX_LOOKBACK_DAYS.
 */
export function replyWatermarkForRows(rows, now = Date.now()) {
  let earliest = Infinity;
  for (const row of (Array.isArray(rows) ? rows : [])) {
    for (const col of DATE_COLUMNS) {
      const t = parseDay(row?.[col]);
      if (Number.isFinite(t)) { earliest = Math.min(earliest, t); break; }
    }
  }
  const floor = now - MAX_LOOKBACK_DAYS * DAY_MS;
  if (!Number.isFinite(earliest) || earliest > now) return now - DEFAULT_LOOKBACK_DAYS * DAY_MS;
  return Math.max(floor, earliest - DAY_MS);
}

/**
 * The column holding each lead's LinkedIn profile link. Keeps `requested` when
 * it exists and holds links; otherwise picks the column with the most
 * linkedin.com/in/ links (e.g. OPI tabs keep them under "Linkedin Bio").
 */
export function detectLinkedinColumn(rows, requested) {
  const list = Array.isArray(rows) ? rows : [];
  const isLink = (v) => /linkedin\.com\/(in|sales\/lead|sales\/people)\//i.test(String(v || ''));
  if (requested && list.some((r) => isLink(r?.[requested]))) return requested;
  const counts = new Map();
  for (const r of list) {
    for (const [k, v] of Object.entries(r || {})) {
      if (isLink(v)) counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  let best = '';
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best || requested || 'Linkedin URL';
}
