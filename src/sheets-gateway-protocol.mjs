import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
export function workspaceKey(token) {
  const secret = createHmac('sha256', token.trim()).update('ortus-sheets-gateway-v1').digest('hex');
  return { id: hash(secret).slice(0, 24), secret };
}
function canonical(time, nonce, body) { return `v1\nPOST\n/bridge\n${time}\n${nonce}\n${hash(body)}`; }
export function signRequest(key, body, now = Date.now(), nonce = randomBytes(16).toString('hex')) {
  const time = String(now);
  return { 'x-ortus-key': key.id, 'x-ortus-time': time, 'x-ortus-nonce': nonce,
    'x-ortus-signature': createHmac('sha256', key.secret).update(canonical(time, nonce, body)).digest('hex') };
}
export function verifyRequest(keys, headers, body, now = Date.now()) {
  const id = headers['x-ortus-key']; const time = headers['x-ortus-time'];
  const nonce = headers['x-ortus-nonce']; const signature = headers['x-ortus-signature'];
  if (!/^\d{13}$/.test(time || '') || Math.abs(now - Number(time)) > 120000 || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
  const key = keys.find(k => k.id === id);
  if (!key) return null;
  const expected = createHmac('sha256', key.secret).update(canonical(time, nonce, body)).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex')) ? { id, nonce } : null;
}
