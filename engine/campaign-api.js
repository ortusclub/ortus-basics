// campaign-api.js
//
// HTTP API for submitting/observing campaigns — mounted on the ALWAYS-ON
// frontend (server.js), the single door for both scrapes and campaigns. It
// writes campaigns + leads into Postgres and flips status; the KEDA-scaled
// campaign-worker pods pick them up (frontend never runs a campaign itself —
// same split as the scrape flow: frontend enqueues, workers execute).
//
// Inert unless a CampaignStore is provided (PG_URL configured), so a
// scraper-only frontend is unaffected — the routes just 503.
//
// Routes:
//   POST /api/campaign/start        create + queue a campaign (+leads)
//   GET  /api/campaign/list         list campaigns (?owner= scopes)
//   GET  /api/campaign/:id          one campaign + lead status counts
//   POST /api/campaign/:id/stop     cancel (or ?pause=1 to pause)

const http = require("http");
const { MODE_PLAN, transitionToMonitoring } = require("./campaign-runtime");

const VALID_MODES = new Set(Object.keys(MODE_PLAN));
// modes that need leads to act on (everything except… all of them, currently)
const LEAD_MODES = VALID_MODES;

function genId() {
  // time-free (Date.now unavailable in some contexts is fine here — server has it)
  return "cmp_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function mountCampaignApi(app, store, opts = {}) {
  const { log = () => {} } = opts;
  const need = (res) => {
    if (!store) { res.status(503).json({ error: "Campaigns not configured on this engine (no PG_URL)." }); return true; }
    return false;
  };

  // Injectable proxy so the /view route is unit-testable; default streams the
  // MJPEG from the worker pod that owns the live browser.
  const proxyStream = (opts && opts.proxyStream) || ((target, req, res) => {
    const upstream = http.get(target, (up) => { res.writeHead(up.statusCode || 200, up.headers); up.pipe(res); });
    upstream.on("error", () => { try { res.status(502).json({ error: "View proxy failed" }); } catch (_) {} });
    req.on("close", () => upstream.destroy());
  });
  // Best-effort live-session lookup (cmp:live:<id> stamped by the worker registry).
  // BOUNDED: prod Redis uses maxRetriesPerRequest:null, so a get issued during a
  // Redis outage never rejects (it queues) — an unbounded await would HANG these
  // endpoints (list is polled by the board). Race a short timeout so an
  // unreachable Redis degrades to "not live" instead of hanging. The dangling
  // read carries its own .catch so it can never surface as an unhandled rejection.
  const liveTimeoutMs = Number.isFinite(opts.liveTimeoutMs) ? opts.liveTimeoutMs : 500;
  const liveOf = async (id) => {
    const read = store.redis.get(`cmp:live:${id}`).catch(() => null);
    const raw = await Promise.race([read, new Promise((r) => setTimeout(() => r(null), liveTimeoutMs))]);
    if (!raw) return { live: false, liveAccount: "", liveProgress: null, _stamp: null };
    try {
      const v = JSON.parse(raw);
      // Per-person selection progress (FG batch), when the worker has stamped it.
      const lp = (v.progress && Number(v.progress.total) > 0) ? {
        selecting: v.progress.selecting || "",
        done: Number(v.progress.done) || 0,
        total: Number(v.progress.total) || 0,
      } : null;
      return { live: true, liveAccount: v.account || "", liveProgress: lp, _stamp: v };
    } catch (_) { return { live: false, liveAccount: "", liveProgress: null, _stamp: null }; }
  };

  // ── create + queue ──
  app.post("/api/campaign/start", async (req, res) => {
    if (need(res)) return;
    try {
      const b = req.body || {};
      const mode = String(b.mode || "");
      if (!VALID_MODES.has(mode)) {
        return res.status(400).json({ error: `mode must be one of: ${[...VALID_MODES].join(", ")}` });
      }
      const leads = Array.isArray(b.leads) ? b.leads : [];
      if (LEAD_MODES.has(mode) && !leads.length) return res.status(400).json({ error: "leads array required for this mode" });

      // Normalize leads; each may carry routeAccount (auto-routed modes pin the
      // lead to its original sender account).
      const normLeads = leads.map((l) => ({
        leadUrl: l.leadUrl || l.url || l.lead_url,
        memberUrn: l.memberUrn || l.member_urn || null,
        fullName: l.fullName || l.full_name || l.name || "",
        routeAccount: l.routeAccount || l.route_account || l.account || "",
        row: (l.row && typeof l.row === "object") ? l.row : {}, // full sheet row for template tokens
      })).filter((l) => l.leadUrl);

      // Accounts: explicit profileIds, else the DISTINCT set the leads route to
      // (auto-routed modes derive their account pool from the sheet, so the
      // caller doesn't have to pass profileIds separately).
      let profileIds = Array.isArray(b.profileIds) ? b.profileIds.filter(Boolean) : [];
      if (!profileIds.length) {
        profileIds = [...new Set(normLeads.map((l) => l.routeAccount).filter(Boolean))];
      }
      if (!profileIds.length) return res.status(400).json({ error: "No accounts — pass profileIds, or leads with a routeAccount (auto-routed modes)." });

      const id = b.id || genId();
      await store.createCampaign({
        id,
        name: b.name || "",
        mode,
        owner: b.owner || "",
        profileIds,
        sheetUrl: b.sheetUrl || "",
        dailyLimit: b.dailyLimit ?? 50,
        config: b.config || {},
        status: "queued",
      });
      const added = normLeads.length ? await store.addLeads(id, normLeads) : 0;

      // Connect modes: don't re-action leads the sheet already marked. Any lead
      // whose row has a non-blank "Connection Request Status" (sent / already
      // connected / errored in a prior run) is flipped out of 'pending' so the
      // worker never re-opens that profile. See store.markPreActionedConnectLeads.
      let preSkipped = 0;
      if (/^connect/.test(mode) && typeof store.markPreActionedConnectLeads === "function") {
        const accountEmails = (b.config && b.config.accountEmails) || {};
        const emailToPid = {};
        for (const [pid, email] of Object.entries(accountEmails)) {
          if (email) emailToPid[String(email).trim().toLowerCase()] = pid;
        }
        try { preSkipped = await store.markPreActionedConnectLeads(id, emailToPid); } catch (e) { log(`campaign ${id}: pre-actioned skip failed — ${e.message}`); }
        // Cross-campaign: leads already actioned by a SIBLING campaign on the
        // same sheet (duplicate launches) — the sheet snapshot can't know.
        if (typeof store.markCrossCampaignActionedLeads === "function") {
          try { preSkipped += await store.markCrossCampaignActionedLeads(id, b.sheetUrl || ""); } catch (e) { log(`campaign ${id}: cross-campaign skip failed — ${e.message}`); }
        }
      }

      // Warm-up narration: the operator's log was blind from dispatch until the
      // first browser opened. First line of the campaign's event feed, written
      // by the always-on API pod the moment the campaign lands.
      if (typeof store.appendMonitorLog === "function") {
        try {
          await store.appendMonitorLog(id, `📦 Campaign received by the engine — ${added} lead${added === 1 ? "" : "s"} imported${preSkipped ? ` · ${preSkipped} already actioned in the sheet (skipped, won't be re-sent)` : ""} · ${profileIds.length} account${profileIds.length === 1 ? "" : "s"} · waiting for a VM worker to pick it up…`);
        } catch (_) { /* narration is best-effort */ }
      }

      log(`campaign ${id} (${mode}) queued — ${added} leads${preSkipped ? ` (${preSkipped} already-actioned, won't re-open)` : ""}, accounts=${profileIds.join(",")}`);
      res.json({ started: true, id, mode, leadsAdded: added, preSkipped });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── list ──
  app.get("/api/campaign/list", async (req, res) => {
    if (need(res)) return;
    try {
      const { rows } = await store.pg.query(
        req.query.owner
          ? "SELECT id,name,mode,status,owner,profile_ids,daily_limit,config,created_at,updated_at,monitoring_until FROM campaigns WHERE owner=$1 ORDER BY created_at DESC"
          : "SELECT id,name,mode,status,owner,profile_ids,daily_limit,config,created_at,updated_at,monitoring_until FROM campaigns ORDER BY created_at DESC",
        req.query.owner ? [req.query.owner] : []
      );
      const withLive = await Promise.all(rows.map(async (r) => {
        const lv = await liveOf(r.id);
        const primarySession = await store.getPrimarySessionStatus(r);
        const { config, ...rest } = r; // explicit-column list — config was only fetched to derive primarySession, don't ship the full templates jsonb
        return { ...rest, live: lv.live, liveAccount: lv.liveAccount, primarySession };
      }));
      res.json({ campaigns: withLive });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── one campaign + progress ──
  app.get("/api/campaign/:id", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      const counts = await store.leadStatusCounts(req.params.id);
      const lv = await liveOf(req.params.id);
      const primarySession = await store.getPrimarySessionStatus(c);
      // Per-account check-sweep events (newest-first) for the app's Live Status feed.
      const monitorLog = typeof store.getMonitorLog === "function" ? await store.getMonitorLog(req.params.id) : [];
      res.json({ campaign: { ...c, primarySession }, leadCounts: counts, live: lv.live, liveAccount: lv.liveAccount, liveProgress: lv.liveProgress, monitorLog });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── per-lead detail (feeds the app's live log) ──
  // The app polls this to render the same per-lead live log a local run shows
  // (sent / skipped / accepted / intro-fired lines) instead of only aggregate
  // counts. Trimmed projection — never ships the full row JSONB. Optional
  // ?status= filter; ?limit= caps the payload (most-recent first by sent_at).
  app.get("/api/campaign/:id/leads", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      const rows = await store.getCampaignLeads(req.params.id, { status: req.query.status });
      const limit = Math.max(0, Math.min(Number(req.query.limit) || 500, 2000));
      const leads = rows
        .map((l) => ({
          id: l.id,
          leadUrl: l.lead_url,
          fullName: l.full_name || "",
          account: l.assigned_profile || null,
          status: l.status,
          stage: l.stage || null,
          error: l.error || null,
          sentAt: l.sent_at || null,
          connectionStatus: l.connection_request_status || null,
          connectionAcceptedStatus: l.connection_accepted_status || null,
          introductionStatus: l.introduction_status || null,
          dmStatus: l.dm_status || null,
          // Acceptance/intro moment (monitor-phase outcome) — lets the app place
          // "connection accepted" / "introduced" lines chronologically in the log.
          dateLastAction: l.date_last_action || null,
        }))
        .sort((a, b) => {
          // most-recent activity first: sent_at desc, nulls last, tiebreak by id
          const ta = a.sentAt ? new Date(a.sentAt).getTime() : 0;
          const tb = b.sentAt ? new Date(b.sentAt).getTime() : 0;
          return tb - ta || (b.id - a.id);
        })
        .slice(0, limit);
      res.json({ leads, total: rows.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── per-account status (feeds the app's Live Status "Accounts" panel) ──
  // For each of the campaign's accounts: sender email, today's send count vs the
  // daily limit, and whether it's parked (throttled / weekly cap) or needs login.
  // Mirrors what the local machine shows per account. Read-only; safe to poll.
  app.get("/api/campaign/:id/accounts", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      const cfg = c.config || {};
      const emails = cfg.accountEmails || {};
      const profileIds = Array.isArray(c.profile_ids) ? c.profile_ids : [];
      const day = new Date().toISOString().slice(0, 10); // UTC day, matches dailyCount keys
      const base = typeof store.accountStatuses === "function"
        ? await store.accountStatuses(profileIds, day, c.daily_limit || 0)
        : profileIds.map((profileId) => ({ profileId, dailyCount: 0, dailyLimit: c.daily_limit || 0, parked: false, parkReason: "", needsLogin: false }));
      // CC+IC only: whether each account has connected to the campaign's primary
      // person yet (campaign_primary_conn.state === "connected"). null when N/A.
      const isCCIC = c.mode === "connect_and_introduce";
      const accounts = [];
      for (const a of base) {
        let primaryConnected = null;
        if (isCCIC && typeof store.getPrimaryConn === "function") {
          try { const pc = await store.getPrimaryConn(c.id, a.profileId); primaryConnected = !!(pc && pc.state === "connected"); }
          catch (_) { primaryConnected = null; }
        }
        accounts.push({ ...a, email: emails[a.profileId] || "", primaryConnected });
      }
      res.json({ accounts, dailyLimit: c.daily_limit || 0, mode: c.mode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Live MJPEG screencast of the campaign's active browser (spec:
  // ortus-gologin-clone/docs/cloud-engine-campaign-view-spec.md). The browser
  // runs on a worker pod; find it via cmp:live:<id> and proxy to that pod
  // (mirrors the scrape View cross-pod path). 404 when idle/not running.
  app.get("/api/campaign/:id/view", async (req, res) => {
    if (need(res)) return;
    const lv = await liveOf(req.params.id);
    if (!lv.live || !lv._stamp || !lv._stamp.podIP) {
      return res.status(404).json({ error: "no active session" });
    }
    const podPort = String(lv._stamp.podPort || "3000");
    const target = `http://${lv._stamp.podIP}:${podPort}/api/campaign/${encodeURIComponent(req.params.id)}/view?internal=1`;
    proxyStream(target, req, res);
  });

  // ── stop / pause ──
  app.post("/api/campaign/:id/stop", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      // keepMonitoring=1 → the app's "Stop sending, keep monitoring": stop
      // claiming new leads (status leaves the active-send set) but transition
      // into the monitoring window instead of cancelling — already-sent connects
      // keep being swept for acceptance + auto-intro/DM. Unsent leads stay
      // pending (never re-sent, since monitoring isn't in getActiveCampaigns).
      if (req.query.keepMonitoring) {
        const r = await transitionToMonitoring(store, c, { log });
        log(`campaign ${req.params.id} → stop(keepMonitoring) → ${r.status}`);
        return res.json({ ok: true, status: r.status, monitoringUntil: r.monitoringUntil });
      }
      const status = req.query.pause ? "paused" : "cancelled";
      await store.setCampaignStatus(req.params.id, status);
      log(`campaign ${req.params.id} → ${status}`);
      res.json({ ok: true, status });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── resume (mirrors the local Resume — un-pauses a paused campaign) ──
  // Pause is stop?pause=1 → status 'paused' (leaves the active-send set, so the
  // scheduler stops claiming leads). Resume flips it back to 'running' so
  // getActiveCampaigns picks it up again and the worker continues from where it
  // left off (pending leads stayed pending). Idempotent: a non-paused campaign
  // returns its current status without change.
  app.post("/api/campaign/:id/resume", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      if (c.status !== "paused") return res.json({ ok: true, status: c.status, alreadyRunning: c.status === "running" });
      await store.setCampaignStatus(req.params.id, "running");
      log(`campaign ${req.params.id} → resumed (running)`);
      res.json({ ok: true, status: "running" });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── restart (re-activate a cancelled/stopped/errored campaign) ──
  // Mirror of the local "restart a stopped campaign": flips a TERMINAL status
  // ('cancelled'/'error'; 'paused' too) back to 'running' so getActiveCampaigns
  // reclaims it and the worker continues. Per-lead state governs progress —
  // leads already sent carry sentAt and are skipped, so this continues where it
  // left off with no double-send. Body { fromStart } is accepted for parity with
  // the app's two buttons (Continue vs Restart-from-start) but does NOT clear
  // lead sentAt — the operator chose "still skip done rows", so both re-scan and
  // act only on un-actioned leads. Idempotent: a running/monitoring campaign
  // returns its current status unchanged.
  app.post("/api/campaign/:id/restart", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      if (c.status === "running" || c.status === "monitoring") {
        return res.json({ ok: true, status: c.status, alreadyRunning: true });
      }
      const fromStart = !!(req.body && req.body.fromStart);
      // The operator may have edited the daily limit while it was stopped — apply
      // the new value to the campaign record before re-activating, so the send
      // gate uses it (and the accounts panel shows it).
      let dailyLimitApplied = null;
      const dl = req.body && req.body.dailyLimit;
      if (dl != null && typeof store.setDailyLimit === "function") {
        const n = Math.floor(Number(dl));
        if (Number.isFinite(n) && n > 0 && n !== c.daily_limit) {
          await store.setDailyLimit(req.params.id, n);
          dailyLimitApplied = n;
        }
      }
      // Re-run the pre-actioned skips before re-activating: a sibling campaign
      // (or a local run) may have actioned leads on this sheet while this one
      // was stopped — those must not be re-opened on the continued run.
      let preSkipped = 0;
      if (/^connect/.test(c.mode) && typeof store.markCrossCampaignActionedLeads === "function") {
        try { preSkipped = await store.markCrossCampaignActionedLeads(req.params.id, c.sheet_url || ""); } catch (_) {}
      }
      await store.setCampaignStatus(req.params.id, "running");
      if (preSkipped && typeof store.appendMonitorLog === "function") {
        try { await store.appendMonitorLog(req.params.id, `⏭ ${preSkipped} lead${preSkipped === 1 ? "" : "s"} actioned elsewhere while stopped — excluded from the continued run`); } catch (_) {}
      }
      log(`campaign ${req.params.id} → restart (${c.status} → running${fromStart ? ", fromStart" : ""}${dailyLimitApplied ? `, dailyLimit=${dailyLimitApplied}` : ""}${preSkipped ? `, ${preSkipped} cross-skipped` : ""})`);
      res.json({ ok: true, status: "running", fromStart, dailyLimit: dailyLimitApplied ?? c.daily_limit, preSkipped });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── manual check-now (mirrors the local "⚡ Check now") ──
  // Arms the monitor task to fire immediately — an acceptance sweep that marks
  // newly-connected leads and fires the CC+IC intro / CC+DM message for them.
  // Allowed while still SENDING ('running') too, not only in 'monitoring': for a
  // long connect_and_* campaign this lets the operator flush intros for leads who
  // already accepted, instead of waiting for end-of-send. Safe mid-send because
  // the sweep contends for the same per-account lock as the send worker (it skips
  // any account busy sending). handleMonitor treats a running-campaign sweep as a
  // ONE-SHOT (it doesn't start recurring monitoring during the send phase).
  app.post("/api/campaign/:id/check-now", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      if (!["monitoring", "running", "cancelled"].includes(c.status)) {
        return res.status(409).json({ error: `campaign is ${c.status}; check-now needs it running, monitoring, or stopped` });
      }
      // scope: "campaign" (default) sweeps this campaign's own accounts; "all"
      // sweeps every unique account in the sheet's "Account Used" column — mirrors
      // the local "⚡ Check now" prompt (all accounts on the sheet vs just this run).
      const scope = (req.body && req.body.scope === "all") ? "all" : "campaign";
      const now = new Date();
      await store.armMonitorTask(req.params.id, now, scope);
      await store.setMonitorState(req.params.id, { nextCheckAt: now });
      log(`campaign ${req.params.id} → check-now (scope=${scope}; monitor task armed; status=${c.status})`);
      res.json({ ok: true, queued: true, scope });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── local-check write-back ──
  // The operator ran an acceptance check for this campaign on THEIR OWN machine
  // (the app's local GoLogin sweep — stamps results into the Google Sheet). The
  // app then posts the sheet's per-lead statuses here so the engine's leads
  // mirror them, and the VM's next sweep won't re-intro someone the local check
  // already introduced. Fill-only: never overwrites a non-blank engine value.
  // Body: { leads: [{ leadUrl, connectionAcceptedStatus?, introductionStatus? }] }
  app.post("/api/campaign/:id/lead-status-sync", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      const rows = Array.isArray(req.body && req.body.leads) ? req.body.leads : [];
      const r = await store.syncLeadStatuses(req.params.id, rows);
      log(`campaign ${req.params.id}: local-check status sync — ${rows.length} row(s) in, ${r.matched} lead(s) updated`);
      res.json({ ok: true, ...r });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── un-bench an account (operator "Retry" on a weekly-cap bench) ──
  // Clears the weekly-cap flag, the park, and the 429 streak so the account is
  // immediately eligible again. If LinkedIn is still capping it, the escalation
  // re-benches it after the same three strikes.
  app.post("/api/campaign/:id/accounts/:profileId/unbench", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      const pid = req.params.profileId;
      if (!(c.profile_ids || []).includes(pid)) return res.status(400).json({ error: "account is not part of this campaign" });
      await store.unbenchAccount(pid);
      const email = ((c.config || {}).accountEmails || {})[pid] || pid;
      if (typeof store.appendMonitorLog === "function") {
        try { await store.appendMonitorLog(req.params.id, `▶ ${email} — un-benched by the operator · eligible again from the next turn`); } catch (_) {}
      }
      log(`campaign ${req.params.id}: ${pid} un-benched (weekly-cap flag + park + 429 streak cleared)`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── auto-checks toggle (mirrors the local "Automatic checks") ──
  // Sets auto_checks_enabled. Enabling (re-)arms the monitor task by the cadence;
  // disabling lets handleMonitor park after its current run. Body: { enabled }.
  app.post("/api/campaign/:id/auto-checks", async (req, res) => {
    if (need(res)) return;
    try {
      const c = await store.getCampaign(req.params.id);
      if (!c) return res.status(404).json({ error: "not found" });
      const enabled = !!(req.body && req.body.enabled);
      await store.setMonitorState(req.params.id, { autoChecksEnabled: enabled });
      if (enabled && c.status === "monitoring") {
        const next = new Date(Date.now() + (Number(c.check_interval_minutes) || 60) * 60000);
        await store.armMonitorTask(req.params.id, next);
        await store.setMonitorState(req.params.id, { nextCheckAt: next });
      }
      log(`campaign ${req.params.id} → auto-checks ${enabled ? "on" : "off"}`);
      res.json({ ok: true, autoChecksEnabled: enabled });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── primary session upload (VM-side capture posts here after a fresh login) ──
  // Resumes any follow_up tasks that were parked waiting on this primary.
  app.post("/api/primaries/:memberId/session", async (req, res) => {
    if (need(res)) return;
    try {
      const b = req.body || {};
      await store.upsertPrimarySession({
        memberId: req.params.memberId,
        publicIdentifier: b.publicIdentifier,
        displayName: b.displayName,
        cookies: b.cookies,
      });
      const { resumed } = await store.resumeParkedFollowups(b.publicIdentifier);
      log(`primary ${req.params.memberId} session uploaded — resumed ${resumed} parked follow-up(s)`);
      res.json({ ok: true, resumed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── primary session read by slug (public-identifier lookup) ──
  app.get("/api/primaries/by-slug/:slug", async (req, res) => {
    if (need(res)) return;
    try {
      const row = await store.getPrimaryBySlug(req.params.slug);
      if (!row) return res.json({ state: "none" });
      res.json({ state: row.state, name: row.display_name || "", capturedAt: row.captured_at });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── personal-primary follow-ups the owner's app drains locally ──
  // The VM never sends a personal follow-up; the app polls these, enqueues them
  // into its local runner, and acks (→ 'delegated').
  app.get("/api/local-followups", async (req, res) => {
    if (need(res)) return;
    const owner = req.query.owner;
    if (!owner) { res.status(400).json({ error: "owner required" }); return; }
    try {
      const rows = await store.getPendingLocalFollowups(owner);
      const followups = rows.map((r) => ({
        taskId: r.taskId, campaignId: r.campaignId, sheetUrl: r.sheetUrl,
        threadUrl: r.payload.threadUrl || "", body: r.payload.body || "",
        leadUrl: r.payload.leadUrl || "", leadName: r.payload.leadName || "",
        primaryName: r.payload.primaryName || "", primaryUrl: r.payload.primaryUrl || "",
        introTitle: r.payload.introTitle || "", profileId: r.payload.profileId || "",
        dueAt: r.payload.dueAt || null,
      }));
      res.json({ followups });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/local-followups/ack", async (req, res) => {
    if (need(res)) return;
    const taskIds = (req.body && req.body.taskIds) || [];
    const owner = req.body && req.body.owner;
    if (!Array.isArray(taskIds) || !taskIds.length) { res.status(400).json({ error: "taskIds required" }); return; }
    if (!owner) { res.status(400).json({ error: "owner required" }); return; }
    try { res.json(await store.delegateLocalFollowups(taskIds, owner)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { mountCampaignApi, VALID_MODES };
