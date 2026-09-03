// test-campaign-parallel.js
//
// #15 — parallel cloud campaigns. The runtime drives up to CAMPAIGN_CONCURRENCY
// campaigns AT ONCE per pod (was one-at-a-time: the first campaign drained fully
// before the next could start — Sam's "only one runs"). Proves:
//   • concurrency=2 → two campaigns run CONCURRENTLY (max 2 in-flight) and
//     INTERLEAVE (not A-drained-then-B)
//   • both campaigns still fully complete
//   • the cap holds: concurrency=1 → strictly serial (max 1 in-flight, A then B)
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-parallel.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { buildRuntime } = require("./campaign-runtime");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

// deps whose action records concurrency: each connect() marks itself in-flight,
// yields (so concurrent runners interleave), then clears — capturing max overlap
// and the processing order across campaigns.
function instrumentedDeps(state) {
  return {
    log: () => {}, sleep: async () => {},
    openSession: async () => ({ page: {}, close: async () => {} }),
    makeWorkerAction: (campaign) => ({
      kind: "connect",
      async openSession(pid) { return { profileId: pid }; },
      async connect(_s, lead) {
        state.inFlight++; state.max = Math.max(state.max, state.inFlight);
        state.seq.push(campaign.id);
        await new Promise((r) => setImmediate(r)); // yield → let a sibling campaign run
        state.inFlight--;
        return { success: true, stage: "CC" };
      },
      async closeSession() {},
    }),
  };
}

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "par" });
  await s.migrate();
  const wipe = async () => {
    await s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaigns RESTART IDENTITY CASCADE");
    const k = await s.redis.keys("cmp:*"); if (k.length) await s.redis.del(...k);
    for (const a of ["acctA", "acctB"]) { const kk = await s.redis.keys("sn:proflock:" + a); if (kk.length) await s.redis.del(...kk); }
  };
  const seed = async () => {
    await s.createCampaign({ id: "A", mode: "connect_only", profileIds: ["acctA"], dailyLimit: 100 });
    await s.createCampaign({ id: "B", mode: "connect_only", profileIds: ["acctB"], dailyLimit: 100 });
    await s.addLeads("A", Array.from({ length: 5 }, (_, i) => ({ leadUrl: `https://l/A${i}`, memberUrn: `A${i}` })));
    await s.addLeads("B", Array.from({ length: 5 }, (_, i) => ({ leadUrl: `https://l/B${i}`, memberUrn: `B${i}` })));
  };

  // ── concurrency = 2 → parallel + interleaved ──
  await wipe(); await seed();
  process.env.CAMPAIGN_CONCURRENCY = "2";
  let st = { inFlight: 0, max: 0, seq: [] };
  await buildRuntime({ store: s, deps: instrumentedDeps(st) }).tickCampaigns();
  assert((await s.leadStatusCounts("A")).sent === 5 && (await s.leadStatusCounts("B")).sent === 5, "both campaigns fully completed (5 + 5 sent)");
  assert(st.max >= 2, `campaigns ran CONCURRENTLY — max ${st.max} in flight at once (was 1 when serial)`);
  const firstB = st.seq.indexOf("B"), lastA = st.seq.lastIndexOf("A");
  assert(firstB !== -1 && firstB < lastA, `A and B INTERLEAVED, not A-drained-then-B (order: ${st.seq.join("")})`);

  // ── concurrency = 1 → the cap holds: strictly serial ──
  await wipe(); await seed();
  process.env.CAMPAIGN_CONCURRENCY = "1";
  let st1 = { inFlight: 0, max: 0, seq: [] };
  await buildRuntime({ store: s, deps: instrumentedDeps(st1) }).tickCampaigns();
  assert(st1.max === 1, `concurrency=1 → strictly serial (max ${st1.max} in flight)`);
  const fB = st1.seq.indexOf("B"), lA = st1.seq.lastIndexOf("A");
  assert(fB > lA, `concurrency=1 → one campaign fully drained before the next (order: ${st1.seq.join("")})`);

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — parallel cloud campaigns"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
