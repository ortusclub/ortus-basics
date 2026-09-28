import { OAuth2Client } from 'google-auth-library';
export const COMPANY_DOMAINS = ['ortusclub.com', 'ortus.solutions', 'linkedvelocity.com', 'apexstrategy.io'];
export function companyIdentity(payload) {
  const email = String(payload?.email || '').toLowerCase();
  const domain = email.split('@')[1];
  if (payload?.email_verified !== true || !payload.sub || !COMPANY_DOMAINS.includes(domain) || payload.hd !== domain) {
    throw Error('Sign in with an approved company Google Workspace account.');
  }
  return { email, subject: payload.sub };
}
export function googleVerifier(clientId) {
  const client = new OAuth2Client(clientId);
  return async token => companyIdentity((await client.verifyIdToken({ idToken: token, audience: clientId })).getPayload());
}
