// campaign-followergrowth.js
//
// Phase G — Follower Growth (follower_growth) on Postgres/Redis. Unlike the
// per-lead modes, this is a BATCH mode: one "Invite to follow" modal session
// per account invites many people at once, capped by two budgets —
//   1. the account's MONTHLY engine budget (config.monthlyBudget, default 30,
//      counted from the leads table via store.invitedCountForMonth), and
//   2. LinkedIn's own credit counter read live from the modal (the vendored
//      runFollowerInvites already stops at creditsBefore).
//
// The browser primitive (campaign-lib/linkedin/follower-invite.js) is vendored
// byte-identical from the app and INJECTABLE here (`sendInvites`), so tests run
// with no browser. Orchestration (claiming, budgets, stamping) is ours.
//
// Outcome contract (mirrors the app's FG sheet semantics):
//   invited      → status 'sent', stage 'Invited', anti-dupe marker kind 'invite'
//   skipped      → status 'skipped' (couldn't be matched in the modal picker)
//   sent=false   → the Invite button was never clicked ⇒ NOTHING was sent —
//                  every claimed lead is released back to pending for a retry.

async function defaultSendInvites({ page, inviteUrl, queued, log, onProgress }) {
  const mod = await import("./campaign-lib/linkedin/follower-invite.js");
  return mod.runFollowerInvites({ page, inviteUrl, queued, log, onProgress });
}

// Run one Follower Growth batch for (campaign, account). `onProgress` (optional)
// is forwarded to the modal driver so the caller gets a per-person selection
// tick during the batch — purely cosmetic, never gates the send.
async function runFollowerGrowth({
  store, campaign, account, page, inviteUrl,
  config = {}, month, sendInvites, log = () => {}, onProgress,
}) {
  const result = {
    claimed: 0, invited: 0, skipped: 0, alreadyFollowing: 0, released: 0,
    creditsBefore: null, creditsAfter: null, allowance: null, refill: "",
    budgetRemaining: null, reason: "", loggedOut: false,
  };

  // ── Budget gate 1: monthly engine budget (durable, restart-proof) ──────────
  const monthlyBudget = Number(config.monthlyBudget ?? 30);
  const used = await store.invitedCountForMonth(account, month);
  let remaining = Math.max(0, monthlyBudget - used);
  result.budgetRemaining = remaining;
  if (!remaining) {
    result.reason = "monthly budget used up — no invites remaining this month";
    log(`[FG] ${account}: ${result.reason} (${used}/${monthlyBudget})`);
    return result;
  }
  if (config.batchCap) remaining = Math.min(remaining, Number(config.batchCap));

  // ── Claim up to `remaining` pending leads; anti-dupe check per lead ────────
  const claimed = [];
  while (claimed.length < remaining) {
    const lead = await store.claimNextLead(campaign.id, account);
    if (!lead) break;
    if (await store.wasActionSent(campaign.id, lead.lead_url, "invite")) {
      await store.markLead(lead.id, "skipped", { error: "already invited (anti-dupe)" });
      result.skipped++;
      continue;
    }
    claimed.push(lead);
  }
  result.claimed = claimed.length;
  if (!claimed.length) {
    if (!result.reason) result.reason = result.skipped ? "all claimable leads already invited" : "no pending leads";
    return result;
  }

  // queued rows in the shape the modal picker needs; memberId = lead.id so the
  // primitive's invited/skipped echo maps back to OUR rows unambiguously.
  const byId = new Map(claimed.map((l) => [String(l.id), l]));
  const queued = claimed.map((l) => ({
    name: l.full_name || `${l.first_name || ""} ${l.last_name || ""}`.trim(),
    jobTitle: l.title || "",
    company: l.company || "",
    memberId: String(l.id),
  }));

  // ── The batch send (vendored modal driver unless injected) ─────────────────
  // A thrown modal error (logged out, or the modal never opened) must NOT strand
  // the leads we already claimed above — release them all so a later sweep or
  // another account retries them, and surface the reason. loggedOut is flagged
  // distinctly so the caller can label the account "needs re-login" (mirrors app).
  const send = sendInvites || defaultSendInvites;
  let out;
  try {
    out = await send({ page, inviteUrl, queued, log, onProgress });
  } catch (e) {
    for (const l of claimed) { await store.releaseLeadToPending(l.id); result.released++; }
    result.loggedOut = !!e.loggedOut;
    result.reason = e.loggedOut ? "logged out — needs re-login" : (e.message || "invite modal error");
    log(`[FG] ${account}: ${result.reason} (released ${result.released})`);
    return result;
  }
  result.creditsBefore = out.creditsBefore ?? null;
  result.creditsAfter = out.creditsAfter ?? null;
  result.allowance = out.allowance ?? null;
  result.refill = out.refill || "";

  // ── Stamp outcomes ──────────────────────────────────────────────────────────
  if (!out.sent) {
    // Invite button never clicked ⇒ nothing actually went out. Release ALL
    // claimed leads so a later sweep (or another account) retries them.
    for (const l of claimed) { await store.releaseLeadToPending(l.id); result.released++; }
    result.reason = out.creditsBefore === 0
      ? "no invite credits available on this account"
      : "invite send not confirmed — leads released for retry";
    log(`[FG] ${account}: ${result.reason} (released ${result.released})`);
    return result;
  }

  const invitedSet = new Set((out.invited || []).map(String));
  const skippedSet = new Set((out.skipped || []).map(String));
  const alreadySet = new Set((out.alreadyFollowing || []).map(String));
  for (const l of claimed) {
    const id = String(l.id);
    if (invitedSet.has(id)) {
      await store.markLead(l.id, "sent", { stage: "Invited" });
      await store.markActionSent(campaign.id, l.lead_url, "invite");
      result.invited++;
    } else if (skippedSet.has(id)) {
      if (alreadySet.has(id)) {
        // Already-follows: remember it with the anti-dupe marker so it never
        // re-fills a slot and is never re-tried — it costs no credit (mirrors app).
        await store.markLead(l.id, "skipped", { error: "already follows the page" });
        await store.markActionSent(campaign.id, l.lead_url, "invite");
        result.alreadyFollowing++;
      } else {
        await store.markLead(l.id, "skipped", { error: "no unambiguous match in invite modal" });
      }
      result.skipped++;
    } else {
      // claimed but never processed (abort mid-batch) → back to the queue
      await store.releaseLeadToPending(l.id);
      result.released++;
    }
  }
  log(`[FG] ${account}: invited ${result.invited}, skipped ${result.skipped} (already-follows ${result.alreadyFollowing}), released ${result.released}, credits ${result.creditsBefore}→${result.creditsAfter}`);
  return result;
}

module.exports = { runFollowerGrowth };
