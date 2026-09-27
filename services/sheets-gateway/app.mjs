import express from 'express';
import { verifyRequest } from './protocol.mjs';
const actions = new Set(['prepareSheet','ensureColumns','updateRows','updateRow','batchUpdate','getStatus','getSoO','setSoO','bumpSoOConnections','writeRecentConnections','clearRecentConnections','writeRecentMessages','getRowStatus','listTabs','listConnections','getConnection','createLeadTab']);
export function createApp({ keys, bridgeUrl, claimNonce, forward = fetch }) {
  const upstream = new URL(bridgeUrl);
  if (upstream.origin !== 'https://script.google.com' || !/^\/macros\/s\/[\w-]+\/exec$/.test(upstream.pathname)) throw Error('Invalid bridge configuration');
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req,res) => res.json({ok:true,service:'ortus-sheets-gateway',protocol:1}));
  app.post('/bridge', express.raw({type:'application/json',limit:'5mb'}), async (req,res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({error:'JSON body required'});
    const auth = verifyRequest(keys, req.headers, req.body);
    if (!auth) return res.status(401).json({error:'Sheets gateway authorization failed. Your workspace must be approved by the administrator.'});
    let data;
    try { data = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({error:'Invalid JSON'}); }
    if (!data || !actions.has(data.action)) return res.status(400).json({error:'Unsupported bridge action'});
    try {
      if (!await claimNonce(auth)) return res.status(409).json({error:'Request already received'});
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
