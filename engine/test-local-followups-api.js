// test-local-followups-api.js
//
// GET /api/local-followups?owner= + POST /api/local-followups/ack
// over real HTTP against local Postgres.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-local-followups-api.js

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

  const owner = "o@test";
  await store.createCampaign({
    id: "lfcamp1", name: "lf", mode: "connect_and_introduce", owner,
    profileIds: ["accA"], config: {}, status: "monitoring",
  });
  await store.pg.query("UPDATE campaigns SET sheet_url='https://sheet/x' WHERE id='lfcamp1'");
  await store.createTask({
    campaignId: "lfcamp1", type: "follow_up", dedupeKey: "fu:a",
    dueAt: new Date(Date.now() - 60000),
    payload: { sender: "local-browser", leadUrl: "https://lk/in/a", leadName: "A", threadUrl: "https://lk/thread", body: "hi", profileId: "accA" },
  });

  // GET without owner → 400
  let r = await get(srv, "/api/local-followups");
  assert(r.status === 400, "GET without owner → 400");

  // GET owner → one follow-up, mapped fields present
  r = await get(srv, "/api/local-followups?owner=" + encodeURIComponent(owner));
  let j = await r.json();
  assert(r.status === 200 && j.followups.length === 1, "GET owner → 200, 1 follow-up");
  const fu = j.followups[0];
  assert(fu.threadUrl === "https://lk/thread" && fu.body === "hi" && fu.leadUrl === "https://lk/in/a" && fu.profileId === "accA" && fu.sheetUrl === "https://sheet/x", "follow-up carries thread/body/lead/profile/sheet");
  assert(fu.taskId != null, "follow-up carries taskId");

  // ack without owner → 400 (symmetric with GET)
  r = await post(srv, "/api/local-followups/ack", { taskIds: [fu.taskId] });
  assert(r.status === 400, "POST ack without owner → 400");

  // ack scoped to the WRONG owner delegates nothing (can't strand another's task)
  r = await post(srv, "/api/local-followups/ack", { taskIds: [fu.taskId], owner: "someone-else@test" });
  j = await r.json();
  assert(r.status === 200 && j.delegated === 0, "POST ack wrong owner → delegated 0");
  j = await (await get(srv, "/api/local-followups?owner=" + encodeURIComponent(owner))).json();
  assert(j.followups.length === 1, "still offered after wrong-owner ack");

  // ack → delegated 1; subsequent GET empty
  r = await post(srv, "/api/local-followups/ack", { taskIds: [fu.taskId], owner });
  j = await r.json();
  assert(r.status === 200 && j.delegated === 1, "POST ack → delegated 1");
  j = await (await get(srv, "/api/local-followups?owner=" + encodeURIComponent(owner))).json();
  assert(j.followups.length === 0, "acked follow-up no longer offered");

  // ack with empty taskIds → 400
  r = await post(srv, "/api/local-followups/ack", { taskIds: [], owner });
  assert(r.status === 400, "POST ack empty → 400");

  srv.close(); await store.close();
  console.log("🎉 ALL CHECKS PASSED — local-followups endpoints");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
