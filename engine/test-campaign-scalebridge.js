// test-campaign-scalebridge.js
//
// Plan A — the KEDA scale bridge. KEDA no longer queries Postgres; instead the
// always-on frontend mirrors the active-campaign count into a Redis LIST
// (cmp:scaleactive) that the campaign ScaledObject's redis trigger watches.
//
// Proves:
//   1. refreshScaleMetric() sets LLEN(cmp:scaleactive) == count of campaigns in
//      status (queued|running|monitoring) — the SAME statuses the old postgresql
//      trigger counted (parity).
//   2. done/failed/other campaigns are NOT counted (don't keep workers alive).
//   3. it's AUTHORITATIVE/idempotent — re-running rebuilds to the exact count
//      (no drift, a crashed campaign can't leak a token).
//   4. going back to zero active → list emptied → KEDA scales to zero.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-scalebridge.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

(async () => {
  const redis = new Redis(REDIS, { maxRetriesPerRequest: null });
  const s = new CampaignStore({ pgUrl: PG, redis, podId: "bridge" });
  await s.migrate();
  const wipe = async () => {
    await s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaigns RESTART IDENTITY CASCADE");
    await redis.del("cmp:scaleactive");
  };
  await wipe();
  const llen = () => redis.llen("cmp:scaleactive");

  // ── 0) no campaigns → empty list (workers scale to zero) ──
  assert((await s.refreshScaleMetric()) === 0 && (await llen()) === 0, "no campaigns → list empty (scale to 0)");

  // ── 1) active statuses are counted (parity with the old PG trigger) ──
  await s.createCampaign({ id: "q", mode: "connect_only", status: "queued", profileIds: ["A"] });
  await s.createCampaign({ id: "r", mode: "connect_only", status: "running", profileIds: ["A"] });
  await s.createCampaign({ id: "m", mode: "connect_only", status: "monitoring", profileIds: ["A"] });
  // ── 2) inactive statuses are NOT counted ──
  await s.createCampaign({ id: "d", mode: "connect_only", status: "done", profileIds: ["A"] });
  await s.createCampaign({ id: "f", mode: "connect_only", status: "failed", profileIds: ["A"] });

  const n = await s.refreshScaleMetric();
  assert(n === 3, `counts queued+running+monitoring = 3 (got ${n})`);
  assert((await llen()) === 3, "LLEN(cmp:scaleactive) == 3 → KEDA runs ceil(3/2)=2 pods");

  // ── 3) authoritative / idempotent — re-run rebuilds to the same count (no drift) ──
  await redis.rpush("cmp:scaleactive", "stale", "stale", "stale"); // simulate a leaked/stale token
  assert((await llen()) === 6, "pre: injected stale tokens (list length 6)");
  await s.refreshScaleMetric();
  assert((await llen()) === 3, "re-run is authoritative — stale tokens purged, LLEN back to 3 (drift-free)");

  // ── 4) campaigns finish → active drops to 0 → list emptied (scale to zero) ──
  await s.setCampaignStatus("q", "done");
  await s.setCampaignStatus("r", "done");
  await s.setCampaignStatus("m", "done");
  const n2 = await s.refreshScaleMetric();
  assert(n2 === 0 && (await llen()) === 0, "all campaigns done → list empty → scale to zero");

  await wipe();
  await s.close(); redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — KEDA scale bridge (Redis)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
