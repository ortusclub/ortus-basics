// test-r4-reply-check.js
//
// R4 parity guard for the AUTOMATIC reply-detection port (campaign-reply-check.js).
// Verifies the vendored pure functions match the app (check-dms.js) and that
// runReplyCheck reproduces checkProfileDms's behavior end-to-end with stubs:
//   • inbound reply → appendReply + pushRow tracking {Reply,ReplyAt,ReplyPreview,stage:'Replied'}
//   • watermark advanced on success, NOT advanced on Voyager-null
//   • ambiguous / unmatched conversations are NOT written
//   • dedup (recordReplies count=0) suppresses the tracking write (non-destructive)
//
// PURE: no PG/Redis/browser/network — stub page + stub getConversationsPage/
// appendReply/pushRow/store. Run: node test-r4-reply-check.js
/* eslint-disable no-console */

const {
  normName, matchConversationToSheet, shouldWriteReply, fetchNewConversations, runReplyCheck,
} = require("./campaign-reply-check");

let failures = 0;
function ok(c, m) { if (!c) { failures++; console.error(`❌ ${m}`); } else { console.log("✅", m); } }
function eq(a, b, m) { if (a !== b) { failures++; console.error(`❌ ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } else { console.log("✅", m); } }

// ── candidate row shape (mirrors store.getReplyCandidateLeads output) ──────────
const janeRow = { id: 1, lead_url: "https://linkedin.com/in/jane", "Linkedin URL": "https://linkedin.com/in/jane", firstName: "Jane", lastName: "Doe" };
const rows = [janeRow];

// ── matchConversationToSheet: single / unmatched / ambiguous ───────────────────
{
  const conv = { participants: [{ firstName: "Jane", lastName: "Doe", profileUrl: "urn:jane" }] };
  const m = matchConversationToSheet(conv, rows);
  ok(m.match === janeRow, "matchConversationToSheet: exact single name match returns the row");

  const un = matchConversationToSheet({ participants: [{ firstName: "Nobody", lastName: "Here" }] }, rows);
  eq(un.match, null, "matchConversationToSheet: no name match → match:null");
  eq(un.reason, "unmatched", "matchConversationToSheet: no name match → reason 'unmatched'");

  const amb = matchConversationToSheet(conv, [janeRow, { firstName: "Jane", lastName: "Doe", "Linkedin URL": "https://linkedin.com/in/jane2" }]);
  eq(amb.reason, "ambiguous", "matchConversationToSheet: two same-name rows → reason 'ambiguous'");
  ok(Array.isArray(amb.candidates) && amb.candidates.length === 2, "matchConversationToSheet: ambiguous carries both candidates");

  const empty = matchConversationToSheet({ participants: [] }, rows);
  eq(empty.reason, "unmatched", "matchConversationToSheet: no participant → unmatched");
}

// ── shouldWriteReply: yes / empty / missing ────────────────────────────────────
ok(shouldWriteReply(null) === true, "shouldWriteReply: null status → true (write)");
ok(shouldWriteReply({ Reply: "yes" }) === false, "shouldWriteReply: Reply='yes' → false (skip, non-destructive)");
ok(shouldWriteReply({ Reply: "YES " }) === false, "shouldWriteReply: 'YES ' (case/space) → false");
ok(shouldWriteReply({ Reply: "" }) === true, "shouldWriteReply: empty Reply → true");
ok(shouldWriteReply({}) === true, "shouldWriteReply: missing Reply → true");

// ── normName ───────────────────────────────────────────────────────────────────
eq(normName("  Jane   Doe "), "jane doe", "normName: lowercases, trims, collapses whitespace");

// ── fetchNewConversations: watermark stop + MAX_PAGES cap ──────────────────────
(async () => {
  {
    // Page 1 has a mix; oldest (5) <= watermark (10) → stop after one page.
    let calls = 0;
    const factory = async () => { calls++; return { elements: [{ lastActivityAt: 30 }, { lastActivityAt: 20 }, { lastActivityAt: 5 }] }; };
    const res = await fetchNewConversations(factory, 10);
    eq(calls, 1, "fetchNewConversations: stops after the page whose oldest ≤ watermark");
    eq(res.length, 2, "fetchNewConversations: returns only conversations newer than the watermark");
  }
  {
    // Every page is all-fresh with no paging.total → runs to the MAX_PAGES=10 cap.
    let calls = 0;
    const factory = async () => { calls++; return { elements: Array.from({ length: 20 }, () => ({ lastActivityAt: 999999 })) }; };
    const res = await fetchNewConversations(factory, 0);
    eq(calls, 10, "fetchNewConversations: MAX_PAGES caps the loop at 10 pages");
    eq(res.length, 200, "fetchNewConversations: accumulates all fresh elements up to the cap");
  }

  // ── runReplyCheck end-to-end ────────────────────────────────────────────────
  const CAMPAIGN = { id: "c1", mode: "message_only", config: { sheetsWebappUrl: "http://webapp" } };
  const SHEET = "https://docs.google.com/spreadsheets/d/SHEET/edit#gid=0";

  // Stub factory: records every injected-dep call.
  // hasReplyReturns → the persistent-dedup probe (true = already stamped → skip).
  // pushRowReturns  → simulate a sheet-write failure ({error}) for retry parity.
  function makeStubs({ recordRepliesReturns = 1, hasReplyReturns = false, pushRowReturns = { ok: true } } = {}) {
    const calls = { appendReply: [], pushRow: [], recordReplies: [], setWatermark: [], hasReply: [], writeRecent: [], getWatermark: 0, getCandidates: 0 };
    const store = {
      getReplyWatermark: async () => { calls.getWatermark++; return 0; },
      getReplyCandidateLeads: async () => { calls.getCandidates++; return rows; },
      hasReply: async (cid, acct, url, key) => { calls.hasReply.push({ cid, acct, url, key }); return hasReplyReturns; },
      recordReplies: async (cid, acct, reps) => { calls.recordReplies.push({ cid, acct, reps }); return recordRepliesReturns; },
      setReplyWatermark: async (cid, acct, wm) => { calls.setWatermark.push({ cid, acct, wm }); },
    };
    const appendReply = async (webapp, sheet, reply) => { calls.appendReply.push({ webapp, sheet, reply }); return { ok: true }; };
    const pushRow = async (webapp, sheet, url, tracking, col) => { calls.pushRow.push({ webapp, sheet, url, tracking, col }); return pushRowReturns; };
    const writeRecentMessages = async (webapp, sheet, acct, msgs) => { calls.writeRecent.push({ webapp, sheet, acct, msgs }); return { ok: true }; };
    return { calls, store, appendReply, pushRow, writeRecentMessages };
  }

  // Inbound reply: actor == the single participant → direction 'in'.
  const inboundConv = {
    threadId: "t1",
    lastActivityAt: 5000,
    participants: [{ firstName: "Jane", lastName: "Doe", profileUrl: "urn:jane" }],
    lastMessage: { text: "Sure, sounds great!", deliveredAt: 5000, actor: { firstName: "Jane", lastName: "Doe", profileUrl: "urn:jane" } },
  };

  {
    const { calls, store, appendReply, pushRow, writeRecentMessages } = makeStubs({ recordRepliesReturns: 1 });
    const getConversationsPage = async () => ({ elements: [inboundConv] });
    const r = await runReplyCheck({
      store, campaign: CAMPAIGN, account: "p1", page: {},
      sheetUrl: SHEET, linkedinColumn: "LinkedIn URL",
      getConversationsPage, appendReply, pushRow, writeRecentMessages,
    });

    eq(calls.getWatermark, 1, "runReplyCheck: reads the watermark once");
    eq(calls.getCandidates, 1, "runReplyCheck: reads candidate leads once");
    eq(calls.appendReply.length, 1, "runReplyCheck: inbound reply → appendReply called once");
    eq(calls.appendReply[0].reply.leadUrl, "https://linkedin.com/in/jane", "runReplyCheck: appendReply gets the matched lead URL");
    eq(calls.appendReply[0].reply.body, "Sure, sounds great!", "runReplyCheck: appendReply gets the full message body");
    eq(calls.appendReply[0].reply.firstName, "Jane", "runReplyCheck: appendReply gets First Name from the matched row");
    eq(calls.hasReply.length, 1, "runReplyCheck: probes hasReply before writing (retry-safe order)");
    eq(calls.pushRow.length, 1, "runReplyCheck: new reply → pushRow tracking written");
    eq(calls.recordReplies.length, 1, "runReplyCheck: recordReplies called AFTER a successful pushRow");
    eq(calls.pushRow[0].tracking.Reply, "yes", "runReplyCheck: tracking Reply='yes'");
    ok(typeof calls.pushRow[0].tracking.ReplyAt === "string" && calls.pushRow[0].tracking.ReplyAt.includes("T"), "runReplyCheck: tracking ReplyAt is an ISO timestamp");
    eq(calls.pushRow[0].tracking.ReplyPreview, "Sure, sounds great!", "runReplyCheck: tracking ReplyPreview is the body (≤100 chars)");
    eq(calls.pushRow[0].tracking.stage, "Replied", "runReplyCheck: inbound → stage 'Replied'");
    eq(calls.writeRecent.length, 1, "runReplyCheck: inbound 1:1 → Recent Messages dumped once (R4 #3)");
    eq(calls.writeRecent[0].msgs.length, 1, "runReplyCheck: one recent-message row");
    eq(calls.writeRecent[0].msgs[0].name, "Jane Doe", "runReplyCheck: recent-message carries the participant name");
    eq(calls.writeRecent[0].msgs[0].matched, true, "runReplyCheck: recent-message flagged matched");
    eq(r.recentMessages.length, 1, "runReplyCheck: returns recentMessages");
    eq(calls.setWatermark.length, 1, "runReplyCheck: watermark advanced on success");
    ok(typeof calls.setWatermark[0].wm === "number" && calls.setWatermark[0].wm >= 5000, "runReplyCheck: watermark set to startTime (a real ms timestamp)");
    eq(r.newWatermark, calls.setWatermark[0].wm, "runReplyCheck: returns newWatermark == the advanced value on success");
    eq(r.replies.length, 1, "runReplyCheck: returns the matched inbound reply");
    eq(r.replies[0].direction, "in", "runReplyCheck: reply direction 'in'");
    eq(r.errors.length, 0, "runReplyCheck: no errors on a clean sweep");
  }

  // Voyager-null → watermark NOT advanced.
  {
    const { calls, store, appendReply, pushRow } = makeStubs();
    const getConversationsPage = async () => null;
    const r = await runReplyCheck({
      store, campaign: CAMPAIGN, account: "p1", page: {},
      sheetUrl: SHEET, linkedinColumn: "LinkedIn URL",
      getConversationsPage, appendReply, pushRow,
    });
    eq(calls.setWatermark.length, 0, "runReplyCheck: Voyager null → watermark NOT advanced");
    eq(r.newWatermark, undefined, "runReplyCheck: Voyager null → newWatermark undefined");
    ok(r.errors.length >= 1 && /Voyager returned null/.test(r.errors[0]), "runReplyCheck: Voyager null → clean error surfaced");
    eq(calls.appendReply.length, 0, "runReplyCheck: Voyager null → nothing appended");
    eq(calls.pushRow.length, 0, "runReplyCheck: Voyager null → nothing written");
  }

  // Ambiguous conversation → NOT written (flagged only).
  {
    const { calls, store, appendReply, pushRow } = makeStubs();
    // Candidate set with two Jane Doe → ambiguous. Override candidates.
    store.getReplyCandidateLeads = async () => [janeRow, { id: 2, lead_url: "https://linkedin.com/in/jane2", "Linkedin URL": "https://linkedin.com/in/jane2", firstName: "Jane", lastName: "Doe" }];
    const getConversationsPage = async () => ({ elements: [inboundConv] });
    const r = await runReplyCheck({
      store, campaign: CAMPAIGN, account: "p1", page: {},
      sheetUrl: SHEET, linkedinColumn: "LinkedIn URL",
      getConversationsPage, appendReply, pushRow,
    });
    eq(calls.appendReply.length, 0, "runReplyCheck: ambiguous conv → NOT appended");
    eq(calls.pushRow.length, 0, "runReplyCheck: ambiguous conv → NOT written");
    eq(r.ambiguous.length, 1, "runReplyCheck: ambiguous conv flagged for manual review");
    eq(calls.setWatermark.length, 1, "runReplyCheck: watermark still advances after an all-ambiguous sweep (scan succeeded)");
  }

  // Dedup: hasReply → true (already stamped) → appendReply still fires, pushRow
  // + recordReplies suppressed (non-destructive, same as the app skipping on Reply='yes').
  {
    const { calls, store, appendReply, pushRow, writeRecentMessages } = makeStubs({ hasReplyReturns: true });
    const getConversationsPage = async () => ({ elements: [inboundConv] });
    await runReplyCheck({
      store, campaign: CAMPAIGN, account: "p1", page: {},
      sheetUrl: SHEET, linkedinColumn: "LinkedIn URL",
      getConversationsPage, appendReply, pushRow, writeRecentMessages,
    });
    eq(calls.appendReply.length, 1, "runReplyCheck: dedup hit → appendReply STILL called (bridge dedupes)");
    eq(calls.pushRow.length, 0, "runReplyCheck: dedup hit → tracking write SUPPRESSED (already replied, non-destructive)");
    eq(calls.recordReplies.length, 0, "runReplyCheck: dedup hit → recordReplies NOT called again");
  }

  // Retry parity: pushRow fails ({error}) → reply is NOT recorded, so it retries
  // next sweep (the app re-reads the still-empty Reply cell and retries).
  {
    const { calls, store, appendReply, pushRow, writeRecentMessages } = makeStubs({ pushRowReturns: { error: "timeout" } });
    const getConversationsPage = async () => ({ elements: [inboundConv] });
    const r = await runReplyCheck({
      store, campaign: CAMPAIGN, account: "p1", page: {},
      sheetUrl: SHEET, linkedinColumn: "LinkedIn URL",
      getConversationsPage, appendReply, pushRow, writeRecentMessages,
    });
    eq(calls.pushRow.length, 1, "runReplyCheck: write attempted");
    eq(calls.recordReplies.length, 0, "runReplyCheck: pushRow error → reply NOT recorded (so it retries next sweep)");
    ok(r.errors.length >= 1 && /writeback failed/.test(r.errors[0]), "runReplyCheck: pushRow error surfaced");
  }

  // Unmatched conversation → skipped entirely.
  {
    const { calls, store, appendReply, pushRow } = makeStubs();
    const stranger = {
      threadId: "t9", lastActivityAt: 5000,
      participants: [{ firstName: "Random", lastName: "Stranger", profileUrl: "urn:x" }],
      lastMessage: { text: "hi", deliveredAt: 5000, actor: { firstName: "Random", lastName: "Stranger", profileUrl: "urn:x" } },
    };
    const getConversationsPage = async () => ({ elements: [stranger] });
    const r = await runReplyCheck({
      store, campaign: CAMPAIGN, account: "p1", page: {},
      sheetUrl: SHEET, linkedinColumn: "LinkedIn URL",
      getConversationsPage, appendReply, pushRow,
    });
    eq(calls.appendReply.length, 0, "runReplyCheck: unmatched conv → nothing appended");
    eq(calls.pushRow.length, 0, "runReplyCheck: unmatched conv → nothing written");
    eq(r.replies.length, 0, "runReplyCheck: unmatched conv → no reply recorded");
  }

  // Watermark filter: a conversation at/below the watermark is ignored.
  {
    const { calls, store, appendReply, pushRow } = makeStubs();
    store.getReplyWatermark = async () => 9000; // newer than the conv's 5000
    const getConversationsPage = async () => ({ elements: [inboundConv] });
    const r = await runReplyCheck({
      store, campaign: CAMPAIGN, account: "p1", page: {},
      sheetUrl: SHEET, linkedinColumn: "LinkedIn URL",
      getConversationsPage, appendReply, pushRow,
    });
    eq(r.replies.length, 0, "runReplyCheck: conversation at/below watermark is filtered out");
    eq(calls.appendReply.length, 0, "runReplyCheck: below-watermark conv → nothing appended");
  }

  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log("\nAll R4 reply-check tests passed.");
})().catch((e) => { console.error(e); process.exit(1); });
