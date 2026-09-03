// test-campaign-worker-livesync.mjs
//
// Live sheet write-back parity. The engine used to push rows to the operator's
// Sheet only at PASS boundaries (syncSheet after CampaignWorker.runCampaign
// returns). A send batch holds the worker for the whole batch (8 leads × 30–60s
// ≈ 6 min), so rows sent mid-batch didn't reach the Sheet until the batch ended
// or the campaign was stopped ("stamping arrives only after the campaign is
// stopped"). Local writes each row live (trackedSheetWrite per lead). This test
// locks the fix: the worker calls its injected syncSheet AFTER EACH lead is
// stamped — once per terminal outcome, during the batch.
//
// Pure — no pg/redis/browser. Run:  node test-campaign-worker-livesync.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CampaignWorker } = require("./campaign-worker");

function liveStore(nLeads) {
  const leads = Array.from({ length: nLeads }, (_, i) => ({ id: `L${i}`, member_urn: `u${i}`, lead_url: `x/${i}` }));
  let idx = 0;
  const marked = [];
  return {
    marked,
    getCampaign: async () => ({ status: "running" }),
    isParked: async () => false,
    dailyCount: async () => 0,
    acquireAccount: async () => true,
    releaseAccount: async () => {},
    heartbeatAccount: async () => {},
    claimNextLead: async () => (idx < leads.length ? leads[idx++] : null),
    pendingLeadCount: async () => leads.length - idx,
    wasActionSent: async () => false,
    tryConsumeDailySend: async () => ({ allowed: true }),
    markActionSent: async () => {},
    markLead: async (id, status) => { marked.push({ id, status }); },
    clearThrottle: async () => {},
    releaseLeadToPending: async () => {},
  };
}

const okAction = {
  kind: "connect",
  countsAsSend: true,
  async openSession(profileId) { return { profileId, page: {} }; },
  async connect() { return { success: true, stage: "CC" }; },
  async closeSession() {},
};

const campaign = { id: "cLIVE", mode: "connect_only", profile_ids: ["acctA"], daily_limit: 50 };

test("worker flushes the Sheet after EACH lead (live), not once at batch end", async () => {
  const store = liveStore(3);
  // Record the sheet-sync call order interleaved with the send marks, so we can
  // prove a sync happens BETWEEN sends, not only after all 3.
  const timeline = [];
  const origMark = store.markLead;
  store.markLead = async (id, status) => { timeline.push(`mark:${id}`); return origMark(id, status); };
  let syncs = 0;
  const w = new CampaignWorker({
    store, action: okAction, batchSize: 8,
    syncSheet: async () => { syncs++; timeline.push(`sync:${syncs}`); },
  });

  const n = await w.runTurn(campaign);

  assert.equal(n, 3, "all 3 leads sent this turn");
  assert.equal(syncs, 3, "syncSheet fired once per lead (live), not once for the whole batch");
  // The order must interleave: mark L0 → sync → mark L1 → sync → mark L2 → sync.
  assert.deepEqual(timeline, ["mark:L0", "sync:1", "mark:L1", "sync:2", "mark:L2", "sync:3"],
    "each send is flushed to the Sheet before the next send begins");
});

test("worker with no syncSheet (unit default) still runs — flush is a safe no-op", async () => {
  const store = liveStore(2);
  const w = new CampaignWorker({ store, action: okAction, batchSize: 8 });
  const n = await w.runTurn(campaign);
  assert.equal(n, 2, "sends complete with the default no-op syncSheet");
});

test("a Sheet-sync failure never blocks the send loop (best-effort)", async () => {
  const store = liveStore(2);
  const w = new CampaignWorker({
    store, action: okAction, batchSize: 8,
    syncSheet: async () => { throw new Error("GAS 500"); },
  });
  const n = await w.runTurn(campaign);
  assert.equal(n, 2, "both leads still send even though every Sheet flush throws");
});
