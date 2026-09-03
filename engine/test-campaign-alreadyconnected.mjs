// test-campaign-alreadyconnected.mjs
//
// CC+IC / CC+DM parity: a pre-existing 1st-degree connection must STILL get its
// intro/DM, exactly like the local app (where the connect skips "Already
// connected" and the idle bulk-check sweep fires the intro from the connected
// account). The engine used to file such leads as `status='error'` with no
// connection_request_status — which the acceptance sweep filters out
// (isMonitorable) — so the intro never fired. These pure tests lock the fix, in
// three links:
//   1. mapConnectResult  — an "Already connected" skip → a distinct alreadyConnected
//                          outcome (NOT success, NOT a plain error).
//   2. CampaignWorker    — alreadyConnected → the lead is marked SKIPPED (terminal,
//                          not error, not counted as a send); anti-dupe recorded.
//   3. reachability      — the stamp alreadyConnectedStamp() writes makes the lead
//                          flow through computeBulkCheckUpdates' trust-the-sheet
//                          branch into connectedUrls (→ runAutoIntros/DMs), even
//                          when it's aged off LinkedIn's ~80 recent connections.
//
// Pure — no pg/redis/browser. Run:  node test-campaign-alreadyconnected.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { computeBulkCheckUpdates } from "./campaign-bulkcheck-core.mjs";

const require = createRequire(import.meta.url);
const { mapConnectResult, MODES } = require("./campaign-action");
const { CampaignWorker } = require("./campaign-worker");
const { alreadyConnectedStamp } = require("./campaign-runtime");
const { leadToRow } = require("./campaign-monitor");

const CONNECT_SPEC = MODES.connect_and_introduce; // CC/CC+IC share force_connect spec

// ── Link 1: mapConnectResult ────────────────────────────────────────────────
test("mapConnectResult: 'Already connected' skip → alreadyConnected (not a failure)", () => {
  const r = mapConnectResult({ action: "skipped", error: "Already connected" }, CONNECT_SPEC);
  assert.equal(r.success, false);
  assert.equal(r.alreadyConnected, true, "flagged as already-connected");
  assert.equal(r.stage, "Already connected");
});

test("mapConnectResult: match is case-insensitive", () => {
  const r = mapConnectResult({ action: "skipped", error: "ALREADY CONNECTED" }, CONNECT_SPEC);
  assert.equal(r.alreadyConnected, true);
});

test("mapConnectResult: a real done action stays a success", () => {
  const r = mapConnectResult({ action: "connection_sent", invitationUrn: "urn:x" }, CONNECT_SPEC);
  assert.equal(r.success, true);
  assert.equal(r.stage, "CC");
  assert.equal(r.invitationUrn, "urn:x");
  assert.ok(!r.alreadyConnected);
});

test("mapConnectResult: a genuine skip (not already-connected) is NOT flagged", () => {
  const r = mapConnectResult({ action: "skipped", error: "lead_timeout_watchdog" }, CONNECT_SPEC);
  assert.equal(r.success, false);
  assert.ok(!r.alreadyConnected, "a real failure must not masquerade as already-connected");
  assert.equal(r.error, "lead_timeout_watchdog");
});

// ── Link 2: the worker marks it skipped, not error ──────────────────────────
function acStore() {
  const leads = [
    { id: "L1", member_urn: "u1", lead_url: "x/1" },
    { id: "L2", member_urn: "u2", lead_url: "x/2" },
  ];
  let idx = 0;
  let consumed = 0; // daily credits consumed minus refunded
  const calls = { markLead: [], markActionSent: [], refundDailySend: [] };
  return {
    calls,
    get consumed() { return consumed; },
    getCampaign: async () => ({ status: "running" }),
    isParked: async () => false,
    dailyCount: async () => 0,
    acquireAccount: async () => true,
    releaseAccount: async () => {},
    heartbeatAccount: async () => {},
    claimNextLead: async () => (idx < leads.length ? leads[idx++] : null),
    pendingLeadCount: async () => leads.length - idx,
    wasActionSent: async () => false,
    tryConsumeDailySend: async () => { consumed++; return { allowed: true }; },
    refundDailySend: async (pid) => { consumed--; calls.refundDailySend.push(pid); },
    markActionSent: async (_cid, key, kind) => { calls.markActionSent.push({ key, kind }); },
    markLead: async (id, status, patch) => { calls.markLead.push({ id, status, patch: patch || {} }); },
    clearThrottle: async () => {},
    releaseLeadToPending: async () => {},
  };
}

const acAction = {
  kind: "connect",
  countsAsSend: true,
  async openSession(profileId) { return { profileId, page: {} }; },
  async connect() { return { success: false, alreadyConnected: true, stage: "Already connected", error: "Already connected" }; },
  async closeSession() {},
};

const campaign = { id: "cAC", mode: "connect_and_introduce", profile_ids: ["acctA"], daily_limit: 50 };

test("worker: already-connected leads are marked SKIPPED (never error) and not counted as sends", async () => {
  const store = acStore();
  const w = new CampaignWorker({ store, action: acAction, batchSize: 8 });
  const n = await w.runTurn(campaign);

  assert.equal(n, 0, "no sends counted — already-connected is not a send");
  assert.equal(store.calls.markLead.length, 2, "both leads reached a terminal mark");
  assert.ok(store.calls.markLead.every((c) => c.status === "skipped"), "already-connected → skipped, NEVER error");
  assert.ok(store.calls.markLead.every((c) => c.patch.stage === "Already connected"), "stage stamped 'Already connected'");
  assert.equal(store.calls.markActionSent.length, 2, "connect anti-dupe recorded so a re-run never re-connects");
  assert.equal(store.calls.refundDailySend.length, 2, "the daily credit consumed by the gate is refunded per lead");
  assert.equal(store.consumed, 0, "net daily-cap consumption is ZERO — an already-connected lead costs no send credit");
});

// ── Link 3: the stamp makes the lead reachable by the sweep ─────────────────
test("reachability: an already-connected-stamped lead, aged off recent connections, is queued for intro", () => {
  const s = alreadyConnectedStamp();
  // Map the stamp onto an engine lead exactly as updateLeadOutcome would persist it.
  const lead = {
    lead_url: "https://www.linkedin.com/in/jane-doe",
    first_name: "Jane", last_name: "Doe",
    connection_request_status: s.connectionRequestStatus,
    connection_accepted_status: s.connectionAcceptedStatus,
    introduction_status: "",           // open intro slot
    assigned_profile: "acctA",
  };
  const row = leadToRow(lead);

  // conns = [] → the lead is NOT in this sweep's ~80 recent connections (the
  // aged-off case). Only the v2.82 trust-the-sheet branch can queue it, and it
  // does so BECAUSE of the "Already connected" accepted-status stamp.
  const { connectedUrls } = computeBulkCheckUpdates(
    [row], [], "LinkedIn URL", "Still Pending (2026-07-14 00:00)",
    { dmSentTerminal: false, profileName: "acctA" }
  );

  assert.ok(
    connectedUrls.includes(lead.lead_url),
    "the already-connected lead must be queued into connectedUrls → runAutoIntros"
  );
});

test("reachability: WITHOUT the accepted-status stamp the lead is NOT queued (proves the stamp is load-bearing)", () => {
  const lead = {
    lead_url: "https://www.linkedin.com/in/jane-doe",
    first_name: "Jane", last_name: "Doe",
    connection_request_status: "Connection Request Sent", // monitorable, but still pending
    connection_accepted_status: "",                        // NOT accepted
    introduction_status: "",
    assigned_profile: "acctA",
  };
  const { connectedUrls } = computeBulkCheckUpdates(
    [leadToRow(lead)], [], "LinkedIn URL", "Still Pending (2026-07-14 00:00)",
    { dmSentTerminal: false, profileName: "acctA" }
  );
  assert.ok(!connectedUrls.includes(lead.lead_url), "a still-pending lead is not intro-queued");
});
