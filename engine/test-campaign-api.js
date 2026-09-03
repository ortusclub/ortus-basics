// test-campaign-api.js
//
// Exercises the campaign submission API over real HTTP against local Postgres:
//   1. POST /api/campaign/start → creates campaign + leads, status queued.
//   2. validation: bad mode → 400; missing profileIds → 400; missing leads → 400.
//   3. GET /api/campaign/list → the campaign appears.
//   4. GET /api/campaign/:id → campaign + leadCounts.
//   5. POST /api/campaign/:id/stop → cancelled (and ?pause=1 → paused).
//   6. store=null (no PG_URL) → every route 503.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-api.js

const express = require("express");
const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { mountCampaignApi } = require("./campaign-api");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

function serve(store) {
  const app = express();
  app.use(express.json());
  mountCampaignApi(app, store);
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}
const url = (s, p) => `http://127.0.0.1:${s.address().port}${p}`;
const post = (s, p, body) => fetch(url(s, p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const get = (s, p) => fetch(url(s, p));

(async () => {
  const store = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "api" });
  await store.migrate();
  await store.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE");
  const k = await store.redis.keys("cmp:*"); if (k.length) await store.redis.del(...k);

  const srv = await serve(store);

  // ── 1) start ──
  let r = await post(srv, "/api/campaign/start", {
    id: "api1", mode: "connect_and_message", name: "July DM", owner: "sam@ortus.club",
    profileIds: ["acctA", "acctB"], dailyLimit: 40,
    config: { ccDmBody: "Hi {first name}!" },
    leads: [
      { leadUrl: "https://linkedin.com/in/jane", memberUrn: "u1", fullName: "Jane Doe" },
      { leadUrl: "https://linkedin.com/in/bob", memberUrn: "u2", fullName: "Bob Lee" },
    ],
  });
  let j = await r.json();
  assert(r.status === 200 && j.started && j.id === "api1", "POST start → 200 started");
  assert(j.leadsAdded === 2, "2 leads added");
  const c = await store.getCampaign("api1");
  assert(c && c.status === "queued" && c.mode === "connect_and_message", "campaign persisted, status queued");
  assert(JSON.stringify(c.profile_ids) === JSON.stringify(["acctA", "acctB"]), "profileIds stored");
  assert(c.config.ccDmBody === "Hi {first name}!", "config stored");

  // ── 2) validation ──
  assert((await (await post(srv, "/api/campaign/start", { mode: "nope", profileIds: ["a"], leads: [{ leadUrl: "x" }] })).json()).error.includes("mode must be"), "bad mode → 400 error");
  assert((await post(srv, "/api/campaign/start", { mode: "connect_only", leads: [{ leadUrl: "x" }] })).status === 400, "missing profileIds → 400");
  assert((await post(srv, "/api/campaign/start", { mode: "connect_only", profileIds: ["a"] })).status === 400, "missing leads → 400");

  // ── 3) list ──
  j = await (await get(srv, "/api/campaign/list")).json();
  assert(j.campaigns.length === 1 && j.campaigns[0].id === "api1", "list returns the campaign");
  j = await (await get(srv, "/api/campaign/list?owner=nobody@x.com")).json();
  assert(j.campaigns.length === 0, "list ?owner filters");

  // ── 4) detail + progress ──
  j = await (await get(srv, "/api/campaign/api1")).json();
  assert(j.campaign.id === "api1" && j.leadCounts.pending === 2, "detail returns campaign + leadCounts (pending=2)");
  assert((await get(srv, "/api/campaign/missing")).status === 404, "unknown id → 404");

  // ── 5) stop / pause ──
  assert((await (await post(srv, "/api/campaign/api1/stop")).json()).status === "cancelled", "stop → cancelled");
  assert((await store.getCampaign("api1")).status === "cancelled", "status persisted cancelled");
  await post(srv, "/api/campaign/start", { id: "api2", mode: "connect_only", profileIds: ["a"], leads: [{ leadUrl: "y", memberUrn: "yy" }] });
  assert((await (await post(srv, "/api/campaign/api2/stop?pause=1")).json()).status === "paused", "stop?pause=1 → paused");

  // ── 5b) restart — re-activate a cancelled campaign → running ──
  assert((await (await post(srv, "/api/campaign/api1/restart")).json()).status === "running", "restart cancelled → running");
  assert((await store.getCampaign("api1")).status === "running", "status persisted running after restart");
  const rr = await (await post(srv, "/api/campaign/api1/restart", { fromStart: true })).json();
  assert(rr.status === "running" && rr.alreadyRunning === true, "restart idempotent + fromStart echoed when already running");

  srv.close();

  // ── 6) no store → 503 ──
  const srv2 = await serve(null);
  assert((await post(srv2, "/api/campaign/start", { mode: "connect_only", profileIds: ["a"], leads: [{ leadUrl: "z" }] })).status === 503, "no PG_URL → start 503");
  assert((await get(srv2, "/api/campaign/list")).status === 503, "no PG_URL → list 503");
  srv2.close();

  await store.pg.query("TRUNCATE leads, campaign_tasks, campaigns RESTART IDENTITY CASCADE");
  await store.close(); store.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — campaign submission API"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
