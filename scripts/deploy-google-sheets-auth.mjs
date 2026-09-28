// Native OAuth client metadata is public. Private bridge credentials stay in
// existing Cloud Run Secret Manager bindings; never read or print them here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const file = process.argv[2];
if (!file) throw Error('Usage: node scripts/deploy-google-sheets-auth.mjs /path/to/desktop-client.json');
const {installed} = JSON.parse(readFileSync(file,'utf8'));
if (!installed || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(installed.client_id || '') || !/^[\w.-]+$/.test(installed.client_secret || '')) throw Error('Expected a Google OAuth Desktop app client JSON file.');
const result = spawnSync('gcloud', ['run','deploy','ortus-sheets-gateway',
  '--project=ortusbot','--region=asia-southeast1',
  '--source='+fileURLToPath(new URL('../services/sheets-gateway',import.meta.url)),
  '--update-env-vars=^|^GOOGLE_DESKTOP_CLIENT_ID='+installed.client_id+'|GOOGLE_DESKTOP_CLIENT_SECRET='+installed.client_secret,
  '--quiet'], {stdio:'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status || (result.signal ? 1 : 0);
