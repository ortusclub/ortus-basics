import { ensureCampaignIdentity, getConfigById } from './campaign-configs.js';
/**
 * Campaign queue — sequential FIFO scheduler.
 *
 * When a campaign starts while another is running, its config is appended
 * here instead of erroring. When a running campaign ends, the runner pops
 * the next entry and launches it. Persisted to disk so a crash mid-run
 * doesn't lose the operator's queued work.
 *
 * One-at-a-time sequential model. Concurrency lives at the account level
 * inside a single campaign, not across campaigns.
 */

import fs from 'fs/promises';
import { dataPath } from './paths.js';

const QUEUE_FILE = dataPath('queued-campaigns.json');

let cache = null;

async function load() {
  if (cache !== null) return cache;
  try {
    const text = await fs.readFile(QUEUE_FILE, 'utf8');
    const parsed = JSON.parse(text);
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist() {
  if (cache === null) await load();
  const tmp = QUEUE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, QUEUE_FILE);
}

export async function getQueue() {
  return (await load()).map(e => {
    const current = getConfigById(e.campaignId || e.config?.campaignId);
    return current ? { ...e, name: current.name, config: { ...e.config, name: current.name } } : { ...e };
  });
}

export async function addToQueue(config, owner, { scheduledAt = null } = {}) {
  await load();
  const identity = ensureCampaignIdentity({ campaignId: config?.campaignId, name: config?.name, config });
  config = { ...config, ...identity };
  const entry = {
    campaignId: identity.campaignId,
    id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    queuedAt: Date.now(),
    name: (config && config.name) || '',
    config,
    owner: owner || null,
    ...(scheduledAt ? { scheduledAt } : {}),
  };
  cache.push(entry);
  await persist();
  return entry;
}

export async function removeFromQueue(id) {
  await load();
  const idx = cache.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  cache.splice(idx, 1);
  await persist();
  return true;
}

// Patch a queued entry by id. Only a small allow-list of keys can be
// changed so an HTTP client can't mutate sensitive fields (owner, id,
// queuedAt). `config` is shallow-merged into the existing config so the
// dashboard's "edit queued campaign" flow can change one field without
// having to round-trip the whole object.
const ALLOWED_PATCH_KEYS = new Set(['name', 'scheduledAt', 'config']);

export async function updateQueueEntry(id, patch) {
  if (!patch || typeof patch !== 'object') {
    throw new Error('updateQueueEntry: patch must be an object');
  }
  for (const k of Object.keys(patch)) {
    if (!ALLOWED_PATCH_KEYS.has(k)) {
      throw new Error(`updateQueueEntry: unknown key "${k}"`);
    }
  }
  await load();
  const idx = cache.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  if (patch.config?.campaignId && patch.config.campaignId !== cache[idx].campaignId) throw new Error('Cannot change a queued campaign identity');
  if (patch.name !== undefined) cache[idx].name = patch.name;
  if (patch.scheduledAt !== undefined) cache[idx].scheduledAt = patch.scheduledAt;
  if (patch.config !== undefined) {
    cache[idx].config = { ...cache[idx].config, ...patch.config };
  }
  await persist();
  return cache[idx];
}

export async function popNext() {
  await load();
  if (cache.length === 0) return null;
  const next = cache.shift();
  await persist();
  return next;
}

// Return the first campaign that is eligible now. A future scheduled entry must
// never block an ordinary queued campaign behind it until tomorrow.
export async function popNextReady(now = Date.now()) {
  await load();
  const idx = cache.findIndex((entry) => {
    if (!entry.scheduledAt) return true;
    const due = new Date(entry.scheduledAt).getTime();
    return !Number.isFinite(due) || due <= now;
  });
  if (idx === -1) return null;
  const [next] = cache.splice(idx, 1);
  await persist();
  return next;
}

// Move a queued entry up (-1) or down (+1) within the FIFO order. No-op
// if the entry is already at the boundary in the requested direction.
// Returns the new index (or -1 if the id wasn't found).
export async function moveInQueue(id, direction) {
  await load();
  const idx = cache.findIndex((e) => e.id === id);
  if (idx === -1) return -1;
  const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
  const target = idx + delta;
  if (target < 0 || target >= cache.length || delta === 0) return idx;
  const [entry] = cache.splice(idx, 1);
  cache.splice(target, 0, entry);
  await persist();
  return target;
}

export async function clearQueue() {
  cache = [];
  await persist();
}

// Atomic full-order reorder. Accepts an array of queue ids in the desired
// new order. Validates that the ids match the current queue exactly (same
// set, same length) so a concurrent pop/cancel can't silently corrupt the
// order. Returns true on success, or an object with reason='mismatch' so
// the caller can refresh and retry. Used by drag-to-reorder in the dashboard.
export async function reorderQueue(ids) {
  await load();
  if (!Array.isArray(ids)) return { ok: false, reason: 'invalid_input' };
  if (ids.length !== cache.length) return { ok: false, reason: 'mismatch' };
  const have = new Set(cache.map((e) => e.id));
  for (const id of ids) {
    if (!have.has(id)) return { ok: false, reason: 'mismatch' };
  }
  const byId = new Map(cache.map((e) => [e.id, e]));
  cache = ids.map((id) => byId.get(id));
  await persist();
  return { ok: true };
}
