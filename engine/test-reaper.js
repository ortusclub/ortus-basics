// test-reaper.js
//
// Proves the orphan reaper: a job left "running" by a hard-killed pod (its
// profile lock expired / reassigned) gets marked interrupted and pulled from
// sn:active — while a genuinely-running job (lock still held) is NOT touched.
//
// Run:  REDIS_URL=redis://localhost:6379 node test-reaper.js

const { RedisStore } = require("./redis-store");
const URL = process.env.REDIS_URL || "redis://localhost:6379";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const s = new RedisStore(URL, "reaper-pod", "10.0.0.9", "3000");
  const wipe = async () => { const k = await s.redis.keys("sn:*"); if (k.length) await s.redis.del(...k); };
  await wipe();

  // ── Case 1: orphaned job (lock expired) → reaped ──
  await s.addJob({ id: "orphan", userId: "op1", profileId: "pA", createdAt: 1, state: "queued" });
  const claimed = await s.claimNextJob();
  assert(claimed && claimed.id === "orphan", "claimed the job (now running, lock held)");
  // simulate the owning pod dying: its lock TTL-expires (we just delete it)
  await s.redis.del("sn:proflock:pA");
  // sanity: it's still wedged in running + active until reaped
  assert((await s.runningCount()) === 1 && (await s.activeCount()) === 1, "before reap: still in running + active");
  const reaped = await s.reapIfOrphaned("orphan");
  assert(reaped && reaped.state === "error", "orphaned job was reaped → state=error");
  assert((await s.runningCount()) === 0, "reaped job removed from sn:running");
  assert((await s.activeCount()) === 0, "reaped job removed from sn:active (KEDA can scale to zero)");

  // ── Case 2: genuinely-running job (lock held) → NOT reaped ──
  await s.addJob({ id: "alive", userId: "op2", profileId: "pB", createdAt: 2, state: "queued" });
  const c2 = await s.claimNextJob();
  assert(c2 && c2.id === "alive", "claimed second job (lock held by it)");
  const r2 = await s.reapIfOrphaned("alive");
  assert(r2 === null, "live job (lock intact) is NOT reaped");
  assert((await s.runningCount()) === 1, "live job still running");

  // ── Case 3: lock reassigned to a newer job → old one reaped ──
  // free pB's lock and let a different job take the profile
  await s.redis.del("sn:proflock:pB");
  await s.redis.set("sn:proflock:pB", "newjob"); // a different job now holds pB
  const r3 = await s.reapIfOrphaned("alive");
  assert(r3 && r3.state === "error", "job whose profile was taken by a newer job is reaped");

  // ── Case 4: idempotent / cross-pod safe — second reap is a no-op ──
  const r4 = await s.reapIfOrphaned("orphan");
  assert(r4 === null, "re-reaping an already-reaped job is a safe no-op");

  await wipe();
  await s.close();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — orphan reaper works"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
