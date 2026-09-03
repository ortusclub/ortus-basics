// test-campaign-live-wiring.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildRuntime } = require("./campaign-runtime.js");

function fakeRegistry() {
  const events = [];
  return { events,
    register: async (id, acct) => events.push(["reg", id, acct]),
    unregister: async (id, acct) => events.push(["unreg", id, acct]),
    get: () => null };
}

function harness(reg, { throwInSweep = false } = {}) {
  const campaign = { id: "cmp1", mode: "connect_and_introduce", profile_ids: ["acctA"],
    status: "monitoring", monitoring_until: new Date(Date.now() + 3600e3).toISOString(),
    auto_checks_enabled: true, check_interval_minutes: 60, config: {} };
  const store = {
    getCampaign: async () => campaign,
    acquireAccount: async () => true, releaseAccount: async () => {},
    getAllConnections: async () => [], getCampaignLeads: async () => [],
    upsertConnections: async () => {}, leadStatusCounts: async () => ({}),
    setMonitorState: async () => {}, getLeadsNeedingSheetSync: async () => [],
    markLeadsSheetSynced: async () => {},
  };
  const page = { _fake: "page" };
  const deps = {
    liveRegistry: reg,
    openSession: async () => ({ page, close: async () => {} }),
    fetchRecent: async () => { if (throwInSweep) throw new Error("boom"); return []; },
    syncSheet: async () => {}, prepareSheet: async () => ({ ok: true }),
    now: () => new Date(), log: () => {},
  };
  return { store, deps };
}

test("handleMonitor registers on open and unregisters on reap", async () => {
  const reg = fakeRegistry();
  const { store, deps } = harness(reg);
  const rt = buildRuntime({ store, deps });
  await rt.handleMonitor({ campaign_id: "cmp1" });
  assert.deepEqual(reg.events[0], ["reg", "cmp1", "acctA"]);
  assert.deepEqual(reg.events[reg.events.length - 1], ["unreg", "cmp1", "acctA"]);
});

test("unregister still fires when the sweep throws", async () => {
  const reg = fakeRegistry();
  const { store, deps } = harness(reg, { throwInSweep: true });
  const rt = buildRuntime({ store, deps });
  await rt.handleMonitor({ campaign_id: "cmp1" });
  assert.ok(reg.events.some((e) => e[0] === "reg"));
  assert.ok(reg.events.some((e) => e[0] === "unreg"), "reap-path unregister");
});
