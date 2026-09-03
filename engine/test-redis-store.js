// test-redis-store.js
//
// Validates the ONE property that makes horizontal scaling safe:
//   No two pods may ever hold the same GoLogin profile lock at the same time.
//
// We simulate several pods hammering claimNextJob() concurrently against a
// queue seeded with many jobs across a small set of profiles, then assert:
//   1. Every claimed job's profile was locked to exactly one pod at a time.
//   2. The number of *concurrently running* jobs per profile never exceeds 1.
//   3. After all work drains, no locks leak.
//
// Run:  REDIS_URL=redis://localhost:6379 node test-redis-store.js

const { RedisStore } = require("./redis-store");

const URL = process.env.REDIS_URL || "redis://localhost:6379";
const PODS = Number(process.env.PODS || 4);              // simulated replicas racing
const PROFILES = Number(process.env.PROFILES || 3);      // GoLogin accounts
const JOBS_PER_PROFILE = Number(process.env.JOBS_PER_PROFILE || 8);

function assert(cond, msg) {
  if (!cond) { console.error("❌ FAIL:", msg); process.exitCode = 1; throw new Error(msg); }
  console.log("✅", msg);
}

(async () => {
  // Use a throwaway connection to wipe just our keys (NOT FLUSHALL — be polite).
  const admin = new RedisStore(URL, "admin");
  const keys = await admin.redis.keys("sn:*");
  if (keys.length) await admin.redis.del(...keys);

  // Seed: PROFILES profiles × JOBS_PER_PROFILE jobs each, interleaved.
  let seq = 0;
  for (let j = 0; j < JOBS_PER_PROFILE; j++) {
    for (let p = 0; p < PROFILES; p++) {
      seq++;
      await admin.addJob({
        id: `job_${seq}`,
        userId: `op_${p}`,
        profileId: `profile_${p}`,
        createdAt: seq,
        status: "queued",
      });
    }
  }
  const totalJobs = PROFILES * JOBS_PER_PROFILE;
  console.log(`seeded ${totalJobs} jobs across ${PROFILES} profiles\n`);

  // Shared observer: track which profile is "live" (claimed but not finished).
  // If the lock is correct, a profile is live for at most one job at a time.
  const liveByProfile = new Map();   // profileId -> jobId currently running
  let maxConcurrentPerProfile = 0;
  let violations = 0;
  let claimedCount = 0;

  // Each simulated pod: loop claim → (simulated work) → finish, until drained.
  async function runPod(podId) {
    const store = new RedisStore(URL, podId);
    while (true) {
      const job = await store.claimNextJob();
      if (!job) {
        // Nothing runnable right now. If everything is done, exit; else the
        // remaining jobs are profile-locked by peers — wait and retry.
        const running = await store.runningCount();
        const remaining = (await store.redis.llen("sn:waiting")) + running;
        if (remaining === 0) break;
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      claimedCount++;

      // CHECK: this profile must not already be live on another pod.
      if (liveByProfile.has(job.profileId)) {
        violations++;
        console.error(`   ⚠️  ${podId} claimed ${job.id} on ${job.profileId} but ${liveByProfile.get(job.profileId)} is still live!`);
      }
      liveByProfile.set(job.profileId, job.id);
      maxConcurrentPerProfile = Math.max(maxConcurrentPerProfile, 1);

      // Simulate scrape work, heartbeating the lock like the real engine would.
      const hb = setInterval(() => store.heartbeat(job).catch(() => {}), 3);
      await new Promise((r) => setTimeout(r, 8 + (seq % 5)));
      clearInterval(hb);

      // Done → release lock.
      liveByProfile.delete(job.profileId);
      await store.finishJob(job.id, { status: "done" });
    }
    await store.close();
  }

  await Promise.all(Array.from({ length: PODS }, (_, i) => runPod(`pod_${i}`)));

  console.log("");
  assert(violations === 0, `no two pods ever held the same profile lock (violations=${violations})`);
  assert(claimedCount === totalJobs, `every job was claimed exactly once (claimed=${claimedCount}/${totalJobs})`);

  const leakedLocks = await admin.redis.keys("sn:proflock:*");
  assert(leakedLocks.length === 0, `no profile locks leaked after drain (leaked=${leakedLocks.length})`);

  const stillWaiting = await admin.redis.llen("sn:waiting");
  const stillRunning = await admin.runningCount();
  assert(stillWaiting === 0 && stillRunning === 0, `queue fully drained (waiting=${stillWaiting} running=${stillRunning})`);

  // The KEDA scale-down metric must reach 0 once all work is done, or pods
  // would never scale to zero overnight.
  const active = await admin.activeCount();
  assert(active === 0, `active-work metric drained to 0 → KEDA can scale to zero (active=${active})`);

  const done = (await admin.getAllJobs()).filter((j) => j.status === "done").length;
  assert(done === totalJobs, `all jobs reached done state (done=${done}/${totalJobs})`);

  // cleanup
  const k2 = await admin.redis.keys("sn:*");
  if (k2.length) await admin.redis.del(...k2);
  await admin.close();

  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — atomic claim-lock holds under concurrency"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
