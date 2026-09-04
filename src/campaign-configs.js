/**
 * src/campaign-configs.js — a campaign's wizard settings, kept by NAME.
 *
 * Ortus Basics 1.0. Settings used to hang off the cloud launch-config snapshot,
 * keyed by an engine campaign id. Local runs had no such id, and the ids that
 * did exist did not survive a restart — so reopening a campaign came back empty
 * every time. The operator's own key for a campaign is its name, so that is what
 * this stores against.
 *
 * The rule: a save (Save, or starting a run) writes the settings and they stay
 * written until the same name is saved again. Nothing else clears them.
 *
 * Lives in the app's data directory, so it survives reinstalling the app.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dataPath } from './paths.js';

const FILE = () => dataPath('campaign-configs.json');

/** Names are compared case-insensitively and trimmed — "Test" and "test " are
 *  the same campaign to an operator, so they must be the same key here. */
export function normaliseName(name) {
  return String(name || '').trim().toLowerCase();
}

function readAll() {
  try {
    const p = FILE();
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    console.warn(`[campaign-configs] could not read: ${err.message}`);
    return {};
  }
}

function writeAll(all) {
  writeFileSync(FILE(), JSON.stringify(all, null, 2), 'utf8');
}

export function saveConfig(name, config) {
  const key = normaliseName(name);
  if (!key) return null;
  const all = readAll();
  all[key] = {
    name: String(name).trim(),      // the operator's own capitalisation
    savedAt: new Date().toISOString(),
    config: config || {},
  };
  writeAll(all);
  return all[key];
}

export function getConfig(name) {
  return readAll()[normaliseName(name)] || null;
}

/** Every saved name, newest first — the dashboard needs this to spot clashes. */
export function listConfigs() {
  return Object.values(readAll())
    .map((e) => ({ name: e.name, savedAt: e.savedAt }))
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/**
 * Rename a campaign: move its settings from one name to another.
 *
 * Settings are keyed by name, so "Save under a new name" wrote a SECOND record
 * and left the first in place — the rename looked saved, then the dashboard
 * showed the old name again because nothing had moved (operator, 2026-09-04).
 *
 * Returns { ok } | { ok:false, reason:'missing'|'clash'|'invalid' }. A clash is
 * refused rather than merged: two campaigns must never collapse into one record.
 */
export function renameConfig(from, to) {
  const fromKey = normaliseName(from);
  const toKey = normaliseName(to);
  if (!fromKey || !toKey) return { ok: false, reason: 'invalid' };
  if (fromKey === toKey) {
    // Same campaign, new capitalisation only — keep the operator's spelling.
    const all = readAll();
    if (!all[fromKey]) return { ok: false, reason: 'missing' };
    all[fromKey].name = String(to).trim();
    all[fromKey].savedAt = new Date().toISOString();
    writeAll(all);
    return { ok: true, name: all[fromKey].name };
  }
  const all = readAll();
  if (!all[fromKey]) return { ok: false, reason: 'missing' };
  if (all[toKey]) return { ok: false, reason: 'clash' };
  all[toKey] = { ...all[fromKey], name: String(to).trim(), savedAt: new Date().toISOString() };
  delete all[fromKey];
  writeAll(all);
  return { ok: true, name: all[toKey].name };
}

export function deleteConfig(name) {
  const all = readAll();
  const key = normaliseName(name);
  if (!(key in all)) return false;
  delete all[key];
  writeAll(all);
  return true;
}
