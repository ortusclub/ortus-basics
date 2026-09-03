// campaign-reply-check.js
//
// R4 — the AUTOMATIC reply-detection subsystem, ported from the desktop app's
// src/linkedin/check-dms.js (checkProfileDms bulk-inbox Voyager scan) + the
// scheduler in src/post-campaign-reply-check.js. Mirrors the app EXACTLY: the
// pure functions below are vendored BYTE-FAITHFUL from check-dms.js (only the
// `export function` → CommonJS wrapping differs), and runReplyCheck reproduces
// checkProfileDms's orchestration adapted to the engine (Postgres candidate
// leads + dedup, injected Voyager read / sheet writers, no browser lifecycle —
// the scheduler owns the session, see campaign-runtime.js handleReply).
//
// The one deliberate engine adaptation: the app's non-destructive "already
// replied?" guard reads the sheet row status back (getSheetRowStatus →
// shouldWriteReply). On the engine we do NOT read the sheet — Postgres is the
// system of record — so the guard is the PERSISTENT reply dedup instead: a
// genuinely-new campaign_replies insert (recordReplies count>0) means "this
// reply was not previously known" → write tracking; a dedup hit means "already
// stamped" → skip (exactly the app's semantics, just keyed on our DB not the
// sheet). Watermark advances ONLY on a successful scan (never on a Voyager-null
// / failure), mirroring the app's "watermark NOT advanced" contract.

// ── Pure functions (vendored byte-faithful from app check-dms.js:97-176) ──────

/**
 * Normalize a name fragment for matching (lowercase, trim, collapse whitespace).
 */
function normName(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Match a normalized conversation (1 participant) against a set of sheet rows.
 * Caller is responsible for pre-filtering rows to the running profile's scope
 * (Message='sent' AND Account Used = profileId).
 *
 * Returns one of:
 *   { match: row }                            — exact single match
 *   { match: null, reason: 'unmatched' }      — no row matched
 *   { match: null, reason: 'ambiguous', candidates: [rows] }  — >1 row matched
 */
function matchConversationToSheet(conv, candidateRows) {
  // Accept either { participant: {...} } (simple test shape) or
  // { participants: [{...}] } (normalized production shape).
  const participant = conv?.participant
    ?? (Array.isArray(conv?.participants) ? conv.participants[0] : null);
  if (!participant) return { match: null, reason: "unmatched" };

  const convFirst = normName(participant.firstName);
  const convLast = normName(participant.lastName);
  const convFull = `${convFirst} ${convLast}`.trim();

  const matches = (candidateRows || []).filter((r) => {
    const rowFull = `${normName(r.firstName || r["First Name"])} ${normName(r.lastName || r["Last Name"])}`.trim();
    return rowFull === convFull && convFull !== "";
  });

  if (matches.length === 0) return { match: null, reason: "unmatched" };
  if (matches.length > 1) return { match: null, reason: "ambiguous", candidates: matches };
  return { match: matches[0] };
}

/**
 * Non-destructive predicate: returns false if the row's Reply column already
 * contains "yes" (preserves manual edits). True when empty / missing / null.
 */
function shouldWriteReply(currentStatus, _newReply) {
  if (!currentStatus) return true;
  const v = String(currentStatus.Reply || "").toLowerCase().trim();
  return v !== "yes";
}

/**
 * Pagination driver. Iterates pages from pageFactory, short-circuits as soon
 * as a page's oldest message is at-or-older than the watermark.
 *
 * pageFactory: async ({start, count}) => {elements: [...], paging?: {total}, metadata?}
 * watermark:   ms timestamp; only conversations with lastActivityAt > watermark return
 */
async function fetchNewConversations(pageFactory, watermark) {
  const result = [];
  let start = 0;
  const count = 20;
  // Hard safety cap to avoid runaway loops if schema drifts
  const MAX_PAGES = 10;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const batch = await pageFactory({ start, count });
    if (!batch || !Array.isArray(batch.elements) || batch.elements.length === 0) break;
    for (const el of batch.elements) {
      if ((el.lastActivityAt || 0) > watermark) result.push(el);
    }
    const oldest = batch.elements.reduce(
      (min, e) => Math.min(min, e.lastActivityAt || 0),
      Number.POSITIVE_INFINITY
    );
    if (oldest <= watermark) break;
    const paging = batch.paging;
    if (paging && typeof paging.total === "number" && start + count >= paging.total) break;
    start += count;
  }
  return result;
}

// ── Orchestrator (mirrors checkProfileDms — check-dms.js:212-434) ─────────────

/**
 * Run one automatic reply scan for a (campaign, account). Engine-adapted mirror
 * of checkProfileDms: the browser `page` is opened+reaped by the scheduler, the
 * Voyager read (getConversationsPage) + sheet writers (appendReply / pushRow)
 * are INJECTED so the whole thing is testable with stubs. candidateRows come
 * from Postgres (store.getReplyCandidateLeads), not the sheet.
 *
 * @returns {
 *   replies:  [{ match, conversation, snippet, leadUrl, inbound, ... }...],
 *   ambiguous:[{ conv, candidates, inbound, name, snippet, timestamp }...],
 *   errors:   [string...],
 *   newWatermark?: number,   // undefined on failure → watermark NOT advanced
 *   newReplies: number,      // genuinely-new replies recorded this sweep
 * }
 */
async function runReplyCheck({
  store, campaign, account, page,
  sheetUrl, webappUrl, linkedinColumn,
  getConversationsPage, appendReply, pushRow, writeRecentMessages,
  log = () => {},
}) {
  const startTime = Date.now();
  const replies = [];
  const ambiguous = [];
  const errors = [];
  const recentMessages = [];

  const wm = await store.getReplyWatermark(campaign.id, account);
  const watermark = Number.isFinite(wm) ? wm : 0;
  const resolvedWebapp = webappUrl || (campaign.config && campaign.config.sheetsWebappUrl) || "";

  // Navigate to LinkedIn's messaging inbox so the messengerConversations XHR
  // fires (getConversationsPage scrapes its URL from performance entries). Every
  // puppeteer call is guarded with `typeof === 'function'` so plain stub pages in
  // tests don't crash — identical to the app (check-dms.js:243-279).
  if (page && typeof page.goto === "function") {
    try {
      await page.goto("https://www.linkedin.com/messaging/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    } catch (e) {
      return { replies, ambiguous, errors: [`navigation to /messaging/ failed: ${e.message}`], newReplies: 0 };
    }
    if (typeof page.waitForFunction === "function") {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        if (typeof page.evaluate === "function") {
          await page.evaluate(() => {
            const list = document.querySelector(
              ".msg-conversations-container__conversations-list, " +
              'ul[class*="conversations-list"], .scaffold-layout__list-detail, .scaffold-layout__list'
            );
            if (list) {
              list.scrollTop = list.scrollHeight;
              list.dispatchEvent(new Event("scroll", { bubbles: true }));
            }
            window.scrollTo(0, document.body.scrollHeight);
          });
        }
      } catch { /* best-effort nudge */ }
      try {
        await page.waitForFunction(
          () => performance.getEntriesByType("resource")
            .some((e) => typeof e.name === "string" && e.name.includes("queryId=messengerConversations")),
          { timeout: 20000 },
        );
      } catch { /* fall through — getConversationsPage returns null and we surface a clean error */ }
    }
  }

  // Fetch the first page directly (avoids double-fetch). If it isn't enough,
  // fetchNewConversations paginates from start=20 with the same factory.
  let first;
  try {
    first = await getConversationsPage(page, { start: 0, count: 20 });
  } catch (e) {
    return { replies, ambiguous, errors: [`getConversationsPage threw: ${e.message}`], newReplies: 0 };
  }

  if (first === null || first === undefined) {
    return { replies, ambiguous, errors: ["Voyager returned null — scan failed; watermark NOT advanced"], newReplies: 0 };
  }

  // Filter first page for new-only.
  const convs = [];
  for (const el of first.elements || []) {
    if ((el.lastActivityAt || 0) > watermark) convs.push(el);
  }

  // If the first page may not have reached the watermark, keep paginating.
  const firstOldest = (first.elements || []).reduce(
    (min, e) => Math.min(min, e.lastActivityAt || 0),
    Number.POSITIVE_INFINITY,
  );
  const paging = first.paging;
  const maybeMore = firstOldest > watermark &&
    (!paging || !paging.total || 20 < paging.total);
  if (maybeMore && (first.elements || []).length >= 20) {
    // Continue from start=20; fetchNewConversations handles stop-on-old + MAX_PAGES.
    const extra = await fetchNewConversations(
      async ({ start, count }) => getConversationsPage(page, { start: start + 20, count }),
      watermark,
    );
    convs.push(...extra);
  }

  const candidateRows = await store.getReplyCandidateLeads(campaign.id, account);

  let newReplies = 0;
  for (const conv of convs) {
    const lastMessage = conv.lastMessage || null;
    // Did the LEAD send the last message (inbound reply) or did we?
    const _leadP = (Array.isArray(conv.participants) && conv.participants[0]) || null;
    let _inbound = false;
    if (lastMessage) {
      const _actor = lastMessage.actor || {};
      const _sameUrl = _leadP?.profileUrl && _actor?.profileUrl && _leadP.profileUrl === _actor.profileUrl;
      const _sameName = _leadP?.firstName && _actor?.firstName
        && normName(_leadP.firstName) === normName(_actor.firstName)
        && normName(_leadP.lastName || "") === normName(_actor.lastName || "");
      _inbound = !!(_sameUrl || _sameName);
    }
    const _convName = [_leadP?.firstName, _leadP?.lastName].filter(Boolean).join(" ").trim();
    const match = matchConversationToSheet(conv, candidateRows);

    // R4 #3 — Recent Messages sidecar dump: inbound replies in 1:1 threads only
    // (participants holds just the other person; >1 = group → skip), last message
    // only. Captured regardless of whether it matched a lead (mirrors app
    // check-dms.js:342-351).
    const _participantCount = Array.isArray(conv.participants) ? conv.participants.length : 1;
    if (_inbound && _participantCount === 1 && lastMessage) {
      recentMessages.push({
        account,
        name: _convName,
        lastMessage: lastMessage.text || "",
        receivedAt: lastMessage.deliveredAt ? new Date(lastMessage.deliveredAt).toISOString() : "",
        matched: !!(match && match.match),
      });
    }

    if (match.reason === "ambiguous") {
      // Same-name leads → can't attribute uniquely. Flag as a suspected reply for
      // manual review instead of stamping the wrong campaign row.
      ambiguous.push({
        conv, candidates: match.candidates,
        inbound: _inbound, name: _convName,
        snippet: lastMessage?.text || "",
        timestamp: lastMessage?.deliveredAt || conv.lastActivityAt,
      });
      continue;
    }
    if (match.reason === "unmatched") continue;

    const linkedinUrl = match.match["Linkedin URL"] || match.match[linkedinColumn] || "";
    if (lastMessage && linkedinUrl) {
      try {
        // Detect direction. The conversation has one participant (the lead). If
        // lastMessage.actor matches that participant, the lead replied (inbound).
        // Otherwise the bot/operator sent it (outbound).
        const leadParticipant = _leadP;
        const actor = lastMessage.actor || {};
        const sameProfileUrl = leadParticipant?.profileUrl && actor?.profileUrl
          && leadParticipant.profileUrl === actor.profileUrl;
        const sameName = leadParticipant?.firstName && actor?.firstName
          && normName(leadParticipant.firstName) === normName(actor.firstName)
          && normName(leadParticipant.lastName || "") === normName(actor.lastName || "");
        const direction = (sameProfileUrl || sameName) ? "in" : "out";
        const senderName = [actor.firstName, actor.lastName].filter(Boolean).join(" ").trim()
          || (direction === "in" ? "lead" : (account || "unknown"));
        const tsIso = new Date(lastMessage.deliveredAt || startTime).toISOString();
        const bodyText = String(lastMessage.text || "");
        const firstName = match.match.firstName || match.match["First Name"] || "";
        const lastName = match.match.lastName || match.match["Last Name"] || "";

        // Append the full message body to the Replies tab. Bridge dedupes so it's
        // safe to call repeatedly (mirrors the app — appended regardless of the
        // tracking-write guard below).
        await appendReply(resolvedWebapp, sheetUrl, {
          leadUrl: linkedinUrl,
          timestamp: tsIso,
          firstName,
          lastName,
          body: bodyText,
        });

        // Non-destructive guard via PERSISTENT dedup (Postgres is the record) —
        // replaces the app's getSheetRowStatus read. Order matters for retry
        // parity: probe first, WRITE the stamp, then RECORD only if the write
        // succeeded. A failed sheet write leaves the reply un-recorded so it
        // retries next sweep — exactly what the app gets by re-reading the still-
        // empty Reply cell. (Previously we recorded before the write, so a failed
        // stamp was never retried.)
        const known = await store.hasReply(campaign.id, account, linkedinUrl, bodyText);
        if (!known) {
          const tracking = {
            Reply: "yes",
            ReplyAt: tsIso,
            ReplyPreview: bodyText.slice(0, 100),
          };
          // Bump Pipeline Stage to 'Replied' when the lead replied (direction 'in').
          if (direction === "in") {
            tracking.stage = "Replied";
          }
          const r = await pushRow(resolvedWebapp, sheetUrl, linkedinUrl, tracking, linkedinColumn);
          if (r && r.error) {
            errors.push(`writeback failed for ${linkedinUrl}: ${r.error}`);
            // do NOT record → un-stamped reply retries on the next sweep
          } else {
            newReplies += await store.recordReplies(campaign.id, account, [{
              leadUrl: linkedinUrl, direction, sender: senderName, body: bodyText, ts: tsIso,
            }]);
          }
        }

        replies.push({
          match: match.match,
          conversation: conv,
          snippet: lastMessage?.text || "",
          threadId: conv.threadId,
          timestamp: lastMessage?.deliveredAt || conv.lastActivityAt,
          inbound: _inbound,
          leadUrl: linkedinUrl,
          name: _convName,
          direction,
        });
      } catch (e) {
        errors.push(`writeback failed for ${linkedinUrl}: ${e.message}`);
      }
    }
  }

  // R4 #3 — dump this sweep's inbound 1:1 replies to the "Recent Messages" tab
  // (mirrors app post-campaign-reply-check → writeRecentMessagesTab). Best-effort;
  // injected so tests stub it. No-op when the writer isn't wired or nothing to write.
  if (recentMessages.length && typeof writeRecentMessages === "function") {
    try { await writeRecentMessages(resolvedWebapp, sheetUrl, account, recentMessages); }
    catch (e) { errors.push(`writeRecentMessages failed: ${e.message}`); }
  }

  // SUCCESS → advance the watermark (only advances, GREATEST-guarded in the
  // store). Never reached on a failure/Voyager-null return above → the app's
  // "watermark NOT advanced" contract.
  try {
    await store.setReplyWatermark(campaign.id, account, startTime);
  } catch (e) {
    errors.push(`setReplyWatermark failed: ${e.message}`);
  }

  return { replies, ambiguous, errors, recentMessages, newWatermark: startTime, newReplies };
}

module.exports = {
  normName,
  matchConversationToSheet,
  shouldWriteReply,
  fetchNewConversations,
  runReplyCheck,
};
