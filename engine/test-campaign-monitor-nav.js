// test-campaign-monitor-nav.js
//
// Monitor/bulk-check must navigate to a LinkedIn URL BEFORE reading recent
// connections (getRecentConnections reads document.cookie for the CSRF token and
// does NOT navigate itself). A fresh monitor/check browser is on about:blank,
// where document.cookie throws "Failed to read the 'cookie' property from
// 'Document': Access is denied" — the error operators hit on a manual check after
// "stop sending, keep monitoring", which ALSO falsely stamps the account
// Needs-Login. navigateThenFetchRecent ports local's bulkCheckConnections nav +
// login-redirect guard. Pure — no browser.  Run: node test-campaign-monitor-nav.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { navigateThenFetchRecent, isSessionInvalidError } = require("./campaign-monitor");

const CONN_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";

// Mock page: records goto, returns a settled URL (or throws on nav).
function mockPage({ landsOn = CONN_URL, gotoThrows = null } = {}) {
  const gotos = [];
  return {
    gotos,
    async goto(url, opts) { gotos.push({ url, opts }); if (gotoThrows) throw new Error(gotoThrows); },
    url() { return landsOn; },
  };
}

test("navigates to the connections URL BEFORE fetching (the missing step)", async () => {
  const page = mockPage();
  let fetchedOn = null;
  const out = await navigateThenFetchRecent(page, async (p) => { fetchedOn = p; return [{ urn: "u1" }]; });

  assert.equal(page.gotos.length, 1, "it navigated exactly once");
  assert.equal(page.gotos[0].url, CONN_URL, "navigated to LinkedIn's own connections URL (1:1 with local)");
  assert.equal(page.gotos[0].opts.waitUntil, "domcontentloaded");
  assert.equal(fetchedOn, page, "getRecent runs only AFTER navigation, on the same page");
  assert.deepEqual(out, [{ urn: "u1" }], "returns the fetch result on success");
});

test("a genuinely dead session (login redirect) → typed session-expired error, fetch NOT run", async () => {
  const page = mockPage({ landsOn: "https://www.linkedin.com/login?session_redirect=1" });
  let ran = false;
  const out = await navigateThenFetchRecent(page, async () => { ran = true; return [{ urn: "x" }]; });

  assert.equal(ran, false, "never hits Voyager on a logged-out page (would 404 anyway)");
  assert.ok(Array.isArray(out) && out.length === 0, "returns the empty-array-with-error contract");
  assert.match(out.error, /session-expired \(redirected to/);
  assert.equal(isSessionInvalidError(out.error), true, "this IS a real Needs-Login signal (unlike the about:blank cookie error)");
});

test("checkpoint / uas redirects are also treated as session-expired", async () => {
  for (const u of [
    "https://www.linkedin.com/checkpoint/challenge/",
    "https://www.linkedin.com/uas/login",
  ]) {
    const out = await navigateThenFetchRecent(mockPage({ landsOn: u }), async () => [{ urn: "x" }]);
    assert.match(out.error, /session-expired/, `redirect to ${u} → session-expired`);
    assert.equal(isSessionInvalidError(out.error), true);
  }
});

test("a navigation failure surfaces as navigation-failed (NOT a false Needs-Login)", async () => {
  const page = mockPage({ gotoThrows: "net::ERR_TIMED_OUT" });
  const out = await navigateThenFetchRecent(page, async () => [{ urn: "x" }]);
  assert.ok(Array.isArray(out) && out.length === 0);
  assert.match(out.error, /navigation-failed: net::ERR_TIMED_OUT/);
  assert.equal(isSessionInvalidError(out.error), false, "a transient nav failure must NOT stamp the account Needs-Login");
});

test("on a healthy connections page the fetch runs — no about:blank cookie error path", async () => {
  const page = mockPage({ landsOn: CONN_URL });
  const out = await navigateThenFetchRecent(page, async () => [{ urn: "a" }, { urn: "b" }]);
  assert.equal(out.length, 2, "acceptances fetched normally once on the real page");
  assert.equal(out.error, undefined);
});
