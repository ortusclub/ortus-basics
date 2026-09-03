// campaign-worker.js
//
// Runs a campaign on the engine (Phase 2: connect_only). A WORKER pod runs turns:
// it acquires a free account (shared lock), then processes a BATCH of leads with
// that account — claim → daily-gate → anti-dupe → ACTION → stamp — then releases
// the account. Many workers run different accounts in parallel; one account is
// only ever driven by one worker (the lock).
//
// The ACTION is injected:
//   • production → wraps the app's reused src/linkedin/outreach.js (real connect)
//   • tests      → a mock that records sends (no real LinkedIn)
// so all the orchestration/coordination is provable locally with zero real sends.

// A throttle/rate-limit signal in the send result (mirrors the local app's
// 429 regex). Distinct from a normal per-lead error.
function is429(msg) {
  return /\b429\b|rate.?limit|too many requests|throttl/i.test(String(msg || ""));
}
// A weekly-invitation-cap 429 (LinkedIn's ~weekly invite limit) vs a transient
// throttle — mirrors local's invite_cap classification (src/campaign.js).
function isWeeklyCap(msg) {
  return /weekly invitation|invitation limit|weekly[_ ]?limit/i.test(String(msg || ""));
}
// A dead/expired LinkedIn session — the account needs a manual re-login. The
// vendored outreach returns "LinkedIn session expired…" (outreach.js:279).
function isSessionDead(msg) {
  return /session expired|not logged in|log ?in required|login_required|session.*(invalid|dead)|redirected to login/i.test(String(msg || ""));
}

class CampaignWorker {
  // action: { connect(lead, profileId) -> { success, stage?, error? } }
  constructor({ store, action, batchSize, today, heartbeatMs,
               delayMin, delayMax, sleep, parkThreshold, parkCooldownSec, onSessionExpired,
               liveRegistry, turnCooldownSec, syncSheet } = {}) {
    this.store = store;
    this.action = action;
    // Live sheet write-back: push each lead's stamp to the operator's Sheet AS IT
    // is actioned (1:1 with local's per-lead trackedSheetWrite), instead of only at
    // pass boundaries. Without this a send batch (8 leads × 30–60s ≈ 6 min) leaves
    // the Sheet blank until the batch ends / the campaign is stopped. Best-effort +
    // no-op default so a Sheet hiccup never blocks a send and unit callers are
    // unaffected. The runtime supplies () => syncSheet(campaign).
    this._syncSheet = typeof syncSheet === "function" ? syncSheet : (async () => {});
    // Live-view registry: the SEND browser is held open across a whole batch
    // (openSession..closeSession below), which is the longest, most watchable
    // window a campaign has. Register it so /api/campaign/:id/view can stream it;
    // no-op default keeps unit tests + non-live callers unaffected. Reap
    // discipline is preserved — we register the ALREADY-open session and
    // unregister in the same finally, never keeping a browser alive to watch.
    this.liveRegistry = liveRegistry || { register: async () => {}, unregister: async () => {} };
    this.batchSize = batchSize || 8;
    // `today` injectable for deterministic daily-limit tests; defaults to UTC date.
    this.today = today || new Date().toISOString().slice(0, 10);
    this.heartbeatMs = heartbeatMs || 30000;
    this.draining = false;
    this.activeAccounts = new Set(); // accounts this worker currently holds
    // Inter-send delay (SECONDS) — randomized delayMin..delayMax between sends on
    // the same account, mirroring the local app (ban-safety). Default 0 here so
    // direct unit use is fast; the RUNTIME supplies the real 30–60s in prod.
    this.delayMin = Number.isFinite(delayMin) ? delayMin : 0;
    this.delayMax = Number.isFinite(delayMax) ? delayMax : 0;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // 429 parking: at parkThreshold consecutive 429s, park the account for
    // parkCooldownSec (leads stay pending, not error).
    this.parkThreshold = parkThreshold || 2;
    this.parkCooldownSec = parkCooldownSec || 1800; // 30 min (transient-throttle recovery)
    // Called with (account) when a dead LinkedIn session is detected — the
    // runtime uses it to stamp SoO Needs-Login. Optional.
    this.onSessionExpired = onSessionExpired || null;
    // Per-account between-batch cooldown (SECONDS) — 1:1 with local's
    // TURN_COOLDOWN_FLOOR_MS (6 min). Set at turn-end for send modes; the
    // selection loop skips a cooling account so batches interleave A×8 → B×8 → A×8
    // instead of draining one account fully. Default 0 (off) keeps unit tests /
    // direct callers unchanged; the RUNTIME supplies 360 in prod.
    this.turnCooldownSec = Number.isFinite(turnCooldownSec) ? turnCooldownSec : 0;
  }

  _delayMs() {
    const min = Math.max(0, this.delayMin);
    const max = Math.max(min, this.delayMax);
    return Math.round((min + Math.random() * (max - min)) * 1000);
  }

  // Run ONE batch-turn for a campaign: grab a free account, action up to
  // batchSize leads, release. Returns the number of leads actioned this turn
  // (0 = no free account, or no work / account capped).
  async runTurn(campaign) {
    if (this.draining) return 0;
    const profiles = campaign.profile_ids || [];

    // Acquire the first account that is (a) NOT parked/throttled AND (b) NOT
    // already at its daily send cap — both skipped in the SAME loop. Checking the
    // cap here (not after acquiring) is what stops a capped account — especially
    // the FIRST in the list — from being grabbed-and-bailed every turn, which
    // starves the accounts that still have capacity (the bug that wedged a
    // campaign whose lead account hit 50/50 while 8 others sat at 0/50).
    // Read-only modes (check_status, countsAsSend:false) ignore the daily cap.
    // The atomic tryConsumeDailySend gate inside the batch remains the
    // correctness guarantee against a check→acquire race.
    const gated = this.action.countsAsSend !== false;
    // Rotate the scan start each turn (1:1 with local's back-of-queue re-enqueue):
    // begin at cursor % N so consecutive turns pick DIFFERENT accounts instead of
    // re-grabbing profile_ids[0] until it drains. Atomic INCR is fair across pods;
    // stores without the method (unit mocks) fall back to a fixed start of 0.
    let start = 0;
    if (this.store.nextRotationIndex && profiles.length) {
      try { start = Number(await this.store.nextRotationIndex(campaign.id)) % profiles.length; } catch { start = 0; }
      if (!Number.isFinite(start) || start < 0) start = 0;
    }
    let profileId = null;
    let nParked = 0, nCooling = 0, nCapped = 0, nBusy = 0;
    for (let k = 0; k < profiles.length; k++) {
      const p = profiles[(start + k) % profiles.length];
      if (await this.store.isParked(p)) { nParked++; continue; }
      // Between-batch cooldown — skip an account still cooling from its last turn,
      // so a different account runs next (the floor that paces a shrunk pool).
      if (this.turnCooldownSec > 0 && this.store.inTurnCooldown && (await this.store.inTurnCooldown(p))) { nCooling++; continue; }
      if (gated && (await this.store.dailyCount(p, this.today)) >= campaign.daily_limit) { nCapped++; continue; }
      if (await this.store.acquireAccount(p)) { profileId = p; break; }
      nBusy++;
    }
    if (!profileId) {
      // Narrate WHY nothing is sending (the silent-"Queued" blind spot), but
      // throttled — the poll retries every ~15s and this state can persist for
      // hours (e.g. all accounts daily-capped), so at most one line per 10 min
      // per campaign per pod.
      if (gated) {
        this._idleEvtAt = this._idleEvtAt || new Map();
        const last = this._idleEvtAt.get(campaign.id) || 0;
        if (Date.now() - last > 10 * 60 * 1000) {
          this._idleEvtAt.set(campaign.id, Date.now());
          const bits = [];
          if (nCooling) bits.push(`${nCooling} resting between batches`);
          if (nCapped) bits.push(`${nCapped} at the daily limit`);
          if (nParked) bits.push(`${nParked} parked (throttled / needs login / weekly cap)`);
          if (nBusy) bits.push(`${nBusy} busy in another campaign or check`);
          await this._evt(campaign, `⏳ No account free right now — ${bits.join(" · ") || "all accounts unavailable"} · retrying automatically`);
        }
      }
      return 0; // every account busy elsewhere, parked, cooling, or daily-capped
    }
    this.activeAccounts.add(profileId);

    let actioned = 0;
    let session = null;
    // Operator-visible narration (send modes only): one line into the campaign's
    // event feed (appendMonitorLog → app Live Status log) at each turn milestone —
    // browser open, park/cap events, browser close — so the VM's activity reads
    // like the local machine's log instead of silent gaps between per-lead rows.
    const acct = this._acctLabel(campaign, profileId);
    if (gated) {
      let d0 = 0; try { d0 = await this.store.dailyCount(profileId, this.today); } catch (_) {}
      await this._evt(campaign, `🖥️ Opening ${acct}'s browser on the VM — ${d0}/${campaign.daily_limit} sent today`);
    }
    const hb = setInterval(() => this.store.heartbeatAccount(profileId).catch(() => {}), this.heartbeatMs);
    try {
      // Open the account's browser ONCE for the whole batch (real adapter launches
      // the GoLogin profile; mock returns a stub). Reused across leads in the turn.
      try {
        session = await this.action.openSession(profileId, campaign);
      } catch (e) {
        if (gated) await this._evt(campaign, `✗ ${acct} — browser failed to open: ${e.message}`);
        throw e;
      }
      // Publish this send session so the live viewer can stream it (best-effort).
      try { await this.liveRegistry.register(campaign.id, profileId, session.page); } catch (_) {}

      for (let i = 0; i < this.batchSize && !this.draining; i++) {
        // 0) Honor a mid-run PAUSE / STOP: if the campaign left the active-send
        // set (paused/cancelled/…), finish the lead already in flight and stop
        // claiming new ones — so pause takes effect after the current lead, 1:1
        // with local. Cheap: one row read between sends (30–60s apart).
        const fresh = await this.store.getCampaign(campaign.id);
        if (fresh && fresh.status !== "running" && fresh.status !== "queued") break;

        // 1) Atomically claim the next pending lead (no two workers get the same).
        const lead = await this.store.claimNextLead(campaign.id, profileId);
        if (!lead) break; // queue empty
        const leadKey = lead.member_urn || lead.lead_url;
        // anti-dupe key is per ACTION KIND (connect vs message) so the same
        // person can be connected AND later messaged, but never the same action twice.
        const dupeKind = (this.action && this.action.kind) || "connect";

        // 2) Anti-dupe — never repeat the same action to the same person.
        if (await this.store.wasActionSent(campaign.id, leadKey, dupeKind)) {
          await this.store.markLead(lead.id, "skipped", { stage: "dup" });
          continue;
        }

        // 3) Daily-send gate (per account). If capped, put the lead back for
        //    another account / tomorrow and end this account's turn. Read-only
        //    actions (check_status) opt out — a status check is not a send.
        if (this.action.countsAsSend !== false) {
          const gate = await this.store.tryConsumeDailySend(profileId, this.today, campaign.daily_limit);
          if (!gate.allowed) {
            await this.store.releaseLeadToPending(lead.id);
            await this._evt(campaign, `⛔ ${acct} — daily limit reached (${campaign.daily_limit}/${campaign.daily_limit}) · ending this account's turn`);
            break;
          }
        }

        // 4) The ACTION — real connect on the open page (mock in tests).
        let res;
        try { res = await this.action.connect(session, lead, campaign); }
        catch (e) { res = { success: false, error: e.message }; }

        if (res && res.success) {
          await this.store.markActionSent(campaign.id, leadKey, dupeKind);
          await this.store.markLead(lead.id, "sent", { stage: res.stage || "CC" });
          await this.store.clearThrottle(profileId); // clean send → reset 429 streak
          if (this.store.clearNeedsLogin) { try { await this.store.clearNeedsLogin(profileId); } catch (_) {} } // a clean send proves it's logged in
          if (this.store.clearWeeklyCap) { try { await this.store.clearWeeklyCap(profileId); } catch (_) {} } // a clean send proves the weekly cap lifted
          actioned++;
        } else if (res && res.alreadyConnected) {
          // Pre-existing 1st-degree connection — NOT a send and NOT a failure. Mark
          // the lead terminal (skipped) so it's never re-attempted or counted as an
          // error; the monitored-mode wrapper (campaign-runtime actionFor) has
          // already stamped it "Already connected"/monitorable so the acceptance
          // sweep fires the intro/DM (1:1 with local, where an already-connected
          // CC+IC lead is skipped at connect time and intro'd by the sweep). Record
          // the connect anti-dupe so a re-run never re-attempts the connect. Not
          // counted in `actioned` (no message was sent).
          // The daily-send gate above already consumed a credit for this lead —
          // refund it, since no invite went out (1:1 with local, which never counts
          // a skip against the daily cap). Guarded: only when this mode consumed one
          // (gated) and the store supports the refund (optional for unit mocks).
          if (gated && this.store.refundDailySend) {
            try { await this.store.refundDailySend(profileId, this.today); } catch (_) {}
          }
          await this.store.markActionSent(campaign.id, leadKey, dupeKind);
          await this.store.markLead(lead.id, "skipped", { stage: res.stage || "Already connected" });
        } else {
          const err = (res && res.error) || "connect failed";
          // Dead session: don't burn leads on an account that needs re-login.
          // Release the lead, PARK the account, and flag SoO Needs-Login.
          if (isSessionDead(err)) {
            await this.store.releaseLeadToPending(lead.id);
            await this.store.parkAccount(profileId, this.parkCooldownSec);
            if (this.store.setNeedsLogin) { try { await this.store.setNeedsLogin(profileId); } catch (_) {} } // flag for the app's account panel
            if (this.onSessionExpired) { try { await this.onSessionExpired(profileId); } catch {} }
            await this._evt(campaign, `✗ ${acct} — logged out of LinkedIn · parked, needs re-login in GoLogin`);
            break;
          }
          // Weekly invitation cap: actions.js throws WEEKLY_LIMIT when LinkedIn's
          // "you've reached the weekly invitation limit" modal/banner shows. It's
          // NOT a 429, so it needs its own branch — set the persistent weekly-cap
          // flag (so the accounts panel shows it all week), park the account, and
          // release the lead (don't burn it as an error — the account just can't
          // send any invites this week). Stop this account's turn.
          if (isWeeklyCap(err)) {
            await this.store.releaseLeadToPending(lead.id);
            if (this.store.setWeeklyCap) { try { await this.store.setWeeklyCap(profileId); } catch (_) {} }
            await this.store.parkAccount(profileId, this.parkCooldownSec, "weekly");
            await this._evt(campaign, `🚫 ${acct} — LinkedIn weekly invitation limit reached · parked for the week`);
            break;
          }
          // 429 / throttle: DON'T burn the lead. Put it back (pending), back off
          // this account, and stop this turn. At threshold the account parks. A
          // "weekly invitation limit" 429 is recorded as reason=weekly so the app
          // can say the account hit its weekly cap (vs a transient throttle).
          if (is429(err)) {
            await this.store.releaseLeadToPending(lead.id);
            const reason = isWeeklyCap(err) ? "weekly" : "throttle";
            if (reason === "weekly" && this.store.setWeeklyCap) { try { await this.store.setWeeklyCap(profileId); } catch (_) {} } // persistent flag (lasts the week, not just the 30-min park)
            const { parked, count } = await this.store.recordThrottle(profileId, this.parkThreshold, this.parkCooldownSec, reason);
            // Escalation (Sam 2026-07-24): LinkedIn often rejects invites with a
            // BARE 429 once the weekly invitation cap is hit — no modal, no
            // "weekly" wording — so the account cycled 429 → 30-min park → 429
            // forever, showing "Active" all along. Three strikes = presume the
            // weekly cap: bench (park) until next Monday 00:00 UTC + set the
            // weekly-cap flag so the Accounts panel says so. The operator can
            // un-bench via Retry (unbenchAccount); a clean send also clears it.
            const WEEKLY_ASSUME_429S = 3;
            if (count >= WEEKLY_ASSUME_429S && reason !== "weekly") {
              if (this.store.setWeeklyCap) { try { await this.store.setWeeklyCap(profileId); } catch (_) {} }
              const secsToWeekEnd = (() => {
                const now = new Date();
                const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
                const daysToMonday = (8 - d.getUTCDay()) % 7 || 7; // next Monday (1-7 days out)
                d.setUTCDate(d.getUTCDate() + daysToMonday);
                return Math.max(3600, Math.floor((d.getTime() - now.getTime()) / 1000));
              })();
              await this.store.parkAccount(profileId, secsToWeekEnd, "weekly");
              await this._evt(campaign, `🚫 ${acct} — ${count} rate-limited turns in a row — assuming the weekly invitation limit · benched for the rest of the week (Retry in the Accounts panel to override)`);
              break;
            }
            await this._evt(campaign, `⏸ ${acct} — rate-limited by LinkedIn (429)${parked ? ` · parked ${Math.round(this.parkCooldownSec / 60)} min` : " · backing off, will retry"} · strike ${count}/${WEEKLY_ASSUME_429S}`);
            break; // stop sending on this account this turn (no machine-gunning)
          }
          // Email-required gate ("enter their email to connect" modal): terminal
          // for this lead — stamp the sheet-visible reason ENGINE-side so the
          // operator's sheet reads "Skipped: Email required" (matching the local
          // app's exact vocabulary) even when the app is closed. The app's
          // reconciler maps the same string, so both paths stay identical.
          if (/email_required/i.test(err) && this.store.updateLeadOutcome) {
            try { await this.store.updateLeadOutcome(lead.id, { connectionRequestStatus: "Skipped: Email required" }); } catch (_) {}
          }
          await this.store.markLead(lead.id, "error", { error: err });
        }

        // Live write-back: flush this lead's stamp to the operator's Sheet NOW,
        // not at end-of-batch (1:1 with local's per-lead write). Reached for
        // sent / already-connected / error — every terminal outcome that just
        // marked a row sheet_dirty. Best-effort: a Sheet failure leaves the row
        // dirty for the pass-boundary retry and never blocks the send loop. The
        // session-dead / 429 paths break out above (they release the lead — no
        // new terminal stamp to push).
        try { await this._syncSheet(); } catch (_) {}

        // Inter-send delay before the next lead on this account (ban-safety).
        if (i < this.batchSize - 1) await this._sleep(this._delayMs());
      }
    } finally {
      clearInterval(hb);
      try { await this.liveRegistry.unregister(campaign.id, profileId); } catch (_) {}
      if (session) await this.action.closeSession(session).catch(() => {});
      await this.store.releaseAccount(profileId);
      // Arm the between-batch cooldown (send modes only — read-only check_status
      // opts out, exactly like local where skipsDailyLimit → cooldown 0). Set even
      // on a short/aborted turn, mirroring local ("cooldown set even on error").
      if (gated && this.turnCooldownSec > 0 && this.store.setTurnCooldown) {
        try { await this.store.setTurnCooldown(profileId, this.turnCooldownSec); } catch (_) {}
      }
      // Turn-end narration: what this turn achieved + where the account stands.
      // Skipped when the browser never opened (the ✗ open-failure line covers it).
      if (gated && session) {
        let d1 = 0; try { d1 = await this.store.dailyCount(profileId, this.today); } catch (_) {}
        const rest = this.turnCooldownSec > 0 ? ` · rests ~${Math.round(this.turnCooldownSec / 60)} min before its next turn` : "";
        await this._evt(campaign, `⏹ ${acct} — browser closed · ${actioned} sent this turn (${d1}/${campaign.daily_limit} today)${rest}`);
      }
      this.activeAccounts.delete(profileId);
    }
    return actioned;
  }

  // ── Operator-visible event narration ──────────────────────────────────────
  // Human label for an account: the campaign config's accountEmails map
  // (profileId → email) when present, else the raw GoLogin profile id.
  _acctLabel(campaign, profileId) {
    try {
      const cfg = typeof campaign.config === "string" ? JSON.parse(campaign.config || "{}") : (campaign.config || {});
      return (cfg.accountEmails || {})[profileId] || profileId;
    } catch (_) { return profileId; }
  }
  // Append one line to the campaign's event feed (Redis, capped + TTL'd) — the
  // app merges it into the Live Status log. Best-effort: never throws, never
  // blocks the send loop on a Redis hiccup.
  async _evt(campaign, line) {
    if (typeof this.store.appendMonitorLog !== "function") return;
    try { await this.store.appendMonitorLog(campaign.id, line); } catch (_) {}
  }

  // Drive a campaign to completion: keep running turns until no pending leads
  // remain (and no account is mid-turn). Cooperates with other workers.
  async runCampaign(campaign, { idleWaitMs = 50, maxIdleRounds = 40 } = {}) {
    let idle = 0;
    while (!this.draining) {
      const n = await this.runTurn(campaign);
      if (n > 0) { idle = 0; continue; }
      // no work this turn — are we actually done?
      const pending = await this.store.pendingLeadCount(campaign.id);
      if (pending === 0) break;
      if (++idle > maxIdleRounds) break; // safety: stop if wedged
      await new Promise((r) => setTimeout(r, idleWaitMs));
    }
  }

  drain() { this.draining = true; }
}

module.exports = { CampaignWorker };
