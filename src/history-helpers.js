import { getConfigById } from './campaign-configs.js';
// Helpers backing the /api/history/:idx/* routes (v0.3 dashboard).
//
// Kept thin and pure so the routes stay declarative and unit tests can
// exercise the logic without spinning up an HTTP listener (matching the
// repo-wide convention in tests/* — pure-helper, not integration).
//
// Persistence model: history.json is a JSON array, oldest-first. We
// replace it wholesale (read → mutate → write) just like the existing
// /api/history/* routes in server.js. No .tmp + rename here — matching
// the in-place pattern those routes already use.

import { readFile } from 'node:fs/promises';
import { dataPath } from './paths.js';
import { addToQueue } from './campaign-queue.js';
import { updateJsonAtomic } from './atomic-json-store.js';

const HISTORY_PATH = dataPath('history.json');

async function readHistory() {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeHistory(arr) {
  await updateJsonAtomic(HISTORY_PATH, [], () => arr);
}

// Result codes mirror the route's HTTP semantics so the route handler
// is a 1:1 translator. 'ok' carries the new queue entry on success.
export async function relaunchHistoryEntry(idx) {
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, code: 'invalid_idx' };
  }
  const history = await readHistory();
  if (idx >= history.length) {
    return { ok: false, code: 'out_of_range' };
  }
  const entry = history[idx];
  if (!entry.settings) {
    return { ok: false, code: 'missing_settings' };
  }
  const config = {
    ...entry.settings,
    campaignId: undefined,
    name: (entry.name || 'Campaign') + ' (rerun)',
    mode: entry.mode || entry.settings.mode,
  };
  const queued = await addToQueue(config, entry.owner || null);
  return { ok: true, entry: queued };
}

export async function archiveHistoryEntry(idx) {
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, code: 'invalid_idx' };
  }
  let found = false;
  await updateJsonAtomic(HISTORY_PATH, [], (value) => {
    const history = Array.isArray(value) ? value : [];
    if (idx < history.length) { history[idx].archived = true; found = true; }
    return history;
  });
  return found ? { ok: true } : { ok: false, code: 'out_of_range' };
}

// Read history with optional archived filter. The default (no filter)
// matches the existing GET /api/history behaviour for backwards compat;
// only `?includeArchived=false` activates the filter.
export async function listHistory({ includeArchived = true } = {}) {
  const all = await readHistory();
  for (const row of all) { const current = getConfigById(row.campaignId); if (current) row.name = current.name; }
  if (includeArchived) return all;
  return all.filter((e) => !e.archived);
}

// Read the per-campaign filtered slice of data/campaign.log. Returns
// the last `limit` lines that mention the campaign's name (case-sensitive
// substring match — the log format embeds the name verbatim).
export async function readCampaignLog(idx, { limit = 500 } = {}) {
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, code: 'invalid_idx' };
  }
  const history = await readHistory();
  if (idx >= history.length) {
    return { ok: false, code: 'out_of_range' };
  }
  const entry = history[idx];
  const name = entry.name || '';
  const logFile = dataPath('campaign.log');
  let text;
  try {
    text = await readFile(logFile, 'utf-8');
  } catch {
    return { ok: true, name, lines: [], total: 0 };
  }
  const all = text.split('\n');
  if (entry.campaignId && (entry.runId || entry.executionId)) {
    const identityTag = `[campaignId=${entry.campaignId}]`;
    const runTag = `[runId=${entry.runId || entry.executionId}]`;
    const exact = all.filter(line => line.includes(identityTag) && line.includes(runTag));
    // New runs carry IDs in every persisted log line. Never substitute another
    // campaign's output when an exact run has no lines (e.g. rotated log).
    if (entry.logIdentityVersion === 1 || exact.length || all.some(line => line.includes(identityTag))) {
      return { ok: true, campaignId: entry.campaignId, name, lines: exact.slice(-limit).map(line => line.replace(/ \[campaignId=[^\]]*\] \[runId=[^\]]*\]$/, '')), total: exact.length };
    }
  }

  // Primary: slice by the campaign's time window — entry.date is the END
  // timestamp and entry.duration the run length in seconds. Per-lead log
  // lines never contain the campaign name, so the legacy name filter
  // returned nothing for most campaigns.
  const windowLines = sliceLogByWindow(all, entry);
  if (windowLines.length) {
    return { ok: true, name, lines: windowLines.slice(-limit), total: windowLines.length };
  }
  // Fallback: legacy case-sensitive name-substring match.
  if (!name) return { ok: true, name, lines: [], total: 0 };
  const filtered = all.filter((l) => l.includes(name));
  return { ok: true, name, lines: filtered.slice(-limit), total: filtered.length };
}

// Pure: lines whose leading "[ISO]" timestamp falls inside the campaign's
// run window [end - duration - grace, end + grace]. Untimestamped lines
// inside the window (continuations) are kept; anything before the window's
// first hit or after its last is dropped. Exported for unit tests.
export function sliceLogByWindow(lines, entry, { graceMs = 60_000 } = {}) {
  const end = Date.parse(entry?.date || '');
  const durationMs = (Number(entry?.duration) || 0) * 1000;
  if (!Number.isFinite(end) || durationMs <= 0) return [];
  const from = end - durationMs - graceMs;
  const to = end + graceMs;
  const out = [];
  let inWindow = false;
  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\]/);
    if (m) {
      const ts = Date.parse(m[1]);
      if (Number.isFinite(ts)) {
        if (ts > to) break;
        inWindow = ts >= from;
      }
    }
    if (inWindow && line.trim()) out.push(line);
  }
  return out;
}
