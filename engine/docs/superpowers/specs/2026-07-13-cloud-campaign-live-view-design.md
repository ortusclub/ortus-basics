# Cloud Campaign "Watch Live" — Design

> **CORRECTION (post-design discovery):** the app (`ortus-gologin-clone`, v2.154.0) **already
> ships the client half** — client `openCampaignViewStream` (`src/campaigns-client.js:226`), server
> proxy `/api/campaign/cloud/:id/view`, viewer overlay `openCloudCampaignView` (`app.js:3001`), and
> the card-#1 "👁 Show" button — plus a handoff contract for the engine
> (`ortus-gologin-clone/docs/cloud-engine-campaign-view-spec.md`). The real missing piece is the
> engine endpoint **`GET /api/campaign/:id/view`** (Bearer-authed, MJPEG). Two design changes follow:
> (1) the **view-token endpoint is DROPPED** — the app already fetches server-side with the Bearer
> header, so no `<img>` token is needed; (2) the engine route is **`/api/campaign/:id/view`** (not
> `/api/campaign/view/:id`). Remaining app work is only the **card-#2 button** and the **LIVE dot**.
> The actionable plan is `docs/superpowers/plans/2026-07-13-cloud-campaign-live-view.md`.

**Date:** 2026-07-13
**Repos:** `ortus-salesnav-scraper-cloud` (engine — most of the work) + `ortus-gologin-clone` (app — the button + viewer)
**Status:** approved design, pending spec review → implementation plan

## Goal

Add a "👁 Watch live" button to the app's two campaign status cards — the **#1 dashboard
strip** and the **#2 campaign-tab card** (`#active-card` via `renderActiveCard`) — that streams
the live browser of **that card's own cloud campaign**, working exactly like the Sales Nav
scraper's per-job `👁 View` button (`ortus-salesnav-scraper-cloud/public/index.html` →
`viewJob()` → engine `GET /api/scrape/view/:jobId`, a CDP `Page.startScreencast` MJPEG stream an
`<img>` renders as native live video).

## Scope (locked with the user)

- **Cloud campaigns only.** Local campaigns (running in the app's own Electron browser) are out
  of scope — they can already be watched on the operator's own screen, and their plumbing is
  entirely different.
- **Per-campaign, this card only.** A card's button streams ONLY that card's campaign
  (keyed by `campaignId`) — never another operator's campaign, never another campaign, never an
  aggregate. Enforced structurally by keying every endpoint on the card's `campaignId`.
- **Opportunistic / live-while-working.** Cloud-campaign browsers are ephemeral and per-account:
  the worker opens a browser for an account only while it is actively sending or running an
  acceptance sweep, then **reaps it** (the reap is load-bearing — a leaked browser pegs CPU;
  Steven's v46 fix). Nothing may keep a browser alive just to be watched. So:
  - Mid-send / mid-sweep → live video of the account browser in use.
  - Between tasks (waiting a turn, or between hourly sweeps) → an idle message, because there is
    no browser open to stream.
  - With `CAMPAIGN_CONCURRENCY` (default 2, per worker pod) capping simultaneous browsers, several
    "running" campaigns will commonly be idle-between-tasks when clicked. This is expected and
    communicated in the UI copy.
- **Multi-account default:** stream the campaign's **most-recently-active** session (whatever the
  live registry currently holds for that campaign). No account picker in v1 (YAGNI); easy to add.

## Approach (chosen: B — reuse the proven pipeline, campaign-flavored)

The scraper's View is battle-tested (CDP screencast + MJPEG framing + cross-pod proxy). We reuse
that **pattern and command sequence** rather than inventing new streaming. It is not a literal
reuse of `/api/scrape/view/:jobId` because:

1. Campaigns run **Puppeteer** (`page.target().createCDPSession()`); the scraper runs **Playwright**
   (`page.context().newCDPSession()`). The CDP wire commands
   (`Page.startScreencast` / `Page.screencastFrameAck` / `Page.screencastFrame` /
   `Page.stopScreencast`) are identical, so the helper is a ~30-line Puppeteer-flavored copy of
   `scraper.js:startScreencast`.
2. The campaign **browser lives in the separate `campaign-worker` pod**, whose process
   (`campaign-main.js`) currently serves only `/healthz`. The public API the app reaches is on the
   `salesnav-scraper` (frontend) pod. So — exactly like the scraper's cross-pod View — the worker
   serves the stream locally and the frontend proxies to it by pod IP.

## Components

### Worker (`campaign-worker` pod)

1. **Live-session registry** — new `campaign-live-registry.js`. In-process
   `Map campaignId → { account, page, startedAt }`.
   - `register(campaignId, account, page)` — called where the runtime opens a session
     (`handleMonitor`, the send loop, `handleReply` — every place `d.openSession` yields a page).
   - `unregister(campaignId, account)` — called in the **same reap `finally`** that already closes
     the session, so a viewer can never extend a browser's life.
   - On register, stamp Redis `cmp:live:<campaignId>` = `{ podIP, podPort, account, startedAt }`
     with a short TTL, refreshed on a heartbeat while the session is open; `DEL` on unregister.
     This is how the frontend discovers which pod holds the live browser (and whether one exists).
     On concurrent multi-account sessions for one campaign, last-writer wins (most-recently-active).

2. **Screencast helper** — `campaignScreencast(page, onFrame, opts)`: Puppeteer CDP session +
   `Page.startScreencast` (jpeg, quality ~50, maxWidth 1280, maxHeight 800, ack each frame),
   returns `stop()` that detaches + `Page.stopScreencast`. Mirrors `scraper.js:startScreencast`.

3. **HTTP route** on the worker's existing server (`campaign-main.js`):
   `GET /api/campaign/view/:id?internal=1` → registry lookup → if found, MJPEG stream
   (`multipart/x-mixed-replace; boundary=ortusframe`, `X-Accel-Buffering: no`, boundary framing
   copied from `server.js`); if not, `404`. Reachable **only cluster-internally**; the internal hop
   from the frontend carries the shared token (or `?internal=1` on the trusted cluster network).
   `req.on('close')` stops the screencast.

### Frontend (`salesnav-scraper` pod, `server.js`, behind existing `authMiddleware`)

4. `GET /api/campaign/view/:id` → read `cmp:live:<id>` from Redis.
   - Live → **proxy** the MJPEG to `http://<podIP>:<podPort>/api/campaign/view/:id?internal=1`
     (the exact cross-pod pattern the scrape View already uses: pipe upstream response, destroy on
     client close).
   - Not live → `404 { error: "No live session" }`.
5. **Live flag folded into the existing status responses** (v1, IN scope). Add
   `live: bool` (+ `liveAccount`) to `GET /api/campaign/list` and `GET /api/campaign/:id`, read from
   `cmp:live:<id>` in Redis (no worker hop). The app already polls campaign status on a cadence, so
   the green "● LIVE" dot updates for free — **no new per-card poller, no extra request**. (A
   standalone `GET /api/campaign/:id/live` is intentionally NOT added; folding avoids a second poll.)
6. `POST /api/campaign/:id/view-token` → mint a short-lived Web-UI session token via the existing
   `generateToken()` (stored in the queue backend, valid on every pod). Returned to the app for the
   `<img>` `?token=`. Rationale: `<img>` cannot send the app's `Authorization: Bearer` header, and
   putting the long-lived shared secret in a URL is undesirable — a short-lived minted token is the
   safe carrier (the scraper already uses a session token in the `?token=` query).

### App (`ortus-gologin-clone`)

7. **Button + LIVE dot** — "👁 Watch live" on both cards, rendered **only for cloud campaigns** whose
   status is `running`/`monitoring`. Same button component/styling on the #1 dashboard strip and the
   #2 `#active-card` (per `feedback_two_live_status_cards`, do not conflate the two cards — add to
   each in its own render path: the strip's renderer and `renderActiveCard`). A green **"● LIVE"**
   dot on the button lights up when the campaign's status payload carries `live: true` (driven by the
   existing status poll — component 5), and is dim/absent otherwise, so the operator knows whether
   there's anything to watch **before** clicking. Clicking while dim still opens the viewer and shows
   the idle copy (the dot is a hint, not a hard gate).
8. **Viewer overlay** — ported from `viewJob()` / `closeJobViewer()`: full-screen overlay with an
   `<img id="cvImg">`, a "👁 Live · <campaign name>" label, a status line, and ✕ Close. On open:
   `POST /api/campaign/:id/view-token` → set
   `img.src = <engineBaseUrl>/api/campaign/view/<id>?token=<viewToken>`. On close: clear `src`
   (aborts the MJPEG → worker stops the screencast) and remove the overlay. One viewer at a time.
   The engine base URL comes from the app's existing engine-URL resolver
   (`scraper-engine-url.js` equivalent) — the same base the app already uses for
   `listCloudCampaigns`/`getCloudCampaign`.
9. **Idle / end copy**:
   - 404 on open → *"No account is live right now — a browser appears here during sends and
     acceptance checks."*
   - `img.onerror` mid-stream (session reaped while watching) → *"Stream ended — the account
     finished its task."*

## Data flow

```
app card "Watch live" click
  → POST /api/campaign/:id/view-token           (frontend, Bearer)   → { token }
  → <img src=…/api/campaign/view/:id?token=…>    (frontend)
      → read cmp:live:<id> from Redis
        · live → proxy MJPEG → worker /api/campaign/view/:id?internal=1
                                  → registry.get(id) → campaignScreencast(page) → frames
        · idle → 404 → viewer shows idle copy
  → <img> renders live video; frames flow until the operator closes (src='') or the session is reaped
```

## Error handling

- **No live session** → 404 → idle copy (not an error state).
- **Session reaped mid-view** → upstream ends → `<img>.onerror` → "stream ended" copy.
- **Worker pod gone / proxy fails** → frontend returns 502; viewer shows the same "stream ended"
  copy (best-effort, never throws into the request).
- **Registry/reap invariant:** `unregister` + Redis `DEL` live in the same `finally` as the reap;
  a screencast `stop()` is best-effort and never blocks the reap. A viewer holding the stream open
  does NOT hold the browser — the worker's task lifecycle owns the browser; when the task ends the
  browser is reaped and the stream drops.

## Testing

- **Pure unit (no PG/Redis/browser):**
  - `campaign-live-registry.js` — register/unregister, most-recent-active resolution, Redis stamp +
    DEL with a fake redis, TTL heartbeat scheduling. `test-campaign-live-registry.js`.
  - Frontend `GET /api/campaign/view/:id` branch — live (proxy invoked) vs idle (404) with a fake
    store/redis and a stubbed proxy. `test-campaign-view-route.js`.
  - `live` flag folded into `GET /api/campaign/list` + `/:id` — reflects `cmp:live:<id>` present vs
    absent (fake redis). Same test file.
  - `view-token` mint → returns a token that `hasToken` accepts (fake queue backend).
- **Integration (untestable locally — flag; first exercise is prod, same as the scrape View):**
  - `campaignScreencast` on a real Puppeteer page (CDP), the cross-pod proxy hop, the end-to-end
    `<img>` stream. Verify on a live cloud campaign during an active send window.

## Out of scope (v1)

- Account picker / multi-feed grid (per-campaign single most-recent stream only).
- Local-campaign live view.
- Recording / history.

## Open risks

- **Idle-heavy UX:** with concurrency-capped, cadenced tasks, clicking a specific campaign often
  catches it idle. Mitigated in v1 by the green "● LIVE" dot (components 5 + 7), which shows whether
  there's anything to watch before clicking; the viewer's idle copy handles the click-anyway case.
- **Worker as an internally-served HTTP target:** the worker already listens on `PORT` for
  `/healthz`; adding one route is low-risk, but the pod must expose that port to the frontend pod
  (cluster networking — verify the pod IP:port is reachable pod-to-pod; the scrape View relies on
  the identical assumption and works).
