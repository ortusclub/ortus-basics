// test-vendored-send.js
//
// Unit test for _vendoredSend — the adapter that wraps the vendored browser
// intro fns (which THROW on failure) into runAutoIntros's { success, threadUrl,
// error } contract. Pure: no PG/Redis/browser. Run: node test-vendored-send.js
//
// Regression guard for the prod bug where the default (non-injected) send path
// called a function that wasn't in scope ("v.sendIntroViaCleanCompose is not a
// function") so NO intro ever fired and no acceptance was stamped.

const { _vendoredSend } = require("./campaign-autointro");

let failures = 0;
function assert(c, m) { if (!c) { failures++; console.error("❌ FAIL:", m); } else { console.log("✅", m); } }

(async () => {
  // 1. Lead WITH a full name → clean-compose group path; success → {success:true}.
  {
    const calls = [];
    const v = {
      sendIntroViaCleanCompose: async (...a) => { calls.push(["clean", a]); /* resolves */ },
      sendIntroMessage: async () => { throw new Error("should not be called"); },
    };
    const send = _vendoredSend(v);
    const res = await send({ page: {}, body: "hi", leadFullName: "Jane Doe", primaryName: "Pat", title: "Intro", leadUrl: "https://linkedin.com/in/jane" });
    assert(res.success === true, "named lead → success:true");
    assert(calls.length === 1 && calls[0][0] === "clean", "named lead uses sendIntroViaCleanCompose");
    const [page, bodyArg, leadFullName, primaryName, groupTitle, opts] = calls[0][1];
    assert(bodyArg === "hi" && leadFullName === "Jane Doe" && primaryName === "Pat" && groupTitle === "Intro",
      "clean-compose signature: (page, body, leadFullName, primaryName, groupTitle, opts)");
    assert(opts && opts.dedupeProbe === true, "clean-compose passes { dedupeProbe:true } as opts (not a URL string)");
  }

  // 2. Lead with NO full name → URL-routed sendIntroMessage fallback.
  {
    const calls = [];
    const v = {
      sendIntroViaCleanCompose: async () => { throw new Error("should not be called"); },
      sendIntroMessage: async (...a) => { calls.push(["msg", a]); },
    };
    const res = await _vendoredSend(v)({ page: {}, body: "hi", leadFullName: "", primaryName: "Pat", title: "Intro", leadUrl: "https://linkedin.com/in/jane" });
    assert(res.success === true, "nameless lead → success:true");
    assert(calls.length === 1 && calls[0][0] === "msg", "nameless lead uses sendIntroMessage");
    const [, bodyArg, introName, groupTitle, second, leadUrl] = calls[0][1];
    assert(introName === "Pat" && groupTitle === "Intro" && second === "" && leadUrl === "https://linkedin.com/in/jane",
      "sendIntroMessage signature: (page, body, introName, groupTitle, '', leadUrl)");
  }

  // 3. Same-name ambiguity → clean-compose THROWS → adapter returns failure (SKIP,
  //    never message the wrong person).
  {
    const v = {
      sendIntroViaCleanCompose: async () => { throw new Error("IC_INTRO_AMBIGUOUS_RECIPIENT: 2 same-name matches"); },
      sendIntroMessage: async () => {},
    };
    const res = await _vendoredSend(v)({ page: {}, body: "hi", leadFullName: "John Smith", primaryName: "Pat", title: "Intro", leadUrl: "u" });
    assert(res.success === false, "ambiguous same-name → success:false (skip, not sent)");
    assert(/AMBIGUOUS/.test(res.error), "ambiguity error surfaced to the outcome stamp");
  }

  // 4. Generic throw → failure contract (no crash).
  {
    const v = { sendIntroViaCleanCompose: async () => { throw new Error("IC_INTRO_FAILED: compose UI did not load"); }, sendIntroMessage: async () => {} };
    const res = await _vendoredSend(v)({ page: {}, body: "hi", leadFullName: "Jane Doe", primaryName: "Pat", title: "Intro", leadUrl: "u" });
    assert(res.success === false && /did not load/.test(res.error), "browser throw → {success:false, error}");
  }

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log("\nAll _vendoredSend contract tests passed.");
})();
