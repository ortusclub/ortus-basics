// test-campaign-routing.js
//
// Per-lead account routing (auto-routed modes: message_only / introduce_back /
// check_status). A lead pinned to account X (route_account) is claimable ONLY
// by X; an unrouted lead (route_account '') is claimable by any account.
//
//   1. addLeads stores routeAccount.
//   2. claimNextLead: account A claims its routed leads + unrouted, NEVER B's.
//   3. end-to-end via the worker: each account actions only its own routed
//      leads (+ shares the unrouted), zero cross-account leakage.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-routing.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { CampaignWorker } = require("./campaign-worker");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
function mkStore(id) { return new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: id }); }

// mock action recording which (account, lead) pairs happened
function mkAction() {
  const pairs = [];
  return { pairs, action: {
    kind: "message",
    async openSession(pid) { return { profileId: pid }; },
    async connect(s, lead) { await new Promise((r) => setTimeout(r, 3)); pairs.push([s.profileId, lead.lead_url]); return { success: true, stage: "DM" }; },
    async closeSession() {},
  } };
}

(async () => {
  const admin = mkStore("admin");
  await admin.migrate();
  const wipe = async () => { await admin.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE"); for (const p of ["cmp:*", "sn:proflock:A", "sn:proflock:B"]) { const k = await admin.redis.keys(p); if (k.length) await admin.redis.del(...k); } };
  await wipe();

  await admin.createCampaign({ id: "rt", mode: "message_only", profileIds: ["A", "B"], dailyLimit: 100 });
  // 3 routed to A, 2 routed to B, 2 unrouted (shared)
  await admin.addLeads("rt", [
    { leadUrl: "https://l/a1", memberUrn: "a1", routeAccount: "A" },
    { leadUrl: "https://l/a2", memberUrn: "a2", routeAccount: "A" },
    { leadUrl: "https://l/a3", memberUrn: "a3", routeAccount: "A" },
    { leadUrl: "https://l/b1", memberUrn: "b1", routeAccount: "B" },
    { leadUrl: "https://l/b2", memberUrn: "b2", routeAccount: "B" },
    { leadUrl: "https://l/u1", memberUrn: "u1" },
    { leadUrl: "https://l/u2", memberUrn: "u2" },
  ]);

  // ── 1) routeAccount stored ──
  const stored = await admin.getCampaignLeads("rt");
  assert(stored.filter((l) => l.route_account === "A").length === 3, "3 leads routed to A stored");
  assert(stored.filter((l) => l.route_account === "B").length === 2, "2 leads routed to B stored");
  assert(stored.filter((l) => l.route_account === "").length === 2, "2 unrouted leads stored");

  // ── 2) claim gating: A never gets B's routed leads ──
  const claimedByA = [];
  let lead;
  while ((lead = await admin.claimNextLead("rt", "A"))) claimedByA.push(lead);
  assert(claimedByA.every((l) => l.route_account === "A" || l.route_account === ""), "A only claimed its routed leads + unrouted");
  assert(!claimedByA.some((l) => l.route_account === "B"), "A NEVER claimed a B-routed lead");
  // B can still get its own routed leads (the unrouted were taken by A above)
  const claimedByB = [];
  while ((lead = await admin.claimNextLead("rt", "B"))) claimedByB.push(lead);
  assert(claimedByB.length === 2 && claimedByB.every((l) => l.route_account === "B"), "B claimed exactly its 2 routed leads");

  // ── 3) end-to-end via the worker (two accounts in parallel) ──
  await wipe();
  await admin.createCampaign({ id: "rt2", mode: "message_only", profileIds: ["A", "B"], dailyLimit: 100 });
  await admin.addLeads("rt2", [
    { leadUrl: "https://l/a1", memberUrn: "a1", routeAccount: "A" },
    { leadUrl: "https://l/a2", memberUrn: "a2", routeAccount: "A" },
    { leadUrl: "https://l/b1", memberUrn: "b1", routeAccount: "B" },
    { leadUrl: "https://l/b2", memberUrn: "b2", routeAccount: "B" },
    { leadUrl: "https://l/b3", memberUrn: "b3", routeAccount: "B" },
  ]);
  const camp = await admin.getCampaign("rt2");
  const sA = mkStore("wa"), sB = mkStore("wb");
  const mk = mkAction();
  const wA = new CampaignWorker({ store: sA, action: mk.action, today: "2026-06-30" });
  const wB = new CampaignWorker({ store: sB, action: mk.action, today: "2026-06-30" });
  await Promise.all([wA.runCampaign(camp), wB.runCampaign(camp)]);
  await sA.close(); sA.redis.disconnect(); await sB.close(); sB.redis.disconnect();

  assert(mk.pairs.length === 5, `all 5 leads actioned (got ${mk.pairs.length})`);
  const bad = mk.pairs.filter(([acct, url]) => (url.includes("/a") && acct !== "A") || (url.includes("/b") && acct !== "B"));
  assert(bad.length === 0, `zero cross-account leakage — every lead actioned by its pinned account (violations=${bad.length})`);
  assert(mk.pairs.filter(([a]) => a === "A").length === 2 && mk.pairs.filter(([a]) => a === "B").length === 3, "A did its 2, B did its 3");

  await wipe();
  await admin.close(); admin.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — per-lead account routing"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
