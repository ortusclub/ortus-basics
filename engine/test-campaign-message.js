// test-campaign-message.js
//
// Phase 3b — message_only mode + the generic action factory.
//   1. makeAction routes by mode (connect_only→connect, message_only→message;
//      unsupported mode throws).
//   2. message_only worker across pods (mock action): every lead messaged once,
//      no double-send, account isolation, daily cap.
//   3. anti-dupe is PER ACTION KIND — a connect marker doesn't block a message
//      (so connect_and_message can later do both to one person, never twice each).
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-message.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { CampaignWorker } = require("./campaign-worker");
const { makeAction } = require("./campaign-action");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mkPod(id) { return new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: id }); }
async function closePod(p) { await p.close(); p.redis.disconnect(); }

function mockAction(kind) {
  const sent = []; const live = new Map(); let viol = 0;
  return {
    sent, get violations() { return viol; },
    action: {
      kind,
      async openSession(profileId) { const n = (live.get(profileId) || 0) + 1; live.set(profileId, n); if (n > 1) viol++; return { profileId }; },
      async connect(session, lead) { await sleep(6); sent.push(lead.member_urn || lead.lead_url); return { success: true, stage: kind === "message" ? "DM" : "CC" }; },
      async closeSession(session) { live.set(session.profileId, (live.get(session.profileId) || 1) - 1); },
    },
  };
}

(async () => {
  const admin = mkPod("admin");
  await admin.migrate();
  const wipe = async () => {
    await admin.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaigns RESTART IDENTITY CASCADE");
    for (const p of ["cmp:*", "sn:proflock:mA", "sn:proflock:mB"]) { const k = await admin.redis.keys(p); if (k.length) await admin.redis.del(...k); }
  };
  await wipe();

  // ── 1) factory routing ──
  assert(makeAction({ mode: "connect_only" }).kind === "connect", "makeAction(connect_only) → kind 'connect'");
  assert(makeAction({ mode: "message_only" }).kind === "message", "makeAction(message_only) → kind 'message'");
  let threw = false; try { makeAction({ mode: "bogus_mode" }); } catch { threw = true; }
  assert(threw, "unsupported mode throws (no silent wrong-action)");

  // ── 2) message_only worker across pods (mock) ──
  await admin.createCampaign({ id: "m1", mode: "message_only", profileIds: ["mA", "mB"], dailyLimit: 100, config: { message: "Hi {first name}" } });
  const N = 20;
  await admin.addLeads("m1", Array.from({ length: N }, (_, i) => ({ leadUrl: `https://m/${i}`, memberUrn: `murn_${i}` })));
  const camp = await admin.getCampaign("m1");
  const mk = mockAction("message");
  const workers = Array.from({ length: 3 }, (_, i) => { const s = mkPod(`m_${i}`); return { s, w: new CampaignWorker({ store: s, action: mk.action, batchSize: 4, today: "2026-06-23" }) }; });
  await Promise.all(workers.map(({ w }) => w.runCampaign(camp)));
  for (const { s } of workers) await closePod(s);
  assert(mk.sent.length === N, `every lead messaged exactly once (sent=${mk.sent.length}/${N})`);
  assert(new Set(mk.sent).size === N, "no lead double-messaged");
  assert(mk.violations === 0, "one account never messaged by two workers at once");
  assert((await admin.leadStatusCounts("m1")).sent === N, "all leads marked sent in Postgres");

  // ── 3) per-kind anti-dupe isolation ──
  await admin.markActionSent("m1", "iso_lead", "connect");
  assert((await admin.wasActionSent("m1", "iso_lead", "connect")) === true, "connect marker set");
  assert((await admin.wasActionSent("m1", "iso_lead", "message")) === false, "a CONNECT marker does NOT block a MESSAGE (per-kind anti-dupe)");

  await wipe();
  await closePod(admin);
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — message_only mode + generic action factory"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
