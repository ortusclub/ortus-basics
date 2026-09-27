import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../paths.js';

export function createSalesNavAccessStore(file) {
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } };
  return {
    get(profileId) { return read()[profileId] || null; },
    set(profileId, status) {
      if (!profileId) return null;
      const records = read();
      const value = { status, checkedAt: new Date().toISOString() };
      records[profileId] = value;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(records), { mode: 0o600 });
      renameSync(file + '.tmp', file);
      return value;
    },
  };
}
const store = createSalesNavAccessStore(dataPath('sales-nav-access.json'));
export const getSalesNavAccess = id => store.get(id);
export const setSalesNavAccess = (id, status) => store.set(id, status);

// Only explicit Sales Navigator subscription gates count. Login pages,
// timeouts, generic Premium ads and navigation errors do not prove no licence.
export function isSalesNavSubscriptionGate(url) {
  try {
    const u = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(u.hostname)
      && (/^\/premium\/products\/?$/i.test(u.pathname)
        && /sales[_-]?(?:ss|nav|navigator)/i.test(u.search)
        || /^\/sales\/(?:signup|subscription|purchase)(?:\/|$)/i.test(u.pathname));
  } catch { return false; }
}

export async function detectSalesNavSubscriptionGate(page) {
  if (isSalesNavSubscriptionGate(page.url())) return true;
  // A redirect can destroy the context while the preceding page is settling.
  // Briefly allow that navigation to finish, checking the URL without JS in-page.
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (isSalesNavSubscriptionGate(page.url())) return true;
  }
  return false;
}

export function salesNavChannel(channel, access) {
  if (access?.status !== 'unavailable') return channel;
  if (channel === 'sn_only') return 'unavailable';
  return 'ln_only';
}
