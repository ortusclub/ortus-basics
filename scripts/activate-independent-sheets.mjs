import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const [deploymentUrl, sheetId] = process.argv.slice(2);
if (!deploymentUrl || !sheetId) throw new Error('Usage: node scripts/activate-independent-sheets.mjs <deployment /exec URL> <sheet ID>');
const url = new URL(deploymentUrl);
if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname)) throw new Error('Expected a Google Apps Script deployment URL');
const key = readFileSync(resolve(root, 'apps-script/independent/bridge-key.txt'), 'utf8').trim();
url.searchParams.set('key', key);

async function request(options = {}) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`Replacement bridge returned HTTP ${r.status}; existing configuration was not changed`);
  let result;
  try { result = await r.json(); } catch { throw new Error('Replacement returned HTML instead of JSON; authorize/deploy it before activation'); }
  if (result.error) throw new Error(result.error);
  return result;
}
const health = await request();
if (health.service !== 'Ortus Basics Independent Sheets Bridge' || health.status !== 'ok') throw new Error('Wrong bridge response');
const tabs = await request({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: 'listTabs', sheetId})});
if (!tabs.ok || !Array.isArray(tabs.tabs)) throw new Error('Could not verify access to the campaign sheet');
const verification = await request({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: 'selfTestBridge'})});
if (!verification.ok || verification.checks?.length !== 5) throw new Error('Replacement write/readback verification did not pass');
console.log('Disposable-sheet write/readback checks passed: ' + verification.checks.join(', '));

const envPath = resolve(root, '.env');
const before = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
if (existsSync(envPath)) {
  const backup = envPath + '.before-independent-sheets';
  if (!existsSync(backup)) {
    copyFileSync(envPath, backup);
    chmodSync(backup, 0o600);
  }
}
const line = 'ORTUS_SHEETS_WEBAPP_URL=' + url.href;
const after = /^ORTUS_SHEETS_WEBAPP_URL=.*$/m.test(before)
  ? before.replace(/^ORTUS_SHEETS_WEBAPP_URL=.*$/m, line)
  : before.trimEnd() + '\n' + line + '\n';
writeFileSync(envPath, after, {mode: 0o600});
chmodSync(envPath, 0o600);
console.log(`Replacement verified (${tabs.tabs.length} sheet tabs). Local .env updated; restart the Electron app to activate.`);
