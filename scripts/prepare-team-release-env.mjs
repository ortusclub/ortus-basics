// Release artifacts must contain no reusable bridge or workspace credentials.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
if (!target || resolve(target) === resolve(root)) throw new Error('Pass an isolated release directory');
mkdirSync(resolve(target), { recursive: true });
writeFileSync(resolve(target, '.env'), '# Team gateway is configured in source. No bundled credentials.\n', {mode:0o600});
console.log('Credential-free release environment prepared.');
