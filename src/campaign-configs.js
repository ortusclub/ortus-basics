/** Permanent campaign registry. Names are unique labels, never record keys.
 * Legacy name-keyed files are backed up and migrated atomically on first read.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dataPath } from './paths.js';
const FILE = () => dataPath('campaign-configs.json');
export const normaliseName = name => String(name || '').trim().toLowerCase();
const empty = () => ({ version: 2, campaigns: {} });
function writeAll(store) {
  const tmp = `${FILE()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  renameSync(tmp, FILE());
}
function readAll() {
  if (!existsSync(FILE())) return empty();
  // Do not replace unreadable/corrupt settings with an empty registry.
  const old = JSON.parse(readFileSync(FILE(), 'utf8'));
  if (old?.version === 2 && old.campaigns && typeof old.campaigns === 'object') return old;
  if (!old || typeof old !== 'object' || Array.isArray(old)) throw new Error('Invalid campaign registry');
  const store = empty();
  for (const entry of Object.values(old)) {
    if (!entry || typeof entry !== 'object' || !entry.name) throw new Error('Invalid legacy campaign settings');
    const campaignId = randomUUID();
    store.campaigns[campaignId] = { ...entry, campaignId, config: { ...entry.config, campaignId } };
  }
  if (!existsSync(`${FILE()}.before-ids.bak`)) copyFileSync(FILE(), `${FILE()}.before-ids.bak`);
  writeAll(store);
  return store;
}
function byName(store, name) {
  const key = normaliseName(name);
  return Object.values(store.campaigns).find(e => normaliseName(e.name) === key) || null;
}
function conflict(message, code = 'name_exists') {
  const error = new Error(message); error.status = 409; error.code = code; throw error;
}
export function getConfig(name) { return byName(readAll(), name); }
export function getConfigById(campaignId) { return readAll().campaigns[campaignId] || null; }
export function saveConfig(name, config, { campaignId = config?.campaignId, create = false, listed } = {}) {
  const label = String(name || '').trim();
  if (!label) return null;
  const store = readAll();
  const named = byName(store, label);
  const current = campaignId ? store.campaigns[campaignId] : named;
  if (campaignId && !current) conflict('Campaign no longer exists. Reopen it from the dashboard.', 'unknown_campaign');
  if ((create && named) || (named && current && named.campaignId !== current.campaignId)) conflict('That campaign name already exists. Please choose a different name.');
  const id = current?.campaignId || randomUUID();
  store.campaigns[id] = { ...current, campaignId: id, name: label, listed: listed ?? current?.listed ?? true, savedAt: new Date().toISOString(), config: { ...config, campaignId: id } };
  writeAll(store);
  return store.campaigns[id];
}
/** Resolve identity without overwriting saved wizard settings. */
export function ensureCampaignIdentity({ campaignId, name = '', config = {}, listed = true } = {}) {
  const entry = campaignId ? getConfigById(campaignId) : (normaliseName(name) ? getConfig(name) : null);
  if (campaignId && !entry) conflict('Campaign no longer exists. Reopen it from the dashboard.', 'unknown_campaign');
  if (entry) return { campaignId: entry.campaignId, name: entry.name };
  if (!normaliseName(name)) {
    const store = readAll(); const id = randomUUID();
    store.campaigns[id] = { campaignId: id, name: '', listed, savedAt: new Date().toISOString(), config: { ...config, campaignId: id } };
    writeAll(store); return { campaignId: id, name: '' };
  }
  const created = saveConfig(name, config, { listed });
  return { campaignId: created.campaignId, name: created.name };
}
export function listConfigs() {
  return Object.values(readAll().campaigns).filter(e => e.listed !== false && normaliseName(e.name)).map(({campaignId,name,savedAt}) => ({campaignId,name,savedAt}))
    .sort((a,b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}
export function renameConfig(from, to, campaignId = null) {
  if (!normaliseName(to) || (!campaignId && !normaliseName(from))) return { ok: false, reason: 'invalid' };
  const entry = campaignId ? getConfigById(campaignId) : getConfig(from);
  if (!entry) return { ok: false, reason: 'missing' };
  try {
    const saved = saveConfig(to, entry.config, { campaignId: entry.campaignId });
    return { ok: true, name: saved.name, campaignId: saved.campaignId };
  } catch (error) { if (error.code === 'name_exists') return { ok: false, reason: 'clash' }; throw error; }
}
export function deleteConfig(name, campaignId = null) {
  const store = readAll();
  const entry = campaignId ? store.campaigns[campaignId] : byName(store, name);
  if (!entry) return false;
  delete store.campaigns[entry.campaignId]; writeAll(store); return true;
}
