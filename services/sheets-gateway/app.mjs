import {installEmailVerification} from './email-verification.mjs';
import express from 'express';
import { verifyRequest } from './protocol.mjs';
const actions = new Set(['prepareSheet','ensureColumns','updateRows','updateRow','batchUpdate','getStatus','getSoO','setSoO','bumpSoOConnections','writeRecentConnections','clearRecentConnections','writeRecentMessages','getRowStatus','listTabs','listConnections','getConnection','createLeadTab']);
export function createApp({ keys = [], bridgeUrl, claimNonce, forward = fetch, verifyGoogle, desktopClient, publicAccess = false, emailVerification, sharedGoLogin = {} }) {
  const upstream = new URL(bridgeUrl);
  if (upstream.origin !== 'https://script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(upstream.pathname)) throw Error('Invalid bridge configuration');
  const app = express();
  app.disable('x-powered-by');
  if(emailVerification)installEmailVerification(app,emailVerification,express.json({limit:'4kb'}));
  app.get('/health', (_req,res) => res.json({ok:true,service:'ortus-sheets-gateway',protocol:1,publicSheetsAccess:publicAccess}));
  app.get('/auth/config', (_req,res) => {
    if (!verifyGoogle || !desktopClient?.clientId) return res.status(503).json({error:'Company Google sign-in has not been configured by the administrator yet.'});
    // Installed-app OAuth metadata is public, not the confidential writer credential.
    res.json(desktopClient);
  });
  async function identity(req) {
    const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '');
    if (!match || !verifyGoogle) return null;
    try { return await verifyGoogle(match[1]); } catch { return null; }
  }
  app.get('/auth/me', async (req,res) => {
    const user = await identity(req);
    if (!user) return res.status(401).json({error:'Sign in with an approved company Google Workspace account.'});
    res.json({ok:true,email:user.email});
  });
  // Public Sheets access never grants access to reusable GoLogin credentials.
  app.get('/gologin/shared', async (req,res) => {
    res.set('Cache-Control','no-store');
    const user = await identity(req);
    if (!user) return res.status(401).json({error:'Company Google sign-in required.'});
    const tokens = {};
    for (const id of ['ortus','marketing']) {
      if (typeof sharedGoLogin[id] === 'string' && sharedGoLogin[id].trim()) tokens[id] = sharedGoLogin[id].trim();
    }
    res.json({tokens});
  });
  app.post('/bridge', express.raw({type:'application/json',limit:'5mb'}), async (req,res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({error:'JSON body required'});
    const google = publicAccess ? null : await identity(req);
    const auth = publicAccess ? {public:true} : google ? {google:true} : (req.headers.authorization ? null : verifyRequest(keys, req.headers, req.body));
    if (!auth) return res.status(401).json({error:'Sheets gateway authorization failed. Connect Google Sheets using your company Google account in Settings.'});
    let data;
    try { data = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({error:'Invalid JSON'}); }
    if (!data || !actions.has(data.action)) return res.status(400).json({error:'Unsupported bridge action'});
    try {
      if (!auth.public && !auth.google && !await claimNonce(auth)) return res.status(409).json({error:'Request already received'});
    } catch { return res.status(503).json({error:'Gateway authorization storage unavailable'}); }
    try {
      const response = await forward(upstream, {method:'POST',headers:{'Content-Type':'application/json'},body:req.body,signal:AbortSignal.timeout(55000)});
      if (!response.ok) return res.status(502).json({error:'Sheets bridge unavailable'});
      const result = await response.json();
      // Do not pass upstream stacks or unexpected diagnostic strings to clients.
      if (result.error) return res.status(502).json({error:'Sheets bridge could not complete this action. Check spreadsheet access and request fields.'});
      delete result.stack;
      res.json(result);
    } catch { res.status(502).json({error:'Sheets bridge did not confirm the request. Check the sheet before retrying.'}); }
  });
  app.use((error,_req,res,_next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({error:'Invalid gateway request'}));
  return app;
}
