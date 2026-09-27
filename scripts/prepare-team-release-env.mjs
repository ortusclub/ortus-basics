// This credential is intentionally shared in the downloadable desktop app.
// Never copy the developer's .env: it contains unrelated private credentials.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
if (!target || resolve(target) === resolve(root)) throw new Error('Pass an isolated release directory, not the development checkout');
const key = readFileSync(resolve(root, 'apps-script/independent/bridge-key.txt'), 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid bridge credential');
const url = new URL('https://script.google.com/macros/s/AKfycbzPLa8j57j-dsq__1j5uKS21pLQAKNy2lCoGmGUHEM60S3fOaqvwppip6hXFexqDF0jrg/exec');
url.searchParams.set('key', key);
mkdirSync(resolve(target), { recursive: true });
writeFileSync(resolve(target, '.env'), `# Intentionally distributed team Sheets bridge credential.\nORTUS_SHEETS_WEBAPP_URL=${url.href}\n`, { mode: 0o600 });
console.log('Release environment prepared: team Sheets bridge only; credential omitted from output.');
