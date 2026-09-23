import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = resolve(root, 'apps-script/independent');
mkdirSync(target, { recursive: true, mode: 0o700 });
chmodSync(target, 0o700);
const keyFile = resolve(target, 'bridge-key.txt');
const key = existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : randomBytes(32).toString('hex');
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid local bridge key');
writeFileSync(keyFile, key + '\n', { mode: 0o600 });

// Keep the existing matching, formatting, tracking columns, and all handlers.
// Only the external entry points change: requests must carry our private key.
let source = readFileSync(resolve(root, 'google-apps-script.js'), 'utf8');
for (const name of ['doPost', 'doGet']) {
  const declaration = `function ${name}(e) {`;
  if (source.split(declaration).length !== 2) throw new Error(`Expected one ${name} handler`);
  source = source.replace(declaration, `function bridge_${name}(e) {`);
}
writeFileSync(resolve(target, 'Code.js'), source);
writeFileSync(resolve(target, 'Access.js'), `// Generated locally; do not commit or share this file.\nvar BRIDGE_KEY = ${JSON.stringify(key)};\n
function bridgeAuthorized(e) {
  return !!(e && e.parameter && e.parameter.key === BRIDGE_KEY);
}
function doGet(e) {
  if (!bridgeAuthorized(e)) return jsonResponse({error: 'Unauthorized Sheets bridge request'});
  return jsonResponse({status: 'ok', service: 'Ortus Basics Independent Sheets Bridge', protocol: 1});
}
function doPost(e) {
  if (!bridgeAuthorized(e)) return jsonResponse({error: 'Unauthorized Sheets bridge request'});
  if (JSON.parse(e.postData.contents).action === 'selfTestBridge') return selfTestBridge();
  return bridge_doPost(e);
}
// Run once in the editor as the owner to grant this project its Google scopes.
function authorizeBridge() {
  SpreadsheetApp.getActiveSpreadsheet();
  DriveApp.getRootFolder().getName();
  console.log('Sheets bridge authorized for ' + Session.getEffectiveUser().getEmail());
}
`);
writeFileSync(resolve(target, 'SelfTest.js'), readFileSync(resolve(root, 'scripts/independent-sheets-self-test.js'), 'utf8'));
writeFileSync(resolve(target, 'appsscript.json'), JSON.stringify({
  timeZone: 'Europe/Belgrade',
  dependencies: { enabledAdvancedServices: [{ userSymbol: 'Drive', version: 'v3', serviceId: 'drive' }] },
  exceptionLogging: 'STACKDRIVER', runtimeVersion: 'V8',
  webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' },
  oauthScopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email'],
}, null, 2) + '\n');
writeFileSync(resolve(target, '.claspignore'), '**/**\n!Code.js\n!Access.js\n!SelfTest.js\n!appsscript.json\n');
console.log('Prepared independent Sheets bridge in apps-script/independent. The private key remains local.');
