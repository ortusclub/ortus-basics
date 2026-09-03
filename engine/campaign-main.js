// campaign-main.js
//
// Process entrypoint for ROLE=campaign-worker pods (Phase H). One deployment,
// all campaign modes: boots the store (Postgres + Redis), runs the schema
// migration idempotently, then starts the runtime — scheduler (monitor /
// follow_up / accept tasks) + the campaign poll (send phases, FG batches).
//
// Env:
//   PG_URL / DATABASE_URL   Postgres connection string          (required)
//   REDIS_URL/REDIS_ADDRESS Redis (same instance as the scraper) (required)
//   CAMPAIGN_POLL_MS        how often to look for campaign work  (default 15s)
//   SCHEDULER_TICK_MS       task-claim tick                      (default 5s)
//
// Health: exposes GET /healthz on PORT (default 3000) for the K8s probes.

require("dotenv").config();
const http = require("http");
const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { buildRuntime } = require("./campaign-runtime");

const PG_URL = process.env.PG_URL || process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ||
  (process.env.REDIS_ADDRESS ? `redis://${process.env.REDIS_ADDRESS}` : "redis://127.0.0.1:6379");
if (!PG_URL) { console.error("[campaign-main] PG_URL / DATABASE_URL is required"); process.exit(1); }

(async () => {
  const podId = process.env.POD_NAME || process.env.HOSTNAME || "campaign-pod";
  const store = new CampaignStore({
    pgUrl: PG_URL,
    redis: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
    podId,
  });
  await store.migrate();
  console.log(`[campaign-main] store ready (pod=${podId})`);

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
  runtime.start({ campaignPollMs: Number(process.env.CAMPAIGN_POLL_MS || 15000) });

  // K8s liveness/readiness + cluster-internal live-view MJPEG stream.
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

  // Graceful shutdown: stop claiming new work, let in-flight turns finish.
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[campaign-main] ${sig} — draining`);
    runtime.stop();
    liveRegistry.stopHeartbeat();
    setTimeout(async () => {
      try { await store.close(); store.redis.disconnect(); } catch {}
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
})().catch((e) => { console.error("[campaign-main] fatal:", e); process.exit(1); });
