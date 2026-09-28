import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Durable queue of sheet updates only. This module never sends LinkedIn messages.
export function createSheetWriteOutbox({ filePath, write, now = Date.now, onResult = () => {}, retryBaseMs = 30000 }) {
  let entries = [];
  try {
    const saved = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(saved) || saved.some(e => !e.id || !e.sheetUrl || !e.url || typeof e.payload !== 'string')) {
      throw new Error('Invalid sheet write queue');
    }
    // A previous process may have exited during a request. Reapply the same
    // cell values; never infer that an unacknowledged request succeeded.
    entries = saved.map(e => ({ ...e, nextAttemptAt: 0 }));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error; // never overwrite an unreadable queue
  }
  let active = null;
  function save() {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath + '.tmp', JSON.stringify(entries), { encoding: 'utf8', mode: 0o600 });
    renameSync(filePath + '.tmp', filePath);
  }
  function key(entry) {
    const sheet = new URL(entry.sheetUrl);
    const gid = sheet.searchParams.get('gid') || new URLSearchParams(sheet.hash.slice(1)).get('gid') || '';
    const lead = entry.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    return `${sheet.pathname.match(/\/d\/([^/]+)/)?.[1] || sheet.pathname}|${gid}|${lead}`;
  }
  function list() { return entries.map(e => ({ ...e })); }
  function enqueue(meta) {
    if (!meta.sheetUrl || !meta.url) throw new Error('Original sheet and lead URL are required for recovery');
    JSON.parse(meta.payload); // recovery must have complete JSON, never a preview
    key(meta);
    const entry = { ...meta, id: randomUUID(), attempts: 0, timestamp: new Date(now()).toISOString(), nextAttemptAt: 0, errorMessage: '' };
    entries.push(entry);
    try { save(); } catch (error) { entries.pop(); throw error; }
    return entry.id;
  }
  function flush({ force = false } = {}) {
    if (active) return active;
    active = (async () => {
      let retried = 0;
      const blocked = new Set();
      // FIFO per sheet+lead prevents an old result overwriting a newer result.
      // Other leads can still sync when one row or workspace is unavailable.
      for (let i = 0; i < entries.length && retried < 100;) {
        const entry = entries[i];
        const rowKey = key(entry);
        if (blocked.has(rowKey) || (!force && entry.nextAttemptAt > now())) {
          blocked.add(rowKey); i++; continue;
        }
        retried++;
        let result;
        try { result = await write(entry); }
        catch (error) { result = { ok: false, error: error.message }; }
        if (result?.ok === true) {
          entries.splice(i, 1);
          try { save(); } catch (error) { entries.splice(i, 0, entry); throw error; }
        } else {
          entry.attempts++;
          entry.errorMessage = result?.error || 'Sheets bridge did not confirm this update.';
          entry.nextAttemptAt = now() + Math.min(300000, retryBaseMs * 2 ** Math.min(entry.attempts - 1, 10));
          save();
          blocked.add(rowKey);
          i++;
        }
        try { onResult({ ...entry }, result); } catch { /* reporting cannot lose a queued result */ }
      }
      return { retried, stillFailing: entries.length };
    })().finally(() => { active = null; });
    return active;
  }
  return { enqueue, flush, list };
}
