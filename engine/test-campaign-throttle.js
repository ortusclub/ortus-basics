// test-campaign-throttle.js
//
// Blockers 1 & 2 — inter-send delays + 429 parking (ban-safety):
//   1. delay: the worker sleeps between sends on the same account (injected
//      sleep spy records the gaps; NOT after anti-dupe skips).
//   2. 429 parking: a throttled send does NOT burn the lead — it goes back to
//      pending; consecutive 429s park the account; a parked account is skipped
//      (its leads wait), and a clean send resets the streak.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-throttle.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { CampaignWorker } = require("./campaign-worker");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "thr" });
  await s.migrate();
  const wipe = async () => { await s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaigns RESTART IDENTITY CASCADE"); for (const pat of ["cmp:*", "sn:proflock:A"]) { const k = await s.redis.keys(pat); if (k.length) await s.redis.del(...k); } };
  await wipe();

  // ── 1) inter-send delay between sends (not after skips) ──
  await s.createCampaign({ id: "d", mode: "connect_only", profileIds: ["A"], dailyLimit: 100 });
  await s.addLeads("d", Array.from({ length: 4 }, (_, i) => ({ leadUrl: `https://l/d${i}`, memberUrn: `d${i}` })));
  // pre-mark lead d0 as already-connected so it's an anti-dupe SKIP (no delay)
  await s.markActionSent("d", "d0", "connect");
  const sleeps = [];
  const okAction = { kind: "connect", async openSession(p) { return { profileId: p }; }, async connect() { return { success: true, stage: "CC" }; }, async closeSession() {} };
  const w = new CampaignWorker({ store: s, action: okAction, today: "2026-06-30", delayMin: 5, delayMax: 5, sleep: async (ms) => sleeps.push(ms) });
  await w.runCampaign(await s.getCampaign("d"));
  // 4 leads: d0 skipped (dup, no delay), d1/d2/d3 sent. Delays fire after a send
  // when a next lead may follow → at least 2 delays of ~5000ms.
  assert(sleeps.filter((ms) => ms >= 4000).length >= 2, `inter-send delays applied (${sleeps.filter((ms) => ms >= 4000).length} × ~5s)`);
  assert((await s.leadStatusCounts("d")).sent === 3, "3 real sends (dup skipped)");

  // ── 2) 429 parking ──
  await wipe();
  await s.createCampaign({ id: "t", mode: "connect_only", profileIds: ["A"], dailyLimit: 100 });
  await s.addLeads("t", Array.from({ length: 5 }, (_, i) => ({ leadUrl: `https://l/t${i}`, memberUrn: `t${i}` })));
  let calls = 0;
  const throttleAction = { kind: "connect",
    async openSession(p) { return { profileId: p }; },
    async connect() { calls++; return { success: false, error: "HTTP 429: rate limited" }; },
    async closeSession() {} };
  const wt = new CampaignWorker({ store: s, action: throttleAction, today: "2026-06-30", delayMin: 0, delayMax: 0, parkThreshold: 2, parkCooldownSec: 60, sleep: async () => {} });
  await wt.runCampaign(await s.getCampaign("t"));
  assert((await s.isParked("A")) === true, "account A parked after consecutive 429s");
  assert(calls === 2, `stopped after ${calls} throttled sends (no machine-gunning through all 5)`);
  const leads = await s.getCampaignLeads("t");
  assert(leads.filter((l) => l.status === "pending").length === 5, "ALL leads stay pending (none burned to error)");
  assert(leads.every((l) => l.status !== "error"), "no lead marked error on 429");

  // parked account is skipped on the next turn (leads wait)
  calls = 0;
  const n = await wt.runTurn(await s.getCampaign("t"));
  assert(n === 0 && calls === 0, "parked account skipped — no sends attempted");

  // ── 2b) dead session → park + SoO Needs-Login callback (Blocker 4) ──
  await wipe();
  await s.createCampaign({ id: "x", mode: "connect_only", profileIds: ["A"], dailyLimit: 100 });
  await s.addLeads("x", Array.from({ length: 3 }, (_, i) => ({ leadUrl: `https://l/x${i}`, memberUrn: `x${i}` })));
  const expired = [];
  const deadAction = { kind: "connect",
    async openSession(p) { return { profileId: p }; },
    async connect() { return { success: false, error: "MESSAGE_SEND_FAILED: LinkedIn session expired — redirected to login" }; },
    async closeSession() {} };
  const wd = new CampaignWorker({ store: s, action: deadAction, today: "2026-06-30", delayMin: 0, delayMax: 0,
    parkCooldownSec: 60, sleep: async () => {}, onSessionExpired: async (acct) => { expired.push(acct); } });
  await wd.runCampaign(await s.getCampaign("x"));
  assert(expired.length === 1 && expired[0] === "A", "onSessionExpired fired for the account (→ SoO Needs-Login)");
  assert((await s.isParked("A")) === true, "dead-session account parked immediately");
  assert((await s.getCampaignLeads("x")).every((l) => l.status === "pending"), "no leads burned on a dead session (all pending)");

  // ── 3) clean send resets the 429 streak ──
  await s.recordThrottle("B", 2, 60); // 1 strike on B (not parked)
  assert((await s.isParked("B")) === false, "1 strike doesn't park");
  await s.clearThrottle("B");
  const after = await s.recordThrottle("B", 2, 60); // back to 1 (streak reset), not 2
  assert(after.count === 1 && !after.parked, "clearThrottle reset the streak (clean send un-does a strike)");

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — inter-send delays + 429 parking"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
