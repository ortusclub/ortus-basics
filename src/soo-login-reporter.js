import { markAccountNeedsLoginSoO } from './soo-writer.js';

const MODES = new Set(['connect_and_introduce', 'open_profile_only', 'introduce_back']);

// One reporter per run. Confirmed flags are deduplicated; failed writes remain
// retryable on the next logout report. Concurrent reports share one request.
export function createSoOLoginReporter({ mode, log = () => {}, write = markAccountNeedsLoginSoO }) {
  const confirmed = new Set(), pending = new Map();
  return async function report(accountName) {
    const email = String(accountName || '').trim().toLowerCase();
    if (!MODES.has(mode) || !email) return;
    if (confirmed.has(email)) return { ok: true, alreadyReported: true };
    if (pending.has(email)) return pending.get(email);
    const task = (async () => {
      try {
        const result = await write({ email });
        if (result?.ok && result.matched) {
          confirmed.add(email);
          if (!result.alreadySet) log(`  ⚑ SoO: ${email} → Needs Login = Y.`);
        } else {
          log(`  ⚠ SoO Needs Login failed for ${email}: ${result?.error || 'update not confirmed'}.`);
        }
        return result;
      } catch (error) {
        log(`  ⚠ SoO Needs Login failed for ${email}: ${error.message}`);
        return { ok: false, error: error.message };
      }
    })();
    pending.set(email, task);
    try { return await task; } finally { pending.delete(email); }
  };
}
