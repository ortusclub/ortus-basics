// Fake launcher: same export surface as src/gologin-launcher.js, but
// launchProfile opens a real headless Chromium whose LinkedIn traffic is
// answered by fake-linkedin.mjs. The real LinkedIn action code runs on top.
import puppeteer from 'puppeteer-core';
import { installFakeLinkedIn } from './fake-linkedin.mjs';
import { findBrowser } from '../browser.mjs';

export * from '../../../src/gologin-launcher.js';
import { DEFAULT_ACCOUNT_ID } from '../../../src/gologin-accounts.js';

const CHROME = findBrowser();
const open = new Map();   // profileId -> browser

export function simState() { return globalThis.__SIM__; }

export async function getProfiles() {
  return simState().accounts.map(a => ({ id: a.id, name: a.name, notes: '', account: DEFAULT_ACCOUNT_ID }));
}
export async function tokenForProfile() { return 'sim-token'; }
// Basics gates launches by GoLogin workspace; the sim's accounts belong to the default one, which any operator may use.
export function accountOfProfile() { return DEFAULT_ACCOUNT_ID; }
export function getProfileLoadWarnings() { return []; }
export async function applyFocusEmulation() {}
export function getProfilePid() { return null; }
export function getActiveBrowserPids() { return []; }

export async function launchProfile(profileId) {
  const sim = simState();
  const account = sim.accounts.find(a => a.id === profileId);
  if (!account) throw new Error(`sim: unknown profile ${profileId}`);
  if (account.launchFails) throw new Error('sim: browser failed to launch');
  if (!CHROME) throw new Error('sim: no Chromium-family browser found (set SIM_CHROME)');
  const opts = { executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--window-size=1366,900'], defaultViewport: { width: 1366, height: 900 } };
  // New headless first (the only mode current Chrome/Orbita still ship); old headless as a fallback.
  let browser;
  try { browser = await puppeteer.launch({ ...opts, headless: true }); }
  catch { browser = await puppeteer.launch({ ...opts, headless: 'shell' }); }
  open.set(profileId, browser);
  const page = (await browser.pages())[0] || await browser.newPage();
  page.setDefaultTimeout(30000);
  await installFakeLinkedIn(browser, account, sim);
  if (!account.loggedOut) {
    await page.setCookie(
      { name: 'li_at', value: 'sim-session-' + profileId, domain: '.linkedin.com', path: '/', secure: true },
      { name: 'JSESSIONID', value: '"ajax:0123456789"', domain: '.www.linkedin.com', path: '/', secure: true },
    );
  }
  return { browser, page };
}

export async function closeProfile(profileId) {
  const b = open.get(profileId);
  open.delete(profileId);
  if (b) { try { await b.close(); } catch { /* */ } }
}
export async function closeAllProfiles() {
  for (const id of [...open.keys()]) await closeProfile(id);
}
