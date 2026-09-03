const { v4: uuidv4 } = require("uuid");
const Scraper = require("./scraper");

// Global cap on concurrent scrapes on THIS pod. Sales Nav scrapes are heavy
// (each ~2–4 GB + CPU for a headed Orbita), and oversubscribing one pod starves
// every browser — pages then load slower than the pagination waits expect,
// which used to cut scrapes short (incomplete "done" jobs). Past this cap, jobs
// queue and start as slots free up. Tune via MAX_CONCURRENT_SCRAPES.
const MAX_CONCURRENT_SCRAPES = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_SCRAPES || "3", 10) || 3
);

/**
 * JobQueue manages all scraping jobs (single and batch).
 * Each profile runs one scrape at a time; the pod runs at most
 * MAX_CONCURRENT_SCRAPES at once (the rest queue).
 */
class JobQueue {
  constructor() {
    this.jobs = new Map(); // jobId → job object
    this.queue = []; // ordered list of jobIds waiting to run
    this.running = new Map(); // jobId → Scraper instance (currently running)
    this.listeners = new Map(); // ws → { userId } for per-user filtering
    this.recentLogs = []; // ring buffer of { ts, jobId, tabName, message }
    this.MAX_LOGS = 500;
    this.tokens = new Set(); // web-UI session tokens (single-pod, in-memory)
  }

  // Auth session tokens — same interface as the Redis backend (sync here).
  addToken(token) { this.tokens.add(token); }
  hasToken(token) { return this.tokens.has(token); }
  removeToken(token) { this.tokens.delete(token); }

  /** Append a log line to the ring buffer (also broadcast over WS as before). */
  pushLog(jobId, tabName, message) {
    this.recentLogs.push({ ts: Date.now(), jobId, tabName: tabName || "", message });
    if (this.recentLogs.length > this.MAX_LOGS) {
      this.recentLogs.splice(0, this.recentLogs.length - this.MAX_LOGS);
    }
  }

  /** The running Scraper instance for a job (for the per-job live View). */
  getRunningScraper(jobId) {
    return this.running.get(jobId) || null;
  }

  /** Recent log lines, oldest first. Optional `since` (ms epoch) for polling. */
  getRecentLogs(since) {
    if (!since) return this.recentLogs.slice();
    return this.recentLogs.filter((l) => l.ts > since);
  }

  /**
   * Recent log lines for ONE operator — only entries whose job is owned by
   * `userId`. This is the REST equivalent of the per-user WebSocket log
   * broadcast, so a colleague's scrape never shows up in your log pane.
   */
  getRecentLogsForUser(userId, since) {
    return this.recentLogs.filter((l) => {
      if (since && l.ts <= since) return false;
      const job = this.jobs.get(l.jobId);
      return job && job.userId === userId;
    });
  }

  /** Register a WebSocket connection with its userId. */
  addListener(ws, userId) {
    this.listeners.set(ws, { userId: userId || null });
  }
  removeListener(ws) {
    this.listeners.delete(ws);
  }

  /** Broadcast an event to all clients, or only to a specific user. */
  broadcast(type, data, targetUserId) {
    const message = JSON.stringify({ type, ...data });
    for (const [ws, info] of this.listeners) {
      try {
        if (ws.readyState !== 1) continue;
        // If the broadcast is user-scoped, only listeners that identified
        // themselves with the matching userId receive it. Listeners with no
        // userId (e.g. a fresh browser session that hasn't connected
        // LinkedIn yet) never receive user-scoped messages — this prevents
        // one user's jobs / logs from leaking into another's UI.
        if (targetUserId && info.userId !== targetUserId) continue;
        ws.send(message);
      } catch (e) {}
    }
  }

  /** Check if a user already has a running job. */
  isUserRunning(userId) {
    for (const [jobId] of this.running) {
      const job = this.jobs.get(jobId);
      if (job && job.userId === userId) return true;
    }
    return false;
  }

  /**
   * Check if a GoLogin profile already has a running job. This is the real
   * concurrency lock: a single profile can't drive two browsers at once
   * (cookie/state collision), but DIFFERENT profiles run concurrently.
   */
  isProfileRunning(profileId) {
    for (const [jobId] of this.running) {
      const job = this.jobs.get(jobId);
      if (job && job.profileId === profileId) return true;
    }
    return false;
  }

  /** Create a single-scrape job. */
  addSingle({ searchUrl, sheetUrl, tabName, slowMode, userId, profileId }) {
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
      state: "queued",
      pages: 0,
      profiles: 0,
      createdAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.broadcast("job:created", { job }, job.userId);
    this._tick();
    return job;
  }

  /** Create a batch of jobs from an array of search URLs. */
  addBatch({ urls, sheetUrl, tabName, slowMode, userId, profileId }) {
    const batchId = uuidv4();
    const created = [];

    urls.forEach((url, i) => {
      const id = uuidv4();
      const job = {
        id,
        batchId,
        type: "batch",
        searchUrl: url.trim(),
        sheetUrl,
        tabName: `${tabName || "Results"} ${i + 1}`,
        slowMode: slowMode ?? false,
        userId: userId || "default",
        profileId: profileId || userId || "default",
        state: "queued",
        pages: 0,
        profiles: 0,
        createdAt: Date.now(),
        index: i + 1,
        total: urls.length,
      };
      this.jobs.set(id, job);
      this.queue.push(id);
      created.push(job);
    });

    this.broadcast("batch:created", { batchId, jobs: created }, userId);
    this._tick();
    return { batchId, jobs: created };
  }

  /** Internal: pick up queued jobs — one per GoLogin profile, capped per pod. */
  async _tick() {
    if (this.draining) return; // SIGTERM in progress — don't start new work
    const profilesStarted = new Set();

    // Pod-wide concurrency budget: never run more than MAX_CONCURRENT_SCRAPES at
    // once, so concurrent scrapes don't starve each other (which truncated
    // results). Excess jobs stay queued and start as running ones finish.
    let available = Math.max(0, MAX_CONCURRENT_SCRAPES - this.running.size);
    if (available <= 0) return;

    // Find one job per profile that can start. Different profiles run
    // concurrently; jobs sharing a profile (e.g. a batch) serialise because a
    // profile can only drive one browser at a time.
    const startable = [];
    for (let i = 0; i < this.queue.length && startable.length < available; i++) {
      const jobId = this.queue[i];
      const job = this.jobs.get(jobId);
      if (!job) continue;

      // Skip if this profile already has a running job OR we already picked one for it this tick
      if (this.isProfileRunning(job.profileId) || profilesStarted.has(job.profileId)) continue;

      startable.push({ index: i, job });
      profilesStarted.add(job.profileId);
    }

    // Remove from queue in reverse order to keep indices valid
    for (let i = startable.length - 1; i >= 0; i--) {
      this.queue.splice(startable[i].index, 1);
    }

    for (const { job } of startable) {
      this._runJob(job);
    }
  }

  /** Internal: run a single job. */
  async _runJob(job) {
    job.state = "running";
    this.broadcast("job:update", { job }, job.userId);

    const scraper = new Scraper({
      slowMode: job.slowMode,
      userId: job.userId,
      profileId: job.profileId,
    });
    this.running.set(job.id, scraper);

    scraper.on("log", (message) => {
      this.pushLog(job.id, job.tabName, message);
      this.broadcast("log", { jobId: job.id, message }, job.userId);
    });

    scraper.on("status", (status) => {
      job.state = status.state;
      job.pages = status.page;
      job.profiles = status.profiles;
      this.broadcast("job:update", { job }, job.userId);
    });

    // Surface "sheet not shared" as a structured event so the UI can pop a
    // helpful modal instead of just dumping a log line. We also cancel the
    // user's remaining queued jobs — they'll all hit the same wall.
    scraper.on("sheet-permission-error", (info) => {
      this.broadcast(
        "sheet:permission-error",
        { jobId: job.id, ...info },
        job.userId
      );
      // Cancel any other queued jobs for this user with the same root cause.
      this.queue = this.queue.filter((id) => {
        const qJob = this.jobs.get(id);
        if (qJob && qJob.userId === job.userId) {
          qJob.state = "cancelled";
          qJob.error = "Cancelled — destination sheet not shared with service account.";
          this.broadcast("job:update", { job: qJob }, job.userId);
          return false;
        }
        return true;
      });
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

    this.broadcast("job:update", { job }, job.userId);
    this.running.delete(job.id);

    // If rate limited, cancel all remaining queued jobs for this user
    if (job.error && (job.error.includes("Rate limited") || job.error.includes("429") || job.error.includes("throttle"))) {
      let cancelled = 0;
      this.queue = this.queue.filter((id) => {
        const qJob = this.jobs.get(id);
        if (qJob && qJob.userId === job.userId) {
          qJob.state = "cancelled";
          qJob.error = "Cancelled — account is rate limited. Wait 15-30 minutes.";
          this.broadcast("job:update", { job: qJob }, job.userId);
          cancelled++;
          return false;
        }
        return true;
      });
      if (cancelled > 0) {
        this.broadcast("log", { jobId: job.id, message: `🚫  Cancelled ${cancelled} remaining job(s) — account is rate limited. Wait 15-30 minutes before scraping again.` }, job.userId);
      }
    }

    // Pick up the next job
    this._tick();
  }

  /** Pause a specific user's running job. */
  pauseForUser(userId) {
    for (const [jobId, scraper] of this.running) {
      const job = this.jobs.get(jobId);
      if (job && job.userId === userId) {
        scraper.pause();
      }
    }
  }

  /** Resume a specific user's running job. */
  resumeForUser(userId) {
    for (const [jobId, scraper] of this.running) {
      const job = this.jobs.get(jobId);
      if (job && job.userId === userId) {
        scraper.resume();
      }
    }
  }

  /** Stop all jobs for a specific user (running + queued). */
  stopForUser(userId) {
    // Stop running jobs for this user
    for (const [jobId, scraper] of this.running) {
      const job = this.jobs.get(jobId);
      if (job && job.userId === userId) {
        scraper.stop();
      }
    }

    // Cancel queued jobs for this user
    this.queue = this.queue.filter((id) => {
      const job = this.jobs.get(id);
      if (job && job.userId === userId) {
        job.state = "cancelled";
        this.broadcast("job:update", { job }, userId);
        return false; // remove from queue
      }
      return true; // keep in queue
    });
  }

  /** Pause the running job for a GoLogin profile. */
  pauseForProfile(profileId) {
    for (const [jobId, scraper] of this.running) {
      const job = this.jobs.get(jobId);
      if (job && job.profileId === profileId) scraper.pause();
    }
  }

  /** Resume the running job for a GoLogin profile. */
  resumeForProfile(profileId) {
    for (const [jobId, scraper] of this.running) {
      const job = this.jobs.get(jobId);
      if (job && job.profileId === profileId) scraper.resume();
    }
  }

  /** Stop all jobs (running + queued) for a GoLogin profile. */
  stopForProfile(profileId) {
    for (const [jobId, scraper] of this.running) {
      const job = this.jobs.get(jobId);
      if (job && job.profileId === profileId) scraper.stop();
    }
    this.queue = this.queue.filter((id) => {
      const job = this.jobs.get(id);
      if (job && job.profileId === profileId) {
        job.state = "cancelled";
        this.broadcast("job:update", { job }, job.userId);
        return false;
      }
      return true;
    });
  }

  /** Return jobs for a specific user. */
  getJobsForUser(userId) {
    return Array.from(this.jobs.values())
      .filter((j) => j.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Return all jobs (for admin). */
  getAllJobs() {
    return Array.from(this.jobs.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }

  /**
   * Graceful drain on SIGTERM: stop starting new jobs and wait for in-flight
   * scrapes to FINISH (don't kill them). Mirrors the Redis queue's drain() so
   * server.js can call it regardless of backend. K8s must allow enough
   * terminationGracePeriodSeconds for a scrape to complete.
   */
  async drain(timeoutMs = 1100000) {
    this.draining = true; // _tick checks this to stop claiming new work
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return { drained: this.running.size === 0, stillRunning: this.running.size };
  }
}

module.exports = new JobQueue();
