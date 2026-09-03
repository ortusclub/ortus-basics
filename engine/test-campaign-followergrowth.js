// test-campaign-followergrowth.js
//
// Phase G — Follower Growth batch mode, MOCK modal driver:
//   1. vendored parser sanity (parseCreditsAvailable / pickInviteResult).
//   2. monthly budget: pre-spent invites reduce what gets claimed.
//   3. happy path: invited→'Invited' stamp + anti-dupe; unmatched→skipped.
//   4. sent=false (credits 0 / button never clicked) → ALL released to pending.
//   5. anti-dupe pre-check: already-invited lead never reaches the modal.
//   6. budget exhausted → claims nothing.
//   7. PARITY: routed-claim isolation — route_account pins a lead to one account.
//   8. PARITY: full_name → queued.name mapping; memberId === String(lead.id).
//
// Run:  PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//       REDIS_URL=redis://localhost:6379 node test-campaign-followergrowth.js

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { runFollowerGrowth } = require("./campaign-followergrowth");

const PG = process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns";
const REDIS = process.env.REDIS_URL || "redis://localhost:6379";
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }
const MONTH = "2026-07";

(async () => {
  const s = new CampaignStore({ pgUrl: PG, redis: new Redis(REDIS, { maxRetriesPerRequest: null }), podId: "fgG" });
  await s.migrate();
  const wipe = async () => { await s.pg.query("TRUNCATE leads, campaign_tasks, daily_counts, campaign_connections, campaign_primary_conn, campaigns RESTART IDENTITY CASCADE"); const k = await s.redis.keys("cmp:*"); if (k.length) await s.redis.del(...k); };
  const seed = async (n = 4) => {
    await wipe();
    await s.createCampaign({ id: "fg", mode: "follower_growth", profileIds: ["acctF"] });
    await s.addLeads("fg", Array.from({ length: n }, (_, i) => ({ leadUrl: `https://l/fg${i}`, memberUrn: `fgurn_${i}`, fullName: `Person ${i}` })));
    await s.pg.query(`UPDATE leads SET title='VP Marketing', company='Acme' WHERE campaign_id='fg'`);
    return s.getCampaign("fg");
  };

  // ── 1) vendored primitive sanity ──
  const fi = await import("./campaign-lib/linkedin/follower-invite.js");
  assert(fi.parseCreditsAvailable("5/30 credits available · Credit refill: July 30, 2026") === 5, "vendored parseCreditsAvailable works");
  assert(fi.pickInviteResult(
    [{ name: "Katie Whitty Jackson", headline: "VP Marketing at Acme", canInvite: true }],
    { name: "Katie Jackson", jobTitle: "VP Marketing", company: "Acme" }
  )?.name === "Katie Whitty Jackson", "vendored pickInviteResult matches first+last across middle name");

  // ── 2) monthly budget reduces claims ──
  let campaign = await seed(4);
  // pre-spend 3 of a 5-budget this month (another campaign, same account)
  await s.createCampaign({ id: "old", mode: "follower_growth", profileIds: ["acctF"] });
  await s.addLeads("old", Array.from({ length: 3 }, (_, i) => ({ leadUrl: `https://l/old${i}`, memberUrn: `oldurn_${i}`, fullName: `Old ${i}` })));
  await s.pg.query(`UPDATE leads SET status='sent', stage='Invited', assigned_profile='acctF', sent_at=to_date('${MONTH}','YYYY-MM') + interval '3 days' WHERE campaign_id='old'`);
  assert((await s.invitedCountForMonth("acctF", MONTH)) === 3, "invitedCountForMonth counts cross-campaign spend");
  let sendArgs = null, sawOnProgress = false;
  const okSend = async ({ queued, onProgress }) => { sendArgs = queued; sawOnProgress = typeof onProgress === "function"; return { sent: true, invited: queued.map((q) => q.memberId), skipped: [], creditsBefore: 30, creditsAfter: 30 - queued.length }; };
  const r2 = await runFollowerGrowth({ store: s, campaign, account: "acctF", page: null, inviteUrl: "u", config: { monthlyBudget: 5 }, month: MONTH, sendInvites: okSend, onProgress: () => {} });
  assert(r2.claimed === 2 && r2.invited === 2, `budget 5 − 3 used → only 2 claimed+invited (got ${r2.claimed}/${r2.invited})`);
  assert(sawOnProgress, "runFollowerGrowth forwards onProgress through to sendInvites");
  assert(r2.budgetRemaining === 2, "budgetRemaining reported");
  assert(sendArgs.length === 2 && sendArgs[0].company === "Acme" && sendArgs[0].jobTitle === "VP Marketing", "queued rows carry name/title/company for modal disambiguation");

  // ── 3) happy path: stamp split invited/skipped ──
  campaign = await seed(3);
  const splitSend = async ({ queued }) => ({ sent: true, invited: [queued[0].memberId], skipped: queued.slice(1).map((q) => q.memberId), creditsBefore: 10, creditsAfter: 9, allowance: 30, refill: "July 30, 2026" });
  const r3 = await runFollowerGrowth({ store: s, campaign, account: "acctF", page: null, inviteUrl: "u", config: { monthlyBudget: 30 }, month: MONTH, sendInvites: splitSend });
  assert(r3.invited === 1 && r3.skipped === 2, "1 invited, 2 skipped stamped");
  const leads3 = await s.getCampaignLeads("fg");
  const inv = leads3.find((l) => l.stage === "Invited");
  assert(inv && inv.status === "sent" && inv.sent_at, "invited lead → status sent, stage 'Invited', sent_at stamped");
  assert((await s.wasActionSent("fg", inv.lead_url, "invite")) === true, "anti-dupe marker kind 'invite' set");
  assert(leads3.filter((l) => l.status === "skipped").every((l) => /modal/.test(l.error)), "skipped leads carry the modal-match reason");
  assert(r3.refill === "July 30, 2026" && r3.allowance === 30, "credit meta (allowance/refill) surfaced for write-back");

  // ── 4) sent=false → everything released for retry ──
  campaign = await seed(2);
  const deadSend = async () => ({ sent: false, invited: [], skipped: [], creditsBefore: 0, creditsAfter: 0 });
  const r4 = await runFollowerGrowth({ store: s, campaign, account: "acctF", page: null, inviteUrl: "u", config: { monthlyBudget: 30 }, month: MONTH, sendInvites: deadSend });
  assert(r4.released === 2 && r4.invited === 0, "no credits / never clicked → all claimed released");
  assert(/no invite credits/.test(r4.reason), "reason names the 0-credit cause");
  assert((await s.pendingLeadCount("fg")) === 2, "released leads are pending again (retryable)");

  // ── 5) anti-dupe pre-check skips before the modal ──
  campaign = await seed(2);
  await s.markActionSent("fg", "https://l/fg0", "invite");
  sendArgs = null;
  const r5 = await runFollowerGrowth({ store: s, campaign, account: "acctF", page: null, inviteUrl: "u", config: { monthlyBudget: 30 }, month: MONTH, sendInvites: okSend });
  assert(sendArgs.length === 1 && sendArgs[0].name === "Person 1", "already-invited lead never reaches the modal");
  assert(r5.skipped === 1 && r5.invited === 1, "pre-skip counted, the other invited");

  // ── 6) budget exhausted → nothing claimed ──
  campaign = await seed(2);
  await s.pg.query(`UPDATE leads SET status='sent', stage='Invited', assigned_profile='acctF', sent_at=to_date('${MONTH}','YYYY-MM') + interval '1 day' WHERE campaign_id='fg' AND id IN (SELECT id FROM leads WHERE campaign_id='fg' LIMIT 1)`);
  const r6 = await runFollowerGrowth({ store: s, campaign, account: "acctF", page: null, inviteUrl: "u", config: { monthlyBudget: 1 }, month: MONTH, sendInvites: okSend });
  assert(r6.claimed === 0 && /monthly budget used up/.test(r6.reason), "budget exhausted → claims nothing, reason surfaced");

  // ── 6b) logged out → modal throws → all claimed leads released, loggedOut flagged ──
  campaign = await seed(3);
  const loggedOutSend = async () => { const e = new Error("account is logged out of LinkedIn — re-login needed"); e.loggedOut = true; e.softSkip = true; throw e; };
  const r6b = await runFollowerGrowth({ store: s, campaign, account: "acctF", page: null, inviteUrl: "u", config: { monthlyBudget: 30 }, month: MONTH, sendInvites: loggedOutSend });
  assert(r6b.loggedOut === true && r6b.released === 3 && r6b.invited === 0, "logged-out throw → all 3 claimed released, loggedOut true, nothing sent");
  assert(/logged out/.test(r6b.reason), "reason names the logged-out cause");
  assert((await s.pendingLeadCount("fg")) === 3, "logged-out release → leads pending again (retryable, not stranded)");

  // ── 6c) already-follows → remembered (anti-dupe) + skipped, counted separately ──
  campaign = await seed(2);
  const alreadySend = async ({ queued }) => ({ sent: true, invited: [queued[0].memberId], skipped: [queued[1].memberId], alreadyFollowing: [queued[1].memberId], creditsBefore: 10, creditsAfter: 9 });
  const r6c = await runFollowerGrowth({ store: s, campaign, account: "acctF", page: null, inviteUrl: "u", config: { monthlyBudget: 30 }, month: MONTH, sendInvites: alreadySend });
  assert(r6c.invited === 1 && r6c.skipped === 1 && r6c.alreadyFollowing === 1, "1 invited, 1 already-follows (counted separately)");
  const leads6c = await s.getCampaignLeads("fg");
  const af = leads6c.find((l) => /already follows/.test(l.error || ""));
  assert(af && af.status === "skipped", "already-follows lead → skipped with 'already follows' reason");
  assert((await s.wasActionSent("fg", af.lead_url, "invite")) === true, "already-follows lead gets the anti-dupe marker (never re-tried)");

  // ── 7) PARITY: routed-claim isolation — a routed lead is claimable ONLY by its pinned account ──
  await wipe();
  await s.createCampaign({ id: "fgRoute", mode: "follower_growth", profileIds: ["accA", "accB"] });
  await s.addLeads("fgRoute", [
    { leadUrl: "https://l/routedA", memberUrn: "routedA_urn", fullName: "Routed A", routeAccount: "accA" },
    { leadUrl: "https://l/routedB", memberUrn: "routedB_urn", fullName: "Routed B", routeAccount: "accB" },
  ]);
  await s.pg.query(`UPDATE leads SET title='VP Marketing', company='Acme' WHERE campaign_id='fgRoute'`);
  const campaignRoute = await s.getCampaign("fgRoute");
  let routeSendArgs = null;
  const routeSend = async ({ queued }) => {
    routeSendArgs = queued;
    return { sent: true, invited: queued.map((q) => q.memberId), skipped: [], creditsBefore: 30, creditsAfter: 30 - queued.length };
  };
  const r7 = await runFollowerGrowth({ store: s, campaign: campaignRoute, account: "accA", page: null, inviteUrl: "u", config: { monthlyBudget: 30 }, month: MONTH, sendInvites: routeSend });
  assert(r7.claimed === 1 && r7.invited === 1, `accA claims exactly its own routed lead, nothing more (got claimed=${r7.claimed}, invited=${r7.invited})`);
  assert(routeSendArgs.length === 1 && routeSendArgs[0].name === "Routed A", "accA's queued batch contains only its own routed lead, never accB's");
  const leadsRoute = await s.getCampaignLeads("fgRoute");
  const leadA = leadsRoute.find((l) => l.lead_url === "https://l/routedA");
  const leadB = leadsRoute.find((l) => l.lead_url === "https://l/routedB");
  assert(leadA && leadA.status === "sent" && leadA.stage === "Invited", "accA's own routed lead was invited");
  assert(leadB && leadB.status === "pending" && leadB.assigned_profile == null, "accB's routed lead was NEVER claimed by accA — stays pending, unclaimed");

  // ── 8) PARITY: full_name flows into queued.name; memberId === String(lead.id) ──
  await wipe();
  await s.createCampaign({ id: "fgName", mode: "follower_growth", profileIds: ["acctF"] });
  await s.addLeads("fgName", [{ leadUrl: "https://l/janedoe", memberUrn: "jane_urn", fullName: "Jane Doe" }]);
  const campaignName = await s.getCampaign("fgName");
  const janeLead = (await s.getCampaignLeads("fgName"))[0];
  let nameSendArgs = null;
  const nameSend = async ({ queued }) => {
    nameSendArgs = queued;
    return { sent: true, invited: queued.map((q) => q.memberId), skipped: [], creditsBefore: 30, creditsAfter: 29 };
  };
  await runFollowerGrowth({ store: s, campaign: campaignName, account: "acctF", page: null, inviteUrl: "u", config: { monthlyBudget: 30 }, month: MONTH, sendInvites: nameSend });
  assert(nameSendArgs.length === 1 && nameSendArgs[0].name === "Jane Doe", "lead.full_name='Jane Doe' flows into queued[0].name");
  assert(nameSendArgs[0].memberId === String(janeLead.id), "queued[0].memberId === String(lead.id)");

  await wipe();
  await s.close(); s.redis.disconnect();
  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — Follower Growth (Phase G)"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
