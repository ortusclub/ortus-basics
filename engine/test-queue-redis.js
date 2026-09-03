// test-queue-redis.js
//
// Integration test for the Redis-backed queue ORCHESTRATION (claim loop,
// cross-pod profile isolation, WS fan-out over Redis, graceful drain, stop
// cascade) using a MOCK scraper — no real browser needed.
//
// Run:  REDIS_URL=redis://localhost:6379 node test-queue-redis.js

process.env.MAX_CONCURRENT_SCRAPES = "2"; // per-pod cap (read at module load)
process.env.CLAIM_INTERVAL_MS = "100";    // tighten poll so the idle pod claims fast in-test

const EventEmitter = require("events");
const { RedisJobQueue } = require("./queue-redis");
const { RedisStore } = require("./redis-store");

const URL = process.env.REDIS_URL || "redis://localhost:6379";

// Shared across both "pods" (same process) to detect a profile ever running two
// scrapes at once — the cardinal sin HPA must never commit.
const liveByProfile = new Map(); // profileId → count currently scraping
let profileViolations = 0;
let maxLivePerProfile = 0;

function assert(cond, msg) {
  if (!cond) { console.error("❌ FAIL:", msg); process.exitCode = 1; throw new Error(msg); }
  console.log("✅", msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 12000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(step); }
  return false;
}

// Mock scraper: emits a couple events, "scrapes" for ~150ms, resolves success.
// Tracks live-per-profile so we can prove isolation across pods.
class MockScraper extends EventEmitter {
  constructor({ userId, profileId }) {
    super();
    this.userId = userId;
    this.profileId = profileId;
    this._stopped = false;
  }
  pause() {}
  resume() {}
  stop() { this._stopped = true; }
  async scrapeSingle({ tabName }) {
    const live = (liveByProfile.get(this.profileId) || 0) + 1;
    liveByProfile.set(this.profileId, live);
    if (live > 1) profileViolations++;
    maxLivePerProfile = Math.max(maxLivePerProfile, live);

    this.emit("log", `start ${tabName}`);
    this.emit("status", { state: "running", page: 1, profiles: 5 });
    // Simulate work LONGER than the 1s claim interval, so the idle pod's claim
    // loop gets a turn (real scrapes take minutes). Bail early if stopped.
    for (let i = 0; i < 26 && !this._stopped; i++) await sleep(50);

    liveByProfile.set(this.profileId, (liveByProfile.get(this.profileId) || 1) - 1);
    this.emit("log", `done ${tabName}`);
    return { success: true, profiles: 25, pages: 2 };
  }
}

(async () => {
  const admin = new RedisStore(URL, "admin");
  const wipe = async () => { const k = await admin.redis.keys("sn:*"); if (k.length) await admin.redis.del(...k); };
  await wipe();

  // Two "pods", each cap 2, sharing one Redis.
  const podA = new RedisJobQueue({ redisUrl: URL, podId: "podA", podIP: "10.0.0.1", ScraperClass: MockScraper });
  const podB = new RedisJobQueue({ redisUrl: URL, podId: "podB", podIP: "10.0.0.2", ScraperClass: MockScraper });

  // A fake ws listener on podA, scoped to user "op1", to prove cross-pod fan-out.
  const received = [];
  const fakeWs = { readyState: 1, send: (m) => received.push(JSON.parse(m)) };
  podA.addListener(fakeWs, "op1");

  // ── 1) Seed work: 3 profiles × 2 jobs (op1), submitted via podB ──
  await sleep(150); // let pub/sub subscriptions settle
  for (let j = 0; j < 2; j++) {
    for (let p = 1; p <= 3; p++) {
      await podB.addSingle({
        searchUrl: `https://x/${p}-${j}`, sheetUrl: "https://sheet", tabName: `P${p}J${j}`,
        userId: "op1", profileId: `profile_${p}`,
      });
    }
  }
  const total = 6;

  // ── 2) Wait for all to finish across both pods ──
  const allDone = await waitFor(async () => {
    const jobs = await admin.getAllJobs();
    return jobs.length === total && jobs.every((j) => j.state === "done");
  });
  assert(allDone, "all 6 jobs reached done across 2 pods");
  assert(profileViolations === 0, `no profile ever ran 2 scrapes at once (violations=${profileViolations}, maxLive=${maxLivePerProfile})`);

  // Work spread across BOTH pods (not all on one) — proves cross-pod claiming.
  const allJobs = await admin.getAllJobs();
  const pods = new Set(allJobs.map((j) => j.podId));
  assert(pods.has("podA") && pods.has("podB"), `work was claimed by BOTH pods (${[...pods].join(",")})`);

  // Every claimed job recorded its owning pod's IP → the cross-pod View proxy
  // has a target to forward the live stream to.
  const ipsOk = allJobs.every((j) => j.podIP === "10.0.0.1" || j.podIP === "10.0.0.2");
  assert(ipsOk, `every job recorded its owning pod IP for View proxying`);

  // ── 3) WS fan-out: podA's listener saw events from jobs submitted on podB ──
  const sawCreated = received.some((m) => m.type === "job:created");
  const sawUpdate = received.some((m) => m.type === "job:update" && m.job && m.job.state === "done");
  assert(sawCreated, "cross-pod WS fan-out: listener received job:created");
  assert(sawUpdate, "cross-pod WS fan-out: listener received job:update (done)");

  // ── 4) active-work metric drained → KEDA can scale to zero ──
  assert((await admin.activeCount()) === 0, "active-work metric drained to 0");
  assert((await admin.redis.keys("sn:proflock:*")).length === 0, "no profile locks leaked");

  // ── 5) Graceful drain waits for an in-flight scrape ──
  await podA.addSingle({ searchUrl: "https://x/drain", sheetUrl: "https://s", tabName: "DRAIN", userId: "op1", profileId: "profile_drain" });
  // wait until it's actually running on some pod
  await waitFor(async () => (await admin.runningCount()) >= 1, 5000);
  const tDrain = Date.now();
  // drain whichever pod is running it (try both; the idle one returns instantly)
  await Promise.all([podA.drain(8000), podB.drain(8000)]);
  const drainMs = Date.now() - tDrain;
  const afterRunning = await admin.runningCount();
  if (afterRunning !== 0) {
    const runIds = await admin.redis.hkeys("sn:running");
    const jobs = await admin.getAllJobs();
    console.error("   DEBUG running ids:", runIds, "| jobs:", jobs.map((j) => `${j.tabName}:${j.state}@${j.podId}`));
    console.error("   DEBUG podA.localScrapers:", podA.localScrapers.size, "podB.localScrapers:", podB.localScrapers.size);
  }
  assert(afterRunning === 0, `drain waited for in-flight scrape to finish (running after=${afterRunning})`);
  assert(drainMs >= 50, `drain actually blocked until the scrape completed (~${drainMs}ms)`);

  // ── 6) Stop cascade cancels queued jobs for a profile ──
  // fresh pod (others drained). Seed 3 jobs same profile: 1 runs, 2 queue.
  const podC = new RedisJobQueue({ redisUrl: URL, podId: "podC", ScraperClass: MockScraper });
  for (let i = 0; i < 3; i++) {
    await podC.addSingle({ searchUrl: `https://x/s${i}`, sheetUrl: "https://s", tabName: `S${i}`, userId: "op2", profileId: "profile_stop" });
  }
  await waitFor(async () => (await admin.runningCount()) >= 1, 5000);
  await podC.stopForProfile("profile_stop");
  await waitFor(async () => {
    const jobs = (await admin.getAllJobs()).filter((j) => j.profileId === "profile_stop");
    return jobs.some((j) => j.state === "cancelled");
  }, 5000);
  const stopJobs = (await admin.getAllJobs()).filter((j) => j.profileId === "profile_stop");
  const cancelled = stopJobs.filter((j) => j.state === "cancelled").length;
  assert(cancelled >= 2, `stopForProfile cancelled the queued jobs (cancelled=${cancelled}/3)`);

  // cleanup
  await podA.close(); await podB.close(); await podC.close();
  await wipe(); await admin.close();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — Redis queue orchestration works across pods"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
