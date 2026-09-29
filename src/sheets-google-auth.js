import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dataPath } from './paths.js';
import { SHEETS_GATEWAY_URL } from './sheets-webapp-url.js';
const base = new URL(SHEETS_GATEWAY_URL).origin;
export function createGoogleConnection({ filePath = dataPath('sheets-google-auth.json'), request = fetch, onConnected = () => {} } = {}) {
  let saved = null, pending = null, error = '', refreshPromise;
  try { saved = JSON.parse(readFileSync(filePath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') error = 'Saved Google connection could not be read. Please sign in again.'; }
  function persist(value) {
    writeFileSync(filePath + '.tmp', JSON.stringify(value), {mode:0o600});
    chmodSync(filePath + '.tmp', 0o600);
    renameSync(filePath + '.tmp', filePath);
    saved = value;
  }
  async function json(url, options = {}) {
    const response = await request(url, {...options, redirect:'error', signal:AbortSignal.timeout(20000)});
    const body = await response.json();
    if (!response.ok) throw Error(url.startsWith(base) ? (body.error || 'Google Sheets authorization failed.') : 'Google sign-in expired or was rejected. Please connect Google Sheets again.');
    return body;
  }
  async function exchange(config, fields) {
    return json('https://oauth2.googleapis.com/token', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({client_id:config.clientId, client_secret:config.clientSecret || '', ...fields}).toString()});
  }
  async function verified(token) {
    if (!token) throw Error('Google did not return an identity token. Please sign in again.');
    return json(base + '/auth/me', {headers:{Authorization:'Bearer ' + token}});
  }
  function cancel() { if (pending) { clearTimeout(pending.timer); pending.server.close(); pending = null; } }
  return {
    status: () => ({connected:!!saved?.refreshToken, email:saved?.email || '', pending:!!pending, legacyAllowed:!saved, error}),
    async begin({onAuthenticated} = {}) {
      cancel(); error = '';
      const config = await json(base + '/auth/config');
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(config.clientId || '')) throw Error('Google sign-in configuration is invalid.');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const attempt = { config, state, verifier };
      const server = createServer(async (req,res) => {
        res.setHeader('Content-Type','text/plain; charset=utf-8');
        res.setHeader('Cache-Control','no-store');
        const callback = new URL(req.url, 'http://127.0.0.1');
        if (req.method !== 'GET' || callback.pathname !== '/callback' || callback.searchParams.get('state') !== state || pending !== attempt || attempt.processing) {
          res.writeHead(400); res.end('Invalid or expired sign-in request.'); return;
        }
        attempt.processing = true;
        try {
          if (callback.searchParams.has('error') || !callback.searchParams.get('code')) throw Error('Google sign-in was cancelled.');
          const tokens = await exchange(config, {code:callback.searchParams.get('code'), code_verifier:verifier, redirect_uri:attempt.redirectUri, grant_type:'authorization_code'});
          const user = await verified(tokens.id_token);
          if (!tokens.refresh_token) throw Error('Google did not grant offline access. Please reconnect.');
          if (pending !== attempt) throw Error('Sign-in was cancelled.');
          persist({config, refreshToken:tokens.refresh_token, idToken:tokens.id_token, expiresAt:Date.now() + (Number(tokens.expires_in) || 3600)*1000, email:user.email});
          await onAuthenticated?.(user);
          error = '';
          res.end('Google Sheets connected. You can close this tab and return to Ortus Basics.');
          Promise.resolve().then(onConnected).catch(() => {});
        } catch (e) { error = e.message; res.writeHead(400); res.end(error); }
        finally { if (pending === attempt) cancel(); }
      });
      attempt.server = server;
      await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
      attempt.redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      attempt.timer = setTimeout(() => { if (pending === attempt) { error = 'Google sign-in timed out. Please try again.'; cancel(); } }, 300000);
      attempt.timer.unref(); server.unref(); pending = attempt;
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({client_id:config.clientId, redirect_uri:attempt.redirectUri, response_type:'code', scope:'openid email', access_type:'offline', prompt:'select_account consent', state, code_challenge:createHash('sha256').update(verifier).digest('base64url'), code_challenge_method:'S256'}).toString();
      return url.href;
    },
    async token({force = false} = {}) {
      if (!saved?.refreshToken) throw Error('Connect Google Sheets with your company Google account in Settings.');
      if (!force && saved.idToken && saved.expiresAt > Date.now()+60000) return saved.idToken;
      if (!refreshPromise) {
        const previous = saved;
        refreshPromise = (async () => {
          try {
            const tokens = await exchange(previous.config, {refresh_token:previous.refreshToken, grant_type:'refresh_token'});
            const user = await verified(tokens.id_token);
            if (saved !== previous) throw Error('Google connection changed. Please retry.');
            persist({...previous, refreshToken:tokens.refresh_token || previous.refreshToken, idToken:tokens.id_token, expiresAt:Date.now()+(Number(tokens.expires_in)||3600)*1000, email:user.email});
            error = ''; return tokens.id_token;
          } catch (e) { error = e.message; throw e; }
          finally { refreshPromise = null; }
        })();
      }
      return refreshPromise;
    },
    disconnect() {
      cancel(); persist({disconnected:true}); error = '';
    },
  };
}
export const sheetsGoogle = createGoogleConnection({onConnected:async () => (await import('./sheet-sync.js')).retryPendingSheetWrites()});
