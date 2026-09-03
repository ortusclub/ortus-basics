// test-campaign-soo-retry.js
//
// SoO Needs-Login write-back — cold-start retry (Task ③). When a cloud session
// dies, the engine stamps "Needs Login: Y" in the SoO sheet through the SAME
// Apps Script web-app as the results write-back — which cold-starts in 28–58s.
// A single 15s attempt aborted every stamp while the webapp was cold (why the
// flag landed unreliably). This proves the mirror of the sheet-writer's fix:
// 30s timeout + transient-only retry with linear backoff; permanent errors don't
// retry; the setSoO payload contract is intact; the 302 result-redirect is
// followed.
//
// Pure unit test — stubs global.fetch, injects `sleep` (no real delays). No
// PG/Redis needed.
//   node test-campaign-soo-retry.js

const { markNeedsLogin } = require("./campaign-soo-writer");
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

// A fetch stub driven by a sequence of behaviors (Response-like object, or an
// Error to throw). Records every call. Repeats the last step once exhausted.
function stubFetch(seq) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const step = seq[Math.min(calls.length, seq.length - 1)];
    calls.push({ url, opts });
    if (step instanceof Error) throw step;
    return step;
  };
  return calls;
}
const ok200 = { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" };
const httpErr = (status, body) => ({ ok: false, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const OPTS = { webappUrl: "http://webapp", sooSheetId: "SOO_SHEET", sooGid: "123", email: "acct@ortus.solutions" };
const noSleep = { sleep: async () => {} };

(async () => {
  // ── 1) missing pieces → graceful skip, never throws, no HTTP ──
  let calls = stubFetch([ok200]);
  assert((await markNeedsLogin({})).skipped === true, "no params → graceful skip (never throws)");
  assert(calls.length === 0, "a skip makes ZERO http calls");
  assert((await markNeedsLogin({ webappUrl: "x", email: "a@b.c" })).skipped === true, "missing sooSheetId → skip");

  // ── 2) success on first try + payload contract ──
  calls = stubFetch([ok200]);
  const r = await markNeedsLogin(OPTS, noSleep);
  assert(r.ok === true && calls.length === 1, "success on attempt 1 (single call)");
  const body = JSON.parse(calls[0].opts.body);
  assert(body.action === "setSoO" && body.sheetId === "SOO_SHEET" && body.gid === "123"
    && body.email === "acct@ortus.solutions" && body.fields["Needs Login"] === "Y",
    "payload = setSoO / sheetId / gid / email / 'Needs Login':Y");

  // ── 3) transient timeouts twice, then success → retried with linear backoff ──
  const sleeps = [];
  calls = stubFetch([new Error("timeout aborted"), new Error("terminated"), ok200]);
  const r3 = await markNeedsLogin(OPTS, { sleep: async (ms) => sleeps.push(ms) });
  assert(r3.ok === true && calls.length === 3, "transient×2 then ok → 3 attempts, succeeds");
  assert(JSON.stringify(sleeps) === "[1500,3000]", "linear backoff between retries (1.5s, 3s)");

  // ── 4) permanent error → returns immediately, NO retry ──
  calls = stubFetch([httpErr(401, { error: "unauthorized" })]);
  const r4 = await markNeedsLogin(OPTS, noSleep);
  assert(r4.ok === false && r4.error === "unauthorized" && calls.length === 1,
    "permanent (401 unauthorized) → 1 call, no retry (retrying wouldn't help)");

  // ── 5) transient forever → exhausts 4 attempts, then gives up ──
  const s5 = [];
  calls = stubFetch([new Error("ECONNRESET socket")]);
  const r5 = await markNeedsLogin(OPTS, { sleep: async (ms) => s5.push(ms) });
  assert(r5.ok === false && calls.length === 4, "transient-forever → 4 attempts then gives up");
  assert(JSON.stringify(s5) === "[1500,3000,4500]", "3 backoffs before the 4th attempt exhausts");

  // ── 6) HTTP 5xx (cold-start class) is transient → retried ──
  calls = stubFetch([httpErr(503, { error: "503 backend unavailable" }), ok200]);
  const r6 = await markNeedsLogin(OPTS, noSleep);
  assert(r6.ok === true && calls.length === 2, "HTTP 503 is transient → retried then ok");

  // ── 7) the 302 result-redirect is followed (Apps Script always 302s the body) ──
  const redirect = {
    ok: false, status: 302,
    headers: { get: (h) => (String(h).toLowerCase() === "location" ? "http://webapp/exec-result" : null) },
    text: async () => "",
  };
  calls = stubFetch([redirect, ok200]);
  const r7 = await markNeedsLogin(OPTS, noSleep);
  assert(r7.ok === true && calls.length === 2 && calls[1].url === "http://webapp/exec-result",
    "302 redirect followed to the exec URL (one logical attempt)");

  console.log(`\n${process.exitCode ? "❌ SOME CHECKS FAILED" : "🎉 ALL CHECKS PASSED — SoO Needs-Login cold-start retry"}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
