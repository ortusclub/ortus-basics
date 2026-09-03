// run-connect-validation.js
//
// DELIBERATE single-lead validation of the REAL connect path. This SENDS A REAL
// CONNECTION REQUEST — run it on purpose with a test account + a throwaway lead.
//
//   GOLOGIN_API_TOKEN=<token> \
//   PG_URL=postgres://postgres:dev@localhost:5433/campaigns \
//   REDIS_URL=redis://localhost:6379 \
//   node run-connect-validation.js <gologinProfileId> <leadUrl> ["optional note"]
//
// Proves end-to-end: launch GoLogin (Puppeteer) → performOutreach connect →
// stamp Postgres → and a SECOND run sends nothing (anti-dupe / no double-send).

const Redis = require("ioredis");
const { CampaignStore } = require("./campaign-store");
const { CampaignWorker } = require("./campaign-worker");
const { makeConnectAction } = require("./campaign-connect-action");

(async () => {
  const [profileId, leadUrl, note] = process.argv.slice(2);
  if (!profileId || !leadUrl) {
    console.error("usage: node run-connect-validation.js <gologinProfileId> <leadUrl> [\"note\"]");
    process.exit(1);
  }
  if (!process.env.GOLOGIN_API_TOKEN) { console.error("set GOLOGIN_API_TOKEN"); process.exit(1); }

  const store = new CampaignStore({
    pgUrl: process.env.PG_URL || "postgres://postgres:dev@localhost:5433/campaigns",
    redis: new Redis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null }),
    podId: "validate",
  });
  await store.migrate();

  const cid = "validate-" + Date.now();
  await store.createCampaign({ id: cid, mode: "connect_only", profileIds: [profileId], dailyLimit: 5, config: { connectionNote: note || "" } });
  await store.addLeads(cid, [{ leadUrl, memberUrn: leadUrl, fullName: "" }]);
  const camp = await store.getCampaign(cid);
  const worker = new CampaignWorker({ store, action: makeConnectAction(camp), batchSize: 1 });

  console.log(`\n▶ Run 1 — connecting to ${leadUrl}\n   via GoLogin profile ${profileId} …`);
  await worker.runCampaign(camp, { maxIdleRounds: 3, idleWaitMs: 200 });
  console.log("   → lead status:", JSON.stringify(await store.leadStatusCounts(cid)));

  console.log("\n▶ Run 2 — re-running (MUST send nothing — anti-dupe):");
  await worker.runCampaign(camp, { maxIdleRounds: 3, idleWaitMs: 200 });
  console.log("   → lead status:", JSON.stringify(await store.leadStatusCounts(cid)));

  console.log("\n✅ Done. Check the test lead on LinkedIn: it should show ONE pending invitation (not two).");
  await store.close();
  store.redis.disconnect();
  process.exit(0);
})().catch((e) => { console.error("\n❌ validation error:", e && e.message); process.exit(1); });
