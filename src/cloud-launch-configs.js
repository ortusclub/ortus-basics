/**
 * Cloud launch-config store.
 *
 * The GKE engine only reports a cloud campaign's status/counts — not the full
 * wizard config (templates, delays, sender columns). To let the app DUPLICATE a
 * cloud campaign (open + New campaign pre-filled), we snapshot the exact config
 * the operator dispatched, keyed by the engine's campaign id.
 *
 * Persisted to disk (survives restarts). Capped so it can't grow unbounded.
 */

import fs from 'fs/promises';
import { dataPath } from './paths.js';

const FILE = dataPath('cloud-launch-configs.json');
const MAX_ENTRIES = 200;

let cache = null;

async function load() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, 'utf8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist() {
  if (cache === null) await load();
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, FILE);
}

export async function saveCloudLaunchConfig(id, name, config) {
  if (!id || !config) return;
  await load();
  cache[id] = { name: name || '', config, ts: Date.now() };
  // Trim oldest if over the cap.
  const ids = Object.keys(cache);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
    for (const old of ids.slice(0, ids.length - MAX_ENTRIES)) delete cache[old];
  }
  await persist();
}

/**
 * Point every run snapshot that carries `from` at `to`.
 *
 * These snapshots are keyed by run id but carry a name, and the dashboard and
 * the wizard both read that name. Leaving it stale after a rename is what makes
 * a renamed campaign come back wearing its old name.
 */
export async function renameCloudLaunchConfigs(from, to) {
  const key = (v) => String(v || '').trim().toLowerCase();
  const fromKey = key(from);
  if (!fromKey || !String(to || '').trim()) return 0;
  await load();
  let changed = 0;
  for (const id of Object.keys(cache)) {
    if (key(cache[id] && cache[id].name) === fromKey) {
      cache[id].name = String(to).trim();
      changed += 1;
    }
  }
  if (changed) await persist();
  return changed;
}

export async function getCloudLaunchConfig(id) {
  if (!id) return null;
  await load();
  return cache[id] || null;
}

// ── Primary people, derived from what was already dispatched ────────────────
// Operator ask, 2026-08-27: typing a primary's name should recall their
// LinkedIn URL. Every CC+IC launch already snapshots primaryName + primaryUrl
// here, so the recall list is the operator's own history rather than a second
// store to keep in sync. Pure so it can be unit-tested without touching disk.
//
// Identity is the URL, not the name: the same person typed as "Sam" once and
// "Sam Adcock" the next time is ONE entry (the most recent spelling wins), and
// two different people who share a first name stay separate because their URLs
// differ. An entry with no URL is dropped — a name that recalls nothing is
// exactly the typing this feature exists to remove.
export function listPrimaryPeople(entries = {}) {
  const byUrl = new Map();
  for (const entry of Object.values(entries || {})) {
    const t = (entry && entry.config && entry.config.templates) || {};
    const url = String(t.primaryUrl || '').trim();
    const name = String(t.primaryName || '').trim();
    if (!url || !name) continue;
    // linkedin.com/in/x/ and linkedin.com/in/X are the same profile.
    const key = url.toLowerCase().replace(/\/+$/, '');
    const ts = Number(entry.ts) || 0;
    const seen = byUrl.get(key);
    if (!seen) { byUrl.set(key, { name, url, count: 1, lastUsed: ts }); continue; }
    seen.count += 1;
    // Keep the spelling and the exact URL from the most RECENT launch.
    if (ts >= seen.lastUsed) { seen.lastUsed = ts; seen.name = name; seen.url = url; }
  }
  return [...byUrl.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

export async function getPrimaryPeople() {
  await load();
  return listPrimaryPeople(cache);
}
