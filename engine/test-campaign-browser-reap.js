// test-campaign-browser-reap.js
//
// Zombie-browser leak fix. The campaign monitoring check launches a GoLogin
// browser every hour; closeProfile used to call GL.stopAndCommit (which uploads
// the profile — the "Profile uploaded to S3" log) but NEVER reaped the Orbita/
// Chrome process, and never touched the Puppeteer browser at all. In the headed-
// Xvfb pod that left one ~30%-CPU zombie per check → 16 in 16h → all 4 cores
// pegged + memory creep (observed live 2026-07-13 on Antonio's monitoring run).
//
// This proves reapSession's contract: it ALWAYS runs every reap layer
// (stopAndCommit → GL.killBrowser → browser.close → browser.disconnect), in that
// order, and one layer throwing never blocks the rest.
//
// Pure unit test — fake GL/browser stubs, no GoLogin/Puppeteer/pod needed. Calls
// reapSession WITHOUT a profileId so the process-level pkill fallback no-ops.
//   node test-campaign-browser-reap.js

const { reapSession } = require("./campaign-browser");
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exitCode = 1; throw new Error(m); } console.log("✅", m); }

// A fake GoLogin + Puppeteer browser that records the order of every reap call.
function makeStubs({ commitThrows = false, killThrows = false, closeThrows = false } = {}) {
  const order = [];
  const GL = {
    async stopAndCommit(opts, local) {
      order.push("stopAndCommit");
      GL._commitArgs = [opts, local];
      if (commitThrows) throw new Error("commit boom");
    },
    killBrowser() {
      order.push("killBrowser");
      if (killThrows) throw new Error("kill boom");
    },
  };
  const browser = {
    async close() {
      order.push("browser.close");
      if (closeThrows) throw new Error("close boom");
    },
    async disconnect() { order.push("browser.disconnect"); },
  };
  return { GL, browser, order };
}

(async () => {
  // 1. Happy path — every layer fires, in the documented order.
  {
    const { GL, browser, order } = makeStubs();
    await reapSession({ GL, browser });
    assert(order.join(",") === "stopAndCommit,killBrowser,browser.close,browser.disconnect",
      "runs all four reap layers in order (commit → kill → close → disconnect)");
    assert(GL._commitArgs[0] && GL._commitArgs[0].posting === true && GL._commitArgs[1] === false,
      "stopAndCommit called with ({ posting: true }, false) — cookie sync contract intact");
  }

  // 2. stopAndCommit throwing must NOT block the process reap (the actual leak:
  //    a commit hiccup previously left the browser alive).
  {
    const { GL, browser, order } = makeStubs({ commitThrows: true });
    await reapSession({ GL, browser });
    assert(order.includes("killBrowser") && order.includes("browser.close"),
      "commit throwing still reaps: killBrowser + browser.close both run");
  }

  // 3. killBrowser throwing must not block the Puppeteer-side close.
  {
    const { GL, browser, order } = makeStubs({ killThrows: true });
    await reapSession({ GL, browser });
    assert(order.includes("browser.close") && order.includes("browser.disconnect"),
      "killBrowser throwing still reaps the Puppeteer browser");
  }

  // 4. browser.close throwing must not block disconnect.
  {
    const { GL, browser, order } = makeStubs({ closeThrows: true });
    await reapSession({ GL, browser });
    assert(order.includes("browser.disconnect"),
      "browser.close throwing still calls disconnect");
  }

  // 5. Partial-start shape — GL present, browser null (puppeteer.connect failed
  //    after GL.start). Must still reap the GoLogin/Orbita side without throwing.
  {
    const { GL, order } = makeStubs();
    await reapSession({ GL, browser: null });
    assert(order.join(",") === "stopAndCommit,killBrowser",
      "partial-start (browser=null) still reaps GoLogin side, no crash on missing browser");
  }

  // 6. Empty/degenerate call must be a safe no-op (never throws).
  {
    await reapSession({});
    await reapSession();
    assert(true, "reapSession({}) / reapSession() are safe no-ops");
  }

  // 7. A HANGING step (browser.close() never resolves) must NOT hang reapSession
  //    — it's bounded by a per-step timeout and the reap completes. This is the
  //    73-min "stuck at 36%" freeze fix (2026-07-20): an unbounded await here
  //    held the pod's whole poll open. REAP_STEP_TIMEOUT_MS shrinks the budget
  //    so the test is fast; without the fix this would hang the test forever.
  {
    process.env.REAP_STEP_TIMEOUT_MS = "150";
    const GL = { async stopAndCommit() {}, killBrowser() {} };
    const order = [];
    const browser = {
      close: () => new Promise(() => { order.push("close-started"); }), // never resolves
      async disconnect() { order.push("disconnect"); },
    };
    const t0 = Date.now();
    await reapSession({ GL, browser });
    const elapsed = Date.now() - t0;
    assert(elapsed < 2000, `hanging browser.close() is bounded, reap returned in ${elapsed}ms (not forever)`);
    assert(order.includes("disconnect"), "reap continues past the hung step to disconnect");
    delete process.env.REAP_STEP_TIMEOUT_MS;
  }

  console.log("\nAll campaign-browser reap tests passed.");
})().catch((e) => { console.error(e); process.exitCode = 1; });
