// campaign-scheduler.js
//
// The durable campaign scheduler. Runs on the always-on FRONTEND. Every tick it
// claims DUE tasks from Postgres (atomically — campaign_tasks, FOR UPDATE SKIP
// LOCKED) and dispatches each to a registered handler by type:
//   • monitor   — check which connects were accepted; fire intro/DM; reschedule
//                 the next check (recurring, until the monitoring window ends)
//   • follow_up — send a scheduled follow-up message
//   • accept    — auto-accept an incoming invitation
//
// This REPLACES the desktop app's in-memory setTimeout/cron (which die on
// restart) with durable, atomically-claimed tasks — so monitoring/follow-ups
// survive pod restarts and never run twice across pods.
//
// Handlers return { status?: 'done'|'error', rescheduleInMs?: number }.
// If rescheduleInMs is set, the task is re-queued that far in the future
// (recurring); otherwise it's marked done/error.

class CampaignScheduler {
  constructor({ store, tickMs } = {}) {
    this.store = store;
    this.tickMs = tickMs || 5000;
    this.handlers = new Map(); // type -> async fn(task) -> { status?, rescheduleInMs? }
    this.running = false;
    this._timer = null;
    this._busy = false;
  }

  on(type, fn) { this.handlers.set(type, fn); return this; }

  start() {
    if (this.running) return;
    this.running = true;
    this._timer = setInterval(() => this._tick().catch(() => {}), this.tickMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() { this.running = false; clearInterval(this._timer); }

  async _tick() {
    if (this._busy) return; // don't overlap ticks
    this._busy = true;
    try { await this.tickOnce(); } finally { this._busy = false; }
  }

  // Claim + dispatch up to `max` due tasks this tick. Returns how many ran.
  async tickOnce(max = 20) {
    // Best-effort: recover follow_up/accept tasks orphaned in 'claimed' by a
    // dead pod. Must never break the tick.
    try {
      const r = await this.store.reapOrphanedTasks();
      if (r && r.reaped) console.log(`[scheduler] reaped ${r.reaped} orphaned task(s)`);
    } catch {}

    let n = 0;
    for (let i = 0; i < max; i++) {
      const task = await this.store.claimNextDueTask();
      if (!task) break; // nothing due
      n++;
      await this._dispatch(task);
    }
    return n;
  }

  async _dispatch(task) {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      await this.store.markTask(task.id, "error"); // unknown type — don't loop
      return;
    }
    let res;
    try { res = await handler(task); }
    catch (e) { res = { status: "error", error: e && e.message }; }

    if (res && typeof res.rescheduleInMs === "number") {
      await this.store.rescheduleTask(task.id, new Date(Date.now() + res.rescheduleInMs));
    } else {
      await this.store.markTask(task.id, (res && res.status) || "done");
    }
  }
}

module.exports = { CampaignScheduler };
