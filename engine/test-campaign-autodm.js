// test-campaign-autodm.js
//
// Phase E — CC+DM auto-DM firing (mirror of D, no primary), MOCK browser:
//   1. DM SENT on acceptance → dm_status='DM Sent', anti-dupe marker set.
//   2. anti-dupe re-run → not re-sent.
//   3. failure → friendly 'Failed — …' stamp.
//   4. misconfigured (no ccDmBody) → skipped, no stamp.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-autodm.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { runAutoDms } = require("./campaign-autodm");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

const URL_J = "https://linkedin.com/in/jane-doe";
const tpl = { ccDmBody: "Thanks for connecting, {first name}!", senderFirstNames: { acct1: "Sam" } };

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "dmE" });
  await s.migrate();
  const wipe = async () => { await s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE"); const k = await s.redis.keys("cmp:*"); if (k.length) await s.redis.del(...k); };
  const seed = async () => {
    await wipe();
    await s.createCampaign({ id: "cd", mode: "connect_and_message", profileIds: ["acct1"] });
    await s.addLeads("cd", [{ leadUrl: URL_J, memberUrn: "ACoAAaaa", fullName: "Jane Doe" }]);
    await s.pg.query(`UPDATE leads SET assigned_profile='acct1', first_name='Jane', last_name='Doe', linkedin_slug='jane-doe', connection_accepted_status='Connected', status='sent' WHERE campaign_id='cd'`);
    return s.getCampaign("cd");
  };

  // ── 1) DM sent on acceptance ──
  let campaign = await seed();
  let calls = []; const sendDm = async (a) => { calls.push(a); return { success: true }; };
  const r1 = await runAutoDms({ store: s, campaign, account: "acct1", page: null, connectedUrls: [URL_J], templates: tpl, sendDm });
  assert(r1.sent === 1 && r1.failed === 0, "DM sent on acceptance");
  assert(calls.length === 1 && calls[0].body === "Thanks for connecting, Jane!", "DM body personalized ({first name}→Jane)");
  assert(calls[0].publicId === "jane-doe", "sent with the lead's publicId");
  const l1 = (await s.getCampaignLeads("cd"))[0];
  assert(l1.dm_status === "DM Sent", "dm_status = DM Sent");
  assert((await s.wasActionSent("cd", URL_J, "message")) === true, "anti-dupe marker set");

  // ── 2) anti-dupe re-run ──
  calls = [];
  const r2 = await runAutoDms({ store: s, campaign, account: "acct1", page: null, connectedUrls: [URL_J], templates: tpl, sendDm });
  assert(r2.sent === 0 && r2.skipped === 1 && calls.length === 0, "anti-dupe: not re-sent");

  // ── 3) failure → friendly stamp ──
  campaign = await seed();
  const r3 = await runAutoDms({ store: s, campaign, account: "acct1", page: null, connectedUrls: [URL_J], templates: tpl,
    sendDm: async () => { throw new Error("MESSAGE_SEND_FAILED: compose textbox did not appear"); } });
  assert(r3.failed === 1, "send failure counted");
  assert((await s.getCampaignLeads("cd"))[0].dm_status === "Failed — Compose page didn't load", "failure → friendly DM stamp");

  // ── 4) misconfigured (no body) → skip ──
  campaign = await seed();
  const r4 = await runAutoDms({ store: s, campaign, account: "acct1", page: null, connectedUrls: [URL_J], templates: {}, sendDm });
  assert(r4.skipped === 1 && r4.sent === 0, "no ccDmBody → skipped");
  assert((await s.getCampaignLeads("cd"))[0].dm_status === "", "misconfigured leaves dm_status blank");

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — CC+DM auto-DM (Phase E)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
