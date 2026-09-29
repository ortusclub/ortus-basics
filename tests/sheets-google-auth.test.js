import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createGoogleConnection } from '../src/sheets-google-auth.js';
import { companyIdentity } from '../services/sheets-gateway/google-auth.mjs';
import { createApp } from '../services/sheets-gateway/app.mjs';

test('only verified Workspace identities from exact approved domains are accepted', () => {
  for (const domain of ['ortusclub.com','ortus.solutions','linkedvelocity.com','apexstrategy.io']) {
    const payload = {sub:'123',email:`member@${domain}`,email_verified:true,hd:domain};
    assert.equal(companyIdentity(payload).email,payload.email);
    for (const change of [{email_verified:false},{hd:undefined},{hd:'evil.com'},{email:`member@${domain}.evil.com`},{sub:''}]) assert.throws(() => companyIdentity({...payload,...change}));
  }
  assert.throws(() => companyIdentity({sub:'123',email:'user@gmail.com',email_verified:true}));
});

test('loopback OAuth checks state, uses PKCE, stores privately, refreshes once and disconnects', async t => {
  const dir = mkdtempSync(join(tmpdir(),'basics-google-'));
  const filePath = join(dir,'auth.json'); let exchanges = 0, recovered = 0;
  let reject = false;
  const request = async (url, options = {}) => {
    if (url.endsWith('/auth/config')) return {ok:true,json:async()=>({clientId:'example.apps.googleusercontent.com',clientSecret:'desktop-public'})};
    if (url.endsWith('/auth/me')) return {ok:!reject,json:async()=> reject ? {error:'Company not approved'} : {email:'user@ortusclub.com'}};
    assert.equal(url,'https://oauth2.googleapis.com/token'); exchanges++;
    const form = new URLSearchParams(options.body);
    if (form.get('grant_type') === 'authorization_code') assert.ok(form.get('code_verifier').length >= 43);
    else assert.equal(form.get('refresh_token'),'refresh-private');
    return {ok:true,json:async()=>({id_token:'id-private',refresh_token:'refresh-private',expires_in:3600})};
  };
  const auth = createGoogleConnection({filePath,request,onConnected:()=>recovered++}); t.after(()=>{ auth.disconnect(); rmSync(dir,{recursive:true,force:true}); });
  const consent = new URL(await auth.begin());
  assert.equal(consent.searchParams.get('code_challenge_method'),'S256');
  assert.equal(consent.searchParams.get('scope'),'openid email');
  const callback = new URL(consent.searchParams.get('redirect_uri')); callback.searchParams.set('code','code');
  callback.searchParams.set('state','forged'); assert.equal((await fetch(callback)).status,400); assert.equal(exchanges,0);
  callback.searchParams.set('state',consent.searchParams.get('state')); assert.equal((await fetch(callback)).status,200);
  assert.equal(auth.status().email,'user@ortusclub.com'); assert.equal(recovered,1);
  assert.doesNotMatch(JSON.stringify(auth.status()),/id-private|refresh-private|desktop-public/);
  assert.equal(statSync(filePath).mode & 0o777,0o600);
  assert.equal(JSON.parse(readFileSync(filePath)).refreshToken,'refresh-private');
  assert.equal(await auth.token(),'id-private'); assert.equal(exchanges,1);
  await Promise.all([auth.token({force:true}),auth.token({force:true})]); assert.equal(exchanges,2);
  reject = true; await assert.rejects(auth.token({force:true}),/Company not approved/);
  auth.disconnect(); assert.equal(auth.status().connected,false); assert.equal(auth.status().legacyAllowed,false);
  await assert.rejects(auth.token(),/Connect Google Sheets/);
  assert.doesNotMatch(readFileSync(filePath,'utf8'),/refresh-private|id-private/);
});

test('gateway Google authorization is independent of GoLogin and rejects invalid identities before forwarding', async t => {
  let forwarded = 0;
  const server = createApp({bridgeUrl:'https://script.google.com/macros/s/test/exec',keys:[],
    desktopClient:{clientId:'desktop.apps.googleusercontent.com'},
    verifyGoogle:async token => { if(token !== 'valid') throw Error('wrong audience or expired'); return {email:'member@apexstrategy.io'}; },
    claimNonce:async()=>{throw Error('Google requests do not need legacy nonce storage');},
    forward:async()=> {forwarded++;return {ok:true,json:async()=>({ok:true})};},
  }).listen(0,'127.0.0.1');
  await once(server,'listening'); t.after(()=>server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/auth/config')).status,200);
  for (const token of ['expired','forged-email','']) {
    const res = await fetch(base+'/bridge',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:'{"action":"updateRow"}'});
    assert.equal(res.status,401);
  }
  assert.equal(forwarded,0);
  assert.equal((await fetch(base+'/bridge',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer valid'},body:'{"action":"updateRow"}'})).status,200);
  assert.equal(forwarded,1);
  assert.equal((await fetch(base+'/auth/me',{headers:{Authorization:'Bearer valid'}})).status,200);
});

test('Google library rejects forged signatures, wrong audience, issuer and expired tokens', async t => {
  const {createRequire} = await import('node:module');
  const gatewayRequire = createRequire(new URL('../services/sheets-gateway/google-auth.mjs', import.meta.url));
  const {OAuth2Client} = gatewayRequire('google-auth-library');
  const {generateKeyPairSync, sign} = await import('node:crypto');
  const {googleVerifier} = await import('../services/sheets-gateway/google-auth.mjs');
  const {publicKey,privateKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const previous = OAuth2Client.prototype.getFederatedSignonCertsAsync;
  OAuth2Client.prototype.getFederatedSignonCertsAsync = async () => ({certs:{test:publicKey.export({type:'spki',format:'pem'})},format:'PEM'});
  t.after(()=>{OAuth2Client.prototype.getFederatedSignonCertsAsync = previous;});
  const now = Math.floor(Date.now()/1000);
  const claims = {iss:'https://accounts.google.com',aud:'expected.apps.googleusercontent.com',sub:'123',iat:now,exp:now+3600,email:'person@ortusclub.com',email_verified:true,hd:'ortusclub.com'};
  function jwt(changes = {}) {
    const input = Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({...claims,...changes})).toString('base64url');
    return input+'.'+sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');
  }
  const verify = googleVerifier(claims.aud);
  assert.equal((await verify(jwt())).email,claims.email);
  for(const changes of [{aud:'attacker.apps.googleusercontent.com'},{iss:'https://evil.test'},{iat:now-7200,exp:now-3600},{hd:undefined},{email_verified:false}]) await assert.rejects(verify(jwt(changes)));
  const forged = jwt().split('.'); forged[2] = Buffer.alloc(256).toString('base64url');
  await assert.rejects(verify(forged.join('.')));
});
