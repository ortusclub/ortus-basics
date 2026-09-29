import { SHEETS_GATEWAY_URL } from './sheets-webapp-url.js';
// Shared Sheets access is public by the owner's explicit configuration.
// Neither app identity, Google session nor GoLogin credentials gate requests.
export async function sheetsFetch(url, options = {}) {
  if (String(url) !== SHEETS_GATEWAY_URL || options.method !== 'POST') return fetch(url, options);
  if (typeof options.body !== 'string') throw Error('Sheets gateway requires a serialized JSON request');
  return fetch(url, {...options, redirect:'error'});
}
