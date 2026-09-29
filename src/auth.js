// Auth module — user store, password hashing, signed-cookie sessions, SoO allowlist.
//
// Users are stored in data/users.json as { email: { passwordHash, createdAt } }.
// Sessions are HMAC-signed cookies carrying the email + expiry (no server-side
// session table needed — restart-safe, Vercel-friendly).
//
// The SoO sheet acts as the allowlist: only emails present in column A of the
// sheet can sign up. The existing DASHBOARD_USERS env var still works as a
// fallback so current logins don't break during migration.

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

import { fetchSoOData } from './soo.js';
import { dataPath } from './paths.js';
import { SIGNUP_ALLOWED_DOMAINS, SIGNUP_ALLOWED_EMAILS } from './sheets-webapp-url.js';

const USERS_PATH = dataPath('users.json');
const SECRET_PATH = dataPath('.session-secret');

const COOKIE_NAME = 'ortus_session';
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// ── Session secret ─────────────────────────────────────────────────
let _secret = null;
async function getSecret() {
  if (_secret) return _secret;
  if (process.env.SESSION_SECRET) {
    _secret = process.env.SESSION_SECRET;
    return _secret;
  }
  try {
    _secret = (await readFile(SECRET_PATH, 'utf-8')).trim();
    if (_secret) return _secret;
  } catch {}
  _secret = crypto.randomBytes(32).toString('hex');
  await mkdir(dirname(SECRET_PATH), { recursive: true });
  await writeFile(SECRET_PATH, _secret, 'utf-8');
  return _secret;
}

// ── User store ─────────────────────────────────────────────────────
async function loadUsers() {
  try {
    return JSON.parse(await readFile(USERS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveUsers(users) {
  await mkdir(dirname(USERS_PATH), { recursive: true });
  await writeFile(USERS_PATH + '.tmp', JSON.stringify(users, null, 2), {encoding:'utf-8',mode:0o600});
  await chmod(USERS_PATH + '.tmp', 0o600);
  await rename(USERS_PATH + '.tmp', USERS_PATH);
}

let usersMutation = Promise.resolve();
function mutateUsers(change) {
  const operation = usersMutation.then(async () => {
    const users = await loadUsers();
    const result = await change(users);
    await saveUsers(users);
    return result;
  });
  usersMutation = operation.catch(() => {});
  return operation;
}

export async function createUser(email, password) {
  const normalized = email.trim().toLowerCase();
  return mutateUsers(async users => {
    if (users[normalized]) throw new Error('Account already exists for this email');
    users[normalized] = {passwordHash:await bcrypt.hash(password,10),createdAt:new Date().toISOString()};
    return normalized;
  });
}

// Internal account-removal helper. Password recovery never deletes an account.
export async function deleteUser(email) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return false;
  return mutateUsers(users => { const existed=!!users[normalized];delete users[normalized];return existed; });
}

// Only called after the one-time email code has been verified server-side.
export async function setPassword(email,password) {
  const normalized=email.trim().toLowerCase();
  return mutateUsers(async users => {
    const previous=users[normalized]||{createdAt:new Date().toISOString()};
    users[normalized]={...previous,passwordHash:await bcrypt.hash(password,10),sessionRevision:crypto.randomBytes(16).toString('hex')};
    return normalized;
  });
}

export async function verifyCredentials(email, password) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized || !password) return null;

  const users = await loadUsers();
  const user = users[normalized];
  if (user && user.passwordHash) {
    const ok = await bcrypt.compare(password, user.passwordHash);
    return ok ? normalized : null;
  }

  // Fallback: DASHBOARD_USERS env var (legacy plaintext). Lets existing logins
  // keep working until everyone has migrated.
  const raw = (process.env.DASHBOARD_USERS || '').trim();
  if (raw) {
    for (const pair of raw.split(',')) {
      const [e, p] = pair.split(':');
      if ((e || '').trim().toLowerCase() === normalized && (p || '').trim() === password) {
        return normalized;
      }
    }
  }
  if (process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS) {
    if (process.env.DASHBOARD_USER.trim().toLowerCase() === normalized
      && process.env.DASHBOARD_PASS === password) {
      return normalized;
    }
  }
  return null;
}

export async function userExists(email) {
  const normalized = (email || '').trim().toLowerCase();
  const users = await loadUsers();
  return Boolean(users[normalized]);
}

// ── Signed cookie sessions ─────────────────────────────────────────
// Token format: base64url(JSON).HMAC-hex. No server-side table needed.
async function signToken(payload) {
  const secret = await getSecret();
  const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const secret = await getSecret();
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(sig)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

export async function issueSessionCookie(res, email) {
  const users = await loadUsers();
  const token = await signToken({ email, revision: users[email]?.sessionRevision || '', exp: Date.now() + COOKIE_MAX_AGE_MS });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export async function readSessionFromRequest(req) {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = await verifyToken(token);
  if (!payload?.email) return null;
  const users = await loadUsers();
  if ((payload.revision || '') !== (users[payload.email]?.sessionRevision || '')) return null;
  return payload.email;
}

// ── SoO allowlist ──────────────────────────────────────────────────
// Uses the shared src/soo.js helper so timeout, error-shape, and redirect
// handling match /api/soo-status exactly.
export async function fetchAllowedEmails() {
  const data = await fetchSoOData();
  const set = new Set();
  for (const acc of data.accounts || []) {
    const e = (acc.email || '').trim().toLowerCase();
    if (e && e.includes('@')) set.add(e);
  }
  return set;
}

export async function isEmailAllowed(email) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized.includes('@')) return false;

  // SOO_BYPASS_EMAILS — comma-separated escape hatch for non-domain emails
  // (dev, emergency, contractors with non-corporate emails). Highest priority
  // so it always wins.
  const bypassRaw = (process.env.SOO_BYPASS_EMAILS || '').trim();
  if (bypassRaw) {
    const bypass = new Set(
      bypassRaw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    );
    if (bypass.has(normalized)) return true;
  }

  // v2.57.x — Domain-based signup allowlist (replaces the previous SoO sheet
  // check). The SoO sheet is keyed to LinkedIn-account-owner emails, not
  // operator login emails — so requiring a SoO match for signup was rejecting
  // legitimate operators (e.g. sam@ortusclub.com). Anyone with an email on
  // an allowed corporate domain can sign up. fetchAllowedEmails() is still
  // exported below for any other caller that wants the SoO sheet contents
  // directly (e.g. campaign-account selection), but signup no longer
  // depends on it.
  const domain = normalized.split('@')[1] || '';
  if (SIGNUP_ALLOWED_DOMAINS.includes(domain)) return true;

  // Per-email allowlist for individual external collaborators (e.g. Milee) —
  // access without opening their whole domain.
  if (SIGNUP_ALLOWED_EMAILS.includes(normalized)) return true;

  return false;
}
