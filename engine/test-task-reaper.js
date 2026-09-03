// test-task-reaper.js
//
// Reaper correctness: a pod that dies between claim and mark strands a
// follow_up/accept row in status='claimed' forever (monitor/reply self-revive
// via armMonitorTask, these don't). reapOrphanedTasks() flips stale-claimed
// rows back to pending so they get re-claimed on the next tick.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-task-reaper.js

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
  };
  await wipe();

  await admin.createCampaign({ id: "c1", mode: "connect_only", profileIds: ["pA"], dailyLimit: 100 });

  const stale = await admin.createTask({ campaignId: "c1", type: "follow_up", dueAt: new Date(Date.now() - 60000), payload: {} });
  const fresh = await admin.createTask({ campaignId: "c1", type: "follow_up", dueAt: new Date(Date.now() - 60000), payload: {} });
  assert(stale && fresh, "seeded two follow_up tasks");

  // stale row: claimed 15 minutes ago (orphan — past the default 10-minute threshold)
  await admin.pg.query(
    `UPDATE campaign_tasks SET status='claimed', claimed_by='dead_pod', claimed_at=now() - interval '15 minutes' WHERE id=$1`,
    [stale.id]
  );
  // fresh row: claimed just now (still legitimately in-flight)
  await admin.pg.query(
    `UPDATE campaign_tasks SET status='claimed', claimed_by='live_pod', claimed_at=now() WHERE id=$1`,
    [fresh.id]
  );

  const result = await admin.reapOrphanedTasks();
  assert(result && result.reaped === 1, `reapOrphanedTasks() reaped exactly 1 orphan (got ${JSON.stringify(result)})`);

  const { rows: [staleRow] } = await admin.pg.query(`SELECT status, claimed_by, claimed_at FROM campaign_tasks WHERE id=$1`, [stale.id]);
  assert(staleRow.status === "pending", "stale row flipped back to pending");
  assert(staleRow.claimed_by === null, "stale row claimed_by cleared");
  assert(staleRow.claimed_at === null, "stale row claimed_at cleared");

  const { rows: [freshRow] } = await admin.pg.query(`SELECT status, claimed_by FROM campaign_tasks WHERE id=$1`, [fresh.id]);
  assert(freshRow.status === "claimed", "fresh row untouched — still claimed");
  assert(freshRow.claimed_by === "live_pod", "fresh row claimed_by untouched");

  // second call is a no-op (nothing left to reap)
  const result2 = await admin.reapOrphanedTasks();
  assert(result2.reaped === 0, "second call reaps nothing — idempotent");

  await wipe();
  await closePod(admin);
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — orphaned task reaper is correct"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
