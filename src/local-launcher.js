import puppeteer from 'puppeteer-core';
import { withTimeout } from './promise-timeout.js';
import { existsSync, mkdirSync } from 'fs';
import { dataPath } from './paths.js';
import { hideByPid } from './mac-window.js';
import { checkDiskFree, formatBytes } from './disk-check.js';

let activeBrowser = null;

// Persistent profile — cookies survive across runs
const LOCAL_PROFILE_DIR = dataPath('local-profile');

/**
 * Find Chrome executable path based on OS.
 */
function findChromePath() {
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Launch a separate Chrome with a persistent profile.
 * First run: user must log into LinkedIn (cookies are saved).
 * Every run after: LinkedIn session is remembered automatically.
 *
 * Returns { browser, page } — same interface as GoLogin launcher.
 */
export async function launchLocalBrowser({ visible = false } = {}) {
  // Phase 2.8.20 (W3-C2): disk-space pre-flight (same gate as GoLogin launcher).
  const disk = await checkDiskFree();
  if (!disk.ok) {
    throw new Error(`Disk space too low (${formatBytes(disk.freeBytes)} free, ${formatBytes(disk.thresholdBytes)} required) — clear space before launching.`);
  }
  console.log('[local] Starting local browser...');

  const chromePath = process.env.CHROME_PATH || findChromePath();
  if (!chromePath) {
    throw new Error('No Chrome/Chromium found. Set CHROME_PATH in .env or install Chrome.');
  }

  if (!existsSync(LOCAL_PROFILE_DIR)) mkdirSync(LOCAL_PROFILE_DIR, { recursive: true });

  console.log(`[local] Chrome: ${chromePath}`);
  console.log(`[local] Profile: ${LOCAL_PROFILE_DIR}`);

  const launchPromise = puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    userDataDir: LOCAL_PROFILE_DIR,
    args: [
      // Parked off-screen for automated runs, on-screen when the operator is
      // being asked to DO something in it. The operator's own words, 2026-09-01:
      // "it has never really opened my local browser" — it always had, at
      // -2400,-2400, where nobody could see it.
      ...(visible ? ['--window-position=60,60'] : ['--window-position=-2400,-2400']),
      '--window-size=1600,1000',
      '--no-first-run',
      '--no-default-browser-check',
      // Anti-detection stealth flags (inspired by playwright-stealth)
      '--disable-blink-features=AutomationControlled',  // Hides navigator.webdriver
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',                              // No "Chrome is controlled" bar
    ],
    ignoreHTTPSErrors: true,
    protocolTimeout: 60000,
  });
  const browser = await withTimeout(launchPromise, {
    ms: 120_000,
    label: 'Local Chrome launch',
    onTimeout: async () => {
      // A late-resolving launch must not leak a browser after its caller has
      // already released the campaign slot.
      launchPromise.then((late) => late?.close?.()).catch(() => {});
    },
  });

  activeBrowser = browser;

  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  await page.setViewport({ width: 1600, height: 1000 });
  page.setDefaultNavigationTimeout(30000);
  // v2.86: 15s → 30s default action timeout (match gologin-launcher) — slow
  // operator machines were timing out clicks / waitForSelector too early.
  page.setDefaultTimeout(30000);

  // Stealth: hide automation indicators from page JS
  await page.evaluateOnNewDocument(() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Normal plugins array (headless Chrome has 0)
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    // Normal languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    // Chrome runtime object (missing in automation)
    if (!window.chrome) window.chrome = { runtime: {} };
  });

  console.log('[local] ✓ Chrome launched with persistent profile (stealth enabled).');

  // Hide background launches on macOS before returning. Login recovery can
  // show the process as soon as the caller detects a signed-out session.
  const pid = browser.process?.()?.pid;
  if (!visible && pid) await hideByPid(pid);

  return { browser, page };
}

/**
 * Close the local browser completely.
 */
export async function closeLocalBrowser() {
  if (!activeBrowser) return;

  try {
    const pages = await activeBrowser.pages();
    for (const p of pages) {
      try { await p.close(); } catch { /* */ }
    }
    await activeBrowser.close();
    console.log('[local] Campaign browser closed.');
  } catch (err) {
    console.warn(`[local] Close warning: ${err.message}`);
  }

  activeBrowser = null;
}
