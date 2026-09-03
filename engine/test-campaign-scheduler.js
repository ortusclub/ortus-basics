// test-campaign-scheduler.js
//
// Phase 3 — the durable scheduler. Proves the timer foundation for monitoring +
// follow-ups, with mock handlers (no real LinkedIn):
//   1. ATOMIC due-task claim — many tasks, many scheduler pods, each task runs
//      exactly once (no double monitor/follow-up).
//   2. due_at respected — future tasks are NOT run early.
//   3. recurring reschedule — a task can re-queue itself (the 30-min monitor loop).
//   4. unknown type → error (no infinite loop).
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-scheduler.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { CampaignScheduler } = require("./campaign-scheduler");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mkPod(id) { return new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: id }); }
async function closePod(p) { await p.close(); p.redis.disconnect(); }

(async () => {
  const admin = mkPod("admin");
  await admin.migrate();
  const wipe = async () => { await admin.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaigns RESTART IDENTITY CASCADE"); };
  await wipe();
  await admin.createCampaign({ id: "sc", mode: "connect_only" });

  // ── 1) atomic due-task claim across pods ──
  const DUE = 30, FUTURE = 5;
  for (let i = 0; i < DUE; i++) await admin.createTask({ campaignId: "sc", type: "noop", dueAt: new Date(Date.now() - 1000) });
  for (let i = 0; i < FUTURE; i++) await admin.createTask({ campaignId: "sc", type: "noop", dueAt: new Date(Date.now() + 3600000) });

  const seen = new Map();
  const noop = async (task) => { seen.set(task.id, (seen.get(task.id) || 0) + 1); return {}; };
  async function drainWith(podId) {
    const s = mkPod(podId);
    const sch = new CampaignScheduler({ store: s }).on("noop", noop);
    while ((await sch.tickOnce()) > 0) { /* keep draining due tasks */ }
    await closePod(s);
  }
  await Promise.all(Array.from({ length: 4 }, (_, i) => drainWith(`p_${i}`)));
  assert(seen.size === DUE, `every DUE task dispatched once across 4 scheduler pods (dispatched=${seen.size}/${DUE})`);
  assert([...seen.values()].every((v) => v === 1), "NO task dispatched twice (no double monitor/follow-up)");
  const pendingFuture = (await admin.pg.query("SELECT count(*)::int AS n FROM campaign_tasks WHERE status='pending'")).rows[0].n;
  assert(pendingFuture === FUTURE, `future tasks NOT run early (still pending=${pendingFuture})`);

  // ── 2) recurring task reschedules itself, then completes ──
  await admin.createTask({ campaignId: "sc", type: "recur", dueAt: new Date() });
  let recurCalls = 0;
  const s2 = mkPod("recur");
  const sch2 = new CampaignScheduler({ store: s2, tickMs: 20 })
    .on("recur", async () => { recurCalls++; return recurCalls < 3 ? { rescheduleInMs: 40 } : { status: "done" }; });
  sch2.start();
  await sleep(500);
  sch2.stop();
  await closePod(s2);
  assert(recurCalls === 3, `recurring task ran 3 times then stopped (ran=${recurCalls}) — the 30-min monitor loop pattern`);

  // ── 3) unknown type → error, not an infinite loop ──
  await admin.createTask({ campaignId: "sc", type: "mystery", dueAt: new Date() });
  const s3 = mkPod("u");
  await new CampaignScheduler({ store: s3 }).tickOnce();
  const st = (await admin.pg.query("SELECT status FROM campaign_tasks WHERE type='mystery'")).rows[0].status;
  assert(st === "error", `unknown task type marked error, not re-run (status=${st})`);
  await closePod(s3);

  await wipe();
  await closePod(admin);
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — durable scheduler is correct across pods"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
