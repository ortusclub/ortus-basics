// test-monitor-tail-action.js
//
// Pure lifecycle decision for handleMonitor's tail (no DB / session needed).
// Locks the parity semantics with the local app:
//   - expired monitoring window → 'expire' (stop, mark done), regardless of auto.
//   - auto-checks OFF (and not expired) → 'park': the sweep that just ran is the
//     last automatic one; the timer pauses. Check-now / toggle-on re-arm it.
//   - auto-checks ON → 'reschedule' by the cadence.
//   - a legacy campaign with the flag unset behaves as auto-ON (safe default).
//
// Run:  node test-monitor-tail-action.js

const { monitorTailAction } = require("./campaign-monitor");
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

assert(monitorTailAction({ expired: true, autoChecksEnabled: true }) === "expire", "expired + auto-on → expire");
assert(monitorTailAction({ expired: true, autoChecksEnabled: false }) === "expire", "expired + auto-off → expire (window wins)");
assert(monitorTailAction({ expired: false, autoChecksEnabled: false }) === "park", "not expired + auto-off → park");
assert(monitorTailAction({ expired: false, autoChecksEnabled: true }) === "reschedule", "not expired + auto-on → reschedule");
assert(monitorTailAction({ expired: false, autoChecksEnabled: undefined }) === "reschedule", "auto flag unset → reschedule (default on)");

console.log("\nall monitorTailAction cases pass");
