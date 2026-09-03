// test-followup-as-primary.js
//
// CC+IC follow-up routing:
//   (a) sender = GoLogin profileId   → sent via withAccountSession(sender), NOT
//       payload.profileId (the campaign account) — else it posts as the wrong person.
//   (b) sender = local-browser       → personal primary: the scheduler must NOT
//       claim it (the VM never sends a personal follow-up — the owner's app drains
//       it locally, see local-drain design). Task stays pending, nothing sent.
//   (f) idempotency: a reaper re-dispatch of the SAME GoLogin follow_up must never
//       double-send.
//
// handleFollowUp is a closure inside buildRuntime — reached only by enqueuing a
// real follow_up task and draining via rt.scheduler.tickOnce().
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-followup-as-primary.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { buildRuntime } = require("./campaign-runtime");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const quiet = () => {};

const PRIMARY_URL = "https://linkedin.com/in/pat-primary";

function mockDeps(overrides = {}) {
  const calls = { sessions: [], followUps: [] };
  return {
    calls,
    deps: {
      log: quiet,
      sleep: async () => {},
      openSession: async (profileId) => { calls.sessions.push(profileId); return { page: { _mock: true }, close: async () => {} }; },
      sendFollowUp: async (a) => { calls.followUps.push(a); return { success: true }; },
      ...overrides,
    },
  };
}

(async () => {
  const admin = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "admin" });
  await admin.migrate();
  const wipe = async () => {
    await admin.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaign_primaries, campaigns RESTART IDENTITY CASCADE");
    const k = await admin.redis.keys("sn:proflock:*");
    if (k.length) await admin.redis.del(...k);
    const s = await admin.redis.keys("cmp:sent:*");
    if (s.length) await admin.redis.del(...s);
  };
  const forceDue = () => admin.pg.query("UPDATE campaign_tasks SET due_at = now() - interval '1 second' WHERE status='pending'");

  // ════ (a) GoLogin sender → withAccountSession(sender), NOT the campaign account ════
  await wipe();
  await admin.createCampaign({ id: "fa", mode: "connect_and_introduce", profileIds: ["acct-1"], dailyLimit: 50 });
  let task = await admin.createTask({
    campaignId: "fa", type: "follow_up", dedupeKey: "fu:a",
    payload: { sender: "primary-gologin-acct", profileId: "acct-1", threadUrl: "https://linkedin.com/messaging/thread/t1", body: "Following up, Jane", leadUrl: "https://linkedin.com/in/jane", leadName: "Jane Doe" },
  });
  let m = mockDeps();
  let rt = buildRuntime({ store: admin, deps: m.deps });
  await forceDue();
  assert((await rt.scheduler.tickOnce()) === 1, "(a) task claimed");
  assert(m.calls.followUps.length === 1, "(a) sendFollowUp fired once");
  assert(m.calls.sessions.includes("primary-gologin-acct"), "(a) session opened on the PRIMARY's GoLogin profile (sender), not payload.profileId");
  assert(!m.calls.sessions.includes("acct-1"), "(a) session NOT opened on the campaign account");
  assert((await admin.pg.query("SELECT status FROM campaign_tasks WHERE id=$1", [task.id])).rows[0].status === "done", "(a) task done");

  // ════ (b) local-browser personal → scheduler SKIPS it (drained locally) ════
  await wipe();
  await admin.createCampaign({ id: "fb", mode: "connect_and_introduce", profileIds: ["acct-1"], dailyLimit: 50 });
  task = await admin.createTask({
    campaignId: "fb", type: "follow_up", dedupeKey: "fu:b",
    payload: { sender: "local-browser", primaryUrl: PRIMARY_URL, threadUrl: "t1", body: "hi", leadUrl: "https://linkedin.com/in/jane" },
  });
  m = mockDeps();
  rt = buildRuntime({ store: admin, deps: m.deps });
  await forceDue();
  assert((await rt.scheduler.tickOnce()) === 0, "(b) personal follow_up NOT claimed by the scheduler");
  assert(m.calls.followUps.length === 0, "(b) sendFollowUp NOT called (VM never sends a personal follow-up)");
  assert((await admin.pg.query("SELECT status FROM campaign_tasks WHERE id=$1", [task.id])).rows[0].status === "pending", "(b) personal task stays pending for the app to drain");

  // ════ (f) idempotency: reaper re-dispatch of the SAME follow_up must NEVER double-send ════
  await wipe();
  await admin.createCampaign({ id: "ff", mode: "connect_and_introduce", profileIds: ["acct-1"], dailyLimit: 50 });
  const leadUrlF = "https://linkedin.com/in/jane";
  task = await admin.createTask({
    campaignId: "ff", type: "follow_up", dedupeKey: "fu:f1",
    payload: { sender: "primary-gologin-acct", profileId: "acct-1", threadUrl: "t1", body: "Following up, Jane", leadUrl: leadUrlF, leadName: "Jane Doe" },
  });
  m = mockDeps();
  rt = buildRuntime({ store: admin, deps: m.deps });
  await forceDue();
  assert((await rt.scheduler.tickOnce()) === 1, "(f) first dispatch claimed");
  assert(m.calls.followUps.length === 1, "(f) sendFollowUp fired once on first dispatch");
  assert((await admin.pg.query("SELECT status FROM campaign_tasks WHERE id=$1", [task.id])).rows[0].status === "done", "(f) first task done");

  const task2 = await admin.createTask({
    campaignId: "ff", type: "follow_up", dedupeKey: "fu:f2",
    payload: { sender: "primary-gologin-acct", profileId: "acct-1", threadUrl: "t1", body: "Following up, Jane", leadUrl: leadUrlF, leadName: "Jane Doe" },
  });
  await forceDue();
  assert((await rt.scheduler.tickOnce()) === 1, "(f) re-dispatched task claimed");
  assert(m.calls.followUps.length === 1, "(f) sendFollowUp did NOT fire again — idempotency guard held");
  assert((await admin.pg.query("SELECT status FROM campaign_tasks WHERE id=$1", [task2.id])).rows[0].status === "done", "(f) re-dispatched task still ends done (short-circuited)");

  await wipe();
  await admin.close(); admin.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — follow_up routing (GoLogin sent, personal skipped, idempotent)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
