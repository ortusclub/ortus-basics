require("dotenv").config();

// Long-running server: never let a stray async error (e.g. a GoLogin commit
// rejection, a hung navigation) take the whole process down. Log and keep
// serving so one bad job can't kill every other in-flight scrape.
process.on("unhandledRejection", (reason) => {
  console.error("[engine] unhandledRejection:", (reason && reason.message) || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[engine] uncaughtException:", (err && err.message) || err);
});

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { checkSession, startLogin, getRegisteredUsers } = require("./browser");
// Queue backend chosen by USE_REDIS (in-memory by default, Redis for HPA).
const jobQueue = require("./job-queue");
const { extractSearchUrlsFromSheet } = require("./sheet-input");

// Campaign submission API — active only when PG_URL is configured (i.e. the
// frontend has a Cloud SQL connection). Writes campaigns to Postgres; the
// KEDA-scaled campaign-worker pods execute them. Inert on a scraper-only
// frontend (routes 503). Lazily required so the scraper never pulls in the
// campaign/pg deps unless it's actually campaign-capable.
let _campaignStore = null;
function initCampaigns() {
  if (!process.env.PG_URL) return null;
  try {
    const Redis = require("ioredis");
    const { CampaignStore } = require("./campaign-store");
    const redisUrl = process.env.REDIS_URL ||
      (process.env.REDIS_ADDRESS ? `redis://${process.env.REDIS_ADDRESS}` : "redis://127.0.0.1:6379");
    _campaignStore = new CampaignStore({
      pgUrl: process.env.PG_URL,
      redis: new Redis(redisUrl, { maxRetriesPerRequest: null }),
      podId: process.env.POD_NAME || process.env.HOSTNAME || "frontend",
    });
    console.log("[campaign-api] enabled (PG_URL set)");
    return _campaignStore;
  } catch (e) {
    console.warn("[campaign-api] disabled — init failed:", e.message);
    return null;
  }
}

const app = express();
const server = http.createServer(app);

// ─── Auth Helpers ───────────────────────────────────────────────
const APP_PASSWORD = process.env.APP_PASSWORD || "changeme";
// Shared bearer token for service clients (the Ortus control panel). Defaults
// to APP_PASSWORD so a single secret works out of the box; override with
// ENGINE_SHARED_TOKEN for a dedicated credential.
const SHARED_TOKEN = process.env.ENGINE_SHARED_TOKEN || APP_PASSWORD;
// Web-UI session tokens live in the queue backend (Redis when USE_REDIS, so a
// token issued by one pod is valid on every pod; in-memory otherwise).

async function generateToken() {
  const token = crypto.randomBytes(32).toString("hex");
  await jobQueue.addToken(token);
  return token;
}

async function authMiddleware(req, res, next) {
  // Bundled engine (inside Electron) runs on localhost only — skip auth entirely.
  if (process.env.SKIP_AUTH === '1') return next();
  try {
    // 1) Web-UI session token (x-auth-token header or ?token= query).
    const sessionToken = req.headers["x-auth-token"] || req.query.token;
    if (sessionToken && (await jobQueue.hasToken(sessionToken))) return next();
    // 2) Service client (Ortus app) — Authorization: Bearer <SHARED_TOKEN>.
    const auth = req.headers["authorization"] || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (bearer && bearer === SHARED_TOKEN) return next();
    return res.status(401).json({ error: "Unauthorized" });
  } catch (e) {
    // If the token store is briefly unreachable, fail closed.
    return res.status(503).json({ error: "Auth temporarily unavailable" });
  }
}

// (noVNC whole-screen view removed — replaced by per-job page screencast at
// GET /api/scrape/view/:jobId.)

// ─── WebSocket ──────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws, req) => {
  // Validate token from query string
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  const userId = url.searchParams.get("userId");
  if (process.env.SKIP_AUTH !== '1' && (!token || !(await jobQueue.hasToken(token)))) {
    ws.close(4001, "Unauthorized");
    return;
  }

  jobQueue.addListener(ws, userId);

  // Only send jobs that belong to THIS user. A connection without a userId
  // (e.g. a fresh browser session / incognito window that hasn't connected
  // a LinkedIn account yet) gets an empty list — never leak other users'
  // jobs to anyone who hits the URL. (await: getJobsForUser is async on the
  // Redis backend, a plain array on the in-memory one — both work.)
  ws.send(
    JSON.stringify({
      type: "init",
      jobs: userId ? await jobQueue.getJobsForUser(userId) : [],
    })
  );

  ws.on("close", () => jobQueue.removeListener(ws));
});

// All WebSocket upgrades → the job-queue WebSocket server.
server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ─── Middleware ──────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' })); // team-wide FG dispatch sends every matched connection as a lead w/ row_data — default 100kb 413s
app.use(express.static(path.join(__dirname, "public")));

// ─── Public Routes (no auth) ────────────────────────────────────

/** App login — validates password, returns a session token */
app.post("/api/auth/login", async (req, res) => {
  const { password } = req.body;
  if (password !== APP_PASSWORD) {
    return res.status(403).json({ error: "Wrong password" });
  }
  const token = await generateToken();
  res.json({ token });
});

// ─── Protected Routes (require auth) ───────────────────────────
app.use("/api", authMiddleware);

// Campaign submission API — mounted AFTER authMiddleware so /api/campaign/*
// requires the bearer token (same as the scrape API). Inert unless PG_URL set.
const { mountCampaignApi } = require("./campaign-api");
const _campaignStoreForApi = initCampaigns();
mountCampaignApi(app, _campaignStoreForApi, { log: (m) => console.log(`[campaign-api] ${m}`) });

// KEDA scale bridge — the always-on frontend mirrors the active-campaign count
// into Redis (list cmp:scaleactive) so the campaign ScaledObject's redis trigger
// can scale workers WITHOUT KEDA needing a Postgres connection (which let us
// collapse the standalone cloudsql-proxy into per-pod sidecars). Authoritative
// re-read each tick → drift-free; a DB blip is SKIPPED (never zeroes the metric,
// so a running campaign can't be scaled to zero by a transient error).
if (_campaignStoreForApi) {
  const SCALE_BRIDGE_MS = Number(process.env.SCALE_BRIDGE_MS || 15000);
  const tick = async () => {
    try { await _campaignStoreForApi.refreshScaleMetric(); }
    catch (e) { console.warn("[scale-bridge] skip (DB blip):", e.message); }
  };
  tick();
  setInterval(tick, SCALE_BRIDGE_MS).unref();
  console.log(`[scale-bridge] active-campaign→Redis every ${SCALE_BRIDGE_MS}ms`);
}

/** Health check */
app.get("/api/health", async (_req, res) => {
  res.json({ ok: true });
});

// ─── LinkedIn display-name resolution ───────────────────────────
// Cache the LinkedIn profile name per userId so the UI can show the real
// account (e.g. "Mark Hubbard") instead of a generic "LinkedIn Account"
// label. The cache lives until logout / pod restart.
const displayNameCache = new Map();

async function fetchLinkedInDisplayName(userId) {
  console.log(`[displayName] fetching for ${userId}`);
  const { newPage } = require("./browser");
  let page;
  // Hard cap so a misbehaving page can't wedge the request forever.
  const overallTimeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("display-name fetch timeout (45s)")), 45000)
  );

  const work = (async () => {
    page = await newPage(userId);

    // Read the CSRF token out of the JSESSIONID cookie ("ajax:1234567890")
    // — LinkedIn's voyager and sales APIs require it in a header.
    const cookies = await page.context().cookies("https://www.linkedin.com");
    const jsess = cookies.find((c) => c.name === "JSESSIONID");
    const csrf = jsess
      ? jsess.value.replace(/^"|"$/g, "")
      : "ajax:0";
    console.log(`[displayName] csrf token: ${JSON.stringify(csrf)}`);

    // The user logged in via /sales/contract-chooser, so cookies are valid
    // for the /sales/* surface. Land on the Sales Nav homepage first.
    await page
      .goto("https://www.linkedin.com/sales/homepage", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    console.log(`[displayName] sales URL: ${page.url()}`);

    // 1) Sales Nav account API. Returns the seat owner's full name.
    let name = await page
      .evaluate(async (csrf) => {
        try {
          const r = await fetch(
            "/sales-api/salesApiAccountSettings?q=accountSettings",
            {
              headers: {
                accept: "application/json",
                "csrf-token": csrf,
                "x-restli-protocol-version": "2.0.0",
              },
              credentials: "include",
            }
          );
          if (!r.ok) return "";
          const j = await r.json();
          const e = j?.elements?.[0] || j?.data?.elements?.[0];
          const f =
            e?.member?.firstName?.text ||
            e?.member?.firstName ||
            e?.firstName ||
            "";
          const l =
            e?.member?.lastName?.text ||
            e?.member?.lastName ||
            e?.lastName ||
            "";
          return `${f} ${l}`.trim();
        } catch (_) {
          return "";
        }
      }, csrf)
      .catch(() => "");
    console.log(`[displayName] sales-api accountSettings: ${JSON.stringify(name)}`);

    // 2) Voyager /me — works if cookies cover the regular linkedin.com too.
    if (!name) {
      name = await page
        .evaluate(async (csrf) => {
          try {
            const r = await fetch("/voyager/api/me", {
              headers: { accept: "application/json", "csrf-token": csrf },
              credentials: "include",
            });
            if (!r.ok) return "";
            const j = await r.json();
            const f =
              j?.miniProfile?.firstName ||
              j?.data?.firstName ||
              j?.firstName ||
              "";
            const l =
              j?.miniProfile?.lastName ||
              j?.data?.lastName ||
              j?.lastName ||
              "";
            return `${f} ${l}`.trim();
          } catch (_) {
            return "";
          }
        }, csrf)
        .catch(() => "");
      console.log(`[displayName] voyager API: ${JSON.stringify(name)}`);
    }

    // 3) DOM-scrape the Sales Nav top bar. The seat owner's name lives in
    //    a few stable spots: the global nav profile menu, the user avatar's
    //    alt text, or the search-bar greeting.
    if (!name) {
      name = await page
        .evaluate(() => {
          const sels = [
            'img.global-nav__me-photo',
            'img[alt*="Photo of"]',
            '.global-nav__me img',
            'button[aria-label*="Profile of"] img',
            '[data-test-global-nav-me-link] img',
            'img[id*="profile-pic"]',
          ];
          for (const s of sels) {
            const el = document.querySelector(s);
            const alt = el?.getAttribute("alt") || "";
            // alt text is usually "Photo of Mark Hubbard" or just "Mark Hubbard".
            const cleaned = alt.replace(/^Photo of\s+/i, "").trim();
            if (cleaned.length >= 2 && cleaned.length <= 80) return cleaned;
          }
          // Last-ditch: scan all visible text for "Welcome, X"
          const m = document.body.innerText.match(/Welcome,\s+([A-Za-z][A-Za-z' .-]{1,60})/);
          return m ? m[1].trim() : "";
        })
        .catch(() => "");
      console.log(`[displayName] sales-nav DOM: ${JSON.stringify(name)}`);
    }

    return (name || "").trim();
  })();

  try {
    const result = await Promise.race([work, overallTimeout]);
    console.log(`[displayName] result for ${userId}: ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    console.log(`[displayName] error for ${userId}: ${e.message}`);
    return "";
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** Check LinkedIn session status for a user */
app.get("/api/linkedin/status/:userId", async (req, res) => {
  const valid = await checkSession(req.params.userId);
  res.json({
    valid,
    userId: req.params.userId,
    displayName: displayNameCache.get(req.params.userId) || "",
  });
});

/** Fetch (and cache) the LinkedIn display name for a user. */
app.get("/api/linkedin/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  if (displayNameCache.has(userId)) {
    return res.json({ name: displayNameCache.get(userId), cached: true });
  }
  const name = await fetchLinkedInDisplayName(userId);
  if (name) displayNameCache.set(userId, name);
  res.json({ name, cached: false });
});

/** List all connected LinkedIn accounts */
app.get("/api/linkedin/accounts", async (_req, res) => {
  const users = getRegisteredUsers();
  const accounts = [];

  for (const userId of users) {
    const valid = await checkSession(userId);
    accounts.push({ userId, connected: valid });
  }

  res.json({ accounts });
});

/** Connect LinkedIn via li_at cookie — no remote browser needed */
app.post("/api/linkedin/login/cookie", async (req, res) => {
  const { userId, cookie } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });
  if (!cookie) return res.status(400).json({ error: "cookie is required" });

  try {
    const { getBrowser, closeBrowser } = require("./browser");

    // Close any existing context for this user
    await closeBrowser(userId);

    // Get a fresh browser context
    const ctx = await getBrowser(userId);

    // Set the li_at cookie and JSESSIONID
    await ctx.addCookies([
      {
        name: "li_at",
        value: cookie,
        domain: ".linkedin.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "None",
      },
      {
        name: "JSESSIONID",
        value: `"ajax:${Date.now()}"`,
        domain: ".linkedin.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None",
      },
    ]);

    // Verify the cookie works by visiting LinkedIn
    const page = await ctx.newPage();
    await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));

    const url = page.url();
    const valid = !url.includes("/login") && !url.includes("/authwall");

    // Try to get the display name
    let displayName = "";
    if (valid) {
      try {
        await page.goto("https://www.linkedin.com/in/me/", {
          waitUntil: "domcontentloaded",
          timeout: 10000,
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 2000));
        displayName = await page.evaluate(() => {
          const el = document.querySelector("h1");
          return el?.textContent?.trim() || "";
        }).catch(() => "");
      } catch (e) {}
    }

    await page.close().catch(() => {});

    if (!valid) {
      // Cookie didn't work — clean up
      await closeBrowser(userId);
    }

    res.json({ valid, userId, displayName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Start LinkedIn login — launches a visible Chrome browser on the virtual display */
app.post("/api/linkedin/login/start", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  try {
    const page = await startLogin(userId);

    // Store the page reference
    if (!app.locals.loginPages) app.locals.loginPages = {};
    app.locals.loginPages[userId] = page;

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Get current screenshot of the login page */
app.get("/api/linkedin/login/screenshot/:userId", async (req, res) => {
  const page = app.locals.loginPages?.[req.params.userId];
  if (!page) return res.status(404).json({ error: "No active login session" });

  try {
    const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
    const base64 = screenshot.toString("base64");
    res.json({
      screenshot: `data:image/jpeg;base64,${base64}`,
      url: page.url(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Send a click to the login page */
app.post("/api/linkedin/login/click", async (req, res) => {
  const { userId, x, y } = req.body;
  const page = app.locals.loginPages?.[userId];
  if (!page) return res.status(404).json({ error: "No active login session" });

  try {
    await page.mouse.click(x, y);
    await new Promise((r) => setTimeout(r, 500));
    const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
    const base64 = screenshot.toString("base64");
    res.json({
      screenshot: `data:image/jpeg;base64,${base64}`,
      url: page.url(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Type text into the login page */
app.post("/api/linkedin/login/type", async (req, res) => {
  const { userId, text } = req.body;
  const page = app.locals.loginPages?.[userId];
  if (!page) return res.status(404).json({ error: "No active login session" });

  try {
    await page.keyboard.type(text, { delay: 50 });
    await new Promise((r) => setTimeout(r, 300));
    const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
    const base64 = screenshot.toString("base64");
    res.json({
      screenshot: `data:image/jpeg;base64,${base64}`,
      url: page.url(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Press a key (Enter, Tab, etc.) */
app.post("/api/linkedin/login/key", async (req, res) => {
  const { userId, key } = req.body;
  const page = app.locals.loginPages?.[userId];
  if (!page) return res.status(404).json({ error: "No active login session" });

  try {
    await page.keyboard.press(key);
    await new Promise((r) => setTimeout(r, 1000));
    const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
    const base64 = screenshot.toString("base64");
    res.json({
      screenshot: `data:image/jpeg;base64,${base64}`,
      url: page.url(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Execute a keyboard combo (e.g. Select All, Clear Field) */
app.post("/api/linkedin/login/combo", async (req, res) => {
  const { userId, action } = req.body;
  const page = app.locals.loginPages?.[userId];
  if (!page) return res.status(404).json({ error: "No active login session" });

  try {
    if (action === "selectAll") {
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      // Also try Meta (Cmd on Mac) in case
      await page.keyboard.down("Meta");
      await page.keyboard.press("a");
      await page.keyboard.up("Meta");
    } else if (action === "clearField") {
      // Select all then delete
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.keyboard.down("Meta");
      await page.keyboard.press("a");
      await page.keyboard.up("Meta");
      await new Promise((r) => setTimeout(r, 100));
      await page.keyboard.press("Backspace");
    } else if (action === "backspace") {
      await page.keyboard.press("Backspace");
    }

    await new Promise((r) => setTimeout(r, 300));
    const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
    const base64 = screenshot.toString("base64");
    res.json({
      screenshot: `data:image/jpeg;base64,${base64}`,
      url: page.url(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Finish login — check if session is valid, extract name, and close the login page */
app.post("/api/linkedin/login/finish", async (req, res) => {
  const { userId } = req.body;
  const page = app.locals.loginPages?.[userId];

  try {
    let displayName = "";

    // Extract the name from whatever page the user is currently on — no
    // navigation, no opening a second browser. LinkedIn / Sales Nav always
    // shows the user's name in the top nav once authenticated, so we can
    // pull it straight out of the already-loaded DOM (instant).
    if (page) {
      try {
        // Read CSRF token from cookies in case we need an in-page API call.
        const cookies = await page
          .context()
          .cookies("https://www.linkedin.com")
          .catch(() => []);
        const jsess = cookies.find((c) => c.name === "JSESSIONID");
        const csrf = jsess ? jsess.value.replace(/^"|"$/g, "") : "ajax:0";

        displayName = await page
          .evaluate(async (csrf) => {
            // 1) Sales Nav top-nav avatar / name elements (works on any
            //    /sales/* page — homepage, search, contract-chooser, etc.)
            const domSels = [
              'img.global-nav__me-photo',
              'img[alt^="Photo of "]',
              '[data-test-global-nav-me-link] img',
              '.global-nav__me img',
              'button[aria-label*="Profile of"] img',
            ];
            for (const s of domSels) {
              const el = document.querySelector(s);
              const alt = el?.getAttribute("alt") || "";
              const cleaned = alt.replace(/^Photo of\s+/i, "").trim();
              if (cleaned.length >= 2 && cleaned.length <= 80) return cleaned;
            }

            // 2) Profile page h1 (if user happened to land there).
            const h1Sels = [
              "h1.text-heading-xlarge",
              "h1.top-card-layout__title",
              "main h1",
              "h1",
            ];
            for (const s of h1Sels) {
              const el = document.querySelector(s);
              const t = el?.textContent?.trim();
              if (t && t.length >= 2 && t.length <= 80) return t;
            }

            // 3) In-page API call — uses the popup's existing session.
            try {
              const url = location.host.includes("linkedin.com")
                ? "/sales-api/salesApiAccountSettings?q=accountSettings"
                : "";
              if (url) {
                const r = await fetch(url, {
                  headers: {
                    accept: "application/json",
                    "csrf-token": csrf,
                    "x-restli-protocol-version": "2.0.0",
                  },
                  credentials: "include",
                });
                if (r.ok) {
                  const j = await r.json();
                  const e = j?.elements?.[0] || j?.data?.elements?.[0];
                  const f =
                    e?.member?.firstName?.text ||
                    e?.member?.firstName ||
                    e?.firstName ||
                    "";
                  const l =
                    e?.member?.lastName?.text ||
                    e?.member?.lastName ||
                    e?.lastName ||
                    "";
                  const combined = `${f} ${l}`.trim();
                  if (combined.length >= 2) return combined;
                }
              }
            } catch (_) {}

            return "";
          }, csrf)
          .catch(() => "");
        console.log(`[finish] in-page extraction for ${userId}: ${JSON.stringify(displayName)}`);
      } catch (e) {
        console.log(`[finish] in-page extraction error: ${e.message}`);
      }
    }

    const valid = await checkSession(userId);

    // Close the visible login popup — we've already extracted what we need.
    if (page) {
      await page.close().catch(() => {});
      delete app.locals.loginPages[userId];
    }

    // Only fall back to the heavy fetchLinkedInDisplayName if the in-page
    // extraction returned nothing. This rarely fires now.
    if (valid && !displayName) {
      console.log(`[finish] in-page extraction empty — falling back to background fetch`);
      displayName = await fetchLinkedInDisplayName(userId);
    }

    if (valid && displayName) displayNameCache.set(userId, displayName);

    res.json({ valid, userId, displayName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Logout — close browser context and delete session data */
app.post("/api/linkedin/logout", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId is required" });

  try {
    // Close the browser context
    const { closeBrowser } = require("./browser");
    await closeBrowser(userId);

    // Delete the session folder
    const sessionPath = path.join(__dirname, "sessions", userId);
    const fs = require("fs");
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    // Drop the cached LinkedIn display name so the next login fetches fresh.
    displayNameCache.delete(userId);

    res.json({ ok: true, message: `Session for "${userId}" cleared` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Read Sales Nav search URLs out of an INPUT Google Sheet (the "From a Sheet"
 * batch input). Returns `items` ([{ row, url }] with 1-based sheet row numbers)
 * so the UI can offer a "scrape rows 2–10" picker, plus a flat `urls` list.
 */
app.get("/api/scrape/extract-urls", async (req, res) => {
  const sheetUrl = (req.query.sheetUrl || "").toString().trim();
  if (!sheetUrl) return res.status(400).json({ error: "sheetUrl required" });
  try {
    const items = await extractSearchUrlsFromSheet(sheetUrl);
    res.json({ items, urls: items.map((i) => i.url), count: items.length });
  } catch (err) {
    res.status(400).json({ error: err && err.message ? err.message : "could not read sheet" });
  }
});

/** Start a single scrape job. Identity is the GoLogin profileId. */
app.post("/api/scrape/single", async (req, res) => {
  const { searchUrl, sheetUrl, tabName, slowMode, userId, profileId, campaignName, ownerEmail, runId } = req.body;

  if (!searchUrl)
    return res.status(400).json({ error: "searchUrl is required" });
  if (!sheetUrl) return res.status(400).json({ error: "sheetUrl is required" });
  if (!profileId)
    return res
      .status(400)
      .json({ error: "profileId is required — pick a GoLogin profile with a Sales Nav seat" });

  const job = await jobQueue.addSingle({
    searchUrl,
    sheetUrl,
    tabName,
    slowMode,
    userId,
    profileId,
    campaignName,
    ownerEmail,
    runId,
  });

  res.json({ job });
});

/** Start a batch of scrape jobs. Accepts `searchUrls` (preferred) or `urls`. */
app.post("/api/scrape/batch", async (req, res) => {
  const { sheetUrl, tabName, slowMode, userId, profileId, campaignName, ownerEmail, runId } = req.body;
  const urls = req.body.searchUrls || req.body.urls;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: "searchUrls array is required" });
  }
  if (!sheetUrl) return res.status(400).json({ error: "sheetUrl is required" });
  if (!profileId)
    return res
      .status(400)
      .json({ error: "profileId is required — pick a GoLogin profile with a Sales Nav seat" });

  const batch = await jobQueue.addBatch({
    urls: urls.filter((u) => u.trim()),
    sheetUrl,
    tabName,
    slowMode,
    userId,
    profileId,
    campaignName,
    ownerEmail,
    runId,
  });

  res.json(batch);
});

/**
 * Queue snapshot for the position/ETA display (WS poll fallback + initial load).
 * Returns aggregate stats and, scoped to ?userId, that operator's own job
 * positions. Live updates normally arrive over WS (queue:position / queue:stats);
 * this endpoint backfills on page load / reconnect.
 */
app.get("/api/scrape/queue", async (req, res) => {
  const userId = req.query.userId || null;
  if (typeof jobQueue.queueSnapshot !== "function") {
    return res.json({ stats: { waiting: 0, running: 0, activeAccounts: 0 }, jobs: {} });
  }
  const snap = await jobQueue.queueSnapshot();
  const jobs = {};
  for (const [id, p] of Object.entries(snap.jobs || {})) {
    if (!userId || p.userId === userId) jobs[id] = p;
  }
  res.json({ stats: snap.stats || {}, jobs });
});

/** Pause a profile's running job. */
app.post("/api/scrape/pause", async (req, res) => {
  const { profileId } = req.body;
  if (profileId) await jobQueue.pauseForProfile(profileId);
  res.json({ ok: true });
});

/** Resume a profile's running job. */
app.post("/api/scrape/resume", async (req, res) => {
  const { profileId } = req.body;
  if (profileId) await jobQueue.resumeForProfile(profileId);
  res.json({ ok: true });
});

/** Stop a profile's jobs (running + queued). */
app.post("/api/scrape/stop", async (req, res) => {
  const { profileId } = req.body;
  if (profileId) await jobQueue.stopForProfile(profileId);
  res.json({ ok: true });
});

/**
 * List the GoLogin profiles (id + name) for the standalone web UI's profile
 * picker. Uses the engine's own GOLOGIN_API_TOKEN. Cached briefly to avoid
 * hammering the GoLogin API.
 */
let _profilesCache = null; // { ts, profiles }
app.get("/api/profiles", async (_req, res) => {
  const token = process.env.GOLOGIN_API_TOKEN;
  if (!token) return res.json({ profiles: [] });
  if (_profilesCache && Date.now() - _profilesCache.ts < 5 * 60 * 1000) {
    return res.json({ profiles: _profilesCache.profiles });
  }
  try {
    // GoLogin v2 paginates 30/page; loop until we've collected allProfilesCount.
    const all = [];
    let page = 1;
    let total = Infinity;
    while (all.length < total && page <= 50) {
      const r = await fetch(`https://api.gologin.com/browser/v2?page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      const raw = Array.isArray(data) ? data : data.profiles || [];
      if (typeof data.allProfilesCount === "number") total = data.allProfilesCount;
      all.push(...raw);
      if (!raw.length) break;
      page++;
    }
    const profiles = all
      .map((p) => ({ id: p.id, name: p.name || p.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    _profilesCache = { ts: Date.now(), profiles };
    res.json({ profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Recent activity log lines (oldest first). ?since=<ms epoch> returns only
 * lines newer than that, for cheap incremental polling.
 */
app.get("/api/logs", async (req, res) => {
  const since = req.query.since ? Number(req.query.since) : 0;
  const { userId } = req.query;
  // ?userId= scopes the log feed to one operator (the Ortus app sends its
  // stable operator id). Without it, returns the global buffer (admin view).
  const logs = userId
    ? await jobQueue.getRecentLogsForUser(userId, since)
    : await jobQueue.getRecentLogs(since);
  res.json({ logs, now: Date.now() });
});

/**
 * Log history for ONE launch (runId) — merged across all its jobs, oldest
 * first. Lets the app board show per-strip history even after jobs finish
 * (the live WS feed only covers running scrapes). runId is echoed on every
 * job in /api/jobs and on each log line.
 */
app.get("/api/scrape/runs/:runId/logs", async (req, res) => {
  if (typeof jobQueue.getLogsForRun !== "function") return res.json({ logs: [] });
  const logs = await jobQueue.getLogsForRun(req.params.runId);
  res.json({ logs, now: Date.now() });
});

/**
 * List jobs. With no filter, returns all jobs (the Ortus control panel is a
 * single admin client). ?userId= or ?profileId= narrow the view.
 */
app.get("/api/jobs", async (req, res) => {
  const { userId, profileId } = req.query;
  let jobs = await jobQueue.getAllJobs();
  if (userId) jobs = jobs.filter((j) => j.userId === userId);
  if (profileId) jobs = jobs.filter((j) => j.profileId === profileId);
  // Attach live queue position/ETA to QUEUED jobs so the desktop app's poll
  // (every ~4s) can show "#N in queue · ~M min". Extra fields are ignored by
  // clients that don't use them. Guarded for the in-memory (non-Redis) backend.
  if (typeof jobQueue.queueSnapshot === "function" && jobs.some((j) => j.state === "queued")) {
    try {
      const snap = await jobQueue.queueSnapshot();
      jobs = jobs.map((j) => {
        const p = snap.jobs && snap.jobs[j.id];
        return p ? { ...j, position: p.position, jobsAhead: p.jobsAhead, accountsAhead: p.accountsAhead, etaMs: p.etaMs } : j;
      });
    } catch (_) {}
  }
  res.json({ jobs });
});

/**
 * Live view for ONE running job — powers the per-job "View" button.
 *
 * Streams a CDP screencast of that job's page as MJPEG
 * (multipart/x-mixed-replace), so a browser <img> renders it as real live
 * video (several fps) with no client-side frame handling. The stream stays open
 * until the client disconnects (or the page closes), at which point we stop the
 * screencast. 404 if the job isn't running.
 */
app.get("/api/scrape/view/:jobId", async (req, res) => {
  const { jobId } = req.params;
  const scraper = jobQueue.getRunningScraper(jobId);

  // Cross-pod View: if this pod isn't running the job, the scrape is on ANOTHER
  // pod. Look up the owning pod's IP (recorded in Redis at claim time) and proxy
  // the live MJPEG stream from it. `?internal=1` marks the proxied hop so the
  // target serves locally and never re-proxies (no loops). Only the distributed
  // (Redis) backend has multiple pods; the in-memory backend always serves local.
  if (!scraper) {
    if (jobQueue.isDistributed && !req.query.internal) {
      let job = null;
      try { job = await jobQueue.getJob(jobId); } catch (_) {}
      if (
        job && job.state === "running" && job.podIP &&
        job.podId !== jobQueue.podId
      ) {
        const target = `http://${job.podIP}:${job.podPort || PORT}/api/scrape/view/${jobId}?internal=1`;
        const upstream = http.get(
          target,
          { headers: { authorization: req.headers["authorization"] || "", "x-auth-token": req.headers["x-auth-token"] || "" } },
          (up) => {
            res.writeHead(up.statusCode || 200, up.headers);
            up.pipe(res);
          }
        );
        upstream.on("error", () => { try { res.status(502).json({ error: "View proxy failed" }); } catch (_) {} });
        req.on("close", () => upstream.destroy());
        return;
      }
    }
    return res.status(404).json({ error: "Job is not running" });
  }

  const boundary = "ortusframe";
  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Connection: "keep-alive",
    // Defeat proxy buffering so frames flush immediately.
    "X-Accel-Buffering": "no",
  });

  let open = true;
  const writeFrame = (buf) => {
    if (!open) return;
    try {
      res.write(
        `--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`
      );
      res.write(buf);
      res.write("\r\n");
    } catch (_) {
      // Downstream went away between checks — cleanup will fire via 'close'.
    }
  };

  const stop = await scraper.startScreencast(writeFrame);

  const cleanup = () => {
    if (!open) return;
    open = false;
    Promise.resolve().then(stop).catch(() => {});
    try { res.end(); } catch (_) {}
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
});

/** Update settings */
app.post("/api/settings", (req, res) => {
  const { slowMode } = req.body;
  if (slowMode !== undefined) process.env.SLOW_MODE = String(slowMode);
  res.json({ ok: true });
});

/** Get current settings */
app.get("/api/settings", (_req, res) => {
  const hasServiceAccount =
    !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    require("fs").existsSync(
      require("path").join(__dirname, "service-account.json")
    );

  res.json({
    slowMode: process.env.SLOW_MODE === "true",
    headless: process.env.HEADLESS === "true",
    sheetsConnected: hasServiceAccount,
  });
});

// ─── Fallback: serve the UI for any non-API route ──────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Error handler — catch malformed URLs and other Express errors ──
app.use((err, _req, res, _next) => {
  if (err instanceof URIError) {
    return res.status(400).send('Bad request');
  }
  console.error('Server error:', err.message);
  res.status(500).send('Internal server error');
});

// ─── Session Auto-Cleanup ────────────────────────────────────────
const SESSION_MAX_AGE_DAYS = 7;

function cleanupOldSessions() {
  const sessionsDir = path.join(__dirname, "sessions");
  if (!fs.existsSync(sessionsDir)) return;

  const now = Date.now();
  const maxAge = SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(sessionsDir, dir.name);
      try {
        const stat = fs.statSync(dirPath);
        const age = now - stat.mtimeMs;
        if (age > maxAge) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
          console.log(`🧹  Cleaned up expired session: ${dir.name} (${Math.round(age / 86400000)} days old)`);
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* ok */ }

  if (cleaned > 0) {
    console.log(`🧹  Cleaned up ${cleaned} expired session(s)`);
  }
}

// ─── Graceful shutdown (SIGTERM from K8s scale-down / rollout) ──────
//
// When KEDA scales a pod down (overnight, weekend) or a rollout happens, K8s
// sends SIGTERM. We must NOT drop an in-flight scrape. Stop accepting new
// connections, then let jobQueue.drain() wait for running scrapes to finish
// (up to the pod's terminationGracePeriodSeconds) before exiting.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[engine] ${signal} received — draining in-flight scrapes before exit…`);
  try {
    server.close(); // stop taking new HTTP/WS connections
    if (typeof jobQueue.drain === "function") {
      // Return ~20s before Autopilot's 600s SIGKILL so we log a clean result.
      const result = await jobQueue.drain(580000);
      console.log(`[engine] drain complete:`, result);
    }
  } catch (e) {
    console.error("[engine] drain error:", e && e.message);
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ─── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log("");
  console.log(
    `🚀  Sales Nav Cloud Scraper running at http://localhost:${PORT}`
  );
  console.log(
    `🔒  App password: ${
      APP_PASSWORD === "changeme"
        ? '⚠️  Using default "changeme" — set APP_PASSWORD in .env!'
        : "Set ✓"
    }`
  );

  // Clean up old sessions on startup
  cleanupOldSessions();

  // Run cleanup every 24 hours
  setInterval(cleanupOldSessions, 24 * 60 * 60 * 1000);

  // Prune finished jobs older than 14 days (frontend only — one pruner is
  // enough). sn:jobs used to grow forever, flooding the app board with stale
  // DONE/ERROR rows and slowly bloating Redis.
  if ((process.env.ROLE || "all") !== "worker" && typeof jobQueue.pruneFinishedJobs === "function") {
    const prune = () =>
      jobQueue.pruneFinishedJobs()
        .then((n) => { if (n) console.log(`🧹  Pruned ${n} finished job(s) older than 14 days`); })
        .catch(() => {});
    setTimeout(prune, 60 * 1000); // first pass shortly after boot
    setInterval(prune, 6 * 60 * 60 * 1000);
  }

  // No pre-warming at startup — it eats GBs of RAM (one Chromium per
  // session) and leaves browser processes in weird states that break
  // subsequent newPage() calls. We just open contexts lazily when they're
  // actually needed.
  const remaining = getRegisteredUsers();
  if (remaining.length > 0) {
    console.log(`📂  ${remaining.length} session(s) on disk — opened lazily on first use.`);
  }

  console.log("");
});
