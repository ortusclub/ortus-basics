// primary-session.js — throwaway plain-Chromium running a PERSONAL primary's
// injected LinkedIn session, so a CC+IC follow-up can be sent AS the primary on
// the VM. Puppeteer-core (not Playwright) so the vendored sendInThread /
// readSelfIdentity primitives work unchanged and the app's puppeteer cookie jar
// injects with no shape translation.
// puppeteer-core@25 and playwright are ESM-only → cannot be require()'d from this
// CJS module on prod Node 18 (ERR_REQUIRE_ESM, Node <22). Loaded via dynamic
// import() inside launchPrimarySession, which works on every Node version and
// keeps the pure helpers (slugFromUrl/identityMatches) dep-free.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A Chromium binary must exist on the VM. Reuse the Playwright-installed chromium
// (the base image ships one under /ms-playwright); override via env.
// ponytail: single env knob — set PRIMARY_CHROME_PATH if the image ships another chrome.
async function chromeExecutable() {
  if (process.env.PRIMARY_CHROME_PATH) return process.env.PRIMARY_CHROME_PATH;
  const { chromium } = await import('playwright');
  const pwPath = chromium.executablePath();
  // The `playwright` npm package can drift AHEAD of the base image's bundled
  // chromium: npm computes e.g. chromium-1223 while the image only ships
  // chromium-1105, so executablePath() points at a binary that isn't on disk
  // and puppeteer.launch throws "Browser was not found". Trust the computed
  // path only if it exists; otherwise use whatever chromium IS installed.
  if (pwPath && fs.existsSync(pwPath)) return pwPath;
  return findInstalledChromium() || pwPath; // none found → let launch throw its own clear error
}

// Scan the Playwright browsers dir for an actually-present chromium binary.
function findInstalledChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')); } catch { return ''; }
  for (const d of dirs) {
    for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = path.join(root, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

function slugFromUrl(url) {
  const m = String(url || '').match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}
function identityMatches(selfProfileUrl, expectedSlug) {
  const got = slugFromUrl(selfProfileUrl);
  return !!got && !!expectedSlug && got === String(expectedSlug).toLowerCase();
}

async function launchPrimarySession(cookies) {
  const { default: puppeteer } = await import('puppeteer-core');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'primary_'));
  const browser = await puppeteer.launch({
    executablePath: await chromeExecutable(),
    // HEADED, on the Xvfb display (DISPLAY=:99) the entrypoint already boots and
    // that Orbita/GoLogin renders to — inherited from process env. Matches how
    // every browser runs on this VM, so LinkedIn sees the same headed rendering
    // it already tolerates. (Dockerfile HEADLESS=false; k8s: "MUST be false so
    // Orbita renders to the Xvfb display".) Never headless here.
    headless: false,
    userDataDir,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = (await browser.pages())[0] || (await browser.newPage());
  if (Array.isArray(cookies) && cookies.length) await page.setCookie(...cookies);
  // Injected cookies don't authenticate anything until the page is ON a
  // linkedin.com document: readSelfIdentity + sendFollowUp run
  // page.evaluate(fetch('/voyager/api/me', credentials:'include')), which reads
  // JSESSIONID from document.cookie — empty on about:blank => "not_logged_in".
  // Load the feed once so every downstream primitive starts authenticated.
  // Swallow a slow/failed nav: the identity gate then reports not_logged_in and
  // the follow-up parks (recoverable) rather than hard-erroring the task.
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const close = async () => {
    try { await browser.close(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };
  return { browser, page, close };
}

async function assertPrimaryIdentity(page, expectedSlug, deps = {}) {
  const readSelf = deps.readSelfIdentity
    || (await import('./campaign-lib/linkedin/accept-invitation.js')).readSelfIdentity;
  const self = await readSelf(page).catch(() => ({}));
  if (!self || !self.profileUrl) return { ok: false, reason: 'not_logged_in' };
  if (!identityMatches(self.profileUrl, expectedSlug)) return { ok: false, reason: 'identity_mismatch', got: self.profileUrl };
  return { ok: true, name: self.name };
}

module.exports = { slugFromUrl, identityMatches, launchPrimarySession, assertPrimaryIdentity, chromeExecutable };
