// test-campaign-parkedmodes.js
//
// The 3 formerly-parked modes now on the engine (inmail_only, open_profile_only,
// check_status). All reuse performOutreach via a modeHint, so we mock the action
// and assert the factory + worker wiring:
//   1. factory: each mode → correct kind + hint + done set + stage mapping.
//   2. check_status: countsAsSend === false (read-only, off the daily send cap).
//   3. worker: check_status does NOT consume the daily send counter; inmail_only
//      DOES; both stamp per the mode.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-parkedmodes.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { CampaignWorker } = require("./campaign-worker");
const { makeAction, MODES } = require("./campaign-action");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

// Mock action of a given kind that returns a fixed outcome, records sends.
function mockAction(kind, countsAsSend, outcome) {
  const sent = [];
  return { sent, action: {
    kind, countsAsSend,
    async openSession(pid) { return { profileId: pid }; },
    async connect(_s, lead) { sent.push(lead.lead_url); return { success: true, stage: outcome }; },
    async closeSession() {},
  } };
}

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "parked" });
  await s.migrate();
  const wipe = async () => { await s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE"); const k = await s.redis.keys("cmp:*"); if (k.length) await s.redis.del(...k); };
  await wipe();

  // ── 1) factory routing for all three ──
  assert(makeAction({ mode: "inmail_only" }).kind === "inmail", "inmail_only → kind 'inmail'");
  assert(makeAction({ mode: "open_profile_only" }).kind === "op", "open_profile_only → kind 'op'");
  assert(makeAction({ mode: "check_status" }).kind === "check", "check_status → kind 'check'");
  assert(MODES.inmail_only.hint === "force_inmail", "inmail_only uses force_inmail hint");
  assert(MODES.open_profile_only.hint === "force_open_profile", "open_profile_only uses force_open_profile hint");
  assert(MODES.check_status.hint === "check_only", "check_status uses check_only hint");
  assert(MODES.inmail_only.done.has("inmail_sent") && MODES.inmail_only.done.has("op_message_sent"), "inmail_only done set covers inmail_sent + op fallback");
  assert(MODES.check_status.done.has("status_accepted") && MODES.check_status.done.has("status_pending"), "check_status treats both accepted + pending as done");
  assert(MODES.check_status.stage("status_accepted") === "Connected" && MODES.check_status.stage("status_pending") === "Still Pending", "check_status stage mapping");

  // ── 2) countsAsSend flag ──
  assert(makeAction({ mode: "check_status" }).countsAsSend === false, "check_status countsAsSend === false (read-only)");
  assert(makeAction({ mode: "inmail_only" }).countsAsSend === true, "inmail_only countsAsSend === true");

  // ── 3a) check_status worker: NO daily-send consumption ──
  await s.createCampaign({ id: "chk", mode: "check_status", profileIds: ["a1"], dailyLimit: 2 });
  await s.addLeads("chk", Array.from({ length: 5 }, (_, i) => ({ leadUrl: `https://l/c${i}`, memberUrn: `cu${i}`, fullName: `C ${i}` })));
  const chkCamp = await s.getCampaign("chk");
  const mkChk = mockAction("check", false, "Connected");
  await new CampaignWorker({ store: s, action: mkChk.action, today: "2026-06-30" }).runCampaign(chkCamp);
  assert(mkChk.sent.length === 5, `check_status checked ALL 5 leads despite dailyLimit=2 (checked=${mkChk.sent.length})`);
  assert((await s.dailyCount("a1", "2026-06-30")) === 0, "check_status consumed 0 of the daily SEND counter");
  assert((await s.leadStatusCounts("chk")).sent === 5, "all 5 leads stamped");

  // ── 3b) inmail_only worker: DOES respect the daily send cap ──
  await s.createCampaign({ id: "im", mode: "inmail_only", profileIds: ["a2"], dailyLimit: 2 });
  await s.addLeads("im", Array.from({ length: 5 }, (_, i) => ({ leadUrl: `https://l/i${i}`, memberUrn: `iu${i}`, fullName: `I ${i}` })));
  const imCamp = await s.getCampaign("im");
  const mkIm = mockAction("inmail", true, "InMail");
  await new CampaignWorker({ store: s, action: mkIm.action, today: "2026-06-30" }).runCampaign(imCamp);
  assert(mkIm.sent.length === 2, `inmail_only stopped at dailyLimit=2 (sent=${mkIm.sent.length})`);
  assert((await s.dailyCount("a2", "2026-06-30")) === 2, "inmail_only consumed 2 send credits");

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — parked modes (inmail / open-profile / check-status)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
