// test-jobs-metadata.js
//
// Round-trip of per-scrape metadata for the app's Sales Nav board:
//   1. addSingle: campaignName/ownerEmail/runId stored; runId defaults to job id.
//   2. addBatch: ONE runId shared by every job in the launch (= batchId default).
//   3. finishJob stamps finishedAt; cancel paths stamp finishedAt.
//   4. log lines carry runId/tabName; getLogsForRun merges a launch's logs.
//   5. pruneFinishedJobs removes only OLD finished jobs (fresh + queued stay).
//
// Run:  REDIS_URL=redis://localhost:6379 node test-jobs-metadata.js

const { RedisJobQueue } = require("./queue-redis");

const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

(async () => {
  const q = new RedisJobQueue({ redisUrl: REDIS, podId: "meta-test", isWorker: false });
  const r = q.store.redis;
  const wipe = async () => {
    const keys = await r.keys("sn:jobs"); // plus queues/logs
    const more = await Promise.all(["sn:waiting", "sn:active", "sn:running", "sn:scaleaccounts"].map((k) => k));
    await r.del("sn:jobs", ...more).catch(() => {});
    for (const k of await r.keys("sn:logs:*")) await r.del(k);
    for (const k of await r.keys("sn:user:*")) await r.del(k);
    for (const k of await r.keys("sn:userlogs:*")) await r.del(k);
    void keys;
  };
  await wipe();

  // ── 1) single: metadata round-trips via getAllJobs (the /api/jobs source) ──
  const s1 = await q.addSingle({
    searchUrl: "https://linkedin.com/sales/search/x", sheetUrl: "https://sheets/x", tabName: "Results",
    userId: "op_1", profileId: "prof_A", campaignName: "July Campaign", ownerEmail: "sam@ortus.club",
  });
  let jobs = await q.getAllJobs();
  const j1 = jobs.find((j) => j.id === s1.id);
  assert(j1.campaignName === "July Campaign" && j1.ownerEmail === "sam@ortus.club", "single: campaignName + ownerEmail round-trip");
  assert(j1.runId === s1.id, "single: runId defaults to the job's own id");
  assert(j1.profileId === "prof_A" && j1.slowMode === false && j1.userId === "op_1", "single: profileId/slowMode/userId present (as before)");

  // client-supplied runId wins
  const s2 = await q.addSingle({ searchUrl: "u", sheetUrl: "s", userId: "op_1", profileId: "prof_A", runId: "run-custom-7" });
  assert((await q.getAllJobs()).find((j) => j.id === s2.id).runId === "run-custom-7", "single: client-supplied runId echoed");

  // ── 2) batch: one runId per launch ──
  const b = await q.addBatch({
    urls: ["https://a", "https://b", "https://c"], sheetUrl: "https://sheets/y", tabName: "Results",
    userId: "op_2", profileId: "prof_B", campaignName: "APAC Push", ownerEmail: "milena@ortus.club",
  });
  jobs = await q.getAllJobs();
  const batchJobs = jobs.filter((j) => j.batchId === b.batchId);
  assert(batchJobs.length === 3, "batch: 3 jobs created");
  assert(new Set(batchJobs.map((j) => j.runId)).size === 1 && batchJobs[0].runId === b.batchId, "batch: ONE shared runId (= batchId) across the launch");
  assert(batchJobs.every((j) => j.campaignName === "APAC Push" && j.ownerEmail === "milena@ortus.club"), "batch: campaignName + ownerEmail on every job");

  // ── 3) finishedAt stamps ──
  const before = Date.now();
  await q.store.finishJob(s1.id, { state: "done", pages: 9, profiles: 200 });
  const done = (await q.getAllJobs()).find((j) => j.id === s1.id);
  assert(done.finishedAt >= before && done.state === "done", "finishJob stamps finishedAt (ms epoch)");
  // queued-cancel path
  await q._cancelQueuedForUser("op_2", "test cancel");
  const cancelled = (await q.getAllJobs()).filter((j) => j.batchId === b.batchId && j.state === "cancelled");
  assert(cancelled.length === 3 && cancelled.every((j) => j.finishedAt >= before), "cancelled jobs stamp finishedAt too");

  // ── 4) per-run logs ──
  await q.pushLog(s1.id, "op_1", "Page 1 scraped", s1);
  await q.pushLog(s1.id, "op_1", "Page 2 scraped", s1);
  const runLogs = await q.getLogsForRun(s1.runId);
  assert(runLogs.length === 2 && runLogs[0].message === "Page 1 scraped", "getLogsForRun returns the launch's logs, oldest first");
  assert(runLogs.every((l) => l.runId === s1.runId && l.tabName === "Results"), "log lines tagged with runId + tabName");
  assert((await r.ttl(`sn:logs:${s1.id}`)) > 0, "per-job log list now expires (TTL set)");

  // ── 5) prune: old finished go, fresh + queued stay ──
  // age the done job artificially
  const raw = JSON.parse(await r.hget("sn:jobs", s1.id));
  raw.finishedAt = Date.now() - 30 * 24 * 3600 * 1000;
  await r.hset("sn:jobs", s1.id, JSON.stringify(raw));
  const q3 = await q.addSingle({ searchUrl: "u", sheetUrl: "s", userId: "op_3", profileId: "prof_C" }); // fresh queued
  const pruned = await q.pruneFinishedJobs();
  jobs = await q.getAllJobs();
  assert(pruned >= 1 && !jobs.find((j) => j.id === s1.id), `prune removed the 30-day-old done job (pruned=${pruned})`);
  assert(jobs.find((j) => j.id === q3.id), "fresh queued job survives the prune");
  assert(jobs.find((j) => j.id === s2.id), "recent queued job survives the prune");
  assert((await r.exists(`sn:logs:${s1.id}`)) === 0, "pruned job's log list removed");

  await wipe();
  q.store.redis.disconnect(); if (q.store.sub) q.store.sub.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — jobs metadata round-trip"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
