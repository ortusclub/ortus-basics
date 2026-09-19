// campaign-autointro.js
//
// Phase D — CC+IC follow-up firing (the engine reimplementation of the app's
// runAutoIntros orchestration). Called by the monitoring engine when an
// acceptance is detected: fires the 3-way intro from the sending account.
//
// Reuses, doesn't duplicate:
//   • primary-connection state → Postgres campaign_primary_conn (Phase B), not
//     the app's in-memory campaign._primaryConn map.
//   • the actual page work (read degree, send intro, read identity) → INJECTABLE
//     primitives (default: the vendored browser fns) so tests run with no browser.
//   • accept / follow-up scheduling → campaign_tasks with dedupe (Phase B).
//
// Pure decision helpers below are ported verbatim from the app's auto-intro.js
// to preserve its hold/stamp/failure semantics.

const { introTokenData } = require("./campaign-personalization");

let _primConn = null, _helpers = null, _introConst = null, _actions = null;
async function vendored() {
  if (!_primConn)   _primConn  = await import("./campaign-lib/linkedin/primary-connection.js");
  if (!_helpers)    _helpers   = await import("./campaign-lib/linkedin/helpers.js");
  if (!_introConst) _introConst = await import("./campaign-lib/linkedin/intro-constants.js");
  // actions.js holds the two intro-send browser fns. Pull them by name (not a
  // full spread) so actions.js's large export surface can't shadow a helper/
  // constant above. Without these, the default (non-injected) send path throws
  // "v.sendIntroViaCleanCompose is not a function" and NO intro ever fires.
  if (!_actions)    _actions   = await import("./campaign-lib/linkedin/actions.js");
  return {
    ..._primConn, ..._helpers, ..._introConst,
    sendIntroViaCleanCompose: _actions.sendIntroViaCleanCompose,
    sendIntroMessage: _actions.sendIntroMessage,
  };
}

// Adapter — the vendored browser intro fns THROW on failure and return no
// {success} contract, but the send loop wants { success, threadUrl, error } so
// it can retry with photo disambiguation and queue the follow-up. This wraps
// them:
//   • lead has a full name → 3-way GROUP via clean-compose (the exact path the
//     app uses, auto-intro.js:722-726). On a same-name ambiguity clean-compose
//     throws IC_INTRO_AMBIGUOUS_RECIPIENT; the loop captures the intended
//     person's profile photo(s) and RETRIES with the avatar tokens so the
//     typeahead picks by picture (never message the wrong person).
//   • no full name → URL-routed sendIntroMessage fallback (auto-intro.js:732).
//   • on success, capture page.url() as the real thread URL (compose redirects
//     to /messaging/thread/…, auto-intro.js:830-832) — was hardcoded "" (#8),
//     which left the follow-up task with no thread to post into.
// Correct signatures (mirror app auto-intro.js):
//   sendIntroViaCleanCompose(page, body, leadFullName, primaryName, groupTitle, opts)
//   sendIntroMessage(page, body, introName, groupTitle, secondRecipientUrl, leadUrl)
function _vendoredSend(v) {
  return async (a) => {
    try {
      if (a.leadFullName) {
        await v.sendIntroViaCleanCompose(a.page, a.body, a.leadFullName, a.primaryName, a.title, {
          dedupeProbe: true,
          leadAvatarToken: a.leadAvatarToken || "",
          primaryAvatarToken: a.primaryAvatarToken || "",
        });
      } else {
        await v.sendIntroMessage(a.page, a.body, a.primaryName, a.title, "", a.leadUrl);
      }
      let threadUrl = "";
      try { threadUrl = a.page.url(); } catch { /* page gone — leave blank */ }
      return { success: true, threadUrl };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) };
    }
  };
}

// ── ported pure helpers (verbatim from app auto-intro.js) ────────────────────
function _shouldHoldIntros(r) { return !!r && r.connected === false; }
function _shouldQueueAutoAccept({ autoAcceptPrimary, connectAttempted } = {}) {
  return !!autoAcceptPrimary && !!connectAttempted;
}
function isLinkedInProfileUrl(url) { return /linkedin\.com\/in\/[^/?#\s]+/i.test((url || "").toString()); }
function introConnectionStamp(ok) {
  return ok ? { connectionAcceptedStatus: "Connected", stage: "Connected", connectedAlready: true } : {};
}

// Ported verbatim from app auto-intro.js:230-237 — the "Jul 12th, 14:07" stamp
// used in the reverify downgrade label.
function _formatLocalDate(d) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = d.getDate();
  const ord = (n) => (n % 10 === 1 && n % 100 !== 11) ? "st"
    : (n % 10 === 2 && n % 100 !== 12) ? "nd"
    : (n % 10 === 3 && n % 100 !== 13) ? "rd" : "th";
  return `${months[d.getMonth()]} ${day}${ord}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Pure reverify decision — ported verbatim from app auto-intro.js:245-259. Given
// getConnectionStatus(page) and the row's current CC, decide whether to downgrade.
// STRICT: only clear-negative signals ('connect'/'pending') downgrade; a flaky
// 'message'/'follow'/'unknown'/'error' read never clobbers a real connection.
function _decideReverifyAction(connectionStatus, currentCc) {
  if (currentCc !== "Connected") return { action: "noop", reason: "cc-not-connected" };
  if (connectionStatus === "connect" || connectionStatus === "pending") return { action: "downgrade" };
  if (connectionStatus === "message") return { action: "noop", reason: "genuine-1st-degree" };
  if (connectionStatus === "follow") return { action: "noop", reason: "follow-only-restricted" };
  return { action: "noop", reason: "ambiguous" };
}

// True when the puppeteer page is dead — browser killed, websocket dropped, or
// tab closed. Ported verbatim from app auto-intro.js:565-572 (page.isClosed() is
// flaky alone → pair with browser.connected). Used to reclassify a mid-send
// failure as "Skipped" (never got a fair attempt) rather than a bogus "Failed".
function _browserAlive(page) {
  try {
    const b = page && page.browser && page.browser();
    if (!b || b.connected === false) return false;
    if (page.isClosed && page.isClosed()) return false;
    return true;
  } catch { return false; }
}
// Full failure-string map — ported VERBATIM from app auto-intro.js:313-364
// (was a 6-pattern truncation → audit #20). Order matters: more-specific first.
// `introFailedPrimaryNotConnected` is the vendored INTRO_FAILED_PRIMARY_NOT_
// CONNECTED constant (the app imports it; the engine passes it in).
function _friendlyIntroFailure(errMsg, introFailedPrimaryNotConnected) {
  const m = errMsg || "";
  if (m.includes("MESSAGE_SEND_FAILED: compose textbox did not appear")) return "Failed — Compose page didn't load";
  if (m.includes("INTRO_RECIPIENT_NOT_FOUND: recipient-not-in-results")) {
    if (/\d+ suggestions but no match/.test(m)) return "Failed — Primary name didn't match suggestions";
    return introFailedPrimaryNotConnected;
  }
  if (m.includes("INTRO_RECIPIENT_NOT_FOUND: recipient-input-not-found")) return "Failed — Compose page missing recipient field";
  if (m.includes("INTRO_RECIPIENT_NOT_FOUND: recipient-pill-not-confirmed")) return "Failed — Primary clicked but not added";
  if (m.includes("INTRO_DROPDOWN_HANG")) return "Failed — Compose page froze";
  if (m.includes("MESSAGE_SEND_FAILED: not on a profile page")) return "Failed — Invalid lead URL";
  if (m.includes("MESSAGE_SEND_FAILED: could not type")) return "Failed — Couldn't type message";
  if (m.includes("MESSAGE_SEND_FAILED: composer not focusable")) return "Failed — Message body not focusable";
  if (m.includes("MESSAGE_SEND_FAILED: send not confirmed")) return "Failed — Send not confirmed";
  if (m.includes("MESSAGE_SEND_FAILED: introName required")) return "Failed — Primary name missing in template";
  // Same-name guard: 2+ people share the name and no profile photo confidently
  // matched the intended person — SKIPPED rather than message a stranger.
  if (m.includes("IC_INTRO_AMBIGUOUS_RECIPIENT")) return "Skipped — multiple same-name matches, verify manually";
  if (m.includes("IC_INTRO_RECIPIENT_NOT_FOUND")) return "Failed — Lead or primary not in your connections";
  if (m.includes("IC_INTRO_FAILED")) return "Failed — Group compose didn't load";
  const trunc = m.length > 60 ? m.slice(0, 57) + "…" : m;
  return `Failed — ${trunc || "unknown"}`;
}

// Capture a person's REAL profile-photo token (licdn media-id) from their /in/
// page, to disambiguate same-name people in the clean-compose typeahead. Ported
// VERBATIM from app auto-intro.js:168-193 (self-contained page.goto + evaluate;
// actions.js/helpers are already vendored byte-identical). Navigates the page;
// the caller re-opens compose on retry. Returns '' on any failure → caller then
// skips rather than guess. Called only on a same-name ambiguity.
async function _captureProfileAvatarToken(page, profileUrl, fullName) {
  try {
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    return await page.evaluate((wantName) => {
      const tok = (s) => (String(s || "").match(/image\/v2\/([^\/]+)\//) || [])[1] || "";
      const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
      const want = norm(wantName);
      const parts = want.split(" ").filter(Boolean);
      const first = parts[0] || "", last = parts[parts.length - 1] || "";
      const imgs = Array.from(document.querySelectorAll("img")).filter((im) => /displayphoto/i.test(im.getAttribute("src") || ""));
      const named = imgs.find((im) => {
        const alt = norm(im.getAttribute("alt") || "");
        return alt && (alt === want || (first && last && alt.includes(first) && alt.includes(last)));
      });
      if (named) return tok(named.getAttribute("src"));
      const tc = document.querySelector(
        'img.pv-top-card-profile-picture__image, .pv-top-card__photo img, button[aria-label*="profile photo" i] img'
      );
      return tc ? tok(tc.getAttribute("src")) : "";
    }, fullName);
  } catch {
    return "";
  }
}

// Thin wrapper over the shared token builder (campaign-personalization.js) so
// the intro path and the DM path can never drift. Spreads the source-sheet row
// (row_data) so every column — {company}/{title}/custom {Event} etc. — resolves,
// exactly like the app's auto-intro.js data map. Signature preserved for the
// existing test-personalization-data.js.
function personalizationData(lead, primaryName, primaryUrl, senderFirst) {
  return introTokenData(lead, { primaryName, primaryUrl, senderFirst });
}

// Fire intros for the newly-accepted leads of (campaign, account).
// Injectable: checkPrimary, sendIntro, readSelf, captureAvatar (default to
// vendored browser fns).
async function runAutoIntros({ store, campaign, account, page, connectedUrls, templates = {}, checkPrimary, sendIntro, readSelf, captureAvatar, getConnStatus, now = Date.now() }) {
  const v = await vendored();
  const result = { sent: 0, failed: 0, skipped: 0, held: 0 };
  if (!Array.isArray(connectedUrls) || !connectedUrls.length) return result;

  const primaryName = (templates.primaryName || "").trim();
  const primaryBody = (templates.primaryIntroBody || "").trim();
  const primaryUrl  = (templates.primaryUrl || "").trim();
  if (!primaryName || !primaryBody) { result.skipped = connectedUrls.length; return result; } // misconfigured → skip (don't stamp)

  // ── primary-connection gate (CC+IC) ──
  if (primaryUrl && isLinkedInProfileUrl(primaryUrl) && account && account !== "local-browser") {
    const prev = await store.getPrimaryConn(campaign.id, account);
    if (!prev || prev.state !== "connected") {
      try {
        const _check = checkPrimary || ((pg, url, opts) => v.checkAndConnectPrimary(pg, url, opts));
        const res = await _check(page, primaryUrl, {
          attemptConnect: !prev || prev.state === "no_url" || prev.state === "unverified",
        });
        await store.setPrimaryConn(campaign.id, account, v.primaryConnState(res.connected), { primaryUrl });

        if (_shouldQueueAutoAccept({ autoAcceptPrimary: templates.autoAcceptPrimary, connectAttempted: res.connectAttempted })) {
          const _readSelf = readSelf || ((pg) => v.readSelfIdentity(pg));
          const self = await _readSelf(page).catch(() => ({}));
          if (self && (self.name || self.profileUrl)) {
            await store.createTask({
              campaignId: campaign.id, type: "accept", dedupeKey: `accept:${account}`,
              payload: { account: self, primaryUrl, sender: templates.primarySource, profileId: account },
            });
          }
        }
        if (_shouldHoldIntros(res)) { result.held = connectedUrls.length; return result; } // leave intro blank → retried next sweep
      } catch (_) { /* gate error must never block intros — fall through */ }
    }
  }

  // ── send loop ──
  const leads = await store.getCampaignLeads(campaign.id);
  const byUrl = new Map(leads.map((l) => [l.lead_url, l]));
  const introTitle = templates.introTitle || "Introduction: {firstName} <> {primaryFirstName}";
  const senderFirst = (templates.senderFirstNames || {})[account] || "";
  const _send = sendIntro || _vendoredSend(v);
  const _capture = captureAvatar || _captureProfileAvatarToken;
  const _connStatus = getConnStatus || ((pg) => v.getConnectionStatus(pg));
  // One primary per campaign, so its profile-photo token is captured at most once
  // and reused across every same-name retry in this sweep — mirrors the app's
  // campaign._primaryAvatarToken cache (auto-intro.js:714), scoped to the sweep.
  let primaryAvatarToken = "";

  // Stamp the not-yet-attempted remainder as "Skipped — <reason>" when the
  // browser dies mid-sweep, so the operator can tell an interrupted lead from a
  // real LinkedIn-side failure. Mirrors app auto-intro.js:549-560 (_stampSkipped),
  // but guarded so it never clobbers a lead already terminal from a prior sweep.
  async function _stampSkipped(urls, reason) {
    for (const u of urls) {
      const l = byUrl.get(u);
      if (!l || !v.isIntroSlotOpen(l.introduction_status)) continue;
      await store.updateLeadOutcome(l.id, { introductionStatus: `Skipped — ${reason}` }).catch(() => {});
      result.skipped++;
    }
  }

  for (let i = 0; i < connectedUrls.length; i++) {
    const url = connectedUrls[i];
    // Pre-send checkpoint — if the browser/session died, don't hammer a dead page
    // (every send fast-fails "compose textbox did not appear" → bogus Failed
    // cascade). Stamp the rest Skipped and bail. Mirrors app auto-intro.js:593-597.
    if (!_browserAlive(page)) {
      await _stampSkipped(connectedUrls.slice(i), "browser closed");
      break;
    }
    const lead = byUrl.get(url);
    if (!lead) { result.skipped++; continue; }
    if (!v.isIntroSlotOpen(lead.introduction_status)) { result.skipped++; continue; } // terminal/one-shot guard
    if (await store.wasActionSent(campaign.id, url, "intro")) { result.skipped++; continue; }

    const data = personalizationData(lead, primaryName, primaryUrl, senderFirst);
    const body = v.personalizeTemplate(primaryBody, data);
    const title = v.personalizeTemplate(introTitle, data);
    const leadFullName = data["full name"];

    // ── retry loop — mirrors app auto-intro.js:699-767 ──
    let attempt = 0, ok = false, alreadyMade = false, errMsg = "", threadUrl = "";
    let leadAvatarToken = "";
    while (attempt < 2) {
      attempt++;
      let res;
      try {
        res = await _send({
          page, leadUrl: url, body, leadFullName, primaryName, primaryUrl, title,
          leadAvatarToken, primaryAvatarToken,
          hasConnectionNote: !!(templates.connectionNote || "").trim(),
        });
      } catch (e) {
        // an injected/vendored send that THROWS instead of returning the contract
        res = { success: false, error: e && e.message ? e.message : String(e) };
      }
      if (res && res.success) { ok = true; threadUrl = res.threadUrl || ""; break; }
      errMsg = (res && res.error) || "send failed";
      // Existing-thread redirect (URL-routing path) → already introduced (#5).
      if (errMsg.includes("INTRO_ALREADY_EXISTS")) { alreadyMade = true; break; }
      // Same-name ambiguity: resolve the intended person's REAL profile photo(s)
      // and retry once so the typeahead picks by picture. If no reference photo
      // can be captured, fall through → skip (never message the wrong person).
      if (attempt < 2 && errMsg.includes("IC_INTRO_AMBIGUOUS_RECIPIENT")) {
        if (!leadAvatarToken && leadFullName) leadAvatarToken = await _capture(page, url, leadFullName).catch(() => "");
        if (!primaryAvatarToken && primaryUrl) primaryAvatarToken = await _capture(page, primaryUrl, primaryName).catch(() => "");
        if (leadAvatarToken || primaryAvatarToken) continue;
        break; // no reference photo available → skip-on-doubt
      }
      // Typeahead miss → retry once after a short settle.
      if (attempt < 2 && (errMsg.includes("INTRO_RECIPIENT_NOT_FOUND") || errMsg.includes("IC_INTRO_RECIPIENT_NOT_FOUND"))) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      break;
    }

    // ── stamp — mirrors app auto-intro.js:774-877 ──
    if (ok || alreadyMade) {
      await store.updateLeadOutcome(lead.id, {
        introductionStatus: alreadyMade ? "Introduction Already Made" : "Introduction Made",
        threadUrl, ...introConnectionStamp(true), // a made/already-made intro proves the connection
      });
      await store.markActionSent(campaign.id, url, "intro"); // durable blacklist (= app introducedInRun)
      // Follow-up only on a FRESH send (app queues it under `if (ok)`, not on
      // alreadyMade — an existing thread already has whatever follow-up it needs).
      if (ok && templates.followUpEnabled && (templates.followUpBody || "").trim()) {
        const delayMs = Math.max(0, (templates.followUpDelayMinutes || 0) * 60000);
        // Carry the intro's captured thread URL verbatim — mirrors app
        // auto-intro.js:832 (page.url() after the compose redirects to the real
        // /messaging/thread/<id>/). If the VM hasn't redirected by capture time
        // it stays "/thread/new/?…"; the send side's isUsableThreadUrl rejects
        // that and falls back to searching Messaging by lead name (same as local).
        // NEVER reconstruct a /thread/new/?recipient=<slug> compose URL here — it
        // is a compose route that 45s-nav-timeouts on send.
        await store.createTask({
          campaignId: campaign.id, type: "follow_up", dedupeKey: `follow-up:${account}:${url}`,
          dueAt: new Date(now + delayMs),
          payload: { threadUrl, body: v.personalizeTemplate(templates.followUpBody, data), leadUrl: url, leadName: leadFullName, primaryName, primaryUrl, sender: templates.primarySource || "local-browser", introTitle: title, profileId: account },
        });
      }
      result.sent++;
    } else {
      // Interruption: the browser/session died mid-send → this lead never got a
      // fair attempt. Stamp "Skipped — browser closed" (retryable) instead of a
      // misleading terminal "Failed", stamp the remainder Skipped, and stop —
      // the session won't recover this sweep. Mirrors app auto-intro.js:792-862.
      if (!_browserAlive(page)) {
        await store.updateLeadOutcome(lead.id, { introductionStatus: "Skipped — browser closed" }).catch(() => {});
        result.skipped++;
        await _stampSkipped(connectedUrls.slice(i + 1), "browser closed");
        break;
      }
      // Reverify-and-downgrade: a compose-textbox failure on a row stamped
      // "Connected" is impossible for a real 1st-degree connection (LinkedIn
      // loads compose for them). Reverify via getConnectionStatus; a clear-
      // negative ('connect'/'pending') downgrades CC so the next sweep leaves it
      // alone. Mirrors app auto-intro.js:774-786 (writes DB, not the sheet).
      if (errMsg.includes("MESSAGE_SEND_FAILED: compose textbox did not appear") &&
          String(lead.connection_accepted_status || "").trim() === "Connected") {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          await new Promise((r) => setTimeout(r, 1500));
          const status = await _connStatus(page);
          if (_decideReverifyAction(status, "Connected").action === "downgrade") {
            await store.updateLeadOutcome(lead.id, {
              connectionAcceptedStatus: `Unverified — manual review (${_formatLocalDate(new Date())})`,
            }).catch(() => {});
          }
        } catch { /* reverify navigation failed — keep the stamp */ }
      }
      await store.updateLeadOutcome(lead.id, { introductionStatus: _friendlyIntroFailure(errMsg, v.INTRO_FAILED_PRIMARY_NOT_CONNECTED) });
      result.failed++;
    }
  }
  return result;
}

module.exports = { runAutoIntros, _shouldHoldIntros, _shouldQueueAutoAccept, isLinkedInProfileUrl, introConnectionStamp, _friendlyIntroFailure, _vendoredSend, personalizationData, _decideReverifyAction, _browserAlive, _formatLocalDate };
