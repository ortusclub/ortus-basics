// Finds a Chromium-family browser for the simulator's fake LinkedIn pages.
// Order: SIM_CHROME → Chrome / Chromium / Edge / Brave → the Playwright browser used in cloud sessions.
// NOT GoLogin's Orbita: it is licence-locked and exits at once ("orbita.config not found", 403) when
// started outside GoLogin — measured on the operator's Mac 2026-10-20, it hung every scenario.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const FIXED = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
];

// Where the test browser is kept when this computer has no Chrome-type browser (downloaded once, reused).
const browserDir = () => process.env.SIM_BROWSER_DIR || join(homedir(), '.ortus-sim-browser');
const MARKER = () => join(browserDir(), 'browser-path.txt');
const downloaded = () => { try { const p = readFileSync(MARKER(), 'utf8').trim(); return p && existsSync(p) ? p : null; } catch { return null; } };

export function findBrowser() {
  // SIM_NO_SYSTEM_BROWSER=1 pretends no browser is installed (used to test the download path).
  const candidates = [process.env.SIM_CHROME, ...(process.env.SIM_NO_SYSTEM_BROWSER ? [] : FIXED)].filter(Boolean);
  return candidates.find(p => existsSync(p)) || downloaded();
}

/** Makes sure a browser exists, downloading Google's small "headless shell" Chrome once if none is installed.
 *  onProgress(pct) reports the download. Resolves { ok: true, path } or { ok: false, message }. Sets SIM_CHROME so child processes reuse it. */
export async function ensureBrowser(onProgress = () => {}) {
  const have = findBrowser();
  if (have) { process.env.SIM_CHROME = have; return { ok: true, path: have }; }
  try {
    const req = createRequire(join(import.meta.dirname, '../../package.json'));
    const { install, detectBrowserPlatform, Browser, computeExecutablePath } = req('@puppeteer/browsers');
    // Same Chrome build the bundled puppeteer-core is made for (falls back to its 22.x pin).
    const buildId = (req('puppeteer-core').PUPPETEER_REVISIONS || {})['chrome-headless-shell'] || '127.0.6533.88';
    const platform = detectBrowserPlatform();
    if (!platform) throw new Error('unsupported computer type');
    const cacheDir = browserDir();
    mkdirSync(cacheDir, { recursive: true });
    await install({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform,
      downloadProgressCallback: (got, total) => onProgress(total ? Math.min(100, Math.round((got / total) * 100)) : 0) });
    const path = computeExecutablePath({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform });
    if (!existsSync(path)) throw new Error('the download did not contain a browser');
    writeFileSync(MARKER(), path);
    process.env.SIM_CHROME = path;
    return { ok: true, path };
  } catch (e) {
    return { ok: false, message: `Could not get a test browser: ${String(e.message || e).split('\n')[0]}. The test needs internet once to download it — or install Google Chrome and run the test again.` };
  }
}

/** One try at opening the browser and closing it again. Resolves { ok: true, path } or { ok: false, message } within `ms`. */
async function tryOpenBrowser(puppeteer, path, ms) {
  const opts = { executablePath: path, args: ['--no-sandbox', '--disable-gpu'] };
  let timer, browser, cancelled = false;
  const attempt = (async () => {
    try { browser = await puppeteer.launch({ ...opts, headless: true }); }
    catch { browser = await puppeteer.launch({ ...opts, headless: 'shell' }); }
    // The time ran out while it was still starting: do not leave a browser running behind the next try.
    if (cancelled) { try { await browser.close(); } catch { /* */ } return { ok: false, message: 'cancelled' }; }
    const page = await browser.newPage();
    await page.goto('about:blank');
    await browser.close();
    browser = null;
    return { ok: true, path };
  })();
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, message: `The test browser did not start within ${ms / 1000}s (${path}).` }), ms); });
  try { return await Promise.race([attempt, limit]); }
  catch (e) { return { ok: false, message: `The test browser would not start (${path}): ${String(e.message || e).split('\n')[0]}` }; }
  finally {
    clearTimeout(timer);
    cancelled = true;
    if (browser) { try { await browser.close(); } catch { /* */ } }
  }
}

/**
 * Opens the browser and closes it again, to prove it can start. The first start after a while can be very slow on a
 * busy laptop (measured on the operator's Mac 2026-10-28: 22.9s cold, 3.3s warm), so each try gets `ms` (60s) and a
 * failed try is repeated once — by then the browser is usually warm. Resolves { ok: true } or { ok: false, message }.
 */
export async function checkBrowser(puppeteer, ms = 60000, tries = 2) {
  const path = findBrowser();
  if (!path) return { ok: false, message: 'No browser found for the test. Install Google Chrome (the test can\'t use GoLogin\'s browser, which only starts inside GoLogin).' };
  let last = { ok: false, message: 'The test browser did not start.' };
  for (let i = 0; i < tries; i++) {
    last = await tryOpenBrowser(puppeteer, path, ms);
    if (last.ok) return last;
  }
  return tries > 1 ? { ok: false, message: `${last.message} Tried ${tries} times.` } : last;
}
