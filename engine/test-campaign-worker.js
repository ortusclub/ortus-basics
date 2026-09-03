// test-campaign-worker.js
//
// Phase 2 — connect_only campaign worker across multiple "pods", with a MOCK
// action (no real LinkedIn). Proves end-to-end:
//   1. Every lead is connected EXACTLY ONCE (no double-send), spread across the
//      campaign's accounts, and one account is never driven by two workers at
//      once (the shared lock).
//   2. The per-account DAILY LIMIT is enforced — never overshoot; remaining
//      leads stay queued.
//   3. Re-running is idempotent (anti-dupe) — no re-connects.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-worker.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { CampaignWorker } = require("./campaign-worker");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
const DAY = "2026-06-23";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mkPod(id) { return new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: id }); }
async function closePod(p) { await p.close(); p.redis.disconnect(); }

// Mock connect action — records sends + tracks concurrent-per-account.
function makeMockAction() {
  const sent = [];                 // { profileId, leadKey }
  const live = new Map();          // profileId -> in-flight count
  let accountViolations = 0;
  return {
    sent, get violations() { return accountViolations; },
    action: {
      // session model: open the account once, connect many, close.
      async openSession(profileId) {
        const n = (live.get(profileId) || 0) + 1;
        live.set(profileId, n);
        if (n > 1) accountViolations++;       // two workers on one account at once!
        return { profileId };
      },
      async connect(session, lead) {
        await sleep(8);
        sent.push({ profileId: session.profileId, leadKey: lead.member_urn || lead.lead_url });
        return { success: true, stage: "CC" };
      },
      async closeSession(session) {
        live.set(session.profileId, (live.get(session.profileId) || 1) - 1);
      },
    },
  };
}

(async () => {
  const admin = mkPod("admin");
  await admin.migrate();
  const wipe = async () => {
    await admin.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaigns RESTART IDENTITY CASCADE");
    for (const pat of ["cmp:*", "sn:proflock:pA", "sn:proflock:pB", "sn:proflock:pC", "sn:proflock:pX"]) {
      const k = await admin.redis.keys(pat); if (k.length) await admin.redis.del(...k);
    }
  };
  await wipe();

  // ── 1) Multi-account connect_only: no double-send, account isolation ──
  await admin.createCampaign({ id: "c1", mode: "connect_only", profileIds: ["pA", "pB", "pC"], dailyLimit: 100 });
  const N = 30;
  await admin.addLeads("c1", Array.from({ length: N }, (_, i) => ({ leadUrl: `https://x/${i}`, memberUrn: `urn_${i}` })));
  const camp = await admin.getCampaign("c1");

  const mock = makeMockAction();
  const M = 4;
  const workers = Array.from({ length: M }, (_, i) => {
    const s = mkPod(`w_${i}`);
    return { s, w: new CampaignWorker({ store: s, action: mock.action, batchSize: 5, today: DAY }) };
  });
  await Promise.all(workers.map(({ w }) => w.runCampaign(camp)));
  for (const { s } of workers) await closePod(s);

  assert(mock.sent.length === N, `every lead connected exactly once (sent=${mock.sent.length}/${N})`);
  assert(new Set(mock.sent.map((x) => x.leadKey)).size === N, "NO lead double-connected (no double-send)");
  assert(mock.violations === 0, `one account never driven by two workers at once (violations=${mock.violations})`);
  const accts = new Set(mock.sent.map((x) => x.profileId));
  assert(accts.size >= 2, `work spread across accounts (${[...accts].join(",")})`);
  const counts = await admin.leadStatusCounts("c1");
  assert(counts.sent === N && !counts.pending, `all ${N} leads marked sent in Postgres`);

  // ── 2) Daily limit enforced (no overshoot) ──
  await admin.createCampaign({ id: "c2", mode: "connect_only", profileIds: ["pX"], dailyLimit: 8 });
  await admin.addLeads("c2", Array.from({ length: 20 }, (_, i) => ({ leadUrl: `https://y/${i}`, memberUrn: `yurn_${i}` })));
  const camp2 = await admin.getCampaign("c2");
  const mock2 = makeMockAction();
  const s2 = mkPod("cap"); const w2 = new CampaignWorker({ store: s2, action: mock2.action, batchSize: 5, today: DAY });
  await w2.runCampaign(camp2, { maxIdleRounds: 8 });
  await closePod(s2);
  assert(mock2.sent.length === 8, `daily cap respected — exactly 8 connects today (got ${mock2.sent.length}), no overshoot`);
  assert((await admin.pendingLeadCount("c2")) === 12, "remaining 12 leads stay queued for tomorrow / another account");

  // ── 3) Idempotent re-run (anti-dupe) ──
  const mock3 = makeMockAction();
  const s3 = mkPod("rerun"); const w3 = new CampaignWorker({ store: s3, action: mock3.action, batchSize: 5, today: DAY });
  await w3.runCampaign(camp, { maxIdleRounds: 5 }); // c1 is fully sent already
  await closePod(s3);
  assert(mock3.sent.length === 0, "re-running a completed campaign sends nothing (no re-connects)");

  await wipe();
  await closePod(admin);
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — connect_only worker is correct across pods"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
