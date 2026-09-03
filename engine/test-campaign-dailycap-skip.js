// test-campaign-dailycap-skip.js
//
// Daily-cap account selection (bugfix). A campaign whose FIRST account has hit
// its daily send cap must NOT wedge: the worker skips daily-capped accounts (like
// parked ones) in the acquire loop and drives the accounts that still have
// capacity. The old code grabbed the capped first account, bailed (return 0), and
// starved the rest — which stalled a live campaign whose lead account hit 50/50
// while 8 others sat at 0/50.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-dailycap-skip.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { CampaignWorker } = require("./campaign-worker");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const TODAY = "2026-06-30";

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "cap" });
  await s.migrate();
  const wipe = async () => {
    await s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaigns RESTART IDENTITY CASCADE");
    for (const pat of ["cmp:*", "sn:proflock:A", "sn:proflock:B", "sn:proflock:C"]) { const k = await s.redis.keys(pat); if (k.length) await s.redis.del(...k); }
  };
  await wipe();

  const mkAction = (sink) => ({
    kind: "connect",
    async openSession(p) { return { profileId: p }; },
    async connect(session) { sink.push(session.profileId); return { success: true, stage: "CC" }; },
    async closeSession() {},
  });

  // ── 1) first account capped → worker skips it, drives the others ──
  await s.createCampaign({ id: "d", mode: "connect_only", profileIds: ["A", "B", "C"], dailyLimit: 5 });
  await s.addLeads("d", Array.from({ length: 6 }, (_, i) => ({ leadUrl: `https://l/d${i}`, memberUrn: `d${i}` })));
  // pre-cap account A (FIRST in the list) at 5/5 for today
  for (let i = 0; i < 5; i++) await s.tryConsumeDailySend("A", TODAY, 5);
  assert((await s.dailyCount("A", TODAY)) === 5, "account A pre-capped at its 5/5 daily limit");

  const used = [];
  const w = new CampaignWorker({ store: s, action: mkAction(used), today: TODAY, delayMin: 0, delayMax: 0, sleep: async () => {} });
  await w.runCampaign(await s.getCampaign("d"));

  assert(used.length > 0, `campaign made progress — NOT wedged on capped A (${used.length} sends)`);
  assert(!used.includes("A"), "capped account A skipped entirely (0 sends on A)");
  assert(used.every((p) => p === "B" || p === "C"), "all sends went to accounts with capacity (B/C)");
  assert((await s.leadStatusCounts("d")).sent >= 1, "leads actually sent via B/C");

  // ── 2) ALL accounts capped → nothing acquired, leads stay pending (not burned) ──
  await wipe();
  await s.createCampaign({ id: "x", mode: "connect_only", profileIds: ["A", "B"], dailyLimit: 2 });
  await s.addLeads("x", Array.from({ length: 3 }, (_, i) => ({ leadUrl: `https://l/x${i}`, memberUrn: `x${i}` })));
  for (const a of ["A", "B"]) for (let i = 0; i < 2; i++) await s.tryConsumeDailySend(a, TODAY, 2);
  const used2 = [];
  const w2 = new CampaignWorker({ store: s, action: mkAction(used2), today: TODAY, delayMin: 0, delayMax: 0, sleep: async () => {} });
  const n = await w2.runTurn(await s.getCampaign("x"));
  assert(n === 0 && used2.length === 0, "all accounts capped → no account acquired, no sends attempted");
  assert((await s.getCampaignLeads("x")).every((l) => l.status === "pending"), "leads stay pending when all capped (none burned)");

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — daily-cap account skip"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
