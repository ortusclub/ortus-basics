// test-campaign-worker-pause.js
//
// A mid-run PAUSE (status → 'paused') must stop the worker claiming new leads
// after the lead currently in flight — 1:1 with local pause. The worker re-reads
// the campaign status before each lead and breaks when it leaves the active set.
// Pure — no pg/redis.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CampaignWorker } = require("./campaign-worker");

function mockStore({ pauseAfter = 1, leads = 10 } = {}) {
  let statusReads = 0;
  let remaining = leads;
  return {
    _sent: [],
    // Return 'running' for the first `pauseAfter` checks, then 'paused'.
    getCampaign: async () => ({ status: (++statusReads > pauseAfter ? "paused" : "running") }),
    isParked: async () => false,
    dailyCount: async () => 0,
    acquireAccount: async () => true,
    releaseAccount: async () => {},
    heartbeatAccount: async () => {},
    claimNextLead: async () => (remaining-- > 0 ? { id: `L${leads - remaining}`, member_urn: `urn_${leads - remaining}`, lead_url: `https://x/${leads - remaining}` } : null),
    wasActionSent: async () => false,
    tryConsumeDailySend: async () => ({ allowed: true }),
    markActionSent: async () => {},
    markLead: async function (id, status) { if (status === "sent") this._sent.push(id); },
    clearThrottle: async () => {},
  };
}
const action = {
  kind: "connect",
  async openSession(profileId) { return { profileId, page: {} }; },
  async connect() { return { success: true, stage: "CC" }; },
  async closeSession() {},
};
const campaign = { id: "cP", mode: "connect_only", profile_ids: ["acctA"], daily_limit: 50 };

test("pause after the 1st status check → only 1 lead sent, rest left pending", async () => {
  const store = mockStore({ pauseAfter: 1, leads: 10 });
  const w = new CampaignWorker({ store, action, batchSize: 10 });
  const n = await w.runTurn(campaign);
  assert.equal(n, 1, "stopped claiming after the lead in flight");
  assert.equal(store._sent.length, 1);
});

test("no pause → the whole batch sends", async () => {
  const store = mockStore({ pauseAfter: 99, leads: 5 });
  const w = new CampaignWorker({ store, action, batchSize: 8 });
  const n = await w.runTurn(campaign);
  assert.equal(n, 5, "all available leads sent when never paused");
});
