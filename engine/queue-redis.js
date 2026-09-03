// queue-redis.js
//
// Redis-backed drop-in replacement for the in-memory JobQueue (queue.js).
// Same public interface (server.js doesn't care which one it gets), but all
// shared state lives in Redis so it works across many pods (HPA).
//
// What lives where:
//   • Job metadata, queue order, per-profile locks, logs, tokens → Redis
//     (shared, via redis-store.js).
//   • Live Scraper instances (event emitters with pause/stop) → LOCAL to the
//     pod that claimed the job. They can't be serialized into Redis.
//
// How a job runs across pods:
//   1. addSingle/addBatch write the job to Redis (sn:waiting + sn:jobs).
//   2. Every pod runs a claim loop. The FIRST pod with a free slot atomically
//      claims it (CLAIM_LUA in redis-store.js locks the profile) and runs the
//      Scraper locally.
//   3. While running, the pod heartbeats the profile lock so it doesn't expire.
//   4. On finish, the pod releases the lock and removes the job from the
//      active-work metric (so KEDA can scale the pod down).
//
// Control (pause/resume/stop) may target a job running on ANOTHER pod, so it's
// published over Redis pub/sub; whichever pod owns the live Scraper acts on it.
//
// WebSocket fan-out: ws clients connect to whichever pod the load balancer
// picked, so events are published to Redis and EVERY pod relays them to its own
// local ws listeners (respecting per-user scoping).

const { v4: uuidv4 } = require("uuid");
const { RedisStore } = require("./redis-store");
const { setPodDeletionCost } = require("./pod-deletion-cost");

// Per-POD concurrency cap (not global). Total concurrency = pods × this.
const MAX_CONCURRENT_SCRAPES = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_SCRAPES || "2", 10) || 2
);

const CLAIM_INTERVAL_MS = Math.max(  // how often an idle pod looks for runnable jobs
  50,
  parseInt(process.env.CLAIM_INTERVAL_MS || "1000", 10) || 1000
);
// How often to sweep for orphaned running jobs (a pod hard-killed mid-scrape
// leaves its job stuck "running" + in sn:active). LOCK_TTL_SEC=120, so an orphan
// is detectable ~120s after the pod dies; sweeping every 60s cleans it shortly
// after. Every pod runs this; an atomic HDEL guard means only one reaps each.
const REAP_INTERVAL_MS = Math.max(
  5000,
  parseInt(process.env.REAP_INTERVAL_MS || "60000", 10) || 60000
);
const HEARTBEAT_MS = 30000;         // renew profile locks (well under LOCK_TTL_SEC=120)
const DRAIN_POLL_MS = 500;

class RedisJobQueue {
  // ScraperClass is injectable so tests can supply a mock (no real browser).
  constructor({ redisUrl, podId, podIP, podPort, ScraperClass, isWorker } = {}) {
    this.podId = podId || process.env.HOSTNAME || "pod";
    this.podIP = podIP || process.env.POD_IP || "";
    this.podPort = String(podPort || process.env.PORT || "3000");
    this.isDistributed = true; // server.js uses this to enable cross-pod View proxy
    // Role split: a WORKER claims + runs jobs; a FRONTEND only accepts jobs,
    // serves the UI/API, relays events, and proxies the live View — it never
    // executes a scrape. Default = worker (back-compat / single-deployment).
    this.isWorker = isWorker !== false;
    this.store = new RedisStore(redisUrl, this.podId, this.podIP, this.podPort);
    // Lazy-require the real Scraper (pulls in Playwright/GoLogin) only when not
    // injected — keeps tests (mock scraper) from loading the browser stack.
    this.Scraper = ScraperClass || require("./scraper");

    this.localScrapers = new Map(); // jobId → live Scraper (running on THIS pod)
    this.localMeta = new Map();     // jobId → job object (for control matching)
    this.listeners = new Map();     // ws → { userId } (local connections)
    this.draining = false;

    // Relay Redis events to local ws listeners + apply cross-pod control.
    this.store.onEvent((evt) => this._onRedisEvent(evt));

    // Background loops. Unref so they never hold the process open on their own.
    // Only WORKERS claim and run jobs (and heartbeat their running scrapes).
    if (this.isWorker) {
      this._claimTimer = setInterval(() => this._claimTick().catch(() => {}), CLAIM_INTERVAL_MS);
      this._hbTimer = setInterval(() => this._heartbeatTick().catch(() => {}), HEARTBEAT_MS);
      if (this._claimTimer.unref) this._claimTimer.unref();
      if (this._hbTimer.unref) this._hbTimer.unref();
    }
    // The reaper runs on EVERY pod — including the always-on frontend, which is
    // the ideal place to clean orphans when all workers have scaled to zero.
    this._reapTimer = setInterval(() => this._reapTick().catch(() => {}), REAP_INTERVAL_MS);
    if (this._reapTimer.unref) this._reapTimer.unref();
  }

  // ─── WebSocket fan-out (mirrors in-memory broadcast, but over Redis) ──────

  addListener(ws, userId) {
    this.listeners.set(ws, { userId: userId || null });
  }
  removeListener(ws) {
    this.listeners.delete(ws);
  }

  // Publish a ws message to ALL pods; each relays to its matching local clients.
  _broadcast(type, data, targetUserId) {
    this.store.broadcast({ kind: "ws", type, data, targetUserId: targetUserId || null });
  }

  _onRedisEvent(evt) {
    if (!evt || !evt.kind) return; // ignore store's internal low-level events
    if (evt.kind === "ws") {
      const message = JSON.stringify({ type: evt.type, ...evt.data });
      for (const [ws, info] of this.listeners) {
        try {
          if (ws.readyState !== 1) continue;
          if (evt.targetUserId && info.userId !== evt.targetUserId) continue;
          ws.send(message);
        } catch (_) {}
      }
    } else if (evt.kind === "control") {
      this._applyControl(evt);
    }
  }

  // ─── Logs ─────────────────────────────────────────────────────────────────

  async pushLog(jobId, userId, message, job) {
    // Tag lines with runId/tabName (when the job context is known) so the app
    // can attribute any log line to its board strip.
    await this.store.pushLog(jobId, userId, {
      ts: Date.now(), jobId, message,
      ...(job && job.runId ? { runId: job.runId } : {}),
      ...(job && job.tabName ? { tabName: job.tabName } : {}),
    });
  }

  async pruneFinishedJobs(maxAgeMs) {
    return this.store.pruneFinishedJobs(maxAgeMs);
  }

  // All log lines for one launch (runId), oldest first — merged across the
  // launch's jobs. Powers GET /api/scrape/runs/:runId/logs for finished strips.
  async getLogsForRun(runId) {
    if (!runId) return [];
    const jobs = (await this.store.getAllJobs()).filter((j) => j.runId === runId || j.batchId === runId);
    const all = [];
    for (const j of jobs) all.push(...(await this.store.getLogsForJob(j.id)));
    return all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }
  async getRecentLogs(since) {
    // Admin view: merge per-user lists isn't cheap; in practice the Ortus panel
    // passes userId. Without it, return this pod's nothing-special: read all
    // jobs' recent logs is heavy — keep parity by returning an empty global feed
    // and rely on per-user feeds (the UI always scopes by userId).
    return [];
  }
  async getRecentLogsForUser(userId, since) {
    const logs = await this.store.getRecentLogsForUser(userId);
    return since ? logs.filter((l) => l.ts > since) : logs;
  }

  // ─── Profile lock check ─────────────────────────────────────────────────────

  async isProfileRunning(profileId) {
    return this.store.isProfileRunning(profileId);
  }

  // ─── Job creation ───────────────────────────────────────────────────────────

  async addSingle({ searchUrl, sheetUrl, tabName, slowMode, userId, profileId, campaignName, ownerEmail, runId }) {
    const id = uuidv4();
    const job = {
      id,
      type: "single",
      searchUrl,
      sheetUrl,
      tabName: tabName || "Sheet1",
      slowMode: slowMode ?? false,
      userId: userId || "default",
      profileId: profileId || userId || "default",
      // Round-trip metadata for the app's board: a stable per-launch runId
      // (client-supplied, else this job's id) + display fields. /api/jobs
      // returns the stored object verbatim, so these echo back automatically.
      runId: runId || id,
      campaignName: campaignName || "",
      ownerEmail: ownerEmail || "",
      state: "queued",
      pages: 0,
      profiles: 0,
      createdAt: Date.now(),
    };
    await this.store.addJob(job);
    this._broadcast("job:created", { job }, job.userId);
    this._claimTick().catch(() => {});
    this._broadcastQueue().catch(() => {}); // show the submitter their position
    return job;
  }

  async addBatch({ urls, sheetUrl, tabName, slowMode, userId, profileId, campaignName, ownerEmail, runId }) {
    const batchId = uuidv4();
    // One launch = one runId shared by every job in the batch (defaults to the
    // batchId), so the app's board can render the whole launch as one strip.
    const launchRunId = runId || batchId;
    const created = [];
    for (let i = 0; i < urls.length; i++) {
      const job = {
        id: uuidv4(),
        batchId,
        type: "batch",
        searchUrl: urls[i].trim(),
        sheetUrl,
        tabName: `${tabName || "Results"} ${i + 1}`,
        slowMode: slowMode ?? false,
        userId: userId || "default",
        profileId: profileId || userId || "default",
        runId: launchRunId,
        campaignName: campaignName || "",
        ownerEmail: ownerEmail || "",
        state: "queued",
        pages: 0,
        profiles: 0,
        createdAt: Date.now(),
        index: i + 1,
        total: urls.length,
      };
      await this.store.addJob(job);
      created.push(job);
    }
    this._broadcast("batch:created", { batchId, jobs: created }, userId || "default");
    this._claimTick().catch(() => {});
    this._broadcastQueue().catch(() => {}); // show the submitter their positions
    return { batchId, jobs: created };
  }

  // ─── Claim loop ─────────────────────────────────────────────────────────────

  async _claimTick() {
    // Frontends never claim/run jobs (defense — they don't start the timer, but
    // addSingle/addBatch also kick a tick on submit).
    if (!this.isWorker) return;
    // Skip if draining, or if a claim is already in flight (prevents overlapping
    // ticks from over-claiming past the cap, and lets drain() wait through a
    // claim-in-progress so SIGTERM can't slip between claim and run).
    if (this.draining || this._claiming) return;
    this._claiming = true;
    let claimedAny = false;
    try {
      let available = MAX_CONCURRENT_SCRAPES - this.localScrapers.size;
      while (available > 0) {
        const job = await this.store.claimNextJob(); // atomically claims + locks profile
        if (!job) break;                              // nothing runnable right now
        available--;
        claimedAny = true;
        this._runJob(job); // fire and forget; runs on this pod
      }
    } finally {
      this._claiming = false;
    }
    // A claim shifts everyone's position — push fresh positions/ETAs.
    if (claimedAny) this._broadcastQueue().catch(() => {});
  }

  async _runJob(job) {
    job.state = "running";
    this.localMeta.set(job.id, job);
    this._broadcast("job:update", { job }, job.userId);

    const scraper = new this.Scraper({
      slowMode: job.slowMode,
      userId: job.userId,
      profileId: job.profileId,
    });
    this.localScrapers.set(job.id, scraper);
    this._refreshDeletionCost(); // busy now → protect this pod from scale-down

    scraper.on("log", (message) => {
      this.pushLog(job.id, job.userId, message, job).catch(() => {});
      this._broadcast("log", { jobId: job.id, runId: job.runId, tabName: job.tabName, message }, job.userId);
    });
    scraper.on("status", (status) => {
      job.state = status.state;
      job.pages = status.page;
      job.profiles = status.profiles;
      this.store.updateJob(job.id, { state: job.state, pages: job.pages, profiles: job.profiles }).catch(() => {});
      this._broadcast("job:update", { job }, job.userId);
    });
    scraper.on("sheet-permission-error", (info) => {
      this._broadcast("sheet:permission-error", { jobId: job.id, ...info }, job.userId);
      this._cancelQueuedForUser(job.userId, "Cancelled — destination sheet not shared with service account.").catch(() => {});
    });

    try {
      const result = await scraper.scrapeSingle({
        searchUrl: job.searchUrl,
        sheetUrl: job.sheetUrl,
        tabName: job.tabName,
      });
      job.state = result.success ? "done" : "error";
      job.profiles = result.profiles || job.profiles;
      job.pages = result.pages || job.pages;
      if (!result.success) job.error = result.reason;
    } catch (err) {
      job.state = "error";
      job.error = err.message;
    }

    // Release the profile lock + drop from active-work metric.
    await this.store.finishJob(job.id, {
      state: job.state,
      pages: job.pages,
      profiles: job.profiles,
      error: job.error,
    }).catch(() => {});
    this.localScrapers.delete(job.id);
    this.localMeta.delete(job.id);
    this._refreshDeletionCost(); // one fewer scrape → lower cost (idle pod = 0, evicted first)
    this._broadcast("job:update", { job }, job.userId);
    this._broadcastQueue().catch(() => {}); // a finish frees a slot → positions shift

    // Rate-limit cascade: cancel this user's remaining queued jobs.
    if (job.error && (job.error.includes("Rate limited") || job.error.includes("429") || job.error.includes("throttle"))) {
      const n = await this._cancelQueuedForUser(job.userId, "Cancelled — account is rate limited. Wait 15-30 minutes.").catch(() => 0);
      if (n > 0) {
        this._broadcast("log", { jobId: job.id, message: `🚫  Cancelled ${n} remaining job(s) — account is rate limited. Wait 15-30 minutes before scraping again.` }, job.userId);
      }
    }

    if (!this.draining) this._claimTick().catch(() => {});
  }

  // Recompute queue positions/ETAs and push them to clients. Per-job position
  // goes only to the owning operator (scoped WS); aggregate stats go to all.
  // Called whenever the queue changes (submit, claim, finish). Best-effort.
  async _broadcastQueue() {
    try {
      const snap = await this.store.queueSnapshot();
      for (const [jobId, pos] of Object.entries(snap.jobs || {})) {
        this._broadcast("queue:position", { jobId, ...pos }, pos.userId);
      }
      this._broadcast("queue:stats", snap.stats || {}, null);
    } catch (_) {}
  }

  // Snapshot for the REST poll fallback (GET /api/scrape/queue).
  async queueSnapshot() {
    return this.store.queueSnapshot();
  }

  // Stamp this pod's scale-down priority via the K8s pod-deletion-cost annotation.
  // cost = number of in-flight scrapes; idle pods (0) are evicted first on
  // scale-down, so a long scrape is never cut mid-run. No-op outside the cluster
  // (local/tests) and on the frontend. Best-effort — never throws.
  _refreshDeletionCost() {
    if (!this.isWorker) return;
    setPodDeletionCost(this.localScrapers.size).catch(() => {});
  }

  async _heartbeatTick() {
    for (const job of this.localMeta.values()) {
      await this.store.heartbeat(job).catch(() => {});
    }
  }

  // Sweep for orphaned running jobs (owner pod hard-killed → job stuck running +
  // wedged in sn:active, which would block scale-to-zero). Never touches jobs
  // running on THIS pod (still in localScrapers). The store's reap is atomic, so
  // running this on every pod is safe — only one wins each orphan.
  async _reapTick() {
    const ids = await this.store.listRunningJobIds();
    for (const jobId of ids) {
      if (this.localScrapers.has(jobId)) continue; // ours, alive — never reap
      const reaped = await this.store.reapIfOrphaned(jobId);
      if (reaped) {
        this._broadcast("job:update", { job: reaped }, reaped.userId);
        this._broadcast(
          "log",
          { jobId, message: "⚠️  Scrape interrupted — the worker pod ended before it finished. Re-run to complete." },
          reaped.userId
        );
      }
    }
  }

  // ─── Cancel queued jobs (cascades) ─────────────────────────────────────────

  async _cancelQueuedForUser(userId, reason) {
    const waiting = await this.store.listWaiting();
    let n = 0;
    for (const job of waiting) {
      if (job.userId !== userId) continue;
      const removed = await this.store.removeFromQueue(job.id, job.profileId);
      if (!removed) continue;
      const updated = await this.store.updateJob(job.id, { state: "cancelled", error: reason, finishedAt: Date.now() });
      this._broadcast("job:update", { job: updated || { ...job, state: "cancelled", error: reason } }, userId);
      n++;
    }
    return n;
  }

  async _cancelQueuedForProfile(profileId) {
    const waiting = await this.store.listWaiting();
    for (const job of waiting) {
      if (job.profileId !== profileId) continue;
      const removed = await this.store.removeFromQueue(job.id, job.profileId);
      if (!removed) continue;
      const updated = await this.store.updateJob(job.id, { state: "cancelled", finishedAt: Date.now() });
      this._broadcast("job:update", { job: updated || { ...job, state: "cancelled" } }, job.userId);
    }
  }

  // ─── Control (pause / resume / stop) — routed across pods via pub/sub ───────

  _broadcastControl(action, selector) {
    this.store.broadcast({ kind: "control", action, ...selector });
  }

  // Applied on the pod that actually owns the live Scraper.
  _applyControl(evt) {
    for (const [jobId, scraper] of this.localScrapers) {
      const meta = this.localMeta.get(jobId);
      if (!meta) continue;
      if (evt.profileId && meta.profileId !== evt.profileId) continue;
      if (evt.userId && meta.userId !== evt.userId) continue;
      try {
        if (evt.action === "pause") scraper.pause();
        else if (evt.action === "resume") scraper.resume();
        else if (evt.action === "stop") scraper.stop();
      } catch (_) {}
    }
  }

  pauseForProfile(profileId) { this._broadcastControl("pause", { profileId }); }
  resumeForProfile(profileId) { this._broadcastControl("resume", { profileId }); }
  async stopForProfile(profileId) {
    this._broadcastControl("stop", { profileId });        // owning pod stops live scraper
    await this._cancelQueuedForProfile(profileId);         // cancel its queued jobs
  }
  pauseForUser(userId) { this._broadcastControl("pause", { userId }); }
  resumeForUser(userId) { this._broadcastControl("resume", { userId }); }
  async stopForUser(userId) {
    this._broadcastControl("stop", { userId });
    await this._cancelQueuedForUser(userId, "Cancelled by operator.");
  }

  // ─── Auth session tokens (shared across pods via Redis) ────────────────────
  async addToken(token) { return this.store.addToken(token); }
  async hasToken(token) { return this.store.hasToken(token); }
  async removeToken(token) { return this.store.removeToken(token); }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async getJobsForUser(userId) {
    const jobs = await this.store.getJobsForUser(userId);
    return jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  async getAllJobs() {
    const jobs = await this.store.getAllJobs();
    return jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  // Per-job live View only works on the pod running the job. If the job runs on
  // another pod, this returns null here (the View would 404). A cross-pod View
  // proxy is a later enhancement — noted for Phase 3.
  getRunningScraper(jobId) {
    return this.localScrapers.get(jobId) || null;
  }

  // Job record (incl. podId/podIP) so server.js can decide whether to serve the
  // live View locally or proxy it to the pod that owns the running scrape.
  async getJob(jobId) {
    return this.store.getJob(jobId);
  }

  // ─── Graceful drain (SIGTERM) ───────────────────────────────────────────────
  //
  // Stop claiming NEW work, then wait for in-flight scrapes on this pod to
  // FINISH (we do NOT kill them — that's the whole point of safe scale-down).
  // K8s must allow enough terminationGracePeriodSeconds for a scrape to complete.
  async drain(timeoutMs = 1100000) {
    this.draining = true;
    clearInterval(this._claimTimer);
    const deadline = Date.now() + timeoutMs;
    // Wait through both in-flight scrapes AND a claim-in-progress (a job may be
    // claimed in Redis a hair before its local Scraper is registered).
    while ((this.localScrapers.size > 0 || this._claiming) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
    clearInterval(this._hbTimer);
    clearInterval(this._reapTimer);
    // Any scrape still running past the deadline keeps its job marked "running";
    // its profile lock will expire via TTL so the profile isn't stuck. The pod
    // is being force-killed at this point regardless.
    return { drained: this.localScrapers.size === 0, stillRunning: this.localScrapers.size };
  }

  async close() {
    clearInterval(this._claimTimer);
    clearInterval(this._hbTimer);
    clearInterval(this._reapTimer);
    await this.store.close();
  }
}

module.exports = { RedisJobQueue };
