// test-campaign-store.js
//
// Phase 1 correctness — the scary coordination, proven with ZERO real sends:
//   1. ATOMIC lead claim — many workers, no lead is ever claimed twice (the
//      thing that prevents double-messaging a prospect).
//   2. SHARED per-account lock — two pods can't drive the same account; the lock
//      lives under the scraper's `sn:proflock:` namespace (cross-engine safety).
//   3. ATOMIC daily-send limit — concurrent consumes never overshoot the cap.
//   4. Anti-dupe set.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-store.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
function mkPod(id) { return new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: id }); }
async function closePod(p) { await p.close(); p.redis.disconnect(); }

(async () => {
  const admin = mkPod("admin");
  await admin.migrate();
  const wipe = async () => {
    await admin.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaigns RESTART IDENTITY CASCADE");
    const ck = await admin.redis.keys("cmp:*"); if (ck.length) await admin.redis.del(...ck);
    const pk = await admin.redis.keys("sn:proflock:test_*"); if (pk.length) await admin.redis.del(...pk);
  };
  await wipe();

  // ── 1) Atomic lead claim across many workers ──
  await admin.createCampaign({ id: "c1", mode: "connect_only", profileIds: ["pA", "pB", "pC"], dailyLimit: 100 });
  const N = 60;
  const added = await admin.addLeads("c1", Array.from({ length: N }, (_, i) => ({ leadUrl: `https://x/${i}`, memberUrn: `urn_${i}`, fullName: `L${i}` })));
  assert(added === N, `seeded ${N} leads`);
  // idempotent re-add does nothing (no duplicate person)
  assert((await admin.addLeads("c1", [{ leadUrl: "https://x/0", memberUrn: "urn_0" }])) === 0, "re-adding an existing lead is a no-op (dedupe)");

  const seen = new Map();
  let totalClaimed = 0;
  const M = 6;
  async function worker(podId) {
    const s = mkPod(podId);
    while (true) {
      const lead = await s.claimNextLead("c1", "pA");
      if (!lead) break;
      seen.set(lead.id, (seen.get(lead.id) || 0) + 1);
      totalClaimed++;
      await s.markLead(lead.id, "sent", { stage: "CC" });
    }
    await closePod(s);
  }
  await Promise.all(Array.from({ length: M }, (_, i) => worker(`pod_${i}`)));
  assert(totalClaimed === N, `every lead claimed exactly once across ${M} workers (claimed=${totalClaimed}/${N})`);
  assert([...seen.values()].every((v) => v === 1), `NO lead was claimed twice (would = a double-send)`);
  const counts = await admin.leadStatusCounts("c1");
  assert(counts.sent === N && !counts.pending, `all ${N} leads marked sent, queue drained`);

  // ── 2) Shared per-account lock (cross-safe with scraper) ──
  const a = mkPod("podA"), b = mkPod("podB");
  assert((await a.acquireAccount("test_acct")) === true, "podA acquires the account lock");
  assert((await b.acquireAccount("test_acct")) === false, "podB CANNOT grab the same account (one stream per account)");
  assert((await admin.redis.exists("sn:proflock:test_acct")) === 1, "lock lives under sn:proflock: → SHARED with the scraper (a scrape can't take it either)");
  await a.releaseAccount("test_acct");
  assert((await b.acquireAccount("test_acct")) === true, "after release, podB can acquire");
  await b.releaseAccount("test_acct");
  await closePod(a); await closePod(b);

  // ── 3) Atomic daily-send limit ──
  const LIM = 10;
  let allowed = 0;
  await Promise.all(Array.from({ length: 25 }, async () => {
    const r = await admin.tryConsumeDailySend("test_acct2", "2026-06-23", LIM);
    if (r.allowed) allowed++;
  }));
  assert(allowed === LIM, `exactly ${LIM} sends allowed under a ${LIM}/day cap (got ${allowed}) — atomic, no overshoot`);
  assert((await admin.tryConsumeDailySend("test_acct2", "2026-06-23", LIM)).allowed === false, "further sends denied once at the cap");

  // ── 4) Anti-dupe ──
  assert((await admin.wasActionSent("c1", "urn_1", "connect")) === false, "action not sent yet");
  await admin.markActionSent("c1", "urn_1", "connect");
  assert((await admin.wasActionSent("c1", "urn_1", "connect")) === true, "after mark → wasSent true (prevents re-send)");

  await wipe();
  await admin.redis.del("sn:proflock:test_acct").catch(() => {});
  await closePod(admin);
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — campaign coordination layer is correct"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
