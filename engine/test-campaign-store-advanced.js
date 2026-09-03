// test-campaign-store-advanced.js
//
// Phase B — the advanced-mode data model (CC+IC / CC+DM / introduce_back).
// Exercises the new schema + CampaignStore methods:
//   1. updateLeadOutcome — per-lead state (connection/accepted/intro/dm status).
//   2. accumulated connections (upsert + getConnections, idempotent, sender-scoped).
//   3. primary-connection state (get/set, transitions).
//   4. campaign monitoring lifecycle (setMonitorState).
//   5. task dedupe (accept/follow-up never double-queued; plain tasks always insert).
//   6. INTEGRATION: getConnections output feeds the ported computeBulkCheckUpdates
//      and an acceptance is detected — proving the data model + matcher compose.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-store-advanced.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "advB" });
  await s.migrate(); // idempotent — applies the Phase B ALTERs + new tables
  const wipe = async () => s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE");
  await wipe();

  await s.createCampaign({ id: "cb", mode: "connect_and_introduce", profileIds: ["acct1"] });
  await s.addLeads("cb", [{ leadUrl: "https://linkedin.com/in/jane-doe", memberUrn: "ACoAAaaa", fullName: "Jane Doe" }]);
  const [lead] = await s.getCampaignLeads("cb");

  // ── 1) updateLeadOutcome — multi-step lifecycle ──
  await s.updateLeadOutcome(lead.id, { connectionRequestStatus: "Connection Request Sent", stage: "Connect Pending", slug: "jane-doe", memberNumber: "111" });
  await s.updateLeadOutcome(lead.id, { connectionAcceptedStatus: "Connected", connectedAlready: true, stage: "Connected" });
  await s.updateLeadOutcome(lead.id, { introductionStatus: "Introduction Made", threadUrl: "https://linkedin.com/messaging/thread/x" });
  const [l1] = await s.getCampaignLeads("cb");
  assert(l1.connection_request_status === "Connection Request Sent", "connection_request_status persisted");
  assert(l1.connection_accepted_status === "Connected", "connection_accepted_status (cc) persisted");
  assert(l1.introduction_status === "Introduction Made", "introduction_status (one-shot) persisted");
  assert(l1.connected_already === true && l1.stage === "Connected", "connected_already + stage persisted");
  assert(l1.linkedin_slug === "jane-doe" && l1.member_number === "111", "identity fields persisted");
  assert(l1.thread_url.includes("/messaging/thread/"), "thread_url persisted (for follow-ups)");
  assert(l1.date_last_action != null, "date_last_action stamped");
  // partial update doesn't clobber other fields
  await s.updateLeadOutcome(l1.id, { dmStatus: "" });
  const [l2] = await s.getCampaignLeads("cb");
  assert(l2.introduction_status === "Introduction Made", "partial update preserves other columns (COALESCE)");

  // ── 2) accumulated connections (sender-scoped, idempotent) ──
  const conns = [
    { publicId: "jane-doe", urn: "ACoAAaaa", memberNumber: "111", firstName: "Jane", lastName: "Doe" },
    { publicId: "bob-smith", urn: "ACoAAbbb", memberNumber: "222", firstName: "Bob", lastName: "Smith" },
  ];
  const n1 = await s.upsertConnections("cb", "acct1", conns);
  assert(n1 === 2, "upsertConnections inserted 2");
  await s.upsertConnections("cb", "acct1", conns); // re-upsert
  const got = await s.getConnections("cb", "acct1");
  assert(got.length === 2, "re-upsert is idempotent (still 2, no dupes)");
  assert(got.every((c) => c.account === "acct1"), "connections carry account (for sender-scoping)");
  assert(got.find((c) => c.publicId === "jane-doe").firstName === "Jane", "connection shape matches getRecentConnections");
  // a different account's connections are scoped separately
  await s.upsertConnections("cb", "acct2", [{ publicId: "carol-x", urn: "ACoAAccc", memberNumber: "333" }]);
  assert((await s.getConnections("cb", "acct1")).length === 2, "acct2's connections don't leak into acct1");

  // ── 3) primary-connection state ──
  assert((await s.getPrimaryConn("cb", "acct1")) === null, "primary-conn starts unset");
  await s.setPrimaryConn("cb", "acct1", "pending", { primaryUrl: "https://linkedin.com/in/primary" });
  let pc = await s.getPrimaryConn("cb", "acct1");
  assert(pc.state === "pending" && pc.primary_url.includes("/in/primary"), "primary-conn set to pending");
  await s.setPrimaryConn("cb", "acct1", "connected"); // transition, keep primary_url
  pc = await s.getPrimaryConn("cb", "acct1");
  assert(pc.state === "connected" && pc.primary_url.includes("/in/primary"), "transition to connected keeps primary_url");

  // ── 4) monitoring lifecycle ──
  const until = new Date(Date.now() + 7 * 86400000);
  await s.setMonitorState("cb", { monitorState: "monitoring", checkIntervalMinutes: 30, sendingEndedAt: new Date(), monitoringUntil: until, nextCheckAt: new Date(Date.now() + 1800000) });
  const camp = await s.getCampaign("cb");
  assert(camp.monitor_state === "monitoring", "monitor_state → monitoring");
  assert(camp.check_interval_minutes === 30, "check_interval_minutes persisted");
  assert(camp.next_check_at != null && camp.monitoring_until != null, "next_check_at + monitoring_until persisted");

  // ── 5) task dedupe ──
  const t1 = await s.createTask({ campaignId: "cb", type: "accept", dedupeKey: "accept:acct1" });
  const t2 = await s.createTask({ campaignId: "cb", type: "accept", dedupeKey: "accept:acct1" });
  assert(t1 && !t2, "dedupeKey: 2nd identical task is a no-op (null)");
  const m1 = await s.createTask({ campaignId: "cb", type: "monitor" });
  const m2 = await s.createTask({ campaignId: "cb", type: "monitor" });
  assert(m1 && m2, "plain tasks (no dedupeKey) always insert");

  // ── 6) INTEGRATION: data model feeds the ported matcher ──
  const { computeBulkCheckUpdates } = await import("./campaign-bulkcheck-core.mjs");
  const matchConns = await s.getConnections("cb", "acct1");
  const row = { "First Name": "Jane", "Last Name": "Doe", "LinkedIn URL": "https://linkedin.com/in/jane-doe", "Connection Request Status": "Connection Request Sent", "Connected Status": "" };
  const { connectedUrls } = computeBulkCheckUpdates([row], matchConns, "LinkedIn URL", "Still Pending (2026-05-12)", { suppressAcceptedStamp: false });
  assert(connectedUrls.includes("https://linkedin.com/in/jane-doe"), "INTEGRATION: getConnections feeds computeBulkCheckUpdates → acceptance detected");

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — advanced-mode data model (Phase B)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
