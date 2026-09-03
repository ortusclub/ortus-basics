// test-frontend-worker.js
//
// Proves the front-door / worker split:
//   • a FRONTEND queue (isWorker:false) accepts jobs but NEVER claims/runs them
//   • a WORKER queue (isWorker:true) claims and runs them
//   • events from the worker still reach the frontend's listeners (Redis fan-out)
//   • with NO worker present, jobs stay queued (proving the frontend can't run them)
//
// Run:  REDIS_URL=redis://localhost:6379 node test-frontend-worker.js

process.env.CLAIM_INTERVAL_MS = "100";
const EventEmitter = require("events");
const { RedisJobQueue } = require("./queue-redis");
const { RedisStore } = require("./redis-store");
const URL = process.env.REDIS_URL || "redis://localhost:6379";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, t = 6000, s = 100) { const end = Date.now() + t; while (Date.now() < end) { if (await fn()) return true; await sleep(s); } return false; }

class MockScraper extends EventEmitter {
  constructor({ profileId }) { super(); this.profileId = profileId; this._stop = false; }
  pause() {} resume() {} stop() { this._stop = true; }
  async scrapeSingle() { this.emit("status", { state: "running", page: 1, profiles: 5 }); for (let i = 0; i < 8 && !this._stop; i++) await sleep(40); return { success: true, profiles: 25, pages: 2 }; }
}

(async () => {
  const admin = new RedisStore(URL, "admin");
  const wipe = async () => { const k = await admin.redis.keys("sn:*"); if (k.length) await admin.redis.del(...k); };
  await wipe();

  // FRONTEND only — no worker yet.
  const frontend = new RedisJobQueue({ redisUrl: URL, podId: "frontend", podIP: "10.0.0.1", isWorker: false, ScraperClass: MockScraper });
  const received = [];
  frontend.addListener({ readyState: 1, send: (m) => received.push(JSON.parse(m)) }, "op1");
  await sleep(150);

  // Submit via the frontend.
  await frontend.addSingle({ searchUrl: "https://x/1", sheetUrl: "https://s", tabName: "T1", userId: "op1", profileId: "pA" });

  // With NO worker, the job must stay queued (frontend can't run it).
  await sleep(800);
  assert((await admin.runningCount()) === 0, "with only a FRONTEND, the job is NOT claimed (stays queued)");
  assert((await admin.redis.llen("sn:waiting")) === 1, "job is sitting in the queue, waiting for a worker");

  // Now bring up a WORKER.
  const worker = new RedisJobQueue({ redisUrl: URL, podId: "worker", podIP: "10.0.0.2", isWorker: true, ScraperClass: MockScraper });

  // Worker should claim + run it to completion.
  const done = await waitFor(async () => {
    const jobs = await admin.getAllJobs();
    return jobs.length === 1 && jobs[0].state === "done";
  });
  assert(done, "WORKER claimed and ran the frontend-submitted job to done");
  const job = (await admin.getAllJobs())[0];
  assert(job.podId === "worker", "the job ran on the WORKER pod (not the frontend)");

  // The frontend's listener got the lifecycle events via Redis fan-out.
  assert(received.some((m) => m.type === "job:created"), "frontend listener saw job:created");
  assert(received.some((m) => m.type === "job:update" && m.job && m.job.state === "done"), "frontend listener saw the worker's done update (cross-pod fan-out)");

  // Frontend never registered a local scraper.
  assert(frontend.localScrapers.size === 0, "frontend ran ZERO scrapers locally");
  assert(worker.localScrapers.size === 0, "worker finished and released its scraper");

  await frontend.close(); await worker.close();
  await wipe(); await admin.close();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — front-door / worker split works"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
