// test-campaign-worker-liveview.js
//
// The SEND browser is held open across a whole batch (openSession..closeSession
// in runTurn) — the longest, most watchable window a campaign has. Before this
// fix the worker never told the live registry about it, so /api/campaign/:id/view
// returned "no active session" even while a campaign was actively sending
// connections (empirically: sent-count climbed but live stayed false).
//
// Pure unit test — no pg/redis. Mocks the store methods runTurn touches and a
// fake registry, and asserts: register fires right after openSession, unregister
// fires in the finally, AND unregister still fires when the send action throws
// (reap discipline — we never leave a session registered after its browser is
// gone, and never keep a browser alive just to watch it).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CampaignWorker } = require("./campaign-worker");

function fakeRegistry() {
  const events = [];
  return { events,
    register: async (id, acct, page) => events.push(["reg", id, acct, page && page._fake]),
    unregister: async (id, acct) => events.push(["unreg", id, acct]) };
}

function mockStore({ leads = 1 } = {}) {
  let remaining = leads;
  return {
    getCampaign: async () => ({ status: "running" }),
    isParked: async () => false,
    dailyCount: async () => 0,
    acquireAccount: async () => true,
    releaseAccount: async () => {},
    heartbeatAccount: async () => {},
    claimNextLead: async () => (remaining-- > 0 ? { id: "L1", member_urn: "urn_1", lead_url: "https://x/1" } : null),
    wasActionSent: async () => false,
    tryConsumeDailySend: async () => ({ allowed: true }),
    markActionSent: async () => {},
    markLead: async () => {},
    clearThrottle: async () => {},
  };
}

function mockAction({ throwOnConnect = false } = {}) {
  return {
    kind: "connect",
    async openSession(profileId) { return { profileId, page: { _fake: "PAGE" } }; },
    async connect() { if (throwOnConnect) throw new Error("boom"); return { success: true, stage: "CC" }; },
    async closeSession() {},
  };
}

const campaign = { id: "cmpX", mode: "connect_only", profile_ids: ["acctA"], daily_limit: 50 };

test("runTurn registers the send session after openSession and unregisters in finally", async () => {
  const reg = fakeRegistry();
  const w = new CampaignWorker({ store: mockStore({ leads: 1 }), action: mockAction(), liveRegistry: reg, batchSize: 1 });
  const n = await w.runTurn(campaign);
  assert.equal(n, 1, "one lead actioned");
  assert.deepEqual(reg.events[0], ["reg", "cmpX", "acctA", "PAGE"], "registers with the real page");
  assert.deepEqual(reg.events[reg.events.length - 1], ["unreg", "cmpX", "acctA"], "unregisters last");
});

test("unregister still fires when the send action throws (reap discipline)", async () => {
  const reg = fakeRegistry();
  const w = new CampaignWorker({ store: mockStore({ leads: 1 }), action: mockAction({ throwOnConnect: true }), liveRegistry: reg, batchSize: 1 });
  await w.runTurn(campaign);
  assert.ok(reg.events.some((e) => e[0] === "reg"), "registered");
  assert.ok(reg.events.some((e) => e[0] === "unreg"), "unregistered on reap even after throw");
});

test("no liveRegistry supplied → no crash (no-op default)", async () => {
  const w = new CampaignWorker({ store: mockStore({ leads: 1 }), action: mockAction(), batchSize: 1 });
  const n = await w.runTurn(campaign);
  assert.equal(n, 1);
});
