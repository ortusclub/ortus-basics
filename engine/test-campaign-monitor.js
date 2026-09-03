// test-campaign-monitor.js
//
// Phase C — the acceptance-monitoring engine, end-to-end with a MOCK page
// (canned connections, no real LinkedIn):
//   1. runBulkCheck: accepted lead → cc 'Connected' + connectedUrls; pending lead
//      → 'Still Pending'. Wires getRecentConnections(mock) → upsert/getConnections
//      → computeBulkCheckUpdates → updateLeadOutcome.
//   2. idempotent: a re-run doesn't corrupt an already-Connected lead.
//   3. sender-scoping: a connection owned by a DIFFERENT account doesn't match.
//   4. monitorSweep: acquires/releases the shared account lock, sweeps accounts.
//   5. nextMonitorDecision: 7-day window expiry vs cadence reschedule.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-monitor.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { runBulkCheck, monitorSweep, nextMonitorDecision } = require("./campaign-monitor");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "monC" });
  await s.migrate();
  const wipe = async () => s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE");
  await wipe();

  // CC+IC campaign, two leads, both with an invite already sent by acct1.
  await s.createCampaign({ id: "cm", mode: "connect_and_introduce", profileIds: ["acct1"] });
  await s.addLeads("cm", [
    { leadUrl: "https://linkedin.com/in/jane-doe", memberUrn: "ACoAAaaa", fullName: "Jane Doe" },
    { leadUrl: "https://linkedin.com/in/bob-smith", memberUrn: "ACoAAbbb", fullName: "Bob Smith" },
  ]);
  await s.pg.query(`UPDATE leads SET assigned_profile='acct1', connection_request_status='Connection Request Sent', status='sent' WHERE campaign_id='cm'`);

  // Mock: only Jane appears in recent connections (no account field — upsert scopes it).
  const conns = [{ firstName: "Jane", lastName: "Doe", publicId: "jane-doe", urn: "ACoAAaaa", memberNumber: "111" }];
  const fetchRecent = async () => conns;
  const campaign = await s.getCampaign("cm");

  // ── 1) runBulkCheck detects Jane accepted, Bob still pending ──
  const r1 = await runBulkCheck({ store: s, campaign, account: "acct1", page: null, fetchRecent });
  assert(r1.connectedUrls.includes("https://linkedin.com/in/jane-doe"), "Jane (accepted) is in connectedUrls");
  assert(!r1.connectedUrls.includes("https://linkedin.com/in/bob-smith"), "Bob (not connected) is NOT in connectedUrls");
  const leads1 = await s.getCampaignLeads("cm");
  const jane = leads1.find((l) => l.lead_url.includes("jane-doe"));
  const bob = leads1.find((l) => l.lead_url.includes("bob-smith"));
  assert(jane.connection_accepted_status === "Connected", "Jane stamped cc=Connected");
  assert(jane.connected_already === true, "Jane connected_already=true");
  assert(/still pending/i.test(bob.connection_accepted_status), "Bob stamped Still Pending");

  // ── 2) idempotent re-run ──
  const r2 = await runBulkCheck({ store: s, campaign, account: "acct1", page: null, fetchRecent });
  const janeAfter = (await s.getCampaignLeads("cm")).find((l) => l.lead_url.includes("jane-doe"));
  assert(janeAfter.connection_accepted_status === "Connected", "re-run keeps Jane Connected (no corruption)");
  assert(Array.isArray(r2.connectedUrls), "re-run returns cleanly");

  // ── 3) sender-scoping: a different account's connection doesn't match ──
  await wipe();
  await s.createCampaign({ id: "cs", mode: "connect_and_introduce", profileIds: ["acctA"] });
  await s.addLeads("cs", [{ leadUrl: "https://linkedin.com/in/carol-x", memberUrn: "ACoAAccc", fullName: "Carol X" }]);
  await s.pg.query(`UPDATE leads SET assigned_profile='acctA', connection_request_status='Connection Request Sent', status='sent' WHERE campaign_id='cs'`);
  // Carol's acceptance was seen by a DIFFERENT account (acctB), not acctA.
  await s.upsertConnections("cs", "acctB", [{ publicId: "carol-x", urn: "ACoAAccc", memberNumber: "999" }]);
  const campS = await s.getCampaign("cs");
  const rs = await runBulkCheck({ store: s, campaign: campS, account: "acctA", page: null, fetchRecent: async () => [] });
  assert(!rs.connectedUrls.includes("https://linkedin.com/in/carol-x"), "sender-scoping: acctB's connection does NOT count for acctA");

  // ── 4) monitorSweep acquires/releases the shared lock ──
  await wipe();
  await s.createCampaign({ id: "cw", mode: "connect_and_introduce", profileIds: ["acct1"] });
  await s.addLeads("cw", [{ leadUrl: "https://linkedin.com/in/jane-doe", memberUrn: "ACoAAaaa", fullName: "Jane Doe" }]);
  await s.pg.query(`UPDATE leads SET assigned_profile='acct1', connection_request_status='Connection Request Sent', status='sent' WHERE campaign_id='cw'`);
  const campW = await s.getCampaign("cw");
  let opened = 0;
  const sweep = await monitorSweep({ store: s, campaign: campW, openSession: async () => { opened++; return { page: null, close: async () => {} }; }, fetchRecent });
  assert(opened === 1, "monitorSweep opened a session for the account");
  assert(sweep.accepted.includes("https://linkedin.com/in/jane-doe"), "monitorSweep returns newly-accepted URLs");
  assert((await s.isAccountLocked("acct1")) === false, "monitorSweep released the account lock after");

  // ── 5) window / cadence decision ──
  const past = await s.getCampaign("cw"); past.monitoring_until = new Date(Date.now() - 1000);
  assert(nextMonitorDecision(past).expired === true, "past monitoring_until → expired (stop)");
  const future = await s.getCampaign("cw"); future.monitoring_until = new Date(Date.now() + 86400000); future.check_interval_minutes = 30;
  const dec = nextMonitorDecision(future);
  assert(dec.expired === false && dec.nextCheckAt > new Date(), "future window → reschedule next_check_at by cadence");

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — monitoring engine (Phase C)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
