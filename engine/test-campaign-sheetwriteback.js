// test-campaign-sheetwriteback.js
//
// Sheet write-back: after a lead is actioned, its status is pushed to the
// operator's Sheet (via the app's webapp updateRow), then the dirty flag clears.
//   1. buildTracking maps engine lead fields → the Apps Script column headers.
//   2. dirty flagging: markLead(sent) + updateLeadOutcome set sheet_dirty; a
//      re-claim does NOT.
//   3. syncCampaignSheet: pushes dirty rows (mock webapp), clears their flags;
//      a FAILED push leaves the row dirty (retried next sweep).
//   4. no webapp/sheet configured → no-op (Postgres stays the record).
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-sheetwriteback.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { syncCampaignSheet, buildTracking } = require("./campaign-sheet-writer");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const URL_J = "https://linkedin.com/in/jane-doe";

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "sw" });
  await s.migrate();
  const wipe = async () => { await s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE"); const k = await s.redis.keys("cmp:*"); if (k.length) await s.redis.del(...k); };
  await wipe();

  // ── 1) buildTracking mapping (FIELD_MAP keys, not display names) ──
  const tr = buildTracking({
    connection_request_status: "Connection Request Sent", connection_accepted_status: "Connected",
    introduction_status: "", dm_status: "DM Sent", stage: "DM", date_last_action: new Date().toISOString(),
  });
  assert(tr.connectionStatus === "Connection Request Sent" && tr.checkStatus === "Connected", "maps to FIELD_MAP keys (connectionStatus/checkStatus)");
  assert(tr.dmStatus === "DM Sent" && tr.stage === "DM Sent", "maps dmStatus + stage (engine code 'DM' → app wording 'DM Sent')");
  assert(!("introductionStatus" in tr), "empty fields are omitted (not written blank)");
  assert("dateLastAction" in tr, "sends dateLastAction");
  // one-shot connect (stage=CC only) derives the connection status
  const trCC = buildTracking({ stage: "CC", connection_request_status: "" });
  assert(trCC.connectionStatus === "Connection Request Sent", "connect_only (stage=CC, blank status) derives connectionStatus");

  // ── 2) dirty flagging ──
  await s.createCampaign({ id: "sw", mode: "connect_and_message", profileIds: ["a1"],
    config: { sheetsWebappUrl: "https://script.google.com/x/exec", linkedinColumn: "LinkedIn URL" }, sheetUrl: "https://sheets/x" });
  await s.addLeads("sw", [{ leadUrl: URL_J, memberUrn: "u1", fullName: "Jane Doe" }, { leadUrl: "https://l/2", memberUrn: "u2", fullName: "Bob" }]);
  const [jane, bob] = await s.getCampaignLeads("sw");
  await s.markLead(jane.id, "claimed");
  assert((await s.getLeadsNeedingSheetSync("sw")).length === 0, "re-claim does NOT dirty the row");
  await s.markLead(jane.id, "sent", { stage: "CC" });
  await s.updateLeadOutcome(bob.id, { connectionAcceptedStatus: "Connected", stage: "Connected" });
  assert((await s.getLeadsNeedingSheetSync("sw")).length === 2, "sent + updateLeadOutcome both dirty their rows");

  // ── 3) sync pushes + clears; failure keeps dirty ──
  const campaign = await s.getCampaign("sw");
  const calls = [];
  let mode = "ok";
  const push = async (webapp, sheetUrl, linkedinUrl, tracking) => {
    calls.push({ webapp, linkedinUrl, tracking });
    return mode === "fail" ? { error: "boom" } : { ok: true };
  };
  // first: fail → rows stay dirty
  mode = "fail";
  let r = await syncCampaignSheet({ store: s, campaign, push });
  assert(r.failed === 2 && r.pushed === 0, "failed push counted");
  assert((await s.getLeadsNeedingSheetSync("sw")).length === 2, "failed rows STAY dirty (retryable)");
  // then: ok → rows push + clear
  mode = "ok"; calls.length = 0;
  r = await syncCampaignSheet({ store: s, campaign, push });
  assert(r.pushed === 2, "second sync pushes both rows");
  assert(calls[0].webapp === "https://script.google.com/x/exec", "posts to the campaign's webapp URL");
  assert(calls.some((c) => c.linkedinUrl === URL_J && c.tracking.stage === "CC"), "pushes Jane's CC stamp");
  assert((await s.getLeadsNeedingSheetSync("sw")).length === 0, "dirty flags cleared after successful push");
  // idempotent: nothing left to push
  r = await syncCampaignSheet({ store: s, campaign, push });
  assert(r.pushed === 0, "re-sync with no dirty rows = no-op");

  // ── 4) no webapp configured → no-op ──
  await s.createCampaign({ id: "nw", mode: "connect_only", profileIds: ["a1"], sheetUrl: "https://sheets/y" });
  await s.addLeads("nw", [{ leadUrl: "https://l/n", memberUrn: "n1" }]);
  const l = (await s.getCampaignLeads("nw"))[0];
  await s.markLead(l.id, "sent", { stage: "CC" });
  let posted = 0;
  r = await syncCampaignSheet({ store: s, campaign: await s.getCampaign("nw"), push: async () => { posted++; return { ok: true }; } });
  assert(posted === 0 && r.pushed === 0, "no webapp URL → nothing posted (Postgres stays the record)");

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — Sheet write-back"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
