// test-r4-prepare-sheet.js
//
// R4 #4 parity guard: the engine must provision the mode's tracking columns at
// campaign start by POSTing the EXACT payload the app's sheets-writer sends —
// {action:'prepareSheet', sheetId, gid, mode} — following the Apps Script 302
// redirect. A malformed payload gets rejected ("sheetId is required") and the
// columns never get created, so every stamp to a missing column is silently
// dropped. This stubs global.fetch to assert the wire contract without network.
//
// Pure(ish): stubs global.fetch, no DB/browser.  Run: node test-r4-prepare-sheet.js

const { prepareSheet } = require("./campaign-sheet-writer");

let failures = 0;
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) { failures++; console.error(`❌ ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } else { console.log("✅", m); } }
function ok(c, m) { if (!c) { failures++; console.error(`❌ ${m}`); } else { console.log("✅", m); } }

const WEBAPP = "https://script.google.com/macros/s/XYZ/exec";
const SHEET = "https://docs.google.com/spreadsheets/d/100vrpDurly8nf5BlaYDDmfaHMQtvWENQk3HwqDwM5nk/edit?gid=1286111558#gid=1286111558";

// A minimal Response stand-in.
function resp({ status = 200, location = null, body = "" }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === "location" ? location : null) },
    text: async () => body,
  };
}

(async () => {
  // ── 1. Happy path: 302 redirect → provisioning succeeds; payload is exact ──
  let captured = null;
  let hop = 0;
  global.fetch = async (url, opts) => {
    hop++;
    if (hop === 1) {
      captured = { url, opts, payload: JSON.parse(opts.body) };
      return resp({ status: 302, location: "https://script.googleusercontent.com/redirect" });
    }
    // followed redirect (GET, no body)
    return resp({ status: 200, body: JSON.stringify({ success: true, added: ["Introduction Status", "Sender"], hidden: ["OP"], shown: [] }) });
  };

  const r = await prepareSheet(WEBAPP, SHEET, "connect_and_introduce");
  eq(captured.payload.action, "prepareSheet", "action = 'prepareSheet'");
  eq(captured.payload.sheetId, "100vrpDurly8nf5BlaYDDmfaHMQtvWENQk3HwqDwM5nk", "sheetId extracted from URL (NOT the whole URL — the 'sheetId is required' trap)");
  eq(captured.payload.gid, "1286111558", "gid extracted from URL");
  eq(captured.payload.mode, "connect_and_introduce", "mode passed through");
  eq(captured.opts.method, "POST", "POST method");
  eq(captured.opts.redirect, "manual", "manual redirect so we can follow the 302 ourselves");
  ok(hop === 2, "followed the 302 redirect (2 fetches)");
  eq(r.ok, true, "returns ok:true on success");
  eq(r.added, ["Introduction Status", "Sender"], "surfaces added columns");
  eq(r.hidden, ["OP"], "surfaces hidden columns");

  // ── 2. Apps Script error → {error}, not a throw ──
  global.fetch = async () => resp({ status: 200, body: JSON.stringify({ error: "BAD_MODE" }) });
  const e = await prepareSheet(WEBAPP, SHEET, "bogus_mode");
  eq(e.error, "BAD_MODE", "Apps Script error surfaced as {error}");

  // ── 3. HTTP failure → {error}, never throws ──
  global.fetch = async () => resp({ status: 500, body: "boom" });
  const h = await prepareSheet(WEBAPP, SHEET, "connect_only");
  ok(!!h.error, "HTTP 500 surfaced as {error} (no throw)");

  // ── 4. Network exception → {error}, never throws ──
  global.fetch = async () => { throw new Error("fetch failed"); };
  const n = await prepareSheet(WEBAPP, SHEET, "connect_only");
  eq(n.error, "fetch failed", "network exception caught and returned as {error}");

  // ── 5. Guard: missing args → skipped, no fetch at all ──
  let called = false;
  global.fetch = async () => { called = true; return resp({}); };
  const g1 = await prepareSheet("", SHEET, "connect_only");
  const g2 = await prepareSheet(WEBAPP, "", "connect_only");
  const g3 = await prepareSheet(WEBAPP, SHEET, "");
  ok(g1.skipped && g2.skipped && g3.skipped, "missing webapp/sheet/mode → {skipped:true}");
  ok(!called, "guard short-circuits BEFORE any network call");

  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log("\nAll R4 prepareSheet tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
