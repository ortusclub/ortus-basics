// test-account-scaling.js
//
// Proves KEDA's scale metric counts DISTINCT ACCOUNTS, not jobs:
//   • 6 jobs on one account  → sn:scaleaccounts = 1  (→ 1 pod, not 3)
//   • account stays counted until its LAST job ends
//   • cancel + reap also free the account
//   • no per-account counter leaks
//
// Run:  REDIS_URL=redis://localhost:6379 node test-account-scaling.js

const { RedisStore } = require("./redis-store");
const URL = process.env.REDIS_URL || "redis://localhost:6379";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

(async () => {
  const s = new RedisStore(URL, "acct-pod", "10.0.0.5", "3000");
  const wipe = async () => { const k = await s.redis.keys("sn:*"); if (k.length) await s.redis.del(...k); };
  await wipe();

  // 6 jobs, ALL one account (pA) — the single-operator-batch case.
  for (let i = 0; i < 6; i++) await s.addJob({ id: `a${i}`, userId: "op1", profileId: "pA", createdAt: i, state: "queued" });
  assert((await s.scaleAccountsCount()) === 1, "6 jobs on ONE account → scaleAccounts=1 (would have been 6 before)");
  assert((await s.activeCount()) === 6, "sn:active still counts all 6 jobs (diagnostic)");

  // A second account adds one job.
  await s.addJob({ id: "b0", userId: "op2", profileId: "pB", createdAt: 9, state: "queued" });
  assert((await s.scaleAccountsCount()) === 2, "second account → scaleAccounts=2");

  // Finish 5 of pA's 6 — account still has work, so still counted.
  for (let i = 0; i < 5; i++) await s.finishJob(`a${i}`, { state: "done" });
  assert((await s.scaleAccountsCount()) === 2, "pA still counted while it has ≥1 active job");

  // Finish pA's last job → pA drops out.
  await s.finishJob("a5", { state: "done" });
  assert((await s.scaleAccountsCount()) === 1, "pA freed after its LAST job → scaleAccounts=1 (only pB)");

  // Cancel pB's queued job (removeFromQueue) → pB drops out → 0.
  await s.removeFromQueue("b0", "pB");
  assert((await s.scaleAccountsCount()) === 0, "cancel frees the account → scaleAccounts=0 (scale-to-zero unblocked)");

  // Reaper path also frees the account: claim a job, kill its lock, reap it.
  // (Clear leftover waiting ids first — the direct finishJob calls above mark
  // jobs done but don't dequeue them; in production jobs are always claimed,
  // which dequeues, before finishing.)
  await s.redis.del("sn:waiting");
  await s.addJob({ id: "c0", userId: "op3", profileId: "pC", createdAt: 20, state: "queued" });
  const claimed = await s.claimNextJob();
  assert(claimed && claimed.id === "c0", "claimed c0");
  assert((await s.scaleAccountsCount()) === 1, "claimed job keeps its account counted");
  await s.redis.del("sn:proflock:pC"); // simulate pod death
  await s.reapIfOrphaned("c0");
  assert((await s.scaleAccountsCount()) === 0, "reaping an orphan frees its account too");

  // No counter leaks.
  const leaked = await s.redis.keys("sn:profactive:*");
  assert(leaked.length === 0, `no per-account counters leaked (leaked=${leaked.length})`);

  await wipe();
  await s.close();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — scale metric counts distinct accounts"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
