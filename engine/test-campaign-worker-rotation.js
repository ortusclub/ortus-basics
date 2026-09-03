// test-campaign-worker-rotation.js
//
// Multi-account batching parity with the local app. Local (src/campaign.js) runs a
// ROTATING worker pool: each turn an account does up to BATCH_SIZE leads, then it
// re-enqueues at the back of the queue AND gets a 6-min TURN_COOLDOWN_FLOOR — so two
// accounts interleave A×8 → B×8 → A×8 instead of one draining fully. The cloud worker
// used to scan profile_ids from index 0 every turn and re-grab the first free account
// until it drained ("does it all one after another in a row"). These tests lock in the
// fix: a round-robin cursor (nextRotationIndex) + a per-account turn cooldown, both
// off by default and exercised here via a mock store that implements them.
//
// Pure — no pg/redis. A fake clock drives the cooldown so no real time passes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CampaignWorker } = require("./campaign-worker");

// Mock store recording which account claimed each lead, with a fake-clock turn
// cooldown and a deterministic 0-based rotation cursor.
function rotStore({ leads = 40 } = {}) {
  let remaining = leads;
  let cursor = 0;                 // 0-based, deterministic (real store uses INCR)
  let clock = 0;                  // fake ms clock; advance with _advance()
  const cooldownUntil = new Map();// profileId -> until (fake ms)
  const locked = new Set();
  const daily = new Map();
  const order = [];               // profileId per claimed lead, in claim order
  return {
    _order: order,
    _advance: (ms) => { clock += ms; },
    getCampaign: async () => ({ status: "running" }),
    isParked: async () => false,
    dailyCount: async (p) => daily.get(p) || 0,
    acquireAccount: async (p) => { if (locked.has(p)) return false; locked.add(p); return true; },
    releaseAccount: async (p) => { locked.delete(p); },
    heartbeatAccount: async () => {},
    claimNextLead: async (_cid, p) => {
      if (remaining <= 0) return null;
      remaining--; order.push(p);
      return { id: `L${leads - remaining}`, member_urn: `u${leads - remaining}`, lead_url: `x/${leads - remaining}` };
    },
    pendingLeadCount: async () => remaining,
    wasActionSent: async () => false,
    tryConsumeDailySend: async (p) => { daily.set(p, (daily.get(p) || 0) + 1); return { allowed: true }; },
    markActionSent: async () => {},
    markLead: async () => {},
    clearThrottle: async () => {},
    // rotation + cooldown primitives (fake-clock)
    nextRotationIndex: async () => cursor++,
    setTurnCooldown: async (p, sec) => { if (sec > 0) cooldownUntil.set(p, clock + sec * 1000); },
    inTurnCooldown: async (p) => (cooldownUntil.get(p) || 0) > clock,
  };
}

const sendAction = {
  kind: "connect",
  async openSession(profileId) { return { profileId, page: {} }; },
  async connect() { return { success: true, stage: "CC" }; },
  async closeSession() {},
};
// read-only action (check_status) — opts out of the daily cap AND the turn cooldown.
const readOnlyAction = { ...sendAction, countsAsSend: false };

const campaign = { id: "cROT", mode: "connect_only", profile_ids: ["acctA", "acctB"], daily_limit: 50 };

test("send mode: turns interleave — turn 1 is all one account, turn 2 the other", async () => {
  const store = rotStore({ leads: 40 });
  const w = new CampaignWorker({ store, action: sendAction, batchSize: 8, turnCooldownSec: 360 });

  const n1 = await w.runTurn(campaign);
  assert.equal(n1, 8, "turn 1 sends a full batch");
  const turn1 = store._order.slice(0, 8);
  assert.ok(turn1.every((p) => p === turn1[0]), "turn 1 uses a single account");

  const n2 = await w.runTurn(campaign);
  assert.equal(n2, 8, "turn 2 sends a full batch");
  const turn2 = store._order.slice(8, 16);
  assert.ok(turn2.every((p) => p === turn2[0]), "turn 2 uses a single account");

  assert.notEqual(turn2[0], turn1[0], "turn 2 rotates to the OTHER account (not draining the first)");
});

test("send mode: both accounts cooling → runTurn does nothing (no machine-gunning)", async () => {
  const store = rotStore({ leads: 40 });
  const w = new CampaignWorker({ store, action: sendAction, batchSize: 8, turnCooldownSec: 360 });
  await w.runTurn(campaign); // A cools
  await w.runTurn(campaign); // B cools
  const n3 = await w.runTurn(campaign);
  assert.equal(n3, 0, "no account is eligible while both are within their 6-min floor");
});

test("send mode: after the cooldown lapses the first account is picked again", async () => {
  const store = rotStore({ leads: 40 });
  const w = new CampaignWorker({ store, action: sendAction, batchSize: 8, turnCooldownSec: 360 });
  await w.runTurn(campaign); // turn 1
  await w.runTurn(campaign); // turn 2 (other account)
  store._advance(361 * 1000); // both cooldowns lapse
  const n3 = await w.runTurn(campaign);
  assert.equal(n3, 8, "turn 3 resumes once the floor has elapsed");
  const turn1First = store._order[0];
  assert.equal(store._order.slice(16, 24)[0], turn1First, "rotation returns to the first account");
});

test("read-only mode rotates via the cursor with NO cooldown (1:1 with local queue rotation)", async () => {
  const store = rotStore({ leads: 40 });
  const w = new CampaignWorker({ store, action: readOnlyAction, batchSize: 8, turnCooldownSec: 360 });
  await w.runTurn(campaign);
  await w.runTurn(campaign);
  await w.runTurn(campaign); // no cooldown was set → all three turns run back-to-back
  const t1 = store._order.slice(0, 8), t2 = store._order.slice(8, 16), t3 = store._order.slice(16, 24);
  assert.ok(t1.every((p) => p === t1[0]) && t2.every((p) => p === t2[0]) && t3.every((p) => p === t3[0]));
  assert.notEqual(t2[0], t1[0], "cursor alternates accounts even with cooldown disabled");
  assert.equal(t3[0], t1[0], "round-robin returns to the first account on turn 3");
});

test("no rotation methods on the store → falls back to index-0 scan (back-compat)", async () => {
  // A bare mock (no nextRotationIndex / turn-cooldown) must behave exactly as before.
  let remaining = 8; const order = [];
  const bare = {
    getCampaign: async () => ({ status: "running" }),
    isParked: async () => false,
    dailyCount: async () => 0,
    acquireAccount: async () => true,
    releaseAccount: async () => {},
    heartbeatAccount: async () => {},
    claimNextLead: async (_c, p) => (remaining-- > 0 ? (order.push(p), { id: `L${remaining}`, member_urn: `u${remaining}`, lead_url: `x/${remaining}` }) : null),
    wasActionSent: async () => false,
    tryConsumeDailySend: async () => ({ allowed: true }),
    markActionSent: async () => {},
    markLead: async () => {},
    clearThrottle: async () => {},
  };
  const w = new CampaignWorker({ store: bare, action: sendAction, batchSize: 8, turnCooldownSec: 360 });
  const n = await w.runTurn(campaign);
  assert.equal(n, 8);
  assert.ok(order.every((p) => p === "acctA"), "with no cursor, scan starts at profile_ids[0]");
});
