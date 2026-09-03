// test-queue-position.js
//
// Validates the queue-position / ETA feature:
//   1. queueSnapshot() reports the right position, jobsAhead, and DISTINCT
//      accountsAhead for every waiting job, in FIFO order.
//   2. The ETA scales with jobs ahead ÷ parallelism (distinct accounts), using
//      the rolling average duration.
//   3. A cancelled/vanished job in the list (id in sn:waiting but gone from
//      sn:jobs) is skipped — it doesn't inflate anyone's position.
//   4. _recordDuration feeds the EMA only for SANE completions (ignores
//      sub-5s blips and non-"done" jobs).
//
// Run:  REDIS_URL=redis://localhost:6379 node test-queue-position.js

const { RedisStore } = require("./redis-store");

const URL = process.env.REDIS_URL || "redis://localhost:6379";
const AVG_KEY = "sn:stats:avgjobms";

function assert(cond, msg) {
  if (!cond) { console.error("❌ FAIL:", msg); process.exitCode = 1; throw new Error(msg); }
  console.log("✅", msg);
}
const near = (a, b, tol = 2500) => Math.abs(a - b) <= tol;

(async () => {
  const s = new RedisStore(URL, "admin");
  const wipe = async () => { const k = await s.redis.keys("sn:*"); if (k.length) await s.redis.del(...k); };
  await wipe();

  // ── 1+2) positions / accountsAhead / ETA ──
  // 6 jobs across 3 accounts, interleaved FIFO:
  //   #1 p0   #2 p1   #3 p2   #4 p0   #5 p1   #6 p2
  const order = [
    ["jA", "p0"], ["jB", "p1"], ["jC", "p2"],
    ["jD", "p0"], ["jE", "p1"], ["jF", "p2"],
  ];
  let seq = 0;
  for (const [id, pid] of order) {
    await s.addJob({ id, userId: `op_${pid}`, profileId: pid, createdAt: ++seq, state: "queued" });
  }
  await s.redis.set(AVG_KEY, "120000"); // pin avg job = 2 min for deterministic ETA

  const snap = await s.queueSnapshot();
  const J = snap.jobs;

  assert(J.jA.position === 1 && J.jA.jobsAhead === 0 && J.jA.accountsAhead === 0, "job #1: position 1, 0 ahead, 0 accounts ahead");
  assert(J.jA.etaMs === 0, "job #1 ETA is 0 (next up)");
  assert(J.jB.position === 2 && J.jB.accountsAhead === 1, "job #2: position 2, 1 distinct account ahead (p0)");
  assert(J.jC.position === 3 && J.jC.accountsAhead === 2, "job #3: position 3, 2 distinct accounts ahead (p0,p1)");
  assert(J.jD.position === 4 && J.jD.accountsAhead === 3, "job #4: position 4, 3 distinct accounts ahead");
  // jE is the 2nd job on p1; p1 already counted → still 3 distinct accounts ahead.
  assert(J.jE.accountsAhead === 3, "job #5: distinct-account count does NOT double-count p1 (still 3)");
  // ETA = ceil-free (jobsAhead / parallelism) * avg.  jE: 4 ahead ÷ 3 lanes × 120000 = 160000.
  assert(near(J.jE.etaMs, 160000), `job #5 ETA ≈ (4/3)*120000=160000 (got ${J.jE.etaMs})`);
  assert(J.jF.etaMs > J.jE.etaMs, "ETA grows further back in the queue (jF > jE)");
  assert(snap.stats.waiting === 6 && snap.stats.running === 0 && snap.stats.avgJobMs === 120000, "stats: 6 waiting, 0 running, avg 120000");

  // ── 3) a vanished job in the list is skipped ──
  await s.redis.rpush("sn:waiting", "ghost_id"); // in the list, but not in sn:jobs
  await s.addJob({ id: "jG", userId: "op_p0", profileId: "p0", createdAt: ++seq, state: "queued" });
  const snap2 = await s.queueSnapshot();
  assert(!snap2.jobs.ghost_id, "vanished/cancelled id is not reported");
  assert(snap2.jobs.jG.jobsAhead === 6, "real job after a ghost counts only the 6 real jobs ahead (ghost ignored)");

  // ── 4) duration EMA feeds only sane completions ──
  await s.redis.del(AVG_KEY);
  const now = Date.now();
  await s._recordDuration({ state: "done", startedAt: now - 120000 }); // 2 min
  assert(near(Number(await s.redis.get(AVG_KEY)), 120000), "first sample sets avg ≈ 120000");
  await s._recordDuration({ state: "done", startedAt: now - 60000 });  // 1 min → EMA blend
  assert(near(Number(await s.redis.get(AVG_KEY)), 108000), "EMA blends: 120000*0.8 + 60000*0.2 ≈ 108000");
  const before = Number(await s.redis.get(AVG_KEY));
  await s._recordDuration({ state: "done", startedAt: now - 1000 });   // 1s → too short, ignored
  assert(Number(await s.redis.get(AVG_KEY)) === before, "sub-5s blip ignored (avg unchanged)");
  await s._recordDuration({ state: "error", startedAt: now - 120000 });// failed → ignored
  assert(Number(await s.redis.get(AVG_KEY)) === before, "non-'done' job ignored (avg unchanged)");

  await wipe();
  await s.close();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — queue position + ETA"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
