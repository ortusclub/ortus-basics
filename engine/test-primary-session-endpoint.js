// test-primary-session-endpoint.js
//
// Exercises the primary-session upload + by-slug read + primarySession status
// field over real HTTP against local Postgres:
//   1. POST /api/primaries/:memberId/session → {ok:true}; campaign status
//      picks up primarySession.state==='live' via config.primaryUrl.
//   2. store.setPrimaryState → status flips to 'needs_login'.
//   3. Re-POST session resumes parked follow_up tasks (due_at pulled to now).
//   4. GET /api/primaries/by-slug/:slug → live/needs_login row, 'none' for unknown.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-primary-session-endpoint.js

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
  await store.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaign_primaries, campaigns RESTART IDENTITY CASCADE");
  const k = await store.redis.keys("cmp:*"); if (k.length) await store.redis.del(...k);

  const srv = await serve(store);

  // ── 1) upload session, then a campaign referencing it via config.primaryUrl ──
  let r = await post(srv, "/api/primaries/m1/session", {
    publicIdentifier: "jane-doe", displayName: "Jane", cookies: [{ name: "li_at", value: "x" }],
  });
  let j = await r.json();
  assert(r.status === 200 && j.ok === true, "POST session → 200 ok");

  await store.createCampaign({
    id: "pcamp1", name: "primary test", mode: "connect_only", owner: "sam@ortus.club",
    profileIds: ["acctA"], config: { primaryUrl: "https://www.linkedin.com/in/Jane-Doe/" }, status: "queued",
  });

  j = await (await get(srv, "/api/campaign/pcamp1")).json();
  assert(j.campaign.primarySession.state === "live", "campaign status → primarySession.state live");
  assert(j.campaign.primarySession.name === "Jane", "campaign status → primarySession.name Jane");
  assert(j.campaign.primarySession.parked === 0, "campaign status → primarySession.parked 0 (no follow_up tasks yet)");

  // ── list also carries primarySession ──
  j = await (await get(srv, "/api/campaign/list")).json();
  const row = j.campaigns.find((c) => c.id === "pcamp1");
  assert(row && row.primarySession && row.primarySession.state === "live", "list → primarySession.state live");

  // ── 2) flip to needs_login ──
  await store.setPrimaryState("m1", "needs_login");
  j = await (await get(srv, "/api/campaign/pcamp1")).json();
  assert(j.campaign.primarySession.state === "needs_login", "status flips to needs_login");

  // ── 3) parked follow_up task, then re-POST resumes it ──
  const future = new Date(Date.now() + 30 * 60000);
  const task = await store.createTask({
    campaignId: "pcamp1", type: "follow_up", dueAt: future,
    payload: { sender: "local-browser", primaryUrl: "https://www.linkedin.com/in/jane-doe/" },
    dedupeKey: "follow-up:m1:jane",
  });
  assert(task && task.status === "pending", "follow_up task created, pending, due in future");

  j = await (await get(srv, "/api/campaign/pcamp1")).json();
  assert(j.campaign.primarySession.parked === 1, "primarySession.parked counts the pending future follow_up");

  r = await post(srv, "/api/primaries/m1/session", {
    publicIdentifier: "jane-doe", displayName: "Jane", cookies: [{ name: "li_at", value: "y" }],
  });
  j = await r.json();
  assert(r.status === 200 && j.ok === true && j.resumed >= 1, "re-POST session → resumed>=1");

  const { rows: taskRows } = await store.pg.query("SELECT status, due_at FROM campaign_tasks WHERE id=$1", [task.id]);
  assert(taskRows[0].status === "pending", "resumed task stays pending (status untouched)");
  assert(new Date(taskRows[0].due_at).getTime() <= Date.now() + 5000, "resumed task due_at pulled to ~now");

  // re-POST also flips state back to live (upsertPrimarySession sets state='live')
  j = await (await get(srv, "/api/campaign/pcamp1")).json();
  assert(j.campaign.primarySession.state === "live", "status flips back to live after re-upload");
  assert(j.campaign.primarySession.parked === 0, "primarySession.parked drops to 0 once due_at is pulled to now");

  // ── 4) by-slug ──
  j = await (await get(srv, "/api/primaries/by-slug/jane-doe")).json();
  assert((j.state === "live" || j.state === "needs_login") && j.name === "Jane", "by-slug jane-doe → live/needs_login + name Jane");
  j = await (await get(srv, "/api/primaries/by-slug/nobody")).json();
  assert(j.state === "none", "by-slug nobody → none");

  srv.close();

  // ── no store → 503 ──
  const srv2 = await serve(null);
  assert((await post(srv2, "/api/primaries/m1/session", {})).status === 503, "no PG_URL → session 503");
  assert((await get(srv2, "/api/primaries/by-slug/jane-doe")).status === 503, "no PG_URL → by-slug 503");
  srv2.close();

  await store.pg.query("TRUNCATE leads, campaign_tasks, campaign_primaries, campaigns RESTART IDENTITY CASCADE");
  await store.close(); store.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — primary session endpoints"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
