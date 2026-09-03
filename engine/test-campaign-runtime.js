// test-campaign-runtime.js
//
// Phase H — FULL INTEGRATION through the single runtime (buildRuntime), all 5
// modes, mock browser deps only. This is the whole engine end-to-end:
//   1. connect_only        → send phase → campaign done.
//   2. introduce_back      → intro per lead → done.
//   3. follower_growth     → batch invite pass → done.
//   4. connect_and_message → connect → monitoring armed → sweep detects
//        acceptance → DM fired → window expiry → done.
//   5. connect_and_introduce → same through intro path + follow-up & accept
//        tasks handled by the scheduler.
//   6. multi-pod: two runtimes share one campaign without double-sending.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-runtime.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { buildRuntime } = require("./campaign-runtime");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const quiet = () => {};

const JANE = "https://linkedin.com/in/jane-doe";
const BOB = "https://linkedin.com/in/bob-smith";

function mkStore(podId) {
  return new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId });
}

// A mock browser world shared by all deps of one runtime.
function mockDeps(overrides = {}) {
  const calls = { sessions: [], outreach: [], dms: [], intros: [], followUps: [], accepts: [], invites: [] };
  return {
    calls,
    deps: {
      log: quiet,
      sleep: async () => {}, // no-op: don't actually wait the 30–60s ban-safety delay
      openSession: async (profileId) => { calls.sessions.push(profileId); return { page: { _mock: true }, close: async () => {} }; },
      makeWorkerAction: (campaign) => ({
        kind: campaign.mode === "introduce_back" ? "intro" : campaign.mode === "message_only" ? "message" : "connect",
        async openSession(pid) { return { profileId: pid }; },
        async connect(_s, lead) { calls.outreach.push(lead.lead_url); return { success: true, stage: "CC" }; },
        async closeSession() {},
      }),
      fetchRecent: async () => [],           // per-test override
      checkPrimary: async () => ({ connected: true }),
      readSelf: async () => ({ name: "Acct", profileUrl: "https://linkedin.com/in/acct" }),
      sendIntro: async (a) => { calls.intros.push(a); return { success: true, threadUrl: "https://linkedin.com/messaging/thread/t1" }; },
      sendDm: async (a) => { calls.dms.push(a); return { success: true }; },
      sendInvites: async ({ queued }) => { calls.invites.push(...queued.map((q) => q.memberId)); return { sent: true, invited: queued.map((q) => q.memberId), skipped: [], creditsBefore: 30, creditsAfter: 30 - queued.length }; },
      sendFollowUp: async (a) => { calls.followUps.push(a.payload.leadUrl); return { success: true }; },
      acceptInvite: async (a) => { calls.accepts.push(a.payload.profileId); return { accepted: true }; },
      ...overrides,
    },
  };
}

(async () => {
  const admin = mkStore("admin");
  await admin.migrate();
  const wipe = async () => { await admin.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE"); const k = await admin.redis.keys("cmp:*"); if (k.length) await admin.redis.del(...k); };
  const forceDue = () => admin.pg.query("UPDATE campaign_tasks SET due_at = now() - interval '1 second' WHERE status='pending'");

  // ════ 1) connect_only end-to-end ════
  await wipe();
  await admin.createCampaign({ id: "c1", mode: "connect_only", profileIds: ["a1"], dailyLimit: 50 });
  await admin.addLeads("c1", [{ leadUrl: JANE, memberUrn: "u1", fullName: "Jane Doe" }, { leadUrl: BOB, memberUrn: "u2", fullName: "Bob Smith" }]);
  let m = mockDeps();
  let rt = buildRuntime({ store: admin, deps: m.deps });
  await rt.tickCampaigns();
  assert(m.calls.outreach.length === 2, "connect_only: both leads actioned");
  assert((await admin.getCampaign("c1")).status === "done", "connect_only: campaign → done");

  // ════ 2) introduce_back end-to-end ════
  await wipe();
  await admin.createCampaign({ id: "c2", mode: "introduce_back", profileIds: ["a1"], dailyLimit: 50 });
  await admin.addLeads("c2", [{ leadUrl: JANE, memberUrn: "u1", fullName: "Jane Doe" }]);
  m = mockDeps();
  rt = buildRuntime({ store: admin, deps: m.deps });
  await rt.tickCampaigns();
  assert(m.calls.outreach.length === 1 && (await admin.getCampaign("c2")).status === "done", "introduce_back: sent + done");

  // ════ 3) follower_growth end-to-end ════
  await wipe();
  await admin.createCampaign({ id: "c3", mode: "follower_growth", profileIds: ["a1"], config: { monthlyBudget: 30, inviteUrl: "https://linkedin.com/company/x/invite" } });
  await admin.addLeads("c3", Array.from({ length: 3 }, (_, i) => ({ leadUrl: `https://l/f${i}`, memberUrn: `fu${i}`, fullName: `Fan ${i}` })));
  m = mockDeps();
  rt = buildRuntime({ store: admin, deps: m.deps });
  await rt.tickCampaigns();
  assert(m.calls.invites.length === 3, "follower_growth: all 3 invited in one batch");
  assert((await admin.getCampaign("c3")).status === "done", "follower_growth: campaign → done");
  assert((await admin.getCampaignLeads("c3")).every((l) => l.stage === "Invited"), "leads stamped Invited");

  // ════ 4) connect_and_message full lifecycle ════
  await wipe();
  await admin.createCampaign({
    id: "c4", mode: "connect_and_message", profileIds: ["a1"], dailyLimit: 50,
    config: { ccDmBody: "Thanks {first name}!", checkIntervalMinutes: 30 },
  });
  await admin.addLeads("c4", [{ leadUrl: JANE, memberUrn: "ACoAAaaa", fullName: "Jane Doe" }]);
  let conns = [];               // what the mock "recent connections" returns
  m = mockDeps({ fetchRecent: async () => conns });
  rt = buildRuntime({ store: admin, deps: m.deps });
  await rt.tickCampaigns();     // send phase
  const c4 = await admin.getCampaign("c4");
  assert(c4.status === "monitoring" && c4.monitor_state === "monitoring", "CC+DM: sending done → status 'monitoring' armed");
  assert(c4.monitoring_until && new Date(c4.monitoring_until) > new Date(), "monitoring window set (~7d)");
  const mt = (await admin.pg.query("SELECT * FROM campaign_tasks WHERE type='monitor'")).rows;
  assert(mt.length === 1 && mt[0].dedupe_key === "monitor:c4", "recurring monitor task queued (deduped)");
  const leadC4 = (await admin.getCampaignLeads("c4"))[0];
  assert(leadC4.connection_request_status === "Connection Request Sent", "connect stamped connection_request_status (monitorable)");

  // sweep 1: nobody accepted yet → reschedules, no DM
  await forceDue();
  assert((await rt.scheduler.tickOnce()) === 1, "monitor sweep 1 claimed");
  assert(m.calls.dms.length === 0, "no acceptance → no DM");
  assert((await admin.pg.query("SELECT count(*)::int n FROM campaign_tasks WHERE status='pending'")).rows[0].n === 1, "monitor rescheduled (recurring)");

  // Jane accepts → sweep 2 detects + fires DM
  conns = [{ publicId: "jane-doe", urn: "ACoAAaaa", memberNumber: "111", firstName: "Jane", lastName: "Doe", connectedAt: new Date().toISOString() }];
  await forceDue();
  await rt.scheduler.tickOnce();
  assert(m.calls.dms.length === 1 && m.calls.dms[0].body === "Thanks Jane!", "acceptance detected → personalized DM fired");
  const janeC4 = (await admin.getCampaignLeads("c4"))[0];
  assert(janeC4.connection_accepted_status === "Connected" && janeC4.dm_status === "DM Sent", "lead stamped Connected + DM Sent");

  // sweep 3: anti-dupe (no second DM), then window expiry → done
  await forceDue();
  await rt.scheduler.tickOnce();
  assert(m.calls.dms.length === 1, "re-sweep does NOT re-DM (anti-dupe)");
  await admin.pg.query("UPDATE campaigns SET monitoring_until = now() - interval '1 minute' WHERE id='c4'");
  await forceDue();
  await rt.scheduler.tickOnce();
  const c4End = await admin.getCampaign("c4");
  assert(c4End.status === "done" && c4End.monitor_state === "ended", "window expired → campaign done, monitor ended");
  assert((await admin.pg.query("SELECT count(*)::int n FROM campaign_tasks WHERE status='pending'")).rows[0].n === 0, "no dangling tasks");

  // ════ 5) connect_and_introduce full lifecycle (intro + follow-up + accept) ════
  await wipe();
  await admin.createCampaign({
    id: "c5", mode: "connect_and_introduce", profileIds: ["a1"], dailyLimit: 50,
    config: {
      primaryName: "Pat Primary", primaryIntroBody: "Hi {first name}, meet {primary first name}",
      primaryUrl: "https://linkedin.com/in/pat-primary", introTitle: "Intro",
      autoAcceptPrimary: true, followUpEnabled: true, followUpBody: "Following up, {first name}",
      followUpDelayMinutes: 0, primarySource: "primary-profile", checkIntervalMinutes: 30,
    },
  });
  await admin.addLeads("c5", [{ leadUrl: JANE, memberUrn: "ACoAAbbb", fullName: "Jane Doe" }]);
  conns = [];
  let primaryConnected = false;
  m = mockDeps({ fetchRecent: async () => conns, checkPrimary: async () => ({ connected: primaryConnected, connectAttempted: true }) });
  rt = buildRuntime({ store: admin, deps: m.deps });
  await rt.tickCampaigns();     // send phase → monitoring
  assert((await admin.getCampaign("c5")).status === "monitoring", "CC+IC: monitoring armed");

  // Jane accepts but primary NOT connected → intro held + accept task queued
  conns = [{ publicId: "jane-doe", urn: "ACoAAbbb", memberNumber: "222", firstName: "Jane", lastName: "Doe" }];
  await forceDue();
  await rt.scheduler.tickOnce();
  assert(m.calls.intros.length === 0, "primary gate: intro HELD while not connected");
  // the accept task is queued due-NOW, so the same tick may already have run it
  const acceptTasks = (await admin.pg.query("SELECT * FROM campaign_tasks WHERE type='accept'")).rows;
  assert(acceptTasks.length === 1 && acceptTasks[0].dedupe_key === "accept:a1", "auto-accept task queued for the primary (deduped)");
  await forceDue();
  while ((await rt.scheduler.tickOnce()) > 0) { /* drain anything still due */ }
  assert(m.calls.accepts.length === 1, "accept task handled ONCE on the primary's session (primary-profile)");
  assert(m.calls.sessions.includes("primary-profile"), "accept ran on the PRIMARY'S browser, not the campaign account's");

  // primary now connected → next sweep fires the intro + queues follow-up
  primaryConnected = true;
  await forceDue();
  while ((await rt.scheduler.tickOnce()) > 0) { /* monitor sweep (queues follow_up) */ }
  await forceDue(); // the just-queued follow_up may be ms in the future (clock skew) — force it due
  while ((await rt.scheduler.tickOnce()) > 0) { /* follow_up drain */ }
  assert(m.calls.intros.length === 1, "primary connected → 3-way intro fired");
  const janeC5 = (await admin.getCampaignLeads("c5"))[0];
  assert(janeC5.introduction_status === "Introduction Made", "lead stamped Introduction Made");
  assert(m.calls.followUps.length === 1 && m.calls.followUps[0] === JANE, "delayed follow-up sent via scheduler");

  // expiry → done
  await admin.pg.query("UPDATE campaigns SET monitoring_until = now() - interval '1 minute' WHERE id='c5'");
  await forceDue();
  while ((await rt.scheduler.tickOnce()) > 0) { /* final sweep */ }
  assert((await admin.getCampaign("c5")).status === "done", "CC+IC lifecycle complete → done");

  // ════ 6) two runtime pods cooperate (no double-send) ════
  await wipe();
  await admin.createCampaign({ id: "c6", mode: "connect_only", profileIds: ["pA", "pB"], dailyLimit: 100 });
  await admin.addLeads("c6", Array.from({ length: 12 }, (_, i) => ({ leadUrl: `https://l/m${i}`, memberUrn: `mu${i}`, fullName: `L ${i}` })));
  const sA = mkStore("podA"), sB = mkStore("podB");
  const sent = [];
  const podDeps = () => mockDeps({ makeWorkerAction: () => ({
    kind: "connect",
    async openSession(pid) { return { profileId: pid }; },
    async connect(_s, lead) { await new Promise((r) => setTimeout(r, 3)); sent.push(lead.lead_url); return { success: true, stage: "CC" }; },
    async closeSession() {},
  }) }).deps;
  const rtA = buildRuntime({ store: sA, deps: podDeps() });
  const rtB = buildRuntime({ store: sB, deps: podDeps() });
  await Promise.all([rtA.tickCampaigns(), rtB.tickCampaigns()]);
  assert(sent.length === 12 && new Set(sent).size === 12, `two pods, 12 leads, zero double-sends (sent=${sent.length})`);
  assert((await admin.getCampaign("c6")).status === "done", "multi-pod campaign completes");
  await sA.close(); sA.redis.disconnect(); await sB.close(); sB.redis.disconnect();

  await wipe();
  await admin.close(); admin.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — single-runtime integration (Phase H)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
