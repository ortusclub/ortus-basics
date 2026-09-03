// campaign-runtime.js
//
// Phase H — the single-deployment glue. ONE runtime drives ALL campaign modes:
//
//   per-lead send modes  → CampaignWorker + makeAction (connect_only,
//                          message_only, introduce_back, and the CONNECT phase
//                          of connect_and_introduce / connect_and_message)
//   batch mode           → runFollowerGrowth (follower_growth)
//   scheduled work       → CampaignScheduler handlers:
//        monitor    — acceptance sweep per account (runBulkCheck), then fires
//                     intros (CC+IC) or DMs (CC+DM) for fresh acceptances;
//                     recurring until the monitoring window expires
//        follow_up  — delayed follow-up message queued by auto-intro
//        accept     — auto-accept the primary's incoming invitation
//
// Everything browser-facing is INJECTABLE (`deps`) so the whole runtime is
// integration-testable locally with zero real LinkedIn traffic. Production
// defaults launch GoLogin profiles via campaign-browser and the vendored
// primitives in campaign-lib.
//
// Multi-pod safe by construction: leads/tasks are claimed atomically in
// Postgres, accounts are held via the shared Redis lock (sn:proflock — also
// respected by the scraper), so N runtime pods cooperate like the workers in
// test-campaign-worker.js.

const { CampaignWorker } = require("./campaign-worker");
const { CampaignScheduler } = require("./campaign-scheduler");
const { makeAction } = require("./campaign-action");
const { runBulkCheck, nextMonitorDecision, monitorTailAction, MONITORING_WINDOW_MS } = require("./campaign-monitor");
const { runAutoIntros } = require("./campaign-autointro");
const { runAutoDms } = require("./campaign-autodm");
const { runFollowerGrowth } = require("./campaign-followergrowth");
const { syncCampaignSheet, prepareSheet, pushRow, appendReply, writeRecentMessages } = require("./campaign-sheet-writer");
const { runReplyCheck } = require("./campaign-reply-check");
const { markNeedsLogin } = require("./campaign-soo-writer");

// Lazy import of the vendored ESM Voyager helpers (getConversationsPage) — same
// pattern campaign-monitor uses for getRecentConnections. Kept out of the boot
// require chain so pods that never sweep replies don't load puppeteer helpers.
let _helpers = null;
async function getHelpers() { if (!_helpers) _helpers = await import("./campaign-lib/linkedin/helpers.js"); return _helpers; }

// Modes that track inbound replies after send (the app's _REPLY_MODES). These
// all send a message a lead can reply to. open_profile_only is DELIBERATELY
// excluded (mirrors the app) — an OP message can't be replied to as a thread.
const _REPLY_MODES = new Set(["introduce_back", "message_only", "connect_and_introduce", "connect_and_message"]);

// What each mode needs from the runtime.
const MODE_PLAN = {
  connect_only:          { kind: "per-lead", monitor: false },
  message_only:          { kind: "per-lead", monitor: false },
  introduce_back:        { kind: "per-lead", monitor: false },
  inmail_only:           { kind: "per-lead", monitor: false },
  open_profile_only:     { kind: "per-lead", monitor: false },
  check_status:          { kind: "per-lead", monitor: false },
  connect_and_introduce: { kind: "per-lead", monitor: true, onAccept: "intro" },
  connect_and_message:   { kind: "per-lead", monitor: true, onAccept: "dm" },
  follower_growth:       { kind: "batch" },
};

// Transition a campaign out of the SEND phase into MONITORING — arm the recurring
// reply sweep (+ acceptance monitor for connect_and_* modes) and flip status.
// Shared by processCampaign's natural end-of-send AND the API's
// stop?keepMonitoring=1 path (the cloud analogue of the app's "Stop sending,
// keep monitoring"). Modes with no monitor plan land on 'done' (reply sweep still
// armed if applicable). `now`/`log` injectable for tests. Idempotent: the reply/
// monitor tasks dedupe on reply:<id> / monitor:<id> (createTask is ON CONFLICT
// DO NOTHING), so a manual stop after natural end-of-send won't double-arm.
async function transitionToMonitoring(store, campaign, { now = () => new Date(), log = () => {} } = {}) {
  const plan = MODE_PLAN[campaign.mode] || {};
  const cfg = campaign.config || {};
  const t = now();
  const intervalMin = Number(cfg.checkIntervalMinutes || campaign.check_interval_minutes || 60);
  const until = new Date(t.getTime() + (Number(cfg.monitoringDays) * 86400000 || MONITORING_WINDOW_MS));
  const firstCheck = new Date(t.getTime() + intervalMin * 60000);

  // Reply tracking runs for the whole window even for send-only modes.
  if (_REPLY_MODES.has(campaign.mode)) {
    await store.createTask({
      campaignId: campaign.id, type: "reply", dueAt: firstCheck,
      dedupeKey: `reply:${campaign.id}`,
      payload: { until: until.toISOString(), intervalMin },
    });
    log(`${campaign.id}: reply tracking armed until ${until.toISOString()} (every ${intervalMin}m)`);
  }

  if (!plan.monitor) { await store.setCampaignStatus(campaign.id, "done"); return { status: "done" }; }

  // connect_and_*: arm the recurring acceptance monitor.
  await store.setMonitorState(campaign.id, {
    monitorState: "monitoring", sendingEndedAt: t, monitoringUntil: until,
    checkIntervalMinutes: intervalMin, nextCheckAt: firstCheck, autoChecksEnabled: true,
  });
  await store.createTask({
    campaignId: campaign.id, type: "monitor", dueAt: firstCheck,
    dedupeKey: `monitor:${campaign.id}`, payload: {},
  });
  await store.setCampaignStatus(campaign.id, "monitoring");
  log(`${campaign.id}: sending done → monitoring until ${until.toISOString()} (every ${intervalMin}m)`);
  return { status: "monitoring", monitoringUntil: until.toISOString() };
}

// Pure lead-outcome stamp for a pre-existing 1st-degree connection in a MONITORED
// intro/DM mode — makes the lead monitorable + accepted so the acceptance sweep
// fires its intro/DM. See the block comment in actionFor. Exported for unit tests.
function alreadyConnectedStamp() {
  return {
    connectionRequestStatus: "Already connected",   // → isMonitorable pre-filter
    connectionAcceptedStatus: "Already connected",  // → core trust-the-sheet branch
    stage: "Already connected",
    connectedAlready: true,
  };
}

function buildRuntime({ store, deps = {} }) {
  const d = {
    // browser session for an account — production: GoLogin via campaign-browser.
    openSession: async (profileId) => {
      const browser = require("./campaign-browser");
      const s = await browser.launchProfile(profileId);
      return { page: s.page, close: () => browser.closeProfile(profileId) };
    },
    makeWorkerAction: (campaign) => makeAction(campaign),
    // monitor/intro/dm/fg primitives — omitted keys fall through to the real
    // vendored implementations inside each module.
    fetchRecent: undefined, sendIntro: undefined, checkPrimary: undefined,
    readSelf: undefined, sendDm: undefined, sendInvites: undefined,
    // follow_up / accept senders (production: vendored thread-message /
    // accept-invitation primitives).
    sendFollowUp: async ({ page, payload }) => {
      const v = await import("./campaign-lib/linkedin/thread-message.js");
      return v.sendInThread(page, payload.threadUrl, payload.body,
        { introTitle: payload.introTitle || "", leadName: payload.leadName || "" });
    },
    acceptInvite: async ({ page, payload }) => {
      const v = await import("./campaign-lib/linkedin/accept-invitation.js");
      // payload.account = the {name, profileUrl} of the PRIMARY whose invitation
      // this account should accept (queued by campaign-autointro).
      return v.acceptInvitationFrom(page, payload.account || payload.primaryUrl);
    },
    now: () => new Date(),
    today: undefined, // CampaignWorker default (UTC date)
    // Inter-send sleep — real timer in prod; tests inject a no-op so the 30–60s
    // ban-safety delays don't actually stall the suite.
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // Sheet write-back POST (default: the real webapp push); injectable for tests.
    pushSheetRow: undefined,
    // R4 reply-check primitives — omitted keys fall through to the real impls
    // (runReplyCheck / appendReply from the reply-check + sheet-writer modules,
    // getConversationsPage from the vendored helpers).
    runReplyCheck: undefined, appendReply: undefined, getConversationsPage: undefined, writeRecentMessages: undefined,
    log: (m) => console.log(`[campaign-runtime] ${m}`),
    // Live-session registry for Watch-live. Default = no-op so tests and any
    // non-worker caller need no browser/redis. Production injects makeLiveRegistry.
    liveRegistry: { register: async () => {}, unregister: async () => {}, progress: async () => {}, get: () => null },
    ...deps,
  };
  // Primary-identity launcher/gate for personal (non-GoLogin) CC+IC follow-ups —
  // injectable so tests never launch a real Chromium (Task 4).

  const cfgOf = (campaign) => campaign.config || {};

  // Push a campaign's dirty leads back to the operator's Google Sheet. Best-
  // effort: never blocks/breaks the campaign; failed rows stay dirty + retry.
  // R4 #4 — provision this mode's tracking columns once, at campaign start, so
  // the operator's sheet has every column write-back will stamp. Best-effort:
  // the Apps Script skips absent columns, so a failure here just means some
  // stamps may be dropped (the prior behavior) — it must never block the run.
  // Injectable (d.prepareSheet) for tests. Idempotent, so a cross-pod double
  // call at the queued→running race is harmless.
  async function provisionSheet(campaign) {
    const cfg = cfgOf(campaign);
    const webappUrl = cfg.sheetsWebappUrl || cfg.sheetWebappUrl || "";
    const sheetUrl = campaign.sheet_url || cfg.sheetUrl || "";
    if (!webappUrl || !sheetUrl) return;
    try {
      const r = await (d.prepareSheet || prepareSheet)(webappUrl, sheetUrl, campaign.mode);
      if (r && r.error) d.log(`prepareSheet ${campaign.id}: ${r.error} (columns not provisioned — stamps to missing columns will be dropped)`);
      else if (r && r.added && r.added.length) d.log(`prepareSheet ${campaign.id}: added ${r.added.join(", ")}`);
    } catch (e) { d.log(`prepareSheet ${campaign.id}: ${e.message}`); }
  }

  async function syncSheet(campaign) {
    try { return await syncCampaignSheet({ store, campaign, push: d.pushSheetRow, log: d.log }); }
    catch (e) { d.log(`sheet sync ${campaign.id}: ${e.message}`); return null; }
  }

  // Wrap the per-lead action so successful connects in MONITORED modes also
  // stamp connection_request_status — that's what makes a lead "monitorable"
  // for the acceptance sweep (isMonitorable in campaign-monitor).
  function actionFor(campaign, plan) {
    const inner = d.makeWorkerAction(campaign);
    if (!plan.monitor) return inner;
    return {
      ...inner,
      async connect(session, lead, camp) {
        const res = await inner.connect(session, lead, camp);
        if (res && res.success) {
          await store.updateLeadOutcome(lead.id, { connectionRequestStatus: "Connection Request Sent" });
        } else if (res && res.alreadyConnected) {
          // Pre-existing 1st-degree connection: the CC skipped, but this lead must
          // STILL get its intro/DM — 1:1 with the local app, where the idle bulk-
          // check sweep stamps "Already connected" and fires from the connected
          // account. alreadyConnectedStamp() writes exactly what makes it reachable
          // by the same sweep on the engine (see that helper). The lead's
          // assigned_profile is already THIS (genuinely-connected) account from
          // claimNextLead, so the intro fires from the right browser.
          await store.updateLeadOutcome(lead.id, alreadyConnectedStamp());
        }
        return res;
      },
    };
  }

  // ── Drive one campaign forward (send phase / FG batch) ─────────────────────
  async function processCampaign(campaign) {
    const plan = MODE_PLAN[campaign.mode];
    if (!plan) { await store.setCampaignStatus(campaign.id, "error"); d.log(`unknown mode ${campaign.mode} → error`); return; }
    if (campaign.status === "queued") {
      await store.setCampaignStatus(campaign.id, "running");
      // Warm-up narration: the moment a worker pod picks the campaign up —
      // closes the blind window between "📦 received" and the first "🖥️ Opening".
      if (typeof store.appendMonitorLog === "function") {
        try { await store.appendMonitorLog(campaign.id, "⚙️ VM worker picked the campaign up — preparing the sheet, then selecting the first account…"); } catch (_) {}
      }
      await provisionSheet(campaign); // R4 #4 — ensure tracking columns exist before first write-back
    }

    if (plan.kind === "batch") {
      // Follower Growth: one batch pass per account (account lock inside runTurn
      // pattern — here we lock explicitly per account).
      const month = d.now().toISOString().slice(0, 7);
      for (const account of campaign.profile_ids || []) {
        if (!(await store.acquireAccount(account))) continue;
        let session = null;
        try {
          session = await d.openSession(account, campaign);
          try { await d.liveRegistry.register(campaign.id, account, session.page); } catch (_) {}
          await runFollowerGrowth({
            store, campaign, account, page: session.page,
            inviteUrl: cfgOf(campaign).inviteUrl, config: cfgOf(campaign),
            month, sendInvites: d.sendInvites, log: d.log,
            // Per-person selection tick → live registry stamp → frontend card.
            // Best-effort/cosmetic: never awaited, guarded, never gates the send.
            onProgress: (p) => {
              if (typeof d.liveRegistry.progress !== "function") return;
              try {
                d.liveRegistry.progress(campaign.id, account, {
                  selecting: (p && p.person && p.person.name) || "",
                  done: p && p.index, total: p && p.total,
                });
              } catch (_) { /* cosmetic */ }
            },
          });
        } catch (e) { d.log(`FG ${account}: ${e.message}`); }
        finally {
          try { await d.liveRegistry.unregister(campaign.id, account); } catch (_) {}
          if (session && session.close) { try { await session.close(); } catch {} }
          await store.releaseAccount(account);
        }
      }
      await syncSheet(campaign); // push Invited/Failed stamps back to the Sheet
      if ((await store.pendingLeadCount(campaign.id)) === 0) await store.setCampaignStatus(campaign.id, "done");
      return;
    }

    // Per-lead modes — CampaignWorker cooperates across pods via locks/claims.
    // Ban-safety: randomized inter-send delay (config override, else 30–60s for
    // send modes / 1–3s for read-only check_status). Plus 429 parking.
    const cfg = cfgOf(campaign);
    const fast = campaign.mode === "check_status";
    const worker = new CampaignWorker({
      store, action: actionFor(campaign, plan), today: d.today,
      liveRegistry: d.liveRegistry, // stream the send browser (open across the whole batch)
      // Live sheet write-back — push each lead's stamp as it's actioned, so the
      // operator's Sheet fills DURING the batch (not only when the ~6-min batch
      // ends / the campaign is stopped). 1:1 with local's per-lead write.
      syncSheet: () => syncSheet(campaign),
      delayMin: Number.isFinite(cfg.delayMin) ? cfg.delayMin : (fast ? 1 : 15),
      delayMax: Number.isFinite(cfg.delayMax) ? cfg.delayMax : (fast ? 3 : 35),
      // Between-batch account rotation floor. Was 360s (1:1 with local's
      // TURN_COOLDOWN_FLOOR_MS = 6 min); lowered to 180s (3 min) to ~2× CC throughput
      // per operator request. Read-only check_status opts out (gated=false in worker).
      turnCooldownSec: 180,
      sleep: d.sleep,
      // Dead session → stamp SoO Needs-Login for that account (best-effort; the
      // app passes accountEmails + sooSheetId/gid so the engine can match).
      onSessionExpired: async (profileId) => {
        const email = (cfg.accountEmails || {})[profileId] || "";
        const r = await (d.markNeedsLogin || markNeedsLogin)({
          webappUrl: cfg.sheetsWebappUrl, sooSheetId: cfg.sooSheetId, sooGid: cfg.sooGid, email,
        });
        d.log(`${campaign.id}: session expired on ${profileId} → parked${r && r.ok ? " + SoO Needs-Login" : ` (SoO ${email ? "write failed" : "no email"})`}`);
      },
    });
    await worker.runCampaign(campaign);
    await syncSheet(campaign); // push this pass's status stamps to the Sheet
    if ((await store.pendingLeadCount(campaign.id)) > 0) return; // another pass will finish it

    // Sending finished → arm reply tracking + (for connect_and_*) the acceptance
    // monitor, and flip status. Shared with the API's stop?keepMonitoring path.
    await transitionToMonitoring(store, campaign, { now: d.now, log: d.log });
  }

  // ── Scheduler handlers ───────────────────────────────────────────────────────
  async function handleMonitor(task) {
    const campaign = await store.getCampaign(task.campaign_id);
    // A manual check-now sweep is allowed on a STOPPED (cancelled) campaign too —
    // the operator may want to catch late acceptances + fire intros after stopping.
    // Still bail for paused/done/error. The tail treats cancelled (like running) as
    // a ONE-SHOT so a stopped campaign never resurrects into recurring monitoring.
    if (!campaign || ["paused", "done", "error"].includes(campaign.status)) return { status: "done" };
    const plan = MODE_PLAN[campaign.mode] || {};
    const templates = cfgOf(campaign);
    let newlyAccepted = 0;
    let checkError = "";
    // Which accounts this sweep opens a browser for. scope="all" (set by a manual
    // "check all accounts" check-now) sweeps every unique account in the sheet's
    // "Account Used" column (assigned_profile on the leads), unioned with the
    // campaign's own profile_ids; scope="campaign" (default / recurring auto-check)
    // sweeps just profile_ids. The acceptance matcher itself is already
    // whole-campaign (getAllConnections), so scope only widens which accounts get
    // their fresh Recent-Connections fetched.
    const checkScope = (task.payload && task.payload.scope) || "campaign";
    const accountsToSweep = await resolveCheckAccounts(store, campaign, checkScope);
    // monLog appends to the app-visible Live Status feed (Redis, per campaign) in
    // addition to the pod-stdout d.log — so the operator sees each account the
    // sweep checks, especially for an all-senders sweep across many accounts.
    const monLog = (line) => (typeof store.appendMonitorLog === "function" ? store.appendMonitorLog(campaign.id, line) : Promise.resolve());
    // Prefer the human-readable account email (from the campaign's accountEmails
    // map) over a raw GoLogin profile id in the log, so the feed reads like the
    // operator's "Account Used" column (e.g. liza.advocate@ortus.solutions).
    const acctLabel = (a) => ((templates.accountEmails || {})[a] || a);
    d.log(`monitor ${campaign.id}: sweep scope=${checkScope} → ${accountsToSweep.length} account(s)${checkScope === "all" ? " (all unique Account-Used accounts)" : ""}`);
    await monLog(`⚡ Check started — ${checkScope === "all" ? "all Account-Used accounts" : "this campaign's accounts"} (${accountsToSweep.length} account${accountsToSweep.length === 1 ? "" : "s"})`);
    if (typeof store.recordMonitorCheckStarted === "function") {
      await store.recordMonitorCheckStarted(campaign.id);
    }

    for (const account of accountsToSweep) {
      if (!(await store.acquireAccount(account))) { d.log(`monitor ${campaign.id}/${account}: busy (sending/scrape) — skipped this sweep`); await monLog(`⏭️ ${acctLabel(account)} — busy (sending/scrape), skipped this sweep`); continue; } // next sweep catches up
      let session = null;
      try {
        d.log(`monitor ${campaign.id}/${account}: checking for accepted connections…`);
        await monLog(`🖥️ Checking ${acctLabel(account)}…`);
        session = await d.openSession(account, campaign);
        try { await d.liveRegistry.register(campaign.id, account, session.page); } catch (_) {}
        const r = await runBulkCheck({ store, campaign, account, page: session.page, fetchRecent: d.fetchRecent });
        newlyAccepted += (r.connectedUrls || []).length;
        d.log(`monitor ${campaign.id}/${account}: ${(r.connectedUrls || []).length} newly-accepted, ${r.applied || 0} lead row(s) updated`);
        await monLog(`✓ ${acctLabel(account)} — ${(r.connectedUrls || []).length} newly accepted, ${r.applied || 0} lead row(s) updated`);
        if (plan.onAccept === "intro") {
          // Intro the BACKLOG, not just this sweep's newly-accepted: any lead that
          // accepted (this sweep or an earlier one) but was never introduced yet.
          // runBulkCheck has already stamped this sweep's acceptances, so the
          // backlog query returns newly-accepted + previously-accepted-not-intro'd
          // in one set. Union with r.connectedUrls (belt-and-braces) and dedup;
          // runAutoIntros re-checks each lead's intro slot and skips the done ones.
          let backlog = [];
          if (typeof store.getAcceptedPendingIntros === "function") {
            try { backlog = await store.getAcceptedPendingIntros(campaign.id, account); } catch (_) { backlog = []; }
          }
          const introUrls = Array.from(new Set([...(r.connectedUrls || []), ...backlog]));
          const olderBacklog = Math.max(0, introUrls.length - (r.connectedUrls || []).length);
          if (olderBacklog > 0) {
            d.log(`monitor ${campaign.id}/${account}: ${olderBacklog} earlier-accepted connection(s) not yet introduced — introducing now`);
            await monLog(`↩︎ ${acctLabel(account)} — introducing ${olderBacklog} earlier-accepted connection${olderBacklog === 1 ? "" : "s"} not yet introduced`);
          }
          if (introUrls.length) {
            await runAutoIntros({
              store, campaign, account, page: session.page, connectedUrls: introUrls,
              templates, checkPrimary: d.checkPrimary, sendIntro: d.sendIntro, readSelf: d.readSelf,
            });
          }
        } else if (r.connectedUrls.length && plan.onAccept === "dm") {
          await runAutoDms({
            store, campaign, account, page: session.page, connectedUrls: r.connectedUrls,
            templates, sendDm: d.sendDm,
          });
        }
      } catch (e) {
        checkError = checkError || (e && e.message) || "Monitor check failed";
        if (e && e.sessionInvalid) {
          // Stale/expired LinkedIn login on this account during MONITORING —
          // stamp SoO "Needs Login: Y" (the same signal the send path uses via
          // onSessionExpired) so the operator knows to re-login in GoLogin.
          // Idempotent: re-stamping each sweep just re-sets the same cell. Without
          // this, acceptance checks silently do nothing until the window ends.
          const email = (templates.accountEmails || {})[account] || "";
          let stamped = false;
          try {
            const r = await (d.markNeedsLogin || markNeedsLogin)({
              webappUrl: templates.sheetsWebappUrl, sooSheetId: templates.sooSheetId, sooGid: templates.sooGid, email,
            });
            stamped = !!(r && r.ok);
          } catch (_) { /* best-effort — never let a write failure crash the sweep */ }
          if (store.setNeedsLogin) { try { await store.setNeedsLogin(account); } catch (_) {} } // flag for the app's account panel
          d.log(`monitor ${campaign.id}/${account}: session expired → ${stamped ? "SoO Needs-Login stamped" : `SoO ${email ? "write failed" : "skipped (no operator email)"}`} — operator must re-login this account in GoLogin, then monitoring resumes automatically`);
          await monLog(`✗ ${acctLabel(account)} — session expired, needs re-login in GoLogin`);
        } else {
          d.log(`monitor ${campaign.id}/${account}: ${e.message}`);
          await monLog(`✗ ${acctLabel(account)} — ${e.message}`);
        }
      }
      finally {
        try { await d.liveRegistry.unregister(campaign.id, account); } catch (_) {}
        if (session && session.close) { try { await session.close(); } catch {} }
        await store.releaseAccount(account);
      }
    }

    if (typeof store.recordMonitorCheckCompleted === "function") {
      await store.recordMonitorCheckCompleted(campaign.id, { newlyAccepted, error: checkError });
    }
    await monLog(checkError
      ? `✗ Check finished with an error — ${checkError}`
      : `✓ Check complete — ${newlyAccepted} newly accepted across ${accountsToSweep.length} account${accountsToSweep.length === 1 ? "" : "s"}`);

    await syncSheet(campaign); // push acceptance/intro/DM stamps from this sweep

    // Re-read the campaign — a sweep can take minutes, so the operator may have
    // toggled auto-checks off (or a check-now may be racing) in the meantime.
    const fresh = (await store.getCampaign(campaign.id)) || campaign;
    const decision = nextMonitorDecision(fresh, d.now());
    let action = monitorTailAction({ expired: decision.expired, autoChecksEnabled: fresh.auto_checks_enabled });
    // A manual check-now fired while the campaign is STILL SENDING ('running') is
    // a one-shot: the sweep above already flushed intros/DMs for anyone already
    // accepted. Don't arm recurring monitoring now — that transition belongs to
    // natural end-of-send (transitionToMonitoring). Sending continues untouched.
    const oneShotManual = ["running", "cancelled"].includes(fresh.status);
    if (oneShotManual) action = "park";
    if (action === "expire") {
      await store.setMonitorState(campaign.id, { monitorState: "ended" });
      await store.setCampaignStatus(campaign.id, "done");
      d.log(`${campaign.id}: monitoring window ended → done`);
      return { status: "done" };
    }
    if (action === "park") {
      // Either a one-shot check-now during send, or auto-checks off during
      // monitoring: run this sweep but DON'T arm the next one. The campaign's
      // status is left as-is (running stays running; monitoring stays monitoring);
      // Check-now / toggling auto back on re-arms via armMonitorTask.
      d.log(oneShotManual
        ? `${campaign.id}: one-shot check-now sweep complete (status ${fresh.status}; not re-armed)`
        : `${campaign.id}: auto-checks off → monitoring paused (Check-now still works)`);
      return { status: "done" };
    }
    // Recurring monitoring reuses THIS task row (rescheduleTask preserves payload),
    // so revert any one-shot "check all" scope back to campaign — auto-checks always
    // sweep just the campaign's own accounts.
    if (checkScope === "all" && typeof store.resetMonitorTaskScope === "function") {
      try { await store.resetMonitorTaskScope(campaign.id); } catch (_) {}
    }
    await store.setMonitorState(campaign.id, { nextCheckAt: decision.nextCheckAt });
    return { rescheduleInMs: decision.nextCheckAt.getTime() - d.now().getTime() };
  }

  // Resolve which accounts a monitor sweep opens a browser for, by scope.
  // "all" → every unique account in the sheet's "Account Used" column
  // (assigned_profile on the campaign's leads), unioned with profile_ids so an
  // account with no leads-under-it still gets checked. Falls back to profile_ids
  // if the lead read fails, so a sweep never silently checks nothing.
  async function resolveCheckAccounts(store, campaign, scope) {
    const base = campaign.profile_ids || [];
    if (scope !== "all") return base;
    const set = new Set(base);
    try {
      const leads = await store.getCampaignLeads(campaign.id);
      for (const l of leads) {
        const a = l && l.assigned_profile ? String(l.assigned_profile).trim() : "";
        if (a) set.add(a);
      }
    } catch (_) { return base; }
    return [...set];
  }

  async function withAccountSession(profileId, fn) {
    if (!(await store.acquireAccount(profileId))) return { retry: true };
    let session = null;
    try { session = await d.openSession(profileId); return { result: await fn(session) }; }
    finally {
      if (session && session.close) { try { await session.close(); } catch {} }
      await store.releaseAccount(profileId);
    }
  }

  async function handleFollowUp(task) {
    const payload = task.payload || {};
    const primarySource = payload.sender || "local-browser";

    // Send-side idempotency: the scheduler + orphan reaper are at-least-once,
    // so a pod dying after send but before markTask('done') can re-dispatch
    // this SAME follow_up. Guard with the same durable Redis set intros use
    // (campaign-autointro.js wasActionSent/markActionSent) — never double-send.
    const leadKey = payload.leadUrl || "";
    if (leadKey && (await store.wasActionSent(task.campaign_id, leadKey, "follow_up"))) {
      return { status: "done" };
    }

    // Primary is on GoLogin → send as the primary's OWN profile (not the sender).
    if (primarySource !== "local-browser") {
      const out = await withAccountSession(primarySource, (session) =>
        d.sendFollowUp({ page: session.page, payload }));
      if (out.retry) return { rescheduleInMs: 5 * 60000 };
      if (leadKey) await store.markActionSent(task.campaign_id, leadKey, "follow_up");
      return { status: "done" };
    }

    // Personal primary (not on GoLogin): the VM must NOT send it. Replaying a
    // personal LinkedIn session from a datacenter IP gets it invalidated (see the
    // local-drain design). claimNextDueTask already skips these so the owner's app
    // drains them; if a stale one still reaches here, leave it for the app —
    // never send a personal follow-up from the VM.
    d.log(`follow_up ${leadKey || "(no lead)"} is personal — left for local drain`);
    return { status: "delegated" };
  }

  async function handleAccept(task) {
    const payload = task.payload || {};
    // The PRIMARY's browser accepts the incoming invitation from the campaign
    // account (payload.account = that account's identity). payload.sender is the
    // profile the primary runs on (campaign-autointro queued it that way).
    const primaryProfile = payload.sender || payload.profileId;
    const out = await withAccountSession(primaryProfile, (session) =>
      d.acceptInvite({ page: session.page, payload }));
    if (out.retry) return { rescheduleInMs: 5 * 60000 };
    return { status: "done" };
  }

  // R4 — the recurring AUTOMATIC reply sweep. Mirrors the app's
  // post-campaign-reply-check tick, engine-adapted: opens a session per account,
  // runs runReplyCheck (bulk-inbox Voyager scan → match candidate leads → append
  // Replies row + stamp Reply/Stage), then REAPS the session in a finally (the
  // CPU-peg hazard — a reply sweep opens browsers on a cadence, so every session
  // MUST be closed, exactly like handleMonitor). Reschedules by the payload's
  // cadence until the reply window closes.
  async function handleReply(task) {
    const campaign = await store.getCampaign(task.campaign_id);
    // Sweep during 'running'/'monitoring'/'done' (send-only reply modes finish to
    // 'done' but still track replies for the window). Only cancelled/paused/error
    // stop it.
    if (!campaign || ["cancelled", "paused", "error"].includes(campaign.status)) return { status: "done" };
    if (!_REPLY_MODES.has(campaign.mode)) return { status: "done" }; // safety: never sweep excluded modes

    const cfg = cfgOf(campaign);
    const payload = task.payload || {};
    const sheetUrl = campaign.sheet_url || cfg.sheetUrl || "";
    const webappUrl = cfg.sheetsWebappUrl || cfg.sheetWebappUrl || "";
    const linkedinColumn = cfg.linkedinColumn || "LinkedIn URL";

    const runReply = d.runReplyCheck || runReplyCheck;
    const append = d.appendReply || appendReply;
    const push = d.pushSheetRow || pushRow;
    const writeRecent = d.writeRecentMessages || writeRecentMessages;
    const gcp = d.getConversationsPage || (async (pg, opts) => (await getHelpers()).getConversationsPage(pg, opts));

    for (const account of campaign.profile_ids || []) {
      if (!(await store.acquireAccount(account))) continue; // busy (monitor/scrape/other) — next sweep catches up
      let session = null;
      try {
        session = await d.openSession(account, campaign);
        try { await d.liveRegistry.register(campaign.id, account, session.page); } catch (_) {}
        const r = await runReply({
          store, campaign, account, page: session.page,
          sheetUrl, webappUrl, linkedinColumn,
          getConversationsPage: gcp, appendReply: append, pushRow: push,
          writeRecentMessages: writeRecent, log: d.log,
        });
        if (r && ((r.replies && r.replies.length) || r.newReplies)) {
          d.log(`reply ${campaign.id}/${account}: ${(r.replies || []).length} matched, ${r.newReplies || 0} new`);
        }
        if (r && r.errors && r.errors.length) d.log(`reply ${campaign.id}/${account}: ${r.errors.join("; ")}`);
      } catch (e) {
        d.log(`reply ${campaign.id}/${account}: ${e.message}`);
      }
      finally {
        // CPU-peg hazard: reap the browser on EVERY path (copy of handleMonitor's
        // session-close discipline). A leaked Orbita pegs a core for hours.
        try { await d.liveRegistry.unregister(campaign.id, account); } catch (_) {}
        if (session && session.close) { try { await session.close(); } catch {} }
        await store.releaseAccount(account);
      }
    }

    // Window/cadence decision — reschedule by the cadence until the reply window
    // closes, then stop (mirrors monitorTailAction's expire-vs-reschedule).
    const now = d.now();
    const until = payload.until ? new Date(payload.until) : null;
    if (until && now.getTime() >= until.getTime()) {
      d.log(`${campaign.id}: reply tracking window ended`);
      return { status: "done" };
    }
    const intervalMin = Number(payload.intervalMin || cfg.checkIntervalMinutes || campaign.check_interval_minutes || 60);
    return { rescheduleInMs: intervalMin * 60000 };
  }

  const scheduler = new CampaignScheduler({ store, tickMs: deps.tickMs })
    .on("monitor", handleMonitor)
    .on("follow_up", handleFollowUp)
    .on("accept", handleAccept)
    .on("reply", handleReply);

  // ── Poll loop: pick up queued/running campaigns ─────────────────────────────
  // PARALLEL CLOUD CAMPAIGNS: drive up to CAMPAIGN_CONCURRENCY campaigns AT ONCE
  // per pod (was one-at-a-time, which drained the first campaign fully before the
  // next could start — the "only one runs" behaviour Sam hit). KEDA scales pods on
  // top (22-campaign-keda.yaml listLength = campaigns-per-pod, kept == this), so
  // total parallelism = pods × concurrency. Safe to raise: the shared account lock
  // (sn:proflock) keeps any single LinkedIn account to one action at a time across
  // ALL pods/campaigns, so this never double-drives an account. Default 2 fits the
  // campaign-worker pod (4 vCPU / 8 GiB) — raise only with bigger pods.
  const CAMPAIGN_CONCURRENCY = Math.max(1, Number(process.env.CAMPAIGN_CONCURRENCY || 2));
  let _campaignTimer = null, _stopped = false;

  // Run `fn` over items with at most `limit` in flight at once (concurrency pool).
  async function _pool(items, limit, fn) {
    const q = items.slice();
    const runners = Array.from({ length: Math.max(1, Math.min(limit, q.length)) }, async () => {
      while (q.length && !_stopped) await fn(q.shift());
    });
    await Promise.all(runners);
  }

  // Coarse safety net: a single processCampaign that HANGS (e.g. a wedged
  // browser teardown — see campaign-browser reapSession) must never hold the
  // poll open, or its in-flight slot never frees and the pod loses capacity
  // (the 73-min "stuck at 36%" incident, 2026-07-20). Generous default (15 min)
  // sits well above a legit batch (batchSize 8 × ~25s ≈ 3-4 min) so it only ever
  // fires on a true infinite hang, never a slow-but-working batch. The
  // reapSession per-step timeouts are the tight fix; this is the backstop.
  const PROCESS_CAMPAIGN_TIMEOUT_MS = Math.max(600000, Number(process.env.PROCESS_CAMPAIGN_TIMEOUT_MS) || 900000);
  function _boundCampaign(promise, ms, onTimeout) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
      const t = setTimeout(() => { if (!done) { done = true; onTimeout(); resolve(); } }, ms);
      Promise.resolve(promise).then(finish, finish);
    });
  }

  // Campaigns THIS pod is currently processing. Replaces the old whole-pass
  // `_polling` guard, which held the poll shut until the SLOWEST campaign of a
  // pass finished — so a campaign (re)started mid-pass (e.g. Continue pressed
  // while a long FG batch ground on) waited for the whole pass before its first
  // send (observed 2026-07-24: restarted CC+IC idle behind an FG pass). Now every
  // tick starts any active campaign that isn't already in flight here, and the
  // in-flight SIZE caps this pod's total concurrency across overlapping ticks.
  const _inFlightCampaigns = new Set();

  async function tickCampaigns() {
    const active = (await store.getActiveCampaigns()).filter((c) => !_inFlightCampaigns.has(c.id));
    await _pool(active, CAMPAIGN_CONCURRENCY, async (c) => {
      // Re-check at start moment: an overlapping tick may have claimed it, or
      // filled every slot, while this one sat in the pool window. A skipped
      // campaign is retried on the next 15s tick — never lost.
      if (_inFlightCampaigns.has(c.id) || _inFlightCampaigns.size >= CAMPAIGN_CONCURRENCY) return;
      _inFlightCampaigns.add(c.id);
      try {
        await _boundCampaign(
          processCampaign(c).catch((e) => d.log(`campaign ${c.id}: ${e.message}`)),
          PROCESS_CAMPAIGN_TIMEOUT_MS,
          () => d.log(`campaign ${c.id}: processCampaign exceeded ${PROCESS_CAMPAIGN_TIMEOUT_MS}ms — abandoning this cycle so the poll keeps running`),
        );
      } finally { _inFlightCampaigns.delete(c.id); }
    });
    return active.length;
  }

  function start({ campaignPollMs = 15000 } = {}) {
    scheduler.start();
    _campaignTimer = setInterval(() => tickCampaigns().catch(() => {}), campaignPollMs);
    if (_campaignTimer.unref) _campaignTimer.unref();
    tickCampaigns().catch(() => {});
    d.log(`runtime started (scheduler + campaign poll, concurrency=${CAMPAIGN_CONCURRENCY})`);
  }
  function stop() { _stopped = true; scheduler.stop(); clearInterval(_campaignTimer); }

  return { scheduler, processCampaign, tickCampaigns, handleMonitor, handleReply, start, stop, MODE_PLAN };
}

module.exports = { buildRuntime, MODE_PLAN, transitionToMonitoring, alreadyConnectedStamp };
