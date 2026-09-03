// test-campaign-autointro.js
//
// Phase D — CC+IC auto-intro firing, end-to-end with MOCK browser primitives:
//   1. primary gate HOLD: account not connected to primary → no intro sent,
//      intro status left blank (retried), primary-conn=pending, accept task queued.
//   2. intro SENT: primary connected → intro fires, introduction_status stamped,
//      connection columns re-stamped, thread captured, follow-up task queued.
//   3. anti-dupe: re-run does NOT re-send (one-shot guard + markActionSent).
//   4. failure: send error → friendly 'Failed — …' stamp, not a crash.
//   5. misconfigured (no primary) → skipped, nothing stamped.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-autointro.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { runAutoIntros } = require("./campaign-autointro");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

const URL_J = "https://linkedin.com/in/jane-doe";
const baseTpl = {
  primaryName: "Pat Primary", primaryIntroBody: "Hi {first name}, meet {primary first name}",
  primaryUrl: "https://linkedin.com/in/pat-primary", introTitle: "Intro: {first name} <> {intro name}",
  autoAcceptPrimary: true, followUpEnabled: true, followUpBody: "Following up, {first name}",
  followUpDelayMinutes: 60, primarySource: "local-browser",
};

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "aiD" });
  await s.migrate();
  const wipe = async () => { await s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE"); const k = await s.redis.keys("cmp:*"); if (k.length) await s.redis.del(...k); };
  const seed = async () => {
    await wipe();
    await s.createCampaign({ id: "ci", mode: "connect_and_introduce", profileIds: ["acct1"] });
    await s.addLeads("ci", [{ leadUrl: URL_J, memberUrn: "ACoAAaaa", fullName: "Jane Doe" }]);
    await s.pg.query(`UPDATE leads SET assigned_profile='acct1', first_name='Jane', last_name='Doe', connection_request_status='Connection Request Sent', connection_accepted_status='Connected', status='sent' WHERE campaign_id='ci'`);
    return s.getCampaign("ci");
  };

  // ── 1) primary gate HOLD (not connected) ──
  let campaign = await seed();
  let sendCalls = 0;
  const sendIntro = async () => { sendCalls++; return { success: true, threadUrl: "https://linkedin.com/messaging/thread/x" }; };
  const r1 = await runAutoIntros({ store: s, campaign, account: "acct1", page: null, connectedUrls: [URL_J], templates: baseTpl,
    checkPrimary: async () => ({ connected: false, connectAttempted: true }), readSelf: async () => ({ name: "Acct One", profileUrl: "https://linkedin.com/in/acct1" }), sendIntro });
  assert(r1.held === 1 && r1.sent === 0, "gate HOLD: not connected → intro held, none sent");
  assert(sendCalls === 0, "no intro sent while held");
  const lh = (await s.getCampaignLeads("ci"))[0];
  assert(lh.introduction_status === "", "intro status left blank → re-detected next sweep");
  assert((await s.getPrimaryConn("ci", "acct1")).state === "pending", "primary-conn set to pending");
  const acceptTasks = (await s.pg.query("SELECT * FROM campaign_tasks WHERE type='accept'")).rows;
  assert(acceptTasks.length === 1 && acceptTasks[0].dedupe_key === "accept:acct1", "auto-accept task queued (deduped)");

  // ── 2) intro SENT (primary connected) ──
  campaign = await seed();
  sendCalls = 0;
  const r2 = await runAutoIntros({ store: s, campaign, account: "acct1", page: null, connectedUrls: [URL_J], templates: baseTpl,
    checkPrimary: async () => ({ connected: true }), sendIntro });
  assert(r2.sent === 1 && r2.failed === 0, "intro SENT when primary connected");
  assert(sendCalls === 1, "sendIntro called once");
  const ls = (await s.getCampaignLeads("ci"))[0];
  assert(ls.introduction_status === "Introduction Made", "introduction_status = Introduction Made");
  assert(ls.connection_accepted_status === "Connected" && ls.connected_already === true, "intro re-stamps connection columns (introConnectionStamp)");
  assert(ls.thread_url.includes("/messaging/thread/"), "thread_url captured for follow-up");
  assert((await s.wasActionSent("ci", URL_J, "intro")) === true, "anti-dupe marker set");
  const fu = (await s.pg.query("SELECT * FROM campaign_tasks WHERE type='follow_up'")).rows;
  assert(fu.length === 1 && fu[0].dedupe_key === `follow-up:acct1:${URL_J}`, "follow-up task queued (deduped, delayed)");

  // ── 3) anti-dupe re-run ──
  sendCalls = 0;
  const r3 = await runAutoIntros({ store: s, campaign, account: "acct1", page: null, connectedUrls: [URL_J], templates: baseTpl,
    checkPrimary: async () => ({ connected: true }), sendIntro });
  assert(r3.sent === 0 && r3.skipped === 1, "re-run skips already-introduced lead");
  assert(sendCalls === 0, "anti-dupe: sendIntro NOT called again");

  // ── 4) failure → friendly stamp ──
  campaign = await seed();
  const r4 = await runAutoIntros({ store: s, campaign, account: "acct1", page: null, connectedUrls: [URL_J], templates: baseTpl,
    checkPrimary: async () => ({ connected: true }), sendIntro: async () => ({ success: false, error: "INTRO_RECIPIENT_NOT_FOUND: recipient-not-in-results" }) });
  assert(r4.failed === 1, "send failure counted");
  const lf = (await s.getCampaignLeads("ci"))[0];
  assert(/^Failed —/.test(lf.introduction_status), `failure → friendly 'Failed —' stamp (got: ${lf.introduction_status})`);

  // ── 5) misconfigured (no primary) → skip, no stamp ──
  campaign = await seed();
  const r5 = await runAutoIntros({ store: s, campaign, account: "acct1", page: null, connectedUrls: [URL_J], templates: { primaryName: "", primaryIntroBody: "" }, sendIntro });
  assert(r5.skipped === 1 && r5.sent === 0, "missing primary config → skipped");
  assert((await s.getCampaignLeads("ci"))[0].introduction_status === "", "misconfigured leaves intro status blank (no bogus stamp)");

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — CC+IC auto-intro (Phase D)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
