// GoLogin-backed browser manager.
//
// The scraper drives the team's existing GoLogin profiles (Orbita anti-detect
// Chromium) instead of a local Playwright Chromium with a noVNC login. Each
// profile carries its own LinkedIn session (cookies synced from GoLogin's
// cloud), so there is no interactive login here.
//
// We launch a profile LOCALLY via the GoLogin SDK (NOT cloud-run — so it is
// not subject to the GoLogin plan's 2-concurrent cloud-launch cap; concurrency
// is bounded only by this host's resources) and attach Playwright over the
// SDK's CDP websocket endpoint.
//
// Identity key is the GoLogin profileId. A single profile cannot run in two
// places at once (cookie/state collision), so getBrowser() holds a per-profile
// launch lock and queue.js additionally serialises one job per profile.

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

// The `gologin` package is an ES Module. CommonJS can't `require()` an ESM on
// older Node (the Playwright base image ships Node 18), so we load it lazily
// with dynamic import() inside launch() — which works on every Node version.
let _GoLoginCtor = null;
async function getGoLoginCtor() {
  if (!_GoLoginCtor) {
    const mod = await import("gologin");
    _GoLoginCtor = mod.GoLogin || mod.default;
  }
  return _GoLoginCtor;
}

const INTERCEPTOR_PATH = path.join(__dirname, "interceptor.js");
const token = () => process.env.GOLOGIN_API_TOKEN || "";

// profileId → { GL, browser, context }
const sessions = new Map();
// profileId → Promise<context> while a launch is in flight, so concurrent
// getBrowser() calls for the SAME profile collapse to one launch.
const launching = new Map();

function isContextAlive(ctx) {
  try {
    ctx.pages();
    return true;
  } catch (_) {
    return false;
  }
}

/** Launch the profile via the GoLogin SDK and attach Playwright over CDP. */
async function launch(profileId) {
  if (!token()) throw new Error("GOLOGIN_API_TOKEN is not set");

  const GoLogin = await getGoLoginCtor();
  const GL = new GoLogin({
    token: token(),
    profile_id: profileId,
    // Mirror the proven flags from the Ortus app's gologin-launcher: trim RAM
    // and stop Chromium from throttling a backgrounded/occluded renderer
    // (which drops keystrokes and stalls LinkedIn's SPA).
    extra_params: [
      // REQUIRED in a container: Chromium/Orbita runs as root and the sandbox
      // can't initialise, so without these it crashes instantly → the
      // remote-debugging port never opens → "connect ECONNREFUSED". (Harmless
      // on a local Mac too.) --disable-dev-shm-usage avoids /dev/shm size limits.
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-features=TranslateUI,MediaRouter,CalculateNativeWinOcclusion",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });

  const { status, wsUrl } = await GL.start();
  if (status !== "success" || !wsUrl) {
    await GL.stop().catch(() => {});
    throw new Error(`GoLogin start failed for ${profileId}: status="${status}"`);
  }

  // Slow profiles (large cookie jars) can take a while for the CDP attach —
  // match the 180s the Ortus launcher uses.
  const browser = await chromium.connectOverCDP(wsUrl, { timeout: 180000 });
  const context = browser.contexts()[0] || (await browser.newContext());

  sessions.set(profileId, { GL, browser, context });
  return context;
}

/**
 * Get (or launch) a Playwright BrowserContext for a GoLogin profile.
 * Reuses a live cached context; recycles a dead one; dedupes concurrent
 * launches of the same profile.
 */
async function getBrowser(profileId) {
  if (!profileId) throw new Error("getBrowser: profileId is required");

  const cached = sessions.get(profileId);
  if (cached && isContextAlive(cached.context)) return cached.context;
  if (cached) await closeBrowser(profileId).catch(() => {});

  if (launching.has(profileId)) return launching.get(profileId);
  const p = launch(profileId).finally(() => launching.delete(profileId));
  launching.set(profileId, p);
  return p;
}

/** Open a new page with the Sales Nav interceptor pre-injected. */
async function newPage(profileId) {
  const interceptorCode = fs.readFileSync(INTERCEPTOR_PATH, "utf-8");
  const ctx = await getBrowser(profileId);
  const page = await ctx.newPage();
  await page.addInitScript(interceptorCode);
  return page;
}

/** Close a profile: commit its cookies back to GoLogin, then detach + kill. */
async function closeBrowser(profileId) {
  const session = sessions.get(profileId);
  sessions.delete(profileId);
  if (!session) return;
  const { GL, browser } = session;

  // Commit cookies + profile state to GoLogin's cloud so the next launch
  // (here or elsewhere) starts from the latest session. Fire-and-forget — the
  // SDK's is_stopping guard makes a duplicate stopAndCommit safe.
  //
  // CRITICAL: stopAndCommit is async, so a try/catch would NOT catch its
  // rejection — a commit failure (profile folder gone, S3 hiccup, network)
  // would become an unhandled rejection and crash the whole engine. Wrap in a
  // promise chain with .catch() so it can never take the process down.
  Promise.resolve()
    .then(() => GL.stopAndCommit({ posting: true }, false))
    .catch((e) => console.warn(`[browser] stopAndCommit ${profileId}: ${e && e.message}`));
  // Detach Playwright; ask the SDK to take down the Orbita process.
  try { await browser.close(); } catch (_) {}
  try { if (GL.killBrowser) GL.killBrowser(); } catch (_) {}
}

/**
 * Lightweight LinkedIn-session check. The session lives in the GoLogin profile
 * (cookies from the cloud), so this launches the profile and checks for li_at.
 */
async function checkSession(profileId) {
  try {
    const ctx = await getBrowser(profileId);
    const cookies = await ctx.cookies("https://www.linkedin.com");
    return cookies.some((c) => c.name === "li_at");
  } catch (_) {
    sessions.delete(profileId);
    return false;
  }
}

/**
 * noVNC interactive login is removed — GoLogin profiles are logged into
 * LinkedIn on the GoLogin side. Kept as a guard so any stale caller fails
 * loudly instead of silently launching a blank browser.
 */
async function startLogin() {
  throw new Error(
    "Interactive login removed — log the GoLogin profile into LinkedIn in the GoLogin app, not here."
  );
}

/** Active (launched) profile ids. */
function getRegisteredUsers() {
  return [...sessions.keys()];
}

module.exports = {
  getBrowser,
  newPage,
  checkSession,
  startLogin,
  closeBrowser,
  getRegisteredUsers,
};
