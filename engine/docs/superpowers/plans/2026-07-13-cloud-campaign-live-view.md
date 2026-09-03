# Cloud Campaign "Watch Live" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the engine endpoint `GET /api/campaign/:id/view` — a live MJPEG CDP screencast of a cloud campaign's active browser — to the contract the app already ships against, then add the "👁 Show" button to the app's second status card and a green "● LIVE" dot to both.

**Architecture:** The `campaign-worker` pod keeps an in-process registry of open campaign browser sessions (keyed by `campaignId`), stamps a short-TTL Redis key `cmp:live:<id>` = `{podIP,podPort,account}` so the always-on frontend can find which pod holds the live browser, and serves the MJPEG on its own HTTP server. The frontend (`campaign-api.js` on `server.js`) proxies the stream to the worker pod (exactly like the scrape View cross-pod path) and folds a `live` flag into the campaign status responses. **The app half is already built (v2.154.0)** — client `openCampaignViewStream`, server proxy `/api/campaign/cloud/:id/view`, viewer overlay `openCloudCampaignView`, and the card-#1 "👁 Show" button — so the engine endpoint is the load-bearing missing piece; the app tasks only add the card-#2 button and the LIVE dot.

**Tech Stack:** Node/Express (engine), Puppeteer CDP (`Page.startScreencast`), ioredis, MJPEG `multipart/x-mixed-replace`, Electron renderer vanilla JS (`public/js/app.js`). Engine tests are standalone `node <file>.js` with `node:test`.

## Contract (already fixed by the app — do not change it)

`ortus-gologin-clone/docs/cloud-engine-campaign-view-spec.md` and `src/campaigns-client.js:226`:

```
GET /api/campaign/:id/view[?account=<profileId>]
Authorization: Bearer <token>          ← standard engine auth (authMiddleware)
→ 200  Content-Type: multipart/x-mixed-replace; boundary=ortusframe   (JPEG frames via CDP)
→ 404  application/json { error: "no active session" }                (idle / not running)
```

The app fetches this **server-side with the Bearer header** and pipes it to a same-origin `<img>`. **No `?token=` / view-token scheme is needed** (that idea is dropped — the app already solved auth). `?account=` is optional; v1 streams the active session and ignores it.

## Global Constraints

- **Cloud campaigns only; per-campaign, this card only.** Every endpoint is keyed on `campaignId`.
- **Honor the reap discipline.** Registry `unregister` + Redis `DEL` happen in the SAME `finally` that already reaps the session. A screencast `stop()` is best-effort and MUST NOT block or delay the reap. Nothing may keep a browser alive to be watched.
- **Redis key:** `cmp:live:<campaignId>` → JSON `{ podIP, podPort, account, startedAt }`, TTL 30s, refreshed on a 10s heartbeat while a session is open; `DEL` on unregister. Namespaced `cmp:*` (never touch `sn:*`).
- **MJPEG contract:** `Content-Type: multipart/x-mixed-replace; boundary=ortusframe`, `X-Accel-Buffering: no`, each frame `--ortusframe\r\nContent-Type: image/jpeg\r\nContent-Length: <n>\r\n\r\n<bytes>\r\n`. Identical to `server.js` scrape View.
- **Screencast params:** jpeg, quality 50, maxWidth 1280, maxHeight 800, everyNthFrame 1 (match `scraper.js:startScreencast`).
- **404 body:** exactly `{ error: "no active session" }` (the app's spec).
- **Integration-only (flag, do not fake-pass):** the Puppeteer screencast, the worker MJPEG route end-to-end, and the frontend→worker cross-pod proxy hop need a real browser + PG/Redis + two pods. First exercise is prod, same as the scrape View. Pure-test everything else.

---

## File Structure

**Engine (`ortus-salesnav-scraper-cloud`):**
- Create `campaign-live-registry.js` — in-process session registry + Redis live-stamp (redis injected; pure logic).
- Create `campaign-screencast.js` — `campaignScreencast(page, onFrame, opts)` Puppeteer CDP screencast helper.
- Modify `campaign-runtime.js` — inject `d.liveRegistry`; register on session open + unregister in the reap `finally` at the 3 watchable sites (send loop, monitor, reply).
- Modify `campaign-main.js` — construct the registry, pass into `buildRuntime`, add the worker MJPEG route + heartbeat.
- Modify `campaign-api.js` — add the frontend `GET /api/campaign/:id/view` proxy (Redis lookup → worker) AND fold `live`/`liveAccount` into `list` + `:id`.
- Tests: `test-campaign-live-registry.js`, `test-campaign-live-wiring.js`, `test-campaign-view-route.js`.

**App (`ortus-gologin-clone`) — follow-on, after the engine endpoint works:**
- Modify `public/js/app.js` — add the "👁 Show" button to card #2 (`_adaptActiveCardControls`, `#active-card` dock) and the "● LIVE" dot to both cards (driven by the folded `live` flag surfaced through the cloud-status mapping).

---

## Task 1: Live-session registry (`campaign-live-registry.js`)

**Files:**
- Create: `campaign-live-registry.js`
- Test: `test-campaign-live-registry.js`

**Interfaces:**
- Produces: `makeLiveRegistry({ redis, podIP, podPort, ttlSec = 30 }) → { register(campaignId, account, page), unregister(campaignId, account), get(campaignId), startHeartbeat(intervalMs=10000), stopHeartbeat() }`.
  - `register` stores `{ account, page, startedAt }` in an in-process `Map` keyed by `campaignId` (last writer wins = most-recently-active account) AND writes Redis `cmp:live:<campaignId>` = JSON `{podIP,podPort,account,startedAt}` with `EX ttlSec` (best-effort; a redis failure never throws).
  - `unregister` deletes the map entry only if the account still owns the slot (a newer account may have replaced it) AND `DEL`s the Redis key when the entry is actually removed.
  - `get(campaignId)` → the in-process `{ account, page, startedAt }` or `null`.
  - `startHeartbeat` re-`EX`es every live key's TTL on an interval; `stopHeartbeat` clears it.

- [ ] **Step 1: Write the failing test**

```js
// test-campaign-live-registry.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeLiveRegistry } = require("./campaign-live-registry.js");

function fakeRedis() {
  const store = new Map(); const calls = [];
  return {
    store, calls,
    async set(k, v, ex, n) { calls.push(["set", k, v, ex, n]); store.set(k, v); return "OK"; },
    async del(k) { calls.push(["del", k]); return store.delete(k) ? 1 : 0; },
    async expire(k, n) { calls.push(["expire", k, n]); return store.has(k) ? 1 : 0; },
  };
}
const PAGE = { _fake: "page" };

test("register stores in-process + stamps redis with TTL", async () => {
  const r = fakeRedis();
  const reg = makeLiveRegistry({ redis: r, podIP: "10.0.0.9", podPort: "3000", ttlSec: 30 });
  await reg.register("cmp1", "acctA", PAGE);
  assert.equal(reg.get("cmp1").page, PAGE);
  assert.equal(reg.get("cmp1").account, "acctA");
  const setCall = r.calls.find((c) => c[0] === "set" && c[1] === "cmp:live:cmp1");
  assert.ok(setCall, "redis key stamped");
  const val = JSON.parse(setCall[2]);
  assert.equal(val.podIP, "10.0.0.9");
  assert.equal(val.account, "acctA");
  assert.equal(setCall[3], "EX");
  assert.equal(setCall[4], 30);
});

test("unregister removes in-process + DELs redis when it owns the slot", async () => {
  const r = fakeRedis();
  const reg = makeLiveRegistry({ redis: r, podIP: "10.0.0.9", podPort: "3000" });
  await reg.register("cmp1", "acctA", PAGE);
  await reg.unregister("cmp1", "acctA");
  assert.equal(reg.get("cmp1"), null);
  assert.ok(r.calls.some((c) => c[0] === "del" && c[1] === "cmp:live:cmp1"), "redis DEL");
});

test("unregister by a stale account does NOT evict a newer holder", async () => {
  const r = fakeRedis();
  const reg = makeLiveRegistry({ redis: r, podIP: "10.0.0.9", podPort: "3000" });
  await reg.register("cmp1", "acctA", PAGE);
  await reg.register("cmp1", "acctB", PAGE);
  await reg.unregister("cmp1", "acctA");
  assert.equal(reg.get("cmp1").account, "acctB", "newer holder survives");
  assert.ok(!r.calls.some((c) => c[0] === "del"), "no DEL while B still live");
});

test("redis failure in register never throws", async () => {
  const boom = { async set() { throw new Error("redis down"); }, async del() {}, async expire() {} };
  const reg = makeLiveRegistry({ redis: boom, podIP: "x", podPort: "3000" });
  await reg.register("cmp1", "acctA", PAGE);
  assert.equal(reg.get("cmp1").account, "acctA");
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `node test-campaign-live-registry.js`
Expected: FAIL — `Cannot find module './campaign-live-registry.js'`.

- [ ] **Step 3: Implement `campaign-live-registry.js`**

```js
// campaign-live-registry.js
//
// In-process registry of OPEN campaign browser sessions on THIS worker pod,
// keyed by campaignId, plus a short-TTL Redis stamp so the always-on frontend
// can discover which pod holds a campaign's live browser (cross-pod View).
// Most-recently-registered account wins per campaign (spec: "most-recently-
// active"). All Redis writes are best-effort — a hiccup must never break a
// campaign or delay a reap.
const LIVE_KEY = (id) => `cmp:live:${id}`;

function makeLiveRegistry({ redis, podIP, podPort, ttlSec = 30 }) {
  const live = new Map(); // campaignId -> { account, page, startedAt }
  let hb = null;

  async function register(campaignId, account, page) {
    const startedAt = Date.now();
    live.set(campaignId, { account, page, startedAt });
    try {
      await redis.set(LIVE_KEY(campaignId),
        JSON.stringify({ podIP, podPort: String(podPort), account, startedAt }),
        "EX", ttlSec);
    } catch (_) { /* best-effort */ }
  }

  async function unregister(campaignId, account) {
    const cur = live.get(campaignId);
    if (!cur || cur.account !== account) return; // a newer session owns it now
    live.delete(campaignId);
    try { await redis.del(LIVE_KEY(campaignId)); } catch (_) { /* best-effort */ }
  }

  function get(campaignId) { return live.get(campaignId) || null; }

  function startHeartbeat(intervalMs = 10000) {
    if (hb) return;
    hb = setInterval(() => {
      for (const id of live.keys()) redis.expire(LIVE_KEY(id), ttlSec).catch(() => {});
    }, intervalMs);
    if (hb.unref) hb.unref();
  }
  function stopHeartbeat() { if (hb) { clearInterval(hb); hb = null; } }

  return { register, unregister, get, startHeartbeat, stopHeartbeat };
}

module.exports = { makeLiveRegistry, LIVE_KEY };
```

- [ ] **Step 4: Run — verify it passes**

Run: `node test-campaign-live-registry.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add campaign-live-registry.js test-campaign-live-registry.js
git commit -m "feat(engine): campaign live-session registry (+redis stamp) for Watch-live"
```

---

## Task 2: Puppeteer screencast helper (`campaign-screencast.js`)

**Files:**
- Create: `campaign-screencast.js`
- Test: none (integration-only — real CDP/browser; flagged).

**Interfaces:**
- Produces: `async campaignScreencast(page, onFrame, { quality=50, maxWidth=1280, maxHeight=800 } = {}) → stop()`. Mirrors `scraper.js:startScreencast` but uses Puppeteer's CDP accessor `page.target().createCDPSession()`.

- [ ] **Step 1: Implement `campaign-screencast.js`**

```js
// campaign-screencast.js
//
// CDP screencast → JPEG frames for a CAMPAIGN browser page. Byte-for-byte the
// scraper's startScreencast (scraper.js) EXCEPT the CDP session accessor:
// campaigns run Puppeteer (page.target().createCDPSession()), the scraper runs
// Playwright (page.context().newCDPSession(page)). The CDP wire commands are
// identical. Returns an async stop().
async function campaignScreencast(page, onFrame, { quality = 50, maxWidth = 1280, maxHeight = 800 } = {}) {
  const noop = async () => {};
  if (!page) return noop;

  let client;
  try { client = await page.target().createCDPSession(); } // Puppeteer
  catch (_) { return noop; }

  const onFrameEvt = async ({ data, sessionId }) => {
    try { onFrame(Buffer.from(data, "base64")); } catch (_) {}
    try { await client.send("Page.screencastFrameAck", { sessionId }); } catch (_) {}
  };
  client.on("Page.screencastFrame", onFrameEvt);

  try {
    await client.send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight, everyNthFrame: 1 });
  } catch (_) {
    try { client.off("Page.screencastFrame", onFrameEvt); } catch (_) {}
    try { await client.detach(); } catch (_) {}
    return noop;
  }

  return async () => {
    try { client.off("Page.screencastFrame", onFrameEvt); } catch (_) {}
    try { await client.send("Page.stopScreencast"); } catch (_) {}
    try { await client.detach(); } catch (_) {}
  };
}

module.exports = { campaignScreencast };
```

- [ ] **Step 2: Sanity — the file loads**

Run: `node -e "require('./campaign-screencast.js'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add campaign-screencast.js
git commit -m "feat(engine): Puppeteer CDP screencast helper for campaign Watch-live"
```

---

## Task 3: Wire the registry into the runtime (`campaign-runtime.js`)

**Files:**
- Modify: `campaign-runtime.js` — the `buildRuntime` deps default (add `liveRegistry`), and the 3 session sites: send loop (~L162–173), `handleMonitor` (~L252–289), `handleReply` (~L376–396).
- Test: `test-campaign-live-wiring.js`.

**Interfaces:**
- Consumes: `makeLiveRegistry(...)` (Task 1) as `deps.liveRegistry`.
- Contract at each site: right after `session = await d.openSession(account, campaign)`, call `d.liveRegistry.register(campaign.id, account, session.page)`; in the existing `finally`, before the reap, call `d.liveRegistry.unregister(campaign.id, account)`. A no-op default keeps existing tests + non-worker callers working.

**Scope note:** Only the 3 long-lived, watchable phases register (send, monitor, reply). The brief `withAccountSession` accept/follow-up opens are NOT registered in v1 (they flash too briefly to watch).

- [ ] **Step 1: Add a no-op default registry to the deps**

In `buildRuntime`'s `d = { ... }` default block add:

```js
    // Live-session registry for Watch-live. Default = no-op so tests and any
    // non-worker caller need no browser/redis. Production injects makeLiveRegistry.
    liveRegistry: { register: async () => {}, unregister: async () => {}, get: () => null },
```

- [ ] **Step 2: Write the failing test**

```js
// test-campaign-live-wiring.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildRuntime } = require("./campaign-runtime.js");

function fakeRegistry() {
  const events = [];
  return { events,
    register: async (id, acct) => events.push(["reg", id, acct]),
    unregister: async (id, acct) => events.push(["unreg", id, acct]),
    get: () => null };
}

function harness(reg, { throwInSweep = false } = {}) {
  const campaign = { id: "cmp1", mode: "connect_and_introduce", profile_ids: ["acctA"],
    status: "monitoring", monitoring_until: new Date(Date.now() + 3600e3).toISOString(),
    auto_checks_enabled: true, check_interval_minutes: 60, config: {} };
  const store = {
    getCampaign: async () => campaign,
    acquireAccount: async () => true, releaseAccount: async () => {},
    getAllConnections: async () => [], getCampaignLeads: async () => [],
    upsertConnections: async () => {}, leadStatusCounts: async () => ({}),
    setMonitorState: async () => {}, getLeadsNeedingSheetSync: async () => [],
    markLeadsSheetSynced: async () => {},
  };
  const page = { _fake: "page" };
  const deps = {
    liveRegistry: reg,
    openSession: async () => ({ page, close: async () => {} }),
    fetchRecent: async () => { if (throwInSweep) throw new Error("boom"); return []; },
    syncSheet: async () => {}, prepareSheet: async () => ({ ok: true }),
    now: () => new Date(), log: () => {},
  };
  return { store, deps };
}

test("handleMonitor registers on open and unregisters on reap", async () => {
  const reg = fakeRegistry();
  const { store, deps } = harness(reg);
  const rt = buildRuntime({ store, deps });
  await rt.handleMonitor({ campaign_id: "cmp1" });
  assert.deepEqual(reg.events[0], ["reg", "cmp1", "acctA"]);
  assert.deepEqual(reg.events[reg.events.length - 1], ["unreg", "cmp1", "acctA"]);
});

test("unregister still fires when the sweep throws", async () => {
  const reg = fakeRegistry();
  const { store, deps } = harness(reg, { throwInSweep: true });
  const rt = buildRuntime({ store, deps });
  await rt.handleMonitor({ campaign_id: "cmp1" });
  assert.ok(reg.events.some((e) => e[0] === "reg"));
  assert.ok(reg.events.some((e) => e[0] === "unreg"), "reap-path unregister");
});
```

- [ ] **Step 2b: Run — verify it fails**

Run: `node test-campaign-live-wiring.js`
Expected: FAIL — registry events empty (wiring not added). (`buildRuntime` returns `handleMonitor` at `campaign-runtime.js:460` — confirmed.)

- [ ] **Step 3: Wire the 3 sites**

At the **send loop** (~L164), the **monitor** (~L254), and the **reply** (~L378), immediately after `session = await d.openSession(...)` add:

```js
        try { await d.liveRegistry.register(campaign.id, account, session.page); } catch (_) {}
```

In each corresponding `finally` (L172 / L288 / L395), add BEFORE the `session.close()` line:

```js
        try { await d.liveRegistry.unregister(campaign.id, account); } catch (_) {}
```

(Order in the finally: unregister → close → releaseAccount. Register never blocks the task; unregister never blocks the reap.)

- [ ] **Step 4: Run — verify it passes**

Run: `node test-campaign-live-wiring.js && node test-campaign-runtime.js`
Expected: PASS (new wiring test) and the existing runtime test still PASS.

- [ ] **Step 5: Commit**

```bash
git add campaign-runtime.js test-campaign-live-wiring.js
git commit -m "feat(engine): register/unregister campaign sessions in live registry (reap-safe)"
```

---

## Task 4: Worker MJPEG route + heartbeat (`campaign-main.js`)

**Files:**
- Modify: `campaign-main.js` — build the registry, inject into `buildRuntime`, start heartbeat, add the view route to the existing `http.createServer`, stop heartbeat on shutdown.

**Interfaces:**
- Consumes: `makeLiveRegistry` (Task 1), `campaignScreencast` (Task 2).
- Serves (worker, cluster-internal only): `GET /api/campaign/:id/view?internal=1` → MJPEG from `registry.get(id).page`; `404 {error:"no active session"}` if no live session on this pod.

- [ ] **Step 1: Build + inject the registry**

Replace the `const runtime = buildRuntime({ store, deps: {...} });` block with:

```js
  const { makeLiveRegistry } = require("./campaign-live-registry");
  const liveRegistry = makeLiveRegistry({
    redis: store.redis,
    podIP: process.env.POD_IP || "",
    podPort: String(process.env.PORT || 3000),
  });
  liveRegistry.startHeartbeat();

  const runtime = buildRuntime({
    store,
    deps: { tickMs: Number(process.env.SCHEDULER_TICK_MS || 5000), liveRegistry },
  });
```

- [ ] **Step 2: Add the view route to the worker HTTP server**

Replace the `http.createServer(...)` block with:

```js
  const { campaignScreencast } = require("./campaign-screencast");
  const port = Number(process.env.PORT || 3000);
  http.createServer(async (req, res) => {
    if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }

    const m = req.url.match(/^\/api\/campaign\/([^/]+)\/view(?:\?|$)/);
    if (m) {
      const u = new URL(req.url, "http://x");
      if (u.searchParams.get("internal") !== "1") { res.writeHead(401); res.end("unauthorized"); return; }
      const id = decodeURIComponent(m[1]);
      const sess = liveRegistry.get(id);
      if (!sess || !sess.page) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no active session" }));
        return;
      }
      const boundary = "ortusframe";
      res.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no",
      });
      let open = true;
      const writeFrame = (buf) => {
        if (!open) return;
        try {
          res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
          res.write(buf); res.write("\r\n");
        } catch (_) {}
      };
      const stop = await campaignScreencast(sess.page, writeFrame);
      const cleanup = () => { if (!open) return; open = false; Promise.resolve().then(stop).catch(() => {}); try { res.end(); } catch (_) {} };
      req.on("close", cleanup); res.on("error", cleanup);
      return;
    }

    res.writeHead(404); res.end();
  }).listen(port, () => console.log(`[campaign-main] http on :${port} (healthz + live view)`));
```

- [ ] **Step 3: Stop the heartbeat on shutdown**

In `shutdown()` after `runtime.stop();` add: `liveRegistry.stopHeartbeat();`

- [ ] **Step 4: Sanity**

Run: `node --check campaign-main.js`
Expected: valid (no output).

- [ ] **Step 5: Commit**

```bash
git add campaign-main.js
git commit -m "feat(engine): worker serves campaign live MJPEG + registry heartbeat"
```

---

## Task 5: Frontend view proxy + live flag (`campaign-api.js`)

**Files:**
- Modify: `campaign-api.js` — add `GET /api/campaign/:id/view` (proxy) inside `mountCampaignApi`; fold `live`/`liveAccount` into `GET /api/campaign/list` (~L88) + `GET /api/campaign/:id` (~L104).
- Test: `test-campaign-view-route.js`.

**Interfaces:**
- Produces:
  - `GET /api/campaign/:id/view` (Bearer via the existing `authMiddleware` that guards `/api`): read `cmp:live:<id>` → if a stamp with `podIP` exists, **proxy** the MJPEG to `http://<podIP>:<podPort>/api/campaign/:id/view?internal=1`; else `404 {error:"no active session"}`.
  - `list` items + `:id` response gain `live: bool` and `liveAccount: string`.
- Consumes: `store.redis`, node `http` (require at top of file).

- [ ] **Step 1: Write the failing tests**

```js
// test-campaign-view-route.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mountCampaignApi } = require("./campaign-api.js");

function fakeApp() {
  const routes = {};
  const reg = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return { get: reg("GET"), post: reg("POST"), routes };
}
function fakeRes() {
  return { code: 200, headers: null, ended: false,
    status(c){ this.code=c; return this; }, json(b){ this.body=b; return this; },
    writeHead(c,h){ this.code=c; this.headers=h; return this; }, end(){ this.ended=true; } };
}
function storeWith(liveKeys) {
  return {
    redis: { async get(k){ return liveKeys[k] || null; } },
    pg: { async query(){ return { rows: [
      { id: "cmp1", name: "A", status: "running" },
      { id: "cmp2", name: "B", status: "monitoring" }] }; } },
    getCampaign: async (id) => ({ id, name: "A", status: "running" }),
    leadStatusCounts: async () => ({ sent: 3 }),
  };
}

test("list folds live flag from cmp:live:<id>", async () => {
  const app = fakeApp();
  mountCampaignApi(app, storeWith({ "cmp:live:cmp1": JSON.stringify({ account: "acctA", podIP: "10.0.0.9" }) }));
  const res = fakeRes();
  await app.routes["GET /api/campaign/list"]({ query: {} }, res);
  const byId = Object.fromEntries(res.body.campaigns.map((c) => [c.id, c]));
  assert.equal(byId.cmp1.live, true);
  assert.equal(byId.cmp1.liveAccount, "acctA");
  assert.equal(byId.cmp2.live, false);
});

test(":id folds live flag", async () => {
  const app = fakeApp();
  mountCampaignApi(app, storeWith({ "cmp:live:cmp1": JSON.stringify({ account: "acctA", podIP: "10.0.0.9" }) }));
  const res = fakeRes();
  await app.routes["GET /api/campaign/:id"]({ params: { id: "cmp1" }, query: {} }, res);
  assert.equal(res.body.live, true);
  assert.equal(res.body.liveAccount, "acctA");
});

test("view: 404 no active session when no stamp", async () => {
  const app = fakeApp();
  mountCampaignApi(app, storeWith({}));
  const res = fakeRes();
  await app.routes["GET /api/campaign/:id/view"]({ params: { id: "cmp1" }, query: {}, on(){} }, res);
  assert.equal(res.code, 404);
  assert.deepEqual(res.body, { error: "no active session" });
});

test("view: proxies when a live stamp with podIP exists", async () => {
  const app = fakeApp();
  const proxied = [];
  mountCampaignApi(app, storeWith({ "cmp:live:cmp1": JSON.stringify({ account: "a", podIP: "10.0.0.9", podPort: 3000 }) }),
    { proxyStream: (target, _req, _res) => { proxied.push(target); } });
  const res = fakeRes();
  await app.routes["GET /api/campaign/:id/view"]({ params: { id: "cmp1" }, query: {}, on(){} }, res);
  assert.equal(proxied.length, 1);
  assert.match(proxied[0], /^http:\/\/10\.0\.0\.9:3000\/api\/campaign\/cmp1\/view\?internal=1$/);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `node test-campaign-view-route.js`
Expected: FAIL — `live` undefined / `GET /api/campaign/:id/view` route missing.

- [ ] **Step 3: Implement — top-of-file require, live helper, folds, and the proxy route**

At the top of `campaign-api.js` add: `const http = require("http");`

In `mountCampaignApi(app, store, opts = {})`, after `need`, add the live helper + an injectable proxy (so the route is unit-testable):

```js
  const proxyStream = (opts && opts.proxyStream) || ((target, req, res) => {
    const upstream = http.get(target, (up) => { res.writeHead(up.statusCode || 200, up.headers); up.pipe(res); });
    upstream.on("error", () => { try { res.status(502).json({ error: "View proxy failed" }); } catch (_) {} });
    req.on("close", () => upstream.destroy());
  });
  const liveOf = async (id) => {
    try {
      const raw = await store.redis.get(`cmp:live:${id}`);
      if (!raw) return { live: false, liveAccount: "", _stamp: null };
      const v = JSON.parse(raw);
      return { live: true, liveAccount: v.account || "", _stamp: v };
    } catch (_) { return { live: false, liveAccount: "", _stamp: null }; }
  };
```

In `GET /api/campaign/list`, replace `res.json({ campaigns: rows });` with:

```js
      const withLive = await Promise.all(rows.map(async (r) => {
        const lv = await liveOf(r.id); return { ...r, live: lv.live, liveAccount: lv.liveAccount };
      }));
      res.json({ campaigns: withLive });
```

In `GET /api/campaign/:id`, replace `res.json({ campaign: c, leadCounts: counts });` with:

```js
      const lv = await liveOf(req.params.id);
      res.json({ campaign: c, leadCounts: counts, live: lv.live, liveAccount: lv.liveAccount });
```

Add the view route (alongside the other `app.get("/api/campaign/...")` routes):

```js
  // Live MJPEG screencast of the campaign's active browser (spec:
  // ortus-gologin-clone/docs/cloud-engine-campaign-view-spec.md). The browser
  // runs on a worker pod; find it via cmp:live:<id> and proxy to that pod
  // (mirrors the scrape View cross-pod path). 404 when idle/not running.
  app.get("/api/campaign/:id/view", async (req, res) => {
    if (need(res)) return;
    const lv = await liveOf(req.params.id);
    if (!lv.live || !lv._stamp || !lv._stamp.podIP) {
      return res.status(404).json({ error: "no active session" });
    }
    const podPort = String(lv._stamp.podPort || "3000");
    const target = `http://${lv._stamp.podIP}:${podPort}/api/campaign/${encodeURIComponent(req.params.id)}/view?internal=1`;
    proxyStream(target, req, res);
  });
```

- [ ] **Step 4: Run — verify it passes**

Run: `node test-campaign-view-route.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add campaign-api.js test-campaign-view-route.js
git commit -m "feat(engine): GET /api/campaign/:id/view proxy + live flag in status (contract complete)"
```

---

## Task 6: Deploy the engine + verify the contract

**Files:** `k8s/03-deployment.yaml`, `k8s/21-campaign-worker.yaml` (image bump).

- [ ] **Step 1:** Run the full pure suite: `for f in test-campaign-live-registry.js test-campaign-live-wiring.js test-campaign-view-route.js test-campaign-runtime.js; do node "$f" || exit 1; done` → all PASS.
- [ ] **Step 2:** Bump both manifests `v48` → `v49`.
- [ ] **Step 3:** Build: `gcloud builds submit --config cloudbuild.yaml --substitutions=_TAG=v49 --project=salesnav-scraper-prod .` (needs `info@ortus.solutions`; `rm ~/.kube/gke_gcloud_auth_plugin_cache` after any auth switch). **Prod `kubectl apply` is user-gated — ask before deploying.**
- [ ] **Step 4:** `kubectl apply` both + `rollout status`; verify pods v49 Running/0-restarts; worker logs `http on :3000 (healthz + live view)`.
- [ ] **Step 5 (integration acceptance — the contract's own test):** start a cloud campaign; while it is sending, click **👁 Show** on its card-#1 strip in the app. Expect live video of the sending browser; a clean "no active session" (not the SPA-fallback message) when idle. This is the first real exercise of the screencast + cross-pod hop.

---

## Task 7 (APP, follow-on): "👁 Show" on card #2 + LIVE dot on both cards

**Repo:** `ortus-gologin-clone`. Do this AFTER Task 6 proves the engine endpoint streams (so the button isn't wired to a dead route).

**Files:**
- Modify: `public/js/app.js` — `_adaptActiveCardControls` (~L6072) for the card-#2 dock button; `renderUnifiedStrip` (~L6915) + `renderCloudStrip` (~L5933) for the LIVE dot; the cloud-status mappers that build the strip `it` and `_buildCloudActiveStatus` (~L6026) to surface `live`.

**Interfaces:**
- Consumes (from the engine, Task 5): `list`/`:id` responses now carry `live` + `liveAccount`. The app's cloud pollers already call `listCloudCampaigns`/`getCloudCampaign`; surface `live` into the strip item `it.live` and into the card-#2 status object.
- Reuses existing: `openCloudCampaignView(id, label)` (`app.js:3001`) — the viewer. Do NOT rebuild it.

- [ ] **Step 1: Card #2 button — inject a `👁 Show` dock button.**
  In `_adaptActiveCardControls(card, status)` (~L6072), where it injects `#dock-cloud-checknow`, add a sibling `#dock-cloud-show` (only when `status && status._cloud`), mirroring that block:

```js
  let sh = dock.querySelector('#dock-cloud-show');
  if (status && status._cloud) {
    if (!sh) {
      sh = document.createElement('button');
      sh.id = 'dock-cloud-show';
      sh.className = 'dock-btn';
      sh.setAttribute('data-tip', 'Show live'); sh.setAttribute('aria-label', 'Show live');
      sh.innerHTML = '👁';
      dock.insertBefore(sh, dock.firstChild);
      const _lbl = String(status.name || status.id || '').replace(/['"\\<>]/g, '');
      sh.onclick = () => { try { openCloudCampaignView(String(status.id), _lbl); } catch (_) {} };
    }
    sh.classList.toggle('live-on', !!status.live); // green dot styling when live
  } else if (sh) { sh.remove(); }
```

- [ ] **Step 2: LIVE dot on card #1.**
  In `renderUnifiedStrip(it)` where the running-cloud `👁 Show` button is built (~L6919), append a live-dot span driven by `it.live`, e.g. change the button label to include `${it.live ? '<span class="live-dot"></span>' : ''}👁 Show`. Add a `.live-dot` CSS rule (small green pulsing circle) near the strip styles.

- [ ] **Step 3: Surface `live` in the cloud mappers.**
  Where the strip item `it` is built from `listCloudCampaigns` results, copy `live`/`liveAccount` from the engine row onto `it`. In `_buildCloudActiveStatus(c, leads, counts)` (~L6026), add `live: !!c.live, liveAccount: c.liveAccount || ''` to the returned status object (source: `getCloudCampaign` response top-level `live`).

- [ ] **Step 4: Manual verification (no unit harness for the renderer).**
  With the engine on v49 and a cloud campaign sending: (a) the card-#1 strip button shows a green dot while a browser is live; (b) open the campaign tab (card #2) — a `👁` dock button appears and opens the live viewer; (c) both stop cleanly when the campaign goes idle (dot off, viewer shows the engine's 404 handled by the existing fallback).

- [ ] **Step 5: Version-bump + commit (app release process).**
  Patch-bump `package.json` + both `index.html ?v=`; commit on a branch (per the app's release rules). Do NOT `git add -A`.

---

## Self-review notes

- **Spec coverage:** engine `GET /api/campaign/:id/view` (T1–T5), `live` flag for the dot (T5), card-#2 button + dot (T7). The viewer/client/card-#1 button already exist (app v2.154.0) — intentionally not rebuilt.
- **Dropped from the original design:** the view-token endpoint (the app proxies server-side with Bearer — no `<img>` token needed).
- **Type consistency:** `live`/`liveAccount` names identical across engine responses (T5) and app consumption (T7); `cmp:live:<id>` stamp shape `{podIP,podPort,account,startedAt}` identical across registry (T1), worker (T4), and frontend (T5).
- **Integration flag:** the screencast, worker route, and cross-pod proxy are only exercisable in prod (T6 Step 5 is the acceptance test) — called out, not fake-passed.
