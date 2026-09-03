// test-campaign-monitor-needslogin.js
//
// Operator alert on a dead session DURING MONITORING. Before this, an expired
// LinkedIn login on a monitoring account surfaced as a `.error` sentinel from
// getRecentConnections that runBulkCheck ignored → the sweep recorded "0
// acceptances" and the operator got NO signal (Antonio's Jul-10 run silently
// checked nothing for days). Now: runBulkCheck surfaces a typed `sessionInvalid`
// throw, and the scheduler's handleMonitor stamps SoO "Needs Login: Y" (the same
// writer the send path uses) so the operator knows to re-login in GoLogin.
//
// Pure unit test — stub store + injected openSession/fetchRecent/markNeedsLogin.
// No PG/Redis/browser/LinkedIn.
//   node test-campaign-monitor-needslogin.js

const { runBulkCheck, isSessionInvalidError } = require("./campaign-monitor");
const { buildRuntime } = require("./campaign-runtime");
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

const COOKIE_ERR = "Failed to read the 'cookie' property from 'Document': Access is denied for this document.";
const sentinel = (msg) => Object.assign([], { error: msg });

(async () => {
  // ── 1) Classifier: session-death signals vs benign/transient ────────────────
  assert(isSessionInvalidError(COOKIE_ERR) === true, "classifier: cookie Access-is-denied → session invalid");
  assert(isSessionInvalidError("HTTP 403 Forbidden") === true, "classifier: 403 → session invalid");
  assert(isSessionInvalidError("redirected to /login") === true, "classifier: login redirect → session invalid");
  assert(isSessionInvalidError("empty-after-3-strategies (keys: ...)") === false, "classifier: empty-after-strategies → NOT session invalid");
  assert(isSessionInvalidError("") === false && isSessionInvalidError(undefined) === false, "classifier: empty/undefined → false");

  // ── 2) runBulkCheck SURFACES a session-invalid sentinel as a typed throw ─────
  //     (and does so BEFORE touching the store — proves it short-circuits).
  {
    let touched = false;
    const store = { upsertConnections: async () => { touched = true; } };
    let thrown = null;
    try {
      await runBulkCheck({ store, campaign: { id: "c1", mode: "connect_and_introduce" }, account: "p1", page: {}, fetchRecent: async () => sentinel(COOKIE_ERR) });
    } catch (e) { thrown = e; }
    assert(thrown && thrown.sessionInvalid === true, "runBulkCheck throws a typed sessionInvalid error on a dead session");
    assert(touched === false, "runBulkCheck short-circuits before store.upsertConnections (no bogus '0 acceptances' write)");
  }

  // ── 3) A BENIGN error sentinel does NOT throw (transient fetch ≠ re-login) ───
  {
    const store = {
      upsertConnections: async () => {}, getAllConnections: async () => [], getConnections: async () => [], getCampaignLeads: async () => [],
    };
    let thrown = null;
    try {
      const r = await runBulkCheck({ store, campaign: { id: "c1", mode: "connect_and_introduce" }, account: "p1", page: {}, fetchRecent: async () => sentinel("empty-after-3-strategies") });
      assert(Array.isArray(r.connectedUrls) && r.connectedUrls.length === 0, "benign error → normal empty result, no throw");
    } catch (e) { thrown = e; }
    assert(!thrown, "runBulkCheck does NOT throw on a benign/transient error sentinel");
  }

  // ── 4) FULL WIRING: dead session in a monitor sweep → SoO Needs-Login stamped ─
  {
    const campaign = {
      id: "c1", mode: "connect_and_introduce", status: "monitoring", profile_ids: ["p1"],
      monitoring_until: new Date(Date.now() + 86400000).toISOString(), check_interval_minutes: 60,
      config: { accountEmails: { p1: "operator@ortus.solutions" }, sheetsWebappUrl: "http://webapp", sooSheetId: "SID", sooGid: "GID", checkIntervalMinutes: 60, monitoringDays: 7 },
    };
    const store = {
      getCampaign: async () => campaign, acquireAccount: async () => true, releaseAccount: async () => {},
      setMonitorState: async () => {}, setCampaignStatus: async () => {},
      upsertConnections: async () => {}, getAllConnections: async () => [], getConnections: async () => [], getCampaignLeads: async () => [],
    };
    const mnl = [];
    const logs = [];
    const rt = buildRuntime({ store, deps: {
      openSession: async () => ({ page: {}, close: async () => {} }),
      fetchRecent: async () => sentinel(COOKIE_ERR),
      markNeedsLogin: async (args) => { mnl.push(args); return { ok: true }; },
      pushSheetRow: async () => {}, sleep: async () => {}, log: (m) => logs.push(m),
    }});
    await rt.handleMonitor({ campaign_id: "c1" });

    assert(mnl.length === 1, "handleMonitor stamps SoO exactly once for the dead account");
    assert(mnl[0].email === "operator@ortus.solutions", "SoO stamp carries the operator's account email (from config.accountEmails)");
    assert(mnl[0].webappUrl === "http://webapp" && mnl[0].sooSheetId === "SID" && mnl[0].sooGid === "GID", "SoO stamp routed to the operator's webapp + SoO sheet/gid");
    assert(logs.some((l) => /session expired/.test(l) && /re-login/.test(l)), "operator log states the session expired and what to do (re-login in GoLogin)");
  }

  // ── 5) A benign monitor error does NOT nag the operator ─────────────────────
  {
    const campaign = {
      id: "c2", mode: "connect_and_introduce", status: "monitoring", profile_ids: ["p1"],
      monitoring_until: new Date(Date.now() + 86400000).toISOString(), check_interval_minutes: 60,
      config: { accountEmails: { p1: "operator@ortus.solutions" }, sheetsWebappUrl: "http://webapp", sooSheetId: "SID", sooGid: "GID" },
    };
    const store = {
      getCampaign: async () => campaign, acquireAccount: async () => true, releaseAccount: async () => {},
      setMonitorState: async () => {}, setCampaignStatus: async () => {},
      upsertConnections: async () => {}, getAllConnections: async () => [], getConnections: async () => [], getCampaignLeads: async () => [],
    };
    const mnl = [];
    const rt = buildRuntime({ store, deps: {
      openSession: async () => ({ page: {}, close: async () => {} }),
      fetchRecent: async () => sentinel("empty-after-3-strategies"),
      markNeedsLogin: async (args) => { mnl.push(args); return { ok: true }; },
      pushSheetRow: async () => {}, sleep: async () => {}, log: () => {},
    }});
    await rt.handleMonitor({ campaign_id: "c2" });
    assert(mnl.length === 0, "benign monitor error does NOT stamp SoO (no false re-login nag)");
  }

  console.log("\nAll monitor needs-login tests passed.");
})().catch((e) => { console.error(e); process.exitCode = 1; });
