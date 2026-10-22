// Test-only speed-up. The engine's built-in pauses ("let the page settle for 5s", "wait 7.5s to confirm
// the send") exist for real LinkedIn; the fake pages settle instantly. SIM_SPEED=N shortens Node timers
// of >= 400ms by N. Network/abort timeouts (AbortSignal.timeout) are untouched, so real timeouts still bite.
const f = Number(process.env.SIM_SPEED || 1);
if (f > 1) {
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, ms, ...args) {
    return orig.call(this, fn, typeof ms === 'number' && ms >= 400 ? Math.max(50, ms / f) : ms, ...args);
  };
}
