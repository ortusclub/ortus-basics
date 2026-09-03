// test-campaign-transition-monitoring.js
//
// transitionToMonitoring is shared by processCampaign's natural end-of-send AND
// the API's stop?keepMonitoring=1 path (the cloud analogue of the app's
// "Stop sending, keep monitoring"). Pure unit test — no pg/redis; a mock store
// records the writes. Verifies:
//   - connect_and_introduce → status 'monitoring', monitor task + reply task armed
//   - message_only (no monitor plan) → status 'done', reply task armed
//   - connect_only (no monitor, not a reply mode) → status 'done', NO tasks
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { transitionToMonitoring } = require("./campaign-runtime");

function mockStore() {
  const tasks = [];
  const monitorStates = [];
  let status = null;
  return {
    tasks, monitorStates, get status() { return status; },
    createTask: async (t) => { tasks.push(t); },
    setMonitorState: async (id, f) => { monitorStates.push({ id, ...f }); },
    setCampaignStatus: async (_id, s) => { status = s; },
  };
}
const NOW = () => new Date("2026-07-14T12:00:00.000Z");

test("connect_and_introduce → monitoring + monitor task + reply task", async () => {
  const store = mockStore();
  const r = await transitionToMonitoring(store, { id: "cA", mode: "connect_and_introduce", config: {} }, { now: NOW });
  assert.equal(r.status, "monitoring");
  assert.equal(store.status, "monitoring");
  assert.equal(store.monitorStates.length, 1);
  assert.equal(store.monitorStates[0].monitorState, "monitoring");
  const types = store.tasks.map((t) => t.type).sort();
  assert.deepEqual(types, ["monitor", "reply"], "both monitor and reply tasks armed");
  // 60m default cadence, 7d default window
  const monitorTask = store.tasks.find((t) => t.type === "monitor");
  assert.equal(monitorTask.dedupeKey, "monitor:cA");
  assert.equal(new Date(monitorTask.dueAt).toISOString(), "2026-07-14T13:00:00.000Z");
});

test("message_only (no monitor plan) → done, reply task still armed", async () => {
  const store = mockStore();
  const r = await transitionToMonitoring(store, { id: "cB", mode: "message_only", config: {} }, { now: NOW });
  assert.equal(r.status, "done");
  assert.equal(store.status, "done");
  assert.equal(store.monitorStates.length, 0, "no monitor state for a non-monitor mode");
  assert.deepEqual(store.tasks.map((t) => t.type), ["reply"], "reply tracking still armed");
});

test("connect_only → done, no tasks (not a reply mode, no monitor)", async () => {
  const store = mockStore();
  const r = await transitionToMonitoring(store, { id: "cC", mode: "connect_only", config: {} }, { now: NOW });
  assert.equal(r.status, "done");
  assert.equal(store.tasks.length, 0);
  assert.equal(store.monitorStates.length, 0);
});

test("honors config cadence + window overrides", async () => {
  const store = mockStore();
  await transitionToMonitoring(store, { id: "cD", mode: "connect_and_message", config: { checkIntervalMinutes: 30, monitoringDays: 3 } }, { now: NOW });
  const monitorTask = store.tasks.find((t) => t.type === "monitor");
  assert.equal(new Date(monitorTask.dueAt).toISOString(), "2026-07-14T12:30:00.000Z", "30m cadence");
  assert.equal(store.monitorStates[0].checkIntervalMinutes, 30);
  assert.equal(new Date(store.monitorStates[0].monitoringUntil).toISOString(), "2026-07-17T12:00:00.000Z", "3d window");
});
