// test-campaign-sheet-timestamp.js
//
// buildTracking must send a timestamp + tz so the Apps Script stamps
// "Date/Time of Last Action" at the EXACT send moment in the operator's tz —
// the cloud parity gap where cloud rows had blank Date/Time (send path stamps
// sent_at but never date_last_action, and no tz was ever sent). Pure — no pg/redis.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildTracking } = require("./campaign-sheet-writer");

test("one-shot SEND (date_last_action null) → dateLastAction falls back to sent_at", () => {
  const t = buildTracking({ stage: "CC", sent_at: "2026-07-14T09:15:30.000Z", date_last_action: null });
  assert.equal(t.dateLastAction, "2026-07-14T09:15:30.000Z", "uses sent_at as the send moment");
});

test("monitor-phase update prefers date_last_action over sent_at", () => {
  const t = buildTracking({
    stage: "IC", introduction_status: "Introduction Made",
    sent_at: "2026-07-14T09:15:30.000Z", date_last_action: "2026-07-15T11:00:00.000Z",
  });
  assert.equal(t.dateLastAction, "2026-07-15T11:00:00.000Z", "acceptance/intro time wins");
});

test("no timestamp at all → dateLastAction omitted (GAS skips the stamp)", () => {
  const t = buildTracking({ stage: "CC", sent_at: null, date_last_action: null });
  assert.ok(!("dateLastAction" in t), "no send/action time → nothing to stamp");
});

test("cfg.tz is forwarded so GAS formats in the operator's timezone", () => {
  const t = buildTracking({ stage: "CC", sent_at: "2026-07-14T09:15:30.000Z" }, { tz: "Europe/Zurich" });
  assert.equal(t.tz, "Europe/Zurich");
});

test("no cfg.tz → no tz key (GAS falls back to script tz, no spurious column)", () => {
  const t = buildTracking({ stage: "CC", sent_at: "2026-07-14T09:15:30.000Z" }, {});
  assert.ok(!("tz" in t), "tz only sent when configured");
});
