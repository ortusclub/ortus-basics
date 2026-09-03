// test-campaign-introduceback.js
//
// Phase F — introduce_back mode (single-pass intro to already-connected leads):
//   1. factory routing: makeAction(introduce_back) → kind 'intro'.
//   2. templates: introMode + introName/introUrl/introTitle + body wired for
//      performOutreach (the reused, unchanged outreach lib).
//   3. worker flow across pods (mock action): every lead introduced exactly once,
//      no double-send, account isolation, stage 'IC'.
//   4. per-kind anti-dupe: an 'intro' marker is independent of connect/message.
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-introduceback.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { CampaignWorker } = require("./campaign-worker");
const { makeAction, MODES } = require("./campaign-action");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mkPod(id) { return new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: id }); }
async function closePod(p) { await p.close(); p.redis.disconnect(); }

function mockIntro() {
  const sent = []; const live = new Map(); let viol = 0;
  return { sent, get violations() { return viol; }, action: {
    kind: "intro",
    async openSession(pid) { const n = (live.get(pid) || 0) + 1; live.set(pid, n); if (n > 1) viol++; return { profileId: pid }; },
    async connect(_s, lead) { await sleep(5); sent.push(lead.member_urn || lead.lead_url); return { success: true, stage: "IC" }; },
    async closeSession(s) { live.set(s.profileId, (live.get(s.profileId) || 1) - 1); },
  } };
}

(async () => {
  const admin = mkPod("admin");
  await admin.migrate();
  const wipe = async () => { await admin.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE"); for (const p of ["cmp:*", "sn:proflock:iA", "sn:proflock:iB"]) { const k = await admin.redis.keys(p); if (k.length) await admin.redis.del(...k); } };
  await wipe();

  // ── 1) factory routing ──
  assert(makeAction({ mode: "introduce_back" }).kind === "intro", "makeAction(introduce_back) → kind 'intro'");

  // ── 2) templates wired for the reused performOutreach (introMode) ──
  const tpl = MODES.introduce_back.buildTemplates(
    { primaryName: "Pat Primary", primaryIntroBody: "Hi {first name}, meet {primary first name}", primaryUrl: "https://linkedin.com/in/pat", introTitle: "Intro" },
    { full_name: "Jane Doe" }
  );
  assert(tpl.introMode === true, "introMode:true (composes a 3-way intro, not a 1:1 DM)");
  assert(tpl.introName === "Pat Primary" && tpl.introUrl.includes("/in/pat"), "introName + introUrl wired");
  assert(tpl.followUpMessage.includes("{first name}"), "intro body carried into followUpMessage for performOutreach");
  assert(MODES.introduce_back.stage("message_sent") === "IC", "message_sent → stage IC");

  // ── 3) worker flow across pods (mock intro action) ──
  await admin.createCampaign({ id: "ib", mode: "introduce_back", profileIds: ["iA", "iB"], dailyLimit: 100 });
  const N = 16;
  await admin.addLeads("ib", Array.from({ length: N }, (_, i) => ({ leadUrl: `https://l/${i}`, memberUrn: `iurn_${i}`, fullName: `Lead ${i}` })));
  const camp = await admin.getCampaign("ib");
  const mk = mockIntro();
  const workers = Array.from({ length: 3 }, (_, i) => { const s = mkPod(`i_${i}`); return { s, w: new CampaignWorker({ store: s, action: mk.action, batchSize: 4, today: "2026-06-30" }) }; });
  await Promise.all(workers.map(({ w }) => w.runCampaign(camp)));
  for (const { s } of workers) await closePod(s);
  assert(mk.sent.length === N, `every lead introduced exactly once (sent=${mk.sent.length}/${N})`);
  assert(new Set(mk.sent).size === N, "no lead double-introduced");
  assert(mk.violations === 0, "one account never introduced by two workers at once");
  assert((await admin.leadStatusCounts("ib")).sent === N, "all leads marked sent in Postgres");

  // ── 4) per-kind anti-dupe ──
  await admin.markActionSent("ib", "x_lead", "intro");
  assert((await admin.wasActionSent("ib", "x_lead", "intro")) === true, "intro marker set");
  assert((await admin.wasActionSent("ib", "x_lead", "message")) === false, "an INTRO marker does NOT block a message (per-kind)");

  await wipe();
  await closePod(admin);
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — introduce_back (Phase F)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
