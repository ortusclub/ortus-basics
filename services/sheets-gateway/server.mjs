import {googleVerifier} from './google-auth.mjs';
import {Firestore, Timestamp} from '@google-cloud/firestore';
import {createApp} from './app.mjs';
const keys = JSON.parse(process.env.WORKSPACE_KEYS || '[]');
if (keys.some(k=>!k.id || !/^[a-f0-9]{64}$/.test(k.secret))) throw Error('Workspace keys missing');
const db = new Firestore({databaseId:'ortus-sheets-gateway'});
const claimNonce = async ({id,nonce}) => {
  try { await db.collection('gatewayNonces').doc(id+'-'+nonce).create({expiresAt:Timestamp.fromMillis(Date.now()+300000)}); return true; }
  catch(e) { if(e.code===6) return false; throw e; }
};
const clientId = process.env.GOOGLE_DESKTOP_CLIENT_ID;
if (!keys.length && !clientId) throw Error('No gateway authentication configured');
createApp({keys,bridgeUrl:process.env.BRIDGE_URL,claimNonce,
  verifyGoogle: clientId ? googleVerifier(clientId) : undefined,
  desktopClient: clientId ? {clientId,clientSecret:process.env.GOOGLE_DESKTOP_CLIENT_SECRET || ''} : undefined,
}).listen(Number(process.env.PORT || 8080),'0.0.0.0');
