// Boots the REAL server.js (the same one the app runs) in a child process with the fake Google Sheet / launcher in front
// of it, a throwaway data folder, and a signed-in session cookie — so a test can use the app exactly like an operator.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SIM = fileURLToPath(new URL('../', import.meta.url));

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.unref(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** sheet = { headers, leads, accounts }. Returns { port, url, cookie, log(), stop(), setSheet(sheet) }. */
export async function bootServer(sheet, { email = 'sim@example.com' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sim-server-'));
  const dataDir = join(dir, 'data');
  const specFile = join(dir, 'sheet.json');
  const setSheet = (s) => writeFileSync(specFile, JSON.stringify(s));
  setSheet(sheet);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'operator-identity.json'), JSON.stringify({ email }));
  const secret = crypto.randomBytes(16).toString('hex');
  writeFileSync(join(dataDir, '.session-secret'), secret);
  const body = Buffer.from(JSON.stringify({ email, exp: Date.now() + 3600e3 })).toString('base64url');
  const cookie = body + '.' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  const port = await freePort();
  let out = '';
  const child = spawn(process.execPath, ['--import', join(SIM, 'register.mjs'), '--import', join(SIM, 'startup/preload.mjs'), join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), ORTUS_DATA_DIR: dataDir, SIM_STARTUP_SPEC: specFile },
  });
  child.stdout.on('data', d => { out = (out + d).slice(-4000); });
  child.stderr.on('data', d => { out = (out + d).slice(-4000); });
  let exited = false; child.on('exit', () => { exited = true; });

  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (exited) throw new Error('The app server exited while starting: ' + out.split('\n').filter(Boolean).slice(-3).join(' | '));
    try { const r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(1500) }); if (r.status === 401 || r.ok) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 60000) { child.kill('SIGKILL'); throw new Error('The app server did not start within 60s: ' + out.split('\n').filter(Boolean).slice(-3).join(' | ')); }
    await new Promise(r => setTimeout(r, 300));
  }
  return { port, url, cookie, setSheet, log: () => out, stop: () => { try { child.kill('SIGKILL'); } catch { /* */ } } };
}
