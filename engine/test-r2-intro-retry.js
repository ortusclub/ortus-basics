// test-r2-intro-retry.js
//
// R2 increment 1 — intro send-loop parity with the app's auto-intro.js:699-877.
// Exercises the retry loop, INTRO_ALREADY_EXISTS happy-path, same-name photo
// disambiguation, RECIPIENT_NOT_FOUND retry-once, terminal failure mapping, and
// follow-up-only-on-fresh-send — via injected sendIntro/captureAvatar + a fake
// in-memory store. Pure: no DB/browser.  Run: node test-r2-intro-retry.js

const { runAutoIntros, _decideReverifyAction, _browserAlive } = require("./campaign-autointro");

let failures = 0;
function eq(a, b, m) { if (a !== b) { failures++; console.error(`❌ ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } else { console.log("✅", m); } }
function ok(c, m) { if (!c) { failures++; console.error(`❌ ${m}`); } else { console.log("✅", m); } }

// Fake store: records outcomes + tasks + the durable action-sent blacklist.
function makeStore(leads) {
  const outcomes = {}, tasks = [], sent = new Set();
  return {
    outcomes, tasks, sent,
    async getPrimaryConn() { return null; },
    async setPrimaryConn() {},
    async getCampaignLeads() { return leads; },
    async wasActionSent(_c, url) { return sent.has(url); },
    async markActionSent(_c, url) { sent.add(url); },
    async updateLeadOutcome(id, fields) { outcomes[id] = { ...(outcomes[id] || {}), ...fields }; },
    async createTask(t) { tasks.push(t); },
  };
}

const lead = (id, url) => ({ id, lead_url: url, introduction_status: "", full_name: "Miera Rotas", row_data: { "First Name": "Miera", "Last Name": "Rotas" } });
// A page that reports itself alive (real puppeteer page has browser()/isClosed()).
// The send loop's pre-send checkpoint treats a page with no browser() as dead.
const livePage = () => ({ browser: () => ({ connected: true }), isClosed: () => false, url: () => "https://linkedin.com/messaging/thread/X", goto: async () => {} });
// No primaryUrl → the primary-connection gate is skipped, isolating the send loop.
const TPL = { primaryName: "Antonio Varlese", primaryIntroBody: "hi {first name}, meet {primary full name}" };

(async () => {
  // ── 1) success first attempt → Introduction Made + Connected stamp + blacklist ──
  {
    const store = makeStore([lead(1, "u/1")]);
    const calls = [];
    const sendIntro = async (a) => { calls.push(a); return { success: true, threadUrl: "https://linkedin.com/messaging/thread/T1" }; };
    const r = await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: livePage(), connectedUrls: ["u/1"], templates: TPL, sendIntro });
    eq(r.sent, 1, "success → sent=1");
    eq(store.outcomes[1].introductionStatus, "Introduction Made", "status = Introduction Made");
    eq(store.outcomes[1].threadUrl, "https://linkedin.com/messaging/thread/T1", "real threadUrl captured (#8)");
    eq(store.outcomes[1].connectionAcceptedStatus, "Connected", "intro proves connection → Connected stamp");
    ok(store.sent.has("u/1"), "markActionSent blacklisted the url");
    eq(calls.length, 1, "single send attempt on first-try success");
  }

  // ── 2) INTRO_ALREADY_EXISTS → Introduction Already Made, counts sent, NO follow-up ──
  {
    const store = makeStore([lead(2, "u/2")]);
    let sends = 0;
    const sendIntro = async () => { sends++; return { success: false, error: "INTRO_ALREADY_EXISTS: existing thread" }; };
    const r = await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: livePage(), connectedUrls: ["u/2"],
      templates: { ...TPL, followUpEnabled: true, followUpBody: "ping" }, sendIntro });
    eq(r.sent, 1, "already-exists counts as sent (#5)");
    eq(store.outcomes[2].introductionStatus, "Introduction Already Made", "status = Introduction Already Made");
    eq(store.outcomes[2].connectionAcceptedStatus, "Connected", "already-made also stamps Connected");
    eq(store.tasks.length, 0, "NO follow-up queued on already-made (app parity)");
    eq(sends, 1, "already-exists breaks the loop (no retry)");
  }

  // ── 3) same-name ambiguity → capture photo → retry succeeds ──
  {
    const store = makeStore([lead(3, "u/3")]);
    const seen = [];
    let n = 0;
    const sendIntro = async (a) => {
      seen.push(a.leadAvatarToken || "");
      n++;
      if (n === 1) return { success: false, error: "IC_INTRO_AMBIGUOUS_RECIPIENT: 2 matches" };
      return { success: true, threadUrl: "https://linkedin.com/messaging/thread/T3" };
    };
    let captured = 0;
    const captureAvatar = async () => { captured++; return "AVATAR_TOKEN_XYZ"; };
    const r = await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: livePage(), connectedUrls: ["u/3"], templates: TPL, sendIntro, captureAvatar });
    eq(r.sent, 1, "ambiguity resolved by photo → sent=1 (#6)");
    eq(seen[0], "", "first attempt sent with no avatar token");
    eq(seen[1], "AVATAR_TOKEN_XYZ", "retry attempt sent WITH the captured lead avatar token");
    ok(captured >= 1, "captureAvatar was invoked on ambiguity");
    eq(store.outcomes[3].introductionStatus, "Introduction Made", "resolved intro stamped Made");
  }

  // ── 4) ambiguity + NO photo available → skip-on-doubt (never message stranger) ──
  {
    const store = makeStore([lead(4, "u/4")]);
    let sends = 0;
    const sendIntro = async () => { sends++; return { success: false, error: "IC_INTRO_AMBIGUOUS_RECIPIENT: 3 matches" }; };
    const captureAvatar = async () => ""; // no reference photo
    const r = await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: livePage(), connectedUrls: ["u/4"], templates: TPL, sendIntro, captureAvatar });
    eq(r.failed, 1, "no photo → not sent");
    eq(sends, 1, "no retry when no photo captured (skip-on-doubt)");
    eq(store.outcomes[4].introductionStatus, "Skipped — multiple same-name matches, verify manually", "friendly skip label");
    ok(!store.sent.has("u/4"), "skipped url NOT blacklisted (can retry after manual disambiguation)");
  }

  // ── 5) RECIPIENT_NOT_FOUND typeahead miss → retry once → success ──
  {
    const store = makeStore([lead(5, "u/5")]);
    let n = 0;
    const sendIntro = async () => { n++; return n === 1 ? { success: false, error: "INTRO_RECIPIENT_NOT_FOUND: recipient-not-in-results" } : { success: true, threadUrl: "T5" }; };
    const r = await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: livePage(), connectedUrls: ["u/5"], templates: TPL, sendIntro });
    eq(r.sent, 1, "typeahead miss retried once → sent=1 (#7)");
    eq(n, 2, "exactly two attempts");
  }

  // ── 6) terminal failure → mapped friendly label, counted failed ──
  {
    const store = makeStore([lead(6, "u/6")]);
    const sendIntro = async () => ({ success: false, error: "MESSAGE_SEND_FAILED: compose textbox did not appear" });
    const r = await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: livePage(), connectedUrls: ["u/6"], templates: TPL, sendIntro });
    eq(r.failed, 1, "terminal error → failed=1");
    eq(store.outcomes[6].introductionStatus, "Failed — Compose page didn't load", "full friendly-map label (#20)");
  }

  // ── 7) fresh send with follow-up enabled → follow-up queued with real threadUrl ──
  {
    const store = makeStore([lead(7, "u/7")]);
    const sendIntro = async () => ({ success: true, threadUrl: "https://linkedin.com/messaging/thread/T7" });
    await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: livePage(), connectedUrls: ["u/7"],
      templates: { ...TPL, followUpEnabled: true, followUpBody: "great chat {first name}", followUpDelayMinutes: 10, primarySource: "acct" }, sendIntro, now: 1_000_000 });
    eq(store.tasks.length, 1, "follow-up queued on fresh send");
    eq(store.tasks[0].payload.threadUrl, "https://linkedin.com/messaging/thread/T7", "follow-up carries the REAL thread URL (was '' → #8)");
    eq(store.tasks[0].type, "follow_up", "task type follow_up");
  }

  // ── 8) INCREMENT 2 — browser dies MID-sweep → interrupted lead + remainder Skipped ──
  {
    const store = makeStore([lead(8, "u/8a"), lead(9, "u/8b")]);
    const p = { _alive: true, browser: () => ({ connected: p._alive }), isClosed: () => false, url: () => "", goto: async () => {} };
    const sendIntro = async () => { p._alive = false; return { success: false, error: "MESSAGE_SEND_FAILED: compose textbox did not appear" }; };
    const r = await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: p, connectedUrls: ["u/8a", "u/8b"], templates: TPL, sendIntro });
    eq(r.failed, 0, "browser-death → not counted as a real Failed");
    eq(r.skipped, 2, "interrupted lead + remaining lead both Skipped");
    eq(store.outcomes[8].introductionStatus, "Skipped — browser closed", "mid-send interruption reclassified to Skipped (not Failed)");
    eq(store.outcomes[9].introductionStatus, "Skipped — browser closed", "remaining lead stamped Skipped, loop broke");
  }

  // ── 9) browser dead BEFORE the first send → whole batch Skipped, nothing sent ──
  {
    const store = makeStore([lead(10, "u/9a"), lead(11, "u/9b")]);
    const deadPage = { browser: () => ({ connected: false }), isClosed: () => true, url: () => "", goto: async () => {} };
    let sends = 0;
    const sendIntro = async () => { sends++; return { success: true }; };
    const r = await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: deadPage, connectedUrls: ["u/9a", "u/9b"], templates: TPL, sendIntro });
    eq(sends, 0, "pre-send checkpoint: dead page → never attempts a send");
    eq(r.skipped, 2, "both leads Skipped");
    eq(store.outcomes[10].introductionStatus, "Skipped — browser closed", "pre-send dead → Skipped");
  }

  // ── 10) reverify-and-downgrade: compose-fail on a Connected row + status 'connect' → downgrade CC ──
  {
    const store = makeStore([{ id: 12, lead_url: "u/10", introduction_status: "", full_name: "Miera Rotas", connection_accepted_status: "Connected", row_data: {} }]);
    const sendIntro = async () => ({ success: false, error: "MESSAGE_SEND_FAILED: compose textbox did not appear" });
    const getConnStatus = async () => "connect"; // reverify says NOT actually connected
    const r = await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: livePage(), connectedUrls: ["u/10"], templates: TPL, sendIntro, getConnStatus });
    eq(r.failed, 1, "still a failed intro");
    eq(store.outcomes[12].introductionStatus, "Failed — Compose page didn't load", "intro stamped Failed");
    ok(/^Unverified — manual review \(/.test(store.outcomes[12].connectionAcceptedStatus || ""), "CC downgraded to 'Unverified — manual review (…)' (#13)");
  }

  // ── 11) reverify no-op: status 'message' (genuine 1st-degree) → CC stays Connected ──
  {
    const store = makeStore([{ id: 13, lead_url: "u/11", introduction_status: "", full_name: "Miera Rotas", connection_accepted_status: "Connected", row_data: {} }]);
    const sendIntro = async () => ({ success: false, error: "MESSAGE_SEND_FAILED: compose textbox did not appear" });
    const getConnStatus = async () => "message"; // genuine connection — a flaky compose, not a false stamp
    await runAutoIntros({ store, campaign: { id: "c" }, account: "acct", page: livePage(), connectedUrls: ["u/11"], templates: TPL, sendIntro, getConnStatus });
    eq(store.outcomes[13].connectionAcceptedStatus, undefined, "genuine 1st-degree → CC NOT downgraded (no clobber on flaky DOM)");
  }

  // ── 12) pure _decideReverifyAction matrix — STRICT: only clear-negatives downgrade ──
  eq(_decideReverifyAction("connect", "Connected").action, "downgrade", "reverify: connect → downgrade");
  eq(_decideReverifyAction("pending", "Connected").action, "downgrade", "reverify: pending → downgrade");
  eq(_decideReverifyAction("message", "Connected").action, "noop", "reverify: message → keep (genuine 1st-degree)");
  eq(_decideReverifyAction("follow", "Connected").action, "noop", "reverify: follow → keep (restricted)");
  eq(_decideReverifyAction("unknown", "Connected").action, "noop", "reverify: unknown → keep (never clobber on ambiguity)");
  eq(_decideReverifyAction("connect", "").action, "noop", "reverify: cc not Connected → noop");

  // ── 13) pure _browserAlive ──
  eq(_browserAlive({ browser: () => ({ connected: true }), isClosed: () => false }), true, "browserAlive: connected + open → true");
  eq(_browserAlive({ browser: () => ({ connected: false }), isClosed: () => false }), false, "browserAlive: disconnected → false");
  eq(_browserAlive({ browser: () => ({ connected: true }), isClosed: () => true }), false, "browserAlive: page closed → false");
  eq(_browserAlive({}), false, "browserAlive: no browser() → false (dead)");

  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log("\nAll R2 intro-retry parity tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
