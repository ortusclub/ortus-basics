import { ensureSharedGoLogin } from './shared-gologin.js';
import { createHash } from 'node:crypto';
import { accountById, tokenForAccount } from './gologin-accounts.js';

/** Read-only check. No token or upstream response body is returned to the UI. */
async function checkWorkspaceCredentialOnce(id, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const account = accountById(id);
  if (!account) return { id, ok: false, error: 'Workspace no longer exists.' };
  const result = { id, label: account.label };
  const token = tokenForAccount(id);
  if (!token) return { ...result, ok: false, error: 'No token is saved for this workspace.' };
  try {
    const response = await fetchImpl('https://api.gologin.com/browser/v2?page=1', {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return { ...result, ok: false, error: `GoLogin rejected this token (${response.status}). Check or replace the API token.` };
    if (response.status === 429) return { ...result, ok: false, error: 'GoLogin is rate limiting requests. Wait a moment, then check again.' };
    if (!response.ok) return { ...result, ok: false, error: `GoLogin could not complete the check (HTTP ${response.status}). Try again shortly.` };
    const data = await response.json();
    if (!Array.isArray(data?.profiles)) return { ...result, ok: false, error: 'GoLogin returned an unexpected account-list response. Try again.' };
    const total = Number(data.allProfilesCount);
    return { ...result, ok: true, profileCount: Number.isFinite(total) && total >= 0 ? total : data.profiles.length };
  } catch (error) {
    return { ...result, ok: false, error: ['AbortError', 'TimeoutError'].includes(error?.name)
      ? 'GoLogin did not respond within 12 seconds. The token is saved; try checking again.'
      : 'Could not reach GoLogin. Check your internet connection and try again.' };
  }
}

// Results belong to the exact token checked. Replacing/removing a token clears
// its displayed verdict automatically; the token itself is never returned.
const checks = new Map();
const fingerprint = id => createHash('sha256').update(tokenForAccount(id) || '').digest('hex');
export function getWorkspaceVerification(id) {
  const entry = checks.get(id);
  return entry && entry.fingerprint === fingerprint(id) ? { ...entry.result } : null;
}
export function recordWorkspaceVerification(id, result) {
  checks.set(id, { fingerprint: fingerprint(id), result: { ...result, checkedAt: new Date().toISOString() } });
}
export async function checkWorkspaceCredential(id, options) {
  await ensureSharedGoLogin();
  const initial = fingerprint(id);
  const result = await checkWorkspaceCredentialOnce(id, options);
  if (initial === fingerprint(id)) recordWorkspaceVerification(id, result);
  return result;
}
