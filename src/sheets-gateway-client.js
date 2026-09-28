import { sheetsGoogle } from './sheets-google-auth.js';
import { workspaceKey, signRequest } from './sheets-gateway-protocol.mjs';
import { allAccounts } from './gologin-accounts.js';
import { SHEETS_GATEWAY_URL } from './sheets-webapp-url.js';
// Only sign requests to the exact shipped gateway. Never forward signatures on redirects.
export async function sheetsFetch(url, options = {}) {
  if (String(url) !== SHEETS_GATEWAY_URL || options.method !== 'POST') return fetch(url, options);
  // Once connected, Google authorization never falls back to workspace credentials.
  if (sheetsGoogle.status().connected) {
    const send = async force => fetch(url, {...options, redirect:'error', headers:{...options.headers, Authorization:'Bearer ' + await sheetsGoogle.token({force})}});
    const response = await send(false);
    return response.status === 401 ? send(true) : response;
  }
  if (!sheetsGoogle.status().legacyAllowed) throw Error('Connect Google Sheets with your company Google account in Settings.');
  // Compatibility for existing installations during the gateway rollout.
  const tokens = allAccounts().map(a => process.env[a.env]?.trim()).filter(Boolean);
  if (!tokens.length) throw Error('Connect Google Sheets with your company Google account in Settings.');
  const body = options.body;
  if (typeof body !== 'string') throw Error('Sheets gateway requires a serialized JSON request');
  let response;
  for (const token of [...new Set(tokens)]) {
    response = await fetch(url, {...options,redirect:'error',headers:{...options.headers,...signRequest(workspaceKey(token),body)}});
    if (response.status !== 401) return response;
  }
  return response;
}
