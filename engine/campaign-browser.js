// campaign-browser.js
//
// Server-side GoLogin + Puppeteer launcher for the CAMPAIGN worker. The app's
// off-limits connect logic (outreach.js/actions.js) is written for Puppeteer, so
// campaigns run on Puppeteer (the scraper stays on Playwright). This mirrors the
// desktop app's gologin-launcher — same GoLogin start + puppeteer.connect +
// stopAndCommit cookie sync — minus the macOS window-hiding (server runs Orbita
// headed under Xvfb, same as the scraper).
//
// The launcher is NOT an off-limits file (only outreach.js/actions.js are), so
// it's written fresh for the server; the page it returns is a normal Puppeteer
// page that performOutreach drives on its native API.

const { execFile } = require("child_process");

// puppeteer-core (like gologin) is ESM-only in current versions, so a top-level
// `require()` throws ERR_REQUIRE_ESM under this CommonJS module. Resolve BOTH
// lazily via dynamic import — this also keeps the module chain loadable at boot
// (campaign-action requires this file) even on pods that never launch a browser.
let _puppeteer = null;
async function getPuppeteer() {
  if (!_puppeteer) {
    const mod = await import("puppeteer-core");
    _puppeteer = mod.default || mod;
  }
  return _puppeteer;
}

let _GoLogin = null;
async function getGoLoginCtor() {
  if (!_GoLogin) {
    const mod = await import("gologin");
    _GoLogin = mod.default || mod.GoLogin || mod;
  }
  return _GoLogin;
}

// profileId -> { GL, browser }. Holds BOTH the GoLogin instance (for cookie
// commit + kill) and the Puppeteer browser (for CDP close), so closeProfile can
// reap the Orbita/Chrome process on either side.
const active = new Map();

async function launchProfile(profileId) {
  const token = process.env.GOLOGIN_API_TOKEN;
  if (!token) throw new Error("GOLOGIN_API_TOKEN not set");
  const GoLogin = await getGoLoginCtor();
  const GL = new GoLogin({
    token,
    profile_id: profileId,
    extra_params: [
      "--window-position=-2400,-2400",
      "--window-size=1366,900",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-features=TranslateUI,MediaRouter,CalculateNativeWinOcclusion",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const { status, wsUrl } = await GL.start();
  if (status !== "success") {
    try { GL.killBrowser(); } catch {}
    await GL.stop().catch(() => {});
    throw new Error(`GoLogin start failed for ${profileId}: status="${status}"`);
  }
  // Register the instance BEFORE wiring Puppeteer, so if puppeteer.connect() or
  // page setup throws below, closeProfile can still reap the Orbita process that
  // GL.start() just launched. Previously a connect() failure here orphaned the
  // browser (no session returned → the caller's finally never called close()).
  active.set(profileId, { GL, browser: null });
  try {
    const puppeteer = await getPuppeteer();
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      ignoreHTTPSErrors: true,
      protocolTimeout: 180000,
    });
    active.set(profileId, { GL, browser });
    const pages = await browser.pages();
    const page = pages.length ? pages[0] : await browser.newPage();
    // close stale tabs from a previous session
    for (let i = 1; i < pages.length; i++) {
      try { await pages[i].close({ runBeforeUnload: false }); } catch {}
    }
    await page.setViewport({ width: 1366, height: 900 });
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    return { browser, page };
  } catch (e) {
    // Puppeteer connect / page setup failed AFTER Orbita launched — reap it now
    // so we don't leave a ~30%-CPU zombie browser behind, then rethrow.
    await closeProfile(profileId).catch(() => {});
    throw e;
  }
}

// Best-effort process-level reap: SIGKILL any Orbita/Chrome still bound to THIS
// profile's user-data-dir (/tmp/gologin_profile_<id>). This is the last line of
// defence for the observed leak where GL.stopAndCommit uploads the profile but
// the headed-Xvfb Orbita process survives. No-ops safely if pkill is absent or
// nothing matches (matcher is unique per profile, so it can't hit other pods'
// browsers).
function reapByProfileDir(profileId) {
  return new Promise((resolve) => {
    if (!profileId) return resolve();
    try {
      execFile("pkill", ["-9", "-f", `gologin_profile_${profileId}`], () => resolve());
    } catch {
      resolve();
    }
  });
}

// Bound a teardown step that may HANG (not just reject). The plain try/catch
// below only catches rejections — a promise that never settles (observed:
// browser.close() over a killed CDP transport that never acks) would hang the
// whole reap forever, and via campaign-runtime's poll that froze the entire pod
// for 73 min (the "stuck at 36%" incident, 2026-07-20). `fn` is a thunk so a
// synchronous throw is caught too. Always resolves; logs which step timed out so
// a residual hang is pinpointed instead of silent.
function _boundStep(fn, ms, label) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    const t = setTimeout(() => {
      if (!done) { done = true; console.warn(`[reap] step '${label}' exceeded ${ms}ms — abandoning it`); resolve(); }
    }, ms);
    Promise.resolve().then(fn).then(finish, (e) => {
      if (!done) console.warn(`[reap] step '${label}' errored: ${e && e.message ? e.message : e}`);
      finish();
    });
  });
}

// The reap sequence that GUARANTEES no zombie browser survives a close. Exported
// for unit testing with fake GL/browser stubs. Every step is best-effort, time-
// bounded, and isolated so one failure OR HANG never blocks the others:
//   1. stopAndCommit — sync cookies back to GoLogin cloud (must run first, while
//      the profile dir is still intact).
//   2. GL.killBrowser() — GoLogin's own SIGKILL of the Orbita process.
//   3. browser.close() + disconnect() — CDP Browser.close from the Puppeteer side.
//   4. reapByProfileDir — process-level fallback keyed on the unique data dir.
async function reapSession({ GL, browser, profileId } = {}) {
  // Test override (read per-call) so the hang cases don't wait the real budgets.
  const _REAP_MS = Number(process.env.REAP_STEP_TIMEOUT_MS) || 0;
  if (GL) await _boundStep(() => GL.stopAndCommit({ posting: true }, false), _REAP_MS || 45000, "stopAndCommit");
  try { if (GL && typeof GL.killBrowser === "function") GL.killBrowser(); } catch {}
  if (browser) await _boundStep(() => browser.close(), _REAP_MS || 15000, "browser.close");
  if (browser && typeof browser.disconnect === "function") await _boundStep(() => browser.disconnect(), _REAP_MS || 10000, "browser.disconnect");
  await _boundStep(() => reapByProfileDir(profileId), _REAP_MS || 15000, "reapByProfileDir");
}

// Commit the profile's cookies back to GoLogin's cloud, then fully reap the
// browser process. Pods are stateless — the session lives in GoLogin's cloud,
// never on disk.
async function closeProfile(profileId) {
  const entry = active.get(profileId);
  active.delete(profileId);
  if (!entry) return;
  // Tolerate the legacy shape (a bare GoLogin instance) in case an old session
  // is still open across a deploy.
  const GL = entry.GL || (entry.stopAndCommit ? entry : null);
  const browser = entry.browser || null;
  await reapSession({ GL, browser, profileId });
}

module.exports = { launchProfile, closeProfile, reapSession };
