import { workspaceKey, signRequest } from './sheets-gateway-protocol.mjs';
import { GL_ACCOUNTS } from './gologin-accounts.js';
import { SHEETS_GATEWAY_URL } from './sheets-webapp-url.js';
// Only sign requests to the exact shipped gateway. Never forward signatures on redirects.
export async function sheetsFetch(url, options = {}) {
  if (String(url) !== SHEETS_GATEWAY_URL || options.method !== 'POST') return fetch(url, options);
  const tokens = GL_ACCOUNTS.map(a => process.env[a.env]?.trim()).filter(Boolean);
  if (!tokens.length) throw Error('A configured company GoLogin workspace is required for the team Sheets bridge.');
  const body = options.body;
  if (typeof body !== 'string') throw Error('Sheets gateway requires a serialized JSON request');
  let response;
  for (const token of [...new Set(tokens)]) {
    response = await fetch(url, {...options,redirect:'error',headers:{...options.headers,...signRequest(workspaceKey(token),body)}});
    if (response.status !== 401) return response;
  }
  return response;
}
