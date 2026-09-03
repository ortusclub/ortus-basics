// redis-store.js
//
// Shared, cross-pod state for horizontal scaling (HPA).
//
// Today the engine keeps everything in process memory:
//   - queue.js : jobs / queue / running Maps + the per-profile lock
//   - server.js: a `tokens` Set for auth
// That works with ONE pod. The moment a second pod exists, each pod has its
// own copy of those Maps, so:
//   - two pods could claim the SAME GoLogin profile at once (two browsers on
//     one LinkedIn account → bans / corrupted sessions), and
//   - a WS client connected to pod A can't see a job running on pod B.
//
// This module moves that state into Redis so every pod reads/writes the same
// source of truth. The single most important guarantee is the ATOMIC CLAIM:
// claiming the next job AND locking its profile happen in one Lua script that
// Redis runs without interleaving, so two pods racing for the same profile can
// never both win.
//
// Keys (all prefixed `sn:`):
//   sn:jobs                 HASH   jobId -> JSON(job)            (all jobs)
//   sn:waiting              LIST   jobIds, FIFO (RPUSH / LPOP)   (queue)
//   sn:running              HASH   jobId -> JSON(job)            (claimed)
//   sn:proflock:<profileId> STRING jobId, TTL'd                  (per-profile lock)
//   sn:user:<userId>:jobs   ZSET   jobId by createdAt           (per-operator index)
//   sn:logs:<jobId>         LIST   JSON(logLine), capped         (per-job logs)
//   sn:userlogs:<userId>    LIST   JSON(logLine), capped         (per-operator recent logs)
//   sn:tokens               SET    session tokens               (auth)
//   sn:events               PUBSUB broadcast channel            (WS fan-out)

const Redis = require("ioredis");

// How long a profile lock lives without a heartbeat. If a pod dies mid-scrape,
// the lock auto-expires after this so the profile isn't stuck forever. The
// owning pod must heartbeat (renew) well inside this window.
const LOCK_TTL_SEC = 120;

// Caps so log lists can't grow without bound (matches the old in-memory caps).
const JOB_LOG_CAP = 5000;
const USER_LOG_CAP = 500;
// Per-job log lists also expire — historically they had no TTL, so every job
// ever run left a list in Redis forever. 14 days comfortably outlives the
// app board's "recent runs" window.
const JOB_LOG_TTL_SEC = 14 * 24 * 3600;

// --- Queue-position ETA tuning ----------------------------------------------
// Rolling average completed-scrape duration (EMA in sn:stats:avgjobms) drives
// the "~N min until your scrape starts" estimate. Until we have real samples we
// assume DEFAULT_AVG_JOB_MS. Only sane completions feed the average (between the
// floor and ceiling) so a 2-second failure or a stuck job can't skew it.
const AVG_JOB_KEY = "sn:stats:avgjobms";
const DEFAULT_AVG_JOB_MS = 3 * 60 * 1000; // 3 min, used before we have samples
const MIN_SAMPLE_MS = 5 * 1000;           // ignore sub-5s blips (instant failures)
const MAX_SAMPLE_MS = 2 * 60 * 60 * 1000; // ignore >2h outliers (stuck/orphaned)
const EMA_ALPHA = 0.2;                     // weight of the newest sample
// How many scrapes can run at once = worker replicas × per-pod concurrency.
// Used only to cap the ETA's parallelism (the per-account lock is the real
// limiter — each account runs one scrape at a time).
const SCALE_CAPACITY = Math.max(
  1,
  (parseInt(process.env.MAX_WORKERS || "5", 10) || 5) *
    (parseInt(process.env.MAX_CONCURRENT_SCRAPES || "2", 10) || 2)
);

// --- Atomic claim-and-lock --------------------------------------------------
// Walk the waiting list oldest-first. For each candidate job, try to acquire
// its profile lock with SET NX. The FIRST job whose profile is free is claimed:
// we set the lock (with TTL), move the job hash from waiting->running, and
// return it. Jobs whose profile is busy are left in the queue (we re-queue them
// at the tail so we don't head-of-line block other operators' free profiles).
//
// All of this runs inside ONE Redis call, so no other pod can observe a
// half-claimed state or grab the same profile concurrently.
//
// KEYS[1]=sn:waiting  KEYS[2]=sn:running  KEYS[3]=sn:jobs
// ARGV[1]=lock-key-prefix ("sn:proflock:")  ARGV[2]=podId  ARGV[3]=LOCK_TTL_SEC
// ARGV[4]=podIP  ARGV[5]=podPort (so any pod can proxy the live View to the
// owning pod at podIP:podPort)
const CLAIM_LUA = `
local waiting = KEYS[1]
local running = KEYS[2]
local jobs    = KEYS[3]
local prefix  = ARGV[1]
local podId   = ARGV[2]
local ttl     = tonumber(ARGV[3])
local podIP   = ARGV[4]
local podPort = ARGV[5]

local n = redis.call('LLEN', waiting)
local skipped = {}
local claimed = nil
-- server clock (ms) so we can measure scrape duration at finish (for ETAs)
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

for i = 1, n do
  local jobId = redis.call('LPOP', waiting)
  if not jobId then break end
  local raw = redis.call('HGET', jobs, jobId)
  if not raw then
    -- job vanished (cancelled); drop it
  else
    local job = cjson.decode(raw)
    local pid = job['profileId']
    if pid == nil or pid == '' then
      -- no profile to lock (shouldn't happen for scrapes); claim it
      job['state'] = 'running'
      job['startedAt'] = nowMs
      job['podId'] = podId
      job['podIP'] = podIP
      job['podPort'] = podPort
      local enc = cjson.encode(job)
      redis.call('HSET', jobs, jobId, enc)
      redis.call('HSET', running, jobId, enc)
      claimed = enc
      break
    else
      local lockKey = prefix .. pid
      local ok = redis.call('SET', lockKey, jobId, 'NX', 'EX', ttl)
      if ok then
        job['state'] = 'running'
        job['startedAt'] = nowMs
        job['podId'] = podId
        job['podIP'] = podIP
        job['podPort'] = podPort
        job['lockKey'] = lockKey
        local enc = cjson.encode(job)
        redis.call('HSET', jobs, jobId, enc)
        redis.call('HSET', running, jobId, enc)
        claimed = enc
        break
      else
        -- profile busy elsewhere; remember to requeue at tail
        table.insert(skipped, jobId)
      end
    end
  end
end

-- put the profile-busy jobs back at the END so other operators flow through
for i = 1, #skipped do
  redis.call('RPUSH', waiting, skipped[i])
end

return claimed
`;

class RedisStore {
  // podId identifies this replica (K8s pod name) so we can attribute locks /
  // running jobs to the pod that owns them and recover them if it dies.
  constructor(url, podId, podIP, podPort) {
    this.podId = podId || "local";
    this.podIP = podIP || "";
    this.podPort = String(podPort || "");
    // Main connection for commands.
    this.redis = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    // Dedicated connections for pub/sub (a subscribed connection can't run
    // normal commands).
    this.pub = new Redis(url, { maxRetriesPerRequest: null });
    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    this._claimSha = null;
    this._listeners = new Set();

    this.sub.subscribe("sn:events").catch(() => {});
    this.sub.on("message", (_chan, msg) => {
      let evt;
      try { evt = JSON.parse(msg); } catch { return; }
      for (const fn of this._listeners) {
        try { fn(evt); } catch { /* listener errors must not break fan-out */ }
      }
    });
  }

  async _loadClaim() {
    if (!this._claimSha) {
      this._claimSha = await this.redis.script("LOAD", CLAIM_LUA);
    }
    return this._claimSha;
  }

  // --- Jobs -----------------------------------------------------------------

  // Add a job to the queue. `job` must carry at least { id, userId, profileId,
  // createdAt }. Stored in the jobs hash + appended to the FIFO waiting list +
  // indexed under the operator.
  async addJob(job) {
    const enc = JSON.stringify(job);
    const pipe = this.redis.pipeline();
    pipe.hset("sn:jobs", job.id, enc);
    pipe.rpush("sn:waiting", job.id);
    // sn:active = waiting + running (all in-flight jobs). Kept for diagnostics
    // and the drain checks.
    pipe.rpush("sn:active", job.id);
    if (job.userId) pipe.zadd(`sn:user:${job.userId}:jobs`, job.createdAt || 0, job.id);
    await pipe.exec();
    // Track this account as having active work. KEDA scales on the COUNT OF
    // DISTINCT ACCOUNTS (sn:scaleaccounts), not raw jobs — because one account
    // can only run one scrape at a time, so N jobs on one account need 1 worker,
    // not N/2.
    if (job.profileId) await this._acctActivate(job.profileId);
    return job;
  }

  // Atomically claim the next runnable job for THIS pod (see CLAIM_LUA). Returns
  // the claimed job object, or null if nothing is runnable (queue empty or every
  // queued job's profile is currently locked).
  async claimNextJob() {
    const sha = await this._loadClaim();
    let raw;
    try {
      raw = await this.redis.evalsha(
        sha, 3,
        "sn:waiting", "sn:running", "sn:jobs",
        "sn:proflock:", this.podId, String(LOCK_TTL_SEC), this.podIP, this.podPort
      );
    } catch (e) {
      // Script flushed from Redis (e.g. FLUSHALL / failover) → reload once.
      if (String(e && e.message).includes("NOSCRIPT")) {
        this._claimSha = null;
        const sha2 = await this._loadClaim();
        raw = await this.redis.evalsha(
          sha2, 3,
          "sn:waiting", "sn:running", "sn:jobs",
          "sn:proflock:", this.podId, String(LOCK_TTL_SEC)
        );
      } else {
        throw e;
      }
    }
    if (!raw) return null;
    return JSON.parse(raw);
  }

  // Renew the profile lock for a running job so it doesn't expire mid-scrape.
  // Call on an interval (well under LOCK_TTL_SEC) from the owning pod.
  async heartbeat(job) {
    if (!job || !job.profileId) return;
    const lockKey = `sn:proflock:${job.profileId}`;
    // Only renew if WE still hold it (value === our jobId), else a no-op.
    const HEARTBEAT_LUA =
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end";
    return this.redis.eval(HEARTBEAT_LUA, 1, lockKey, job.id, String(LOCK_TTL_SEC));
  }

  // Patch fields on a job (status, progress, counts…) wherever it lives.
  async updateJob(jobId, patch) {
    const raw = await this.redis.hget("sn:jobs", jobId);
    if (!raw) return null;
    const job = { ...JSON.parse(raw), ...patch };
    const enc = JSON.stringify(job);
    const pipe = this.redis.pipeline();
    pipe.hset("sn:jobs", jobId, enc);
    if (await this.redis.hexists("sn:running", jobId)) pipe.hset("sn:running", jobId, enc);
    await pipe.exec();
    return job;
  }

  // Finish a job (done/error/cancelled): release its profile lock and remove it
  // from the running set. The lock is released with a check-and-delete so we
  // only ever delete OUR lock, never one a later job re-acquired.
  async finishJob(jobId, finalPatch = {}) {
    const raw = await this.redis.hget("sn:jobs", jobId);
    if (!raw) return null;
    // finishedAt powers the app board's "Done N ago"; an explicit patch wins.
    const job = { ...JSON.parse(raw), state: "done", finishedAt: Date.now(), ...finalPatch };
    const enc = JSON.stringify(job);

    const RELEASE_LUA =
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

    const pipe = this.redis.pipeline();
    pipe.hset("sn:jobs", jobId, enc);
    pipe.hdel("sn:running", jobId);
    pipe.lrem("sn:active", 0, jobId);
    const res = await pipe.exec();
    const wasActive = (res?.[2]?.[1] || 0) > 0; // lrem(sn:active) removed it
    if (job.profileId) {
      await this.redis.eval(RELEASE_LUA, 1, `sn:proflock:${job.profileId}`, jobId);
      // Decrement this account's active-job count (only if THIS call removed the
      // job — guards against a double finishJob over-decrementing).
      if (wasActive) await this._acctDeactivate(job.profileId);
    }
    // Feed the rolling avg-duration used for queue ETAs (best-effort, never
    // allowed to affect the finish path).
    try { await this._recordDuration(job); } catch (_) {}
    return job;
  }

  // Update the EMA of completed-scrape duration (sn:stats:avgjobms). Only sane
  // successful completions count, so failures/orphans can't skew the ETA.
  async _recordDuration(job) {
    if (!job || job.state !== "done" || !job.startedAt) return;
    const dur = Date.now() - Number(job.startedAt);
    if (!(dur >= MIN_SAMPLE_MS && dur <= MAX_SAMPLE_MS)) return;
    const prev = parseFloat(await this.redis.get(AVG_JOB_KEY));
    const next = Number.isFinite(prev) ? prev * (1 - EMA_ALPHA) + dur * EMA_ALPHA : dur;
    await this.redis.set(AVG_JOB_KEY, String(Math.round(next)));
  }

  // Snapshot the queue for position/ETA display. Reads the waiting list in
  // order, plus the running set, and computes for EACH waiting job:
  //   position      1-based place in line
  //   jobsAhead     how many jobs are ahead of it
  //   accountsAhead distinct LinkedIn accounts ahead of it
  //   etaMs         rough "time until it starts" estimate
  // Returns { stats, jobs: { jobId -> {position, jobsAhead, accountsAhead, etaMs, userId} } }.
  //
  // ETA model (deliberately rough — labelled an estimate in the UI): jobs flow
  // through `parallelism` lanes, where parallelism = distinct accounts with work
  // (the per-account lock serialises each account), capped by worker capacity.
  // eta ≈ ceil(jobsAhead / parallelism) × avgJobMs.
  async queueSnapshot() {
    const ids = await this.redis.lrange("sn:waiting", 0, -1);
    const runningRaws = await this.redis.hvals("sn:running");
    const avg = parseFloat(await this.redis.get(AVG_JOB_KEY));
    const avgJobMs = Number.isFinite(avg) && avg > 0 ? avg : DEFAULT_AVG_JOB_MS;

    const running = runningRaws.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    const runningAccounts = new Set(running.map((j) => j.profileId).filter(Boolean));

    const out = { stats: {}, jobs: {} };
    if (!ids.length) {
      out.stats = {
        waiting: 0,
        running: running.length,
        activeAccounts: runningAccounts.size,
        avgJobMs,
      };
      return out;
    }

    const raws = await this.redis.hmget("sn:jobs", ...ids);
    const seenAccounts = new Set(runningAccounts); // accounts already consuming a lane
    let jobsAhead = 0;
    for (let i = 0; i < ids.length; i++) {
      const raw = raws[i];
      if (!raw) continue; // cancelled/vanished — skip (don't count as ahead)
      let job; try { job = JSON.parse(raw); } catch { continue; }

      const accountsAhead = seenAccounts.size;
      // Lanes available to clear the work ahead of this job.
      const parallelism = Math.max(1, Math.min(accountsAhead || 1, SCALE_CAPACITY));
      const etaMs = Math.round((jobsAhead / parallelism) * avgJobMs);

      out.jobs[ids[i]] = {
        position: jobsAhead + 1,
        jobsAhead,
        accountsAhead,
        etaMs,
        userId: job.userId || null,
      };

      jobsAhead++;
      if (job.profileId) seenAccounts.add(job.profileId);
    }

    out.stats = {
      waiting: jobsAhead,
      running: running.length,
      activeAccounts: runningAccounts.size,
      avgJobMs,
    };
    return out;
  }

  // True if a profile is currently locked (a scrape is running on it anywhere).
  async isProfileRunning(profileId) {
    if (!profileId) return false;
    return (await this.redis.exists(`sn:proflock:${profileId}`)) === 1;
  }

  async getJob(jobId) {
    const raw = await this.redis.hget("sn:jobs", jobId);
    return raw ? JSON.parse(raw) : null;
  }

  async getAllJobs() {
    const all = await this.redis.hgetall("sn:jobs");
    return Object.values(all).map((s) => JSON.parse(s));
  }

  // Drop FINISHED jobs (done/error/cancelled) older than maxAgeMs from the jobs
  // hash + user indexes + their log lists. sn:jobs historically grew forever
  // (hundreds of stale records), which polluted the app board with ancient
  // DONE/ERROR rows. Queued/running jobs are never touched. Returns pruned count.
  async pruneFinishedJobs(maxAgeMs = 14 * 24 * 3600 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const all = await this.redis.hgetall("sn:jobs");
    let pruned = 0;
    for (const [id, raw] of Object.entries(all)) {
      let job;
      try { job = JSON.parse(raw); } catch { job = null; }
      // Unparseable records are stale garbage — prune them too.
      const finished = !job || ["done", "error", "cancelled"].includes(job.state);
      const stamp = job ? (job.finishedAt || job.createdAt || 0) : 0;
      if (!finished || stamp > cutoff) continue;
      const pipe = this.redis.pipeline();
      pipe.hdel("sn:jobs", id);
      pipe.del(`sn:logs:${id}`);
      if (job && job.userId) pipe.zrem(`sn:user:${job.userId}:jobs`, id);
      await pipe.exec();
      pruned++;
    }
    return pruned;
  }

  async getJobsForUser(userId) {
    const ids = await this.redis.zrevrange(`sn:user:${userId}:jobs`, 0, -1);
    if (!ids.length) return [];
    const raws = await this.redis.hmget("sn:jobs", ...ids);
    return raws.filter(Boolean).map((s) => JSON.parse(s));
  }

  async runningCount() {
    return this.redis.hlen("sn:running");
  }

  // Job ids currently in the running set (for the orphan reaper to sweep).
  async listRunningJobIds() {
    return this.redis.hkeys("sn:running");
  }

  // Reap a running job IF it's orphaned — i.e. its profile lock is no longer
  // held by it (the owning pod died, so the lock TTL-expired, or a newer job
  // re-acquired the profile). Atomic: HDEL on sn:running is the "claim to reap",
  // so across pods only ONE reaper wins and finalizes the job. Returns the
  // patched job if THIS caller reaped it, else null (still running, no profile
  // to verify, or another pod reaped it first).
  async reapIfOrphaned(jobId) {
    const raw = await this.redis.hget("sn:running", jobId);
    if (!raw) return null;
    const job = JSON.parse(raw);
    // Only profile-locked jobs can be safely verified as orphaned. (Scrapes
    // always have a profileId; skip anything without one to avoid false reaps.)
    if (!job.profileId) return null;
    const lockVal = await this.redis.get(`sn:proflock:${job.profileId}`);
    if (lockVal === jobId) return null; // lock still held by this job → alive

    // Orphaned. Claim the reap atomically.
    const removed = await this.redis.hdel("sn:running", jobId);
    if (removed !== 1) return null; // another pod won the reap
    await this.redis.lrem("sn:active", 0, jobId);
    await this._acctDeactivate(job.profileId); // free this account's scale slot

    const curRaw = await this.redis.hget("sn:jobs", jobId);
    let patched = job;
    if (curRaw) {
      patched = JSON.parse(curRaw);
      if (patched.state === "running" || patched.state === "queued") {
        patched.state = "error";
        patched.error =
          patched.error ||
          `Interrupted — worker pod ended before finishing (partial: ${patched.profiles || 0} profiles written). Re-run to complete.`;
        await this.redis.hset("sn:jobs", jobId, JSON.stringify(patched));
      }
    }
    return patched;
  }

  // waiting + running. This is the metric KEDA's Redis trigger scales on.
  async activeCount() {
    return this.redis.llen("sn:active");
  }

  // Jobs still in the queue (not yet claimed), oldest first.
  async listWaiting() {
    const ids = await this.redis.lrange("sn:waiting", 0, -1);
    if (!ids.length) return [];
    const raws = await this.redis.hmget("sn:jobs", ...ids);
    return raws.filter(Boolean).map((s) => JSON.parse(s));
  }

  // Pull a still-queued job out of the queue (used to cancel it). Removes it
  // from the waiting list + sn:active, and decrements its account's active count.
  // Returns true if it was actually in the queue (not already claimed/running).
  async removeFromQueue(jobId, profileId) {
    const pipe = this.redis.pipeline();
    pipe.lrem("sn:waiting", 0, jobId);
    pipe.lrem("sn:active", 0, jobId);
    const res = await pipe.exec();
    const removedWaiting = (res?.[0]?.[1] || 0) > 0;
    const removedActive = (res?.[1]?.[1] || 0) > 0;
    if (removedActive && profileId) await this._acctDeactivate(profileId);
    return removedWaiting;
  }

  // ─── Distinct-account scale metric ──────────────────────────────────────────
  // sn:scaleaccounts holds each account that currently has active work, exactly
  // once. LLEN(sn:scaleaccounts) = distinct active accounts = the real max
  // concurrency. KEDA scales on this (÷2 per pod). Per-account counts live in
  // sn:profactive:<id>; the transitions 0→1 (add) and 1→0 (remove) are done in
  // one atomic Lua each so concurrent pods can't double-add or miss a removal.
  async _acctActivate(profileId) {
    const ADD =
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('RPUSH',KEYS[2],ARGV[1]) end; return n";
    return this.redis.eval(ADD, 2, `sn:profactive:${profileId}`, "sn:scaleaccounts", profileId);
  }
  async _acctDeactivate(profileId) {
    const REM =
      "local n=redis.call('DECR',KEYS[1]); if n<=0 then redis.call('DEL',KEYS[1]); redis.call('LREM',KEYS[2],0,ARGV[1]); return 0 end; return n";
    return this.redis.eval(REM, 2, `sn:profactive:${profileId}`, "sn:scaleaccounts", profileId);
  }
  // Distinct active accounts — what KEDA scales on (the test asserts this).
  async scaleAccountsCount() {
    return this.redis.llen("sn:scaleaccounts");
  }

  // --- Logs -----------------------------------------------------------------

  async pushLog(jobId, userId, line) {
    const enc = JSON.stringify(line);
    const pipe = this.redis.pipeline();
    pipe.rpush(`sn:logs:${jobId}`, enc);
    pipe.ltrim(`sn:logs:${jobId}`, -JOB_LOG_CAP, -1);
    pipe.expire(`sn:logs:${jobId}`, JOB_LOG_TTL_SEC);
    if (userId) {
      pipe.rpush(`sn:userlogs:${userId}`, enc);
      pipe.ltrim(`sn:userlogs:${userId}`, -USER_LOG_CAP, -1);
    }
    await pipe.exec();
  }

  async getLogsForJob(jobId) {
    const raws = await this.redis.lrange(`sn:logs:${jobId}`, 0, -1);
    return raws.map((s) => JSON.parse(s));
  }

  async getRecentLogsForUser(userId) {
    const raws = await this.redis.lrange(`sn:userlogs:${userId}`, 0, -1);
    return raws.map((s) => JSON.parse(s));
  }

  // --- Auth tokens ----------------------------------------------------------

  async addToken(token) { return this.redis.sadd("sn:tokens", token); }
  async removeToken(token) { return this.redis.srem("sn:tokens", token); }
  async hasToken(token) { return (await this.redis.sismember("sn:tokens", token)) === 1; }

  // --- Pub/Sub --------------------------------------------------------------

  async broadcast(evt) {
    try { await this.pub.publish("sn:events", JSON.stringify(evt)); } catch { /* non-fatal */ }
  }

  onEvent(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  async close() {
    try { await this.redis.quit(); } catch {}
    try { await this.pub.quit(); } catch {}
    try { await this.sub.quit(); } catch {}
  }
}

module.exports = { RedisStore, LOCK_TTL_SEC };
